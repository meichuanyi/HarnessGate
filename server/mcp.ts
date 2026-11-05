import { mkdirSync, readFileSync, renameSync, statSync, watch, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";

/**
 * 受管 MCP 服务器：全局一份配置（~/.harnessgate/mcp.json），新建会话时按需勾选注入。
 * env/headers 用 [{name,value}] 行式存储（UI 好编辑）；wire() 负责转成 ACP 线格式。
 * 读取前按文件指纹（mtimeMs:size）懒加载：脚本/编辑器直改 mcp.json 无需重启服务，
 * 但只影响之后新建/恢复的会话，已在跑的会话不回溯变更。
 */
export type McpServerConfig = {
  id: string;
  /** agent 侧的标识，只允许字母/数字/._- */
  name: string;
  type: "stdio" | "http" | "sse";
  /** stdio：可执行文件（建议绝对路径） */
  command?: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
  /** http/sse：服务器地址 */
  url?: string;
  headers?: Array<{ name: string; value: string }>;
  /** 新建会话时的默认勾选状态 */
  enabled: boolean;
  note?: string;
};

type McpFile = { version: 1; servers: McpServerConfig[] };

/** ACP 线格式的 MCP 服务器（结构对齐 SDK 的 schema.McpServer 联合，避免深路径 import） */
export type WireMcp =
  | { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
  | { name: string; type: "http"; url: string; headers: Array<{ name: string; value: string }> }
  | { name: string; type: "sse"; url: string; headers: Array<{ name: string; value: string }> };

export type McpUpsertResult = McpServerConfig | { error: string };

export class McpStore {
  private servers: McpServerConfig[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** 上次加载的文件指纹（mtimeMs:size），外部直改后变化以触发热载 */
  private fingerprint: string | null = null;
  /** 外部直改（脚本/编辑器）被热载吸收后触发（仅内容成功解析时；自身 flush 不触发）。
   *  index.ts 用它广播 mcp 消息让已连接的 web/插件刷新列表快照——否则旧快照里的死 id
   *  在建会话时会被过滤并报「部分所选 MCP 服务器已不存在」。 */
  onExternalChange?: () => void;
  private watcher: ReturnType<typeof watch> | null = null;

  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.load();
    // 目录级监听：外部直改 mcp.json 立刻触发 sync（懒加载只靠读路径驱动，没人读就永远不重载、
    // 也就永远不推送新列表）。watch 目录而不是文件——mcp.json 常被原子替换（tmp+rename），
    // 文件级 watcher 会跟丢 inode。自身 flush 后指纹已更新，这里 sync 是空操作。
    try {
      const w = watch(dirname(this.file), (_event, filename) => {
        if (filename === basename(this.file)) this.sync();
      });
      w.on("error", () => {}); // 监听异常（权限/溢出）：退回懒加载语义，不影响主流程
      this.watcher = w;
    } catch {
      /* 平台不支持：退回懒加载 */
    }
  }

  /** 热载入口：文件指纹变了就重读。所有读写路径先走这里 */
  private sync(): void {
    let fp: string;
    try {
      const st = statSync(this.file);
      fp = `${st.mtimeMs}:${st.size}`;
    } catch {
      return; // 文件暂不可见（原子替换瞬间/被删）：保留内存现状
    }
    if (fp !== this.fingerprint) this.load(true);
  }

  private load(notify = false): void {
    let fp: string | null = null;
    try {
      const st = statSync(this.file);
      fp = `${st.mtimeMs}:${st.size}`;
    } catch {
      return;
    }
    let parsed = false;
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as Partial<McpFile>;
      this.servers = (data.servers ?? []).filter((s) => s && typeof s.name === "string");
      for (const s of this.servers) s.id ||= randomUUID().slice(0, 8);
      console.log(`[mcp] 已加载 ${this.servers.length} 个受管 MCP 服务器`);
      parsed = true;
    } catch (err) {
      // 半截写入/语法错误：沿用内存旧配置（指纹照常更新，避免每次调用都重试解析）
      console.error(
        `[mcp] 读取 ${this.file} 失败，保留内存中的 ${this.servers.length} 条配置:`,
        err instanceof Error ? err.message : err,
      );
    }
    // 铁律：先记指纹再通知——通知回调会 list()→sync()，指纹没更新就会无限递归
    this.fingerprint = fp;
    if (notify && parsed) this.onExternalChange?.();
  }

  list(): McpServerConfig[] {
    this.sync();
    return this.servers.map((s) => ({ ...s, env: s.env?.map((e) => ({ ...e })), headers: s.headers?.map((h) => ({ ...h })) }));
  }

  get(id: string): McpServerConfig | undefined {
    this.sync();
    return this.servers.find((s) => s.id === id);
  }

  /** 新建会话未明确选择时的默认集合 */
  enabledIds(): string[] {
    this.sync();
    return this.servers.filter((s) => s.enabled).map((s) => s.id);
  }

  /** 新建/更新：无 id 新建、有 id 覆盖。校验失败返回 {error}（不落库） */
  upsert(input: Partial<McpServerConfig>): McpUpsertResult {
    this.sync(); // 先吸收外部直改，避免 UI 保存把脚本写入的内容冲掉
    const name = String(input.name ?? "").trim();
    if (!name) return { error: "name 不能为空" };
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) return { error: "name 只能包含字母/数字/._-（这是 agent 侧的服务器标识）" };
    const type = input.type === "http" || input.type === "sse" ? input.type : "stdio";
    const next: McpServerConfig = {
      id: input.id || randomUUID().slice(0, 8),
      name,
      type,
      enabled: input.enabled !== false,
      note: input.note?.trim() || undefined,
      ...(type === "stdio"
        ? {
            command: String(input.command ?? "").trim() || undefined,
            args: (input.args ?? []).map(String).map((a) => a.trim()).filter(Boolean),
            env: normPairs(input.env),
          }
        : {
            url: String(input.url ?? "").trim() || undefined,
            headers: normPairs(input.headers),
          }),
    };
    if (type === "stdio" && !next.command) return { error: "stdio 服务器需要 command" };
    if (type !== "stdio" && !/^https?:\/\//.test(next.url ?? "")) return { error: `${type} 服务器需要 http(s) url` };
    const i = input.id ? this.servers.findIndex((s) => s.id === input.id) : -1;
    if (i >= 0) this.servers[i] = next;
    else this.servers.push(next);
    this.schedule();
    return { ...next };
  }

  remove(id: string): boolean {
    this.sync();
    const i = this.servers.findIndex((s) => s.id === id);
    if (i < 0) return false;
    this.servers.splice(i, 1);
    this.schedule();
    return true;
  }

  /** 所选 id → ACP 线格式。未知 id 静默跳过：配置被删过的老会话不至于起不来 */
  wire(ids: string[]): WireMcp[] {
    const out: WireMcp[] = [];
    for (const id of ids) {
      const s = this.get(id);
      if (!s) continue;
      if (s.type === "stdio") {
        out.push({ name: s.name, command: s.command ?? "", args: s.args ?? [], env: s.env ?? [] });
      } else {
        out.push({ type: s.type, name: s.name, url: s.url ?? "", headers: s.headers ?? [] });
      }
    }
    return out;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 400);
    this.timer.unref?.();
  }

  private flush(): void {
    const payload: McpFile = { version: 1, servers: this.servers };
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(payload, null, 1));
      renameSync(tmp, this.file);
      try {
        const st = statSync(this.file);
        this.fingerprint = `${st.mtimeMs}:${st.size}`; // 自己写入的也算已加载，省一次重载
      } catch {
        /* stat 失败：下次 sync 会多读一次，无害 */
      }
    } catch (err) {
      console.error(`[mcp] 写入失败:`, err instanceof Error ? err.message : err);
    }
  }
}

function normPairs(pairs?: Array<{ name?: unknown; value?: unknown }>): Array<{ name: string; value: string }> {
  return (pairs ?? [])
    .filter((p) => p && typeof p === "object")
    .map((p) => ({ name: String(p.name ?? "").trim(), value: String(p.value ?? "") }))
    .filter((p) => p.name);
}

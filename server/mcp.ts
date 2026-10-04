import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

/**
 * 受管 MCP 服务器：全局一份配置（~/.harnessgate/mcp.json），新建会话时按需勾选注入。
 * env/headers 用 [{name,value}] 行式存储（UI 好编辑）；wire() 负责转成 ACP 线格式。
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

  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file)) return;
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as Partial<McpFile>;
      this.servers = (data.servers ?? []).filter((s) => s && typeof s.name === "string");
      for (const s of this.servers) s.id ||= randomUUID().slice(0, 8);
    } catch (err) {
      console.error(`[mcp] 读取 ${file} 失败，从空配置开始:`, err instanceof Error ? err.message : err);
    }
  }

  list(): McpServerConfig[] {
    return this.servers.map((s) => ({ ...s, env: s.env?.map((e) => ({ ...e })), headers: s.headers?.map((h) => ({ ...h })) }));
  }

  get(id: string): McpServerConfig | undefined {
    return this.servers.find((s) => s.id === id);
  }

  /** 新建会话未明确选择时的默认集合 */
  enabledIds(): string[] {
    return this.servers.filter((s) => s.enabled).map((s) => s.id);
  }

  /** 新建/更新：无 id 新建、有 id 覆盖。校验失败返回 {error}（不落库） */
  upsert(input: Partial<McpServerConfig>): McpUpsertResult {
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

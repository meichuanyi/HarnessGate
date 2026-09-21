import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import type { Readable as NodeReadable, Writable as NodeWritable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  Attachment,
  ConfigOption,
  HarnessSpec,
  PermissionOption,
  SessionInfo,
  SessionStatus,
  TranscriptEntry,
} from "./types.ts";
import { AuditLog, isInside } from "./audit.ts";
import type { WorkspaceHub } from "./workspace.ts";
import type { PersistedSession } from "./store.ts";
import type { WorktreeInfo } from "./types.ts";

/** 从台账推导会话标题：优先用户的第1句，其次助手的第1句 */
export function deriveTitle(transcript: TranscriptEntry[]): string | undefined {
  for (const e of transcript) {
    if (e.kind === "user" && e.text) return e.text.slice(0, 40);
  }
  for (const e of transcript) {
    if (e.kind === "assistant" && e.text) return e.text.replace(/\s+/g, " ").slice(0, 40);
  }
  return undefined;
}

export type SessionHooks = {
  onStatus: (info: SessionInfo) => void;
  onUpdate: (sessionId: string, update: unknown) => void;
  onTurnEnd: (sessionId: string, stopReason: string) => void;
  onPermission: (
    sessionId: string,
    requestId: string,
    title: string,
    options: PermissionOption[],
  ) => void;
  onLog: (sessionId: string, line: string) => void;
  /** 会话记录有变化（含 transcript），交给 store 落盘 */
  onPersist: (record: PersistedSession) => void;
};

type Child = ChildProcessByStdio<NodeWritable, NodeReadable, NodeReadable>;
type Update = Record<string, unknown> & {
  sessionUpdate?: string;
  content?: { type?: string; text?: string };
};

const now = () => new Date().toISOString();

/** 单条工具详情（入参 + 输出）上限，超了从尾部截断，避免把台账撑爆 */
const DETAIL_MAX = 4000;

/** ACP 的 content 形态不统一：可能是字符串、内容块数组、或 {type,content:{text}}，统一摊成文本 */
function textOf(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join("\n");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (o.content !== undefined) return textOf(o.content);
    try {
      return JSON.stringify(v);
    } catch {
      return "";
    }
  }
  return String(v);
}

/** 从 ACP tool_call 事件中提取更有辨识度的工具名称与标题（如 bash: npm test / read_file: src/index.ts） */
function formatToolTitle(u: Record<string, unknown>): string {
  let title = typeof u.title === "string" && u.title.trim() ? u.title.trim() : "";
  const name =
    typeof u.name === "string"
      ? u.name
      : typeof u.toolName === "string"
        ? u.toolName
        : typeof u.callName === "string"
          ? u.callName
          : typeof u.kind === "string" && u.kind !== "tool"
            ? u.kind
            : "";

  if (!title && name) title = name;
  if (!title) title = "tool";

  const raw = u.rawInput ?? u.input;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const cmd = obj.command ?? obj.cmd ?? obj.script;
    const file = obj.path ?? obj.file_path ?? obj.filePath ?? obj.file ?? obj.target_file;
    const query = obj.query ?? obj.pattern ?? obj.regex;
    const url = obj.url ?? obj.uri;

    if (typeof cmd === "string" && cmd.trim()) {
      const short = cmd.trim().split("\n")[0]?.slice(0, 60) ?? "";
      if (short && !title.includes(short)) title = `${name || title}: ${short}`;
    } else if (typeof file === "string" && file.trim()) {
      if (!title.includes(file)) title = `${name || title}: ${file}`;
    } else if (typeof query === "string" && query.trim()) {
      if (!title.includes(query)) title = `${name || title}: "${query.slice(0, 40)}"`;
    } else if (typeof url === "string" && url.trim()) {
      if (!title.includes(url)) title = `${name || title}: ${url.slice(0, 50)}`;
    }
  }
  return title;
}

/** 追加一段工具输出并限长；下游每次发全量时靠 endsWith 去重，避免同一个输出被叠很多遍 */
function appendDetail(prev: string | undefined, add: string): string {
  if (!add) return prev ?? "";
  if (!prev) return cap(add);
  if (prev.endsWith(add)) return prev;
  return cap(`${prev}\n${add}`);
}
function cap(s: string): string {
  return s.length > DETAIL_MAX ? `…${s.slice(-DETAIL_MAX)}` : s;
}

/**
 * 一个 HarnessSession = 一个 harness 子进程 + 一个 ACP 会话（可恢复）。
 * agent 在服务器上运行；浏览器只是观察者/驱动者，从不接触文件系统。
 */
export type AutoApproveLevel = "off" | "readonly" | "all";

export class HarnessSession {
  readonly id: string;
  readonly createdAt: string;
  readonly harnessId: string;
  readonly harnessLabel: string;
  readonly cwd: string;
  status: SessionStatus;
  error?: string;
  resumable = false;
  acpSessionId?: string;
  title?: string;
  origin: "new" | "imported" = "new";
  /** 由哪个圆桌创建（删圆桌时据此连带删除） */
  roomId?: string;
  modes?: { currentModeId?: string; availableModes?: { id: string; name?: string }[] };
  configOptions?: ConfigOption[];
  worktree?: WorktreeInfo;
  /** 圆桌模式下由服务端自动批准权限请求（成员会话没人点按钮，否则会永久挂起） */
  autoApprove: AutoApproveLevel = "off";
  /** 危险操作硬闸：无论档位，匹配到这些模式的权限请求都强制人工决策（弹按钮） */
  /** 危险操作硬闸开关：默认关（全自动=真全自动，危险操作只打 ⚠ 标记）；=1 时危险操作强制人工 */
  static readonly DANGER_HOLD = process.env.HG_DANGER_HOLD === "1";
  static readonly DANGER_RE = /rm\s+-rf\s+[/"']|git\s+push[^&|;]*--force|git\s+reset\s+--hard|\bmkfs\b|\bdd\b[^|;]*of=/i;
  /** 建会话时就想应用的配置（模型等）：会话就绪后自动下发，失败只记日志不中断 */
  pendingConfigs: Array<{ configId: string; value: string }> = [];
  /** env 占位符的自定义取值（如 HG_OPENCLAW_AGENT），由创建方（向导/圆桌）传入 */
  vars: Record<string, string> = {};

  private child?: Child;
  private ctx?: acp.ClientContext;
  private releaseConn?: () => void;
  private readonly pendingPermissions = new Map<string, (optionId: string) => void>();
  /** 最近一条挂着的授权请求（界面上"待审批：xxx"就靠它；同时有多个请求时只留最后一个） */
  private pendingPerm?: { requestId: string; title: string; options: PermissionOption[] };
  private permSeq = 0;
  private stopRequested = false;
  private replaying = false;
  private readonly transcript: TranscriptEntry[];
  private assistantOpen = false;
  private turnWaiter?: { from: number; resolve: (r: { text: string; stopReason: string }) => void };
  /** 一个 turn 正在跑（前端据此显示「停止」按钮；随 SessionInfo 广播） */
  private inTurnFlag = false;
  /** 本回合开始时间（epoch ms）——前端显示「已运行 X 分钟」 */
  private turnStartedAt?: number;
  /** 最近一次收到 agent 事件（流式/思考/工具调用）的时间——看门狗按「静默多久」判死，不看总时长 */
  private lastProgressAt = Date.now();
  /** 会话还没就绪时先排队，就绪后自动发出（避免用户手快丢消息） */
  private queued: { text: string; attachments: Attachment[] }[] = [];
  /** 用户手动选过的配置（模型等），持久化并在恢复时重放 */
  private chosen: Record<string, string> = {};
  /** 房间 worker 的宽松权限：就绪后自动切到 harness 支持的最宽 mode（auto/yolo/acceptEdits/…）。
   *  worker 都在 git 隔离的 worktree 里，从源头减少授权请求比事后批准更稳（不会挂、不留审批债） */
  permissiveMode = false;
  /** 当前正在干的事（圆桌/工作队设置，如「T1 完成RQ2实证分析」）——权限决策记录的任务上下文 */
  intentTag?: string;

  constructor(
    private readonly spec: HarnessSpec,
    record: PersistedSession,
    private readonly audit: AuditLog,
    private readonly hooks: SessionHooks,
    private readonly hub: WorkspaceHub,
  ) {
    this.id = record.id;
    this.createdAt = record.createdAt;
    this.harnessId = spec.id;
    this.harnessLabel = spec.label;
    this.cwd = record.cwd;
    this.status = record.status;
    this.acpSessionId = record.acpSessionId;
    this.resumable = record.resumable;
    this.title = record.title;
    this.origin = record.origin ?? "new";
    this.roomId = record.roomId;
    this.worktree = record.worktree;
    this.transcript = record.transcript;
    // 上次手动选过的配置（模型等）：进会话时 UI 显示它，恢复会话时自动重新下发给 harness
    this.chosen = record.chosen ?? {};
    this.autoApprove = (record.autoApprove as AutoApproveLevel) ?? "off";
    this.pendingConfigs = Object.entries(this.chosen).map(([configId, value]) => ({ configId, value }));
  }

  static newRecord(spec: HarnessSpec, cwd: string, id?: string): PersistedSession {
    return {
      id: id ?? randomUUID().slice(0, 8),
      harnessId: spec.id,
      cwd,
      createdAt: now(),
      lastActiveAt: now(),
      status: "starting",
      resumable: false,
      origin: "new",
      transcript: [],
    };
  }

  /** 没标题时从台账里推导一个（恢复出来的会话常常没有标题） */
  private derivedTitle(): string | undefined {
    return this.title ?? deriveTitle(this.transcript);
  }

  /** 当前完整记录（给 store 落盘用） */
  record(): PersistedSession {
    return {
      id: this.id,
      harnessId: this.harnessId,
      cwd: this.cwd,
      createdAt: this.createdAt,
      lastActiveAt: now(),
      status: this.live() ? this.status : "saved",
      acpSessionId: this.acpSessionId,
      resumable: this.resumable,
      origin: this.origin,
      roomId: this.roomId,
      title: this.derivedTitle(),
      worktree: this.worktree,
      transcript: this.transcript,
      chosen: Object.keys(this.chosen).length ? this.chosen : undefined,
      autoApprove: this.autoApprove,
    };
  }

  info(): SessionInfo {
    return {
      id: this.id,
      harnessId: this.harnessId,
      harnessLabel: this.harnessLabel,
      cwd: this.cwd,
      status: this.status,
      createdAt: this.createdAt,
      lastActiveAt: now(),
      live: this.live(),
      resumable: this.resumable,
      acpSessionId: this.acpSessionId,
      error: this.error,
      pendingPermission: this.pendingPerm,
      title: this.derivedTitle(),
      modes: this.modes,
      configOptions: this.configOptions?.map((o) =>
        // 用户上次选的值优先显示（恢复后的会话 harness 上报的 currentValue 可能回到默认）
        this.chosen[o.id] !== undefined && !(o.options?.length && !o.options.some((x) => x.value === this.chosen[o.id]))
          ? { ...o, currentValue: this.chosen[o.id] }
          : o,
      ),
      worktree: this.worktree,
      inTurn: this.inTurnFlag,
      /** 本回合开始时间（epoch ms）；inTurn=false 时无 */
      turnStartedAt: this.inTurnFlag ? (this.turnStartedAt ?? Date.now()) : undefined,
      /** 最近一次 agent 事件时间（epoch ms）——前端据此显示「最后活动 X 前」 */
      lastProgressAt: this.lastProgressAt,
      autoApprove: this.autoApprove,
      roomId: this.roomId,
    };
  }

  transcriptEntries(): TranscriptEntry[] {
    return this.transcript;
  }

  private live(): boolean {
    return this.status === "starting" || this.status === "ready" || this.status === "awaiting";
  }

  private log(line: string): void {
    this.hooks.onLog(this.id, line);
  }

  private setStatus(status: SessionStatus, error?: string): void {
    this.status = status;
    this.error = error;
    this.hooks.onStatus(this.info());
    this.persist();
  }

  private persist(): void {
    this.hooks.onPersist(this.record());
  }

  private push(entry: TranscriptEntry): void {
    this.transcript.push(entry);
    this.persist();
  }

  async start(mode: "new" | "resume" = "new"): Promise<void> {
    if (mode === "resume" && !this.acpSessionId) {
      this.setStatus("error", "该会话没有可恢复的 ACP 会话 id");
      return;
    }
    this.audit.append({
      session: this.id,
      harness: this.harnessId,
      op: mode === "resume" ? "session.resume" : "session.start",
      cwd: this.cwd,
      cmd: this.spec.cmd,
      args: this.spec.args,
      proxy: this.spec.proxy,
      acpSessionId: this.acpSessionId,
    });

    try {
      if (!existsSync(this.cwd)) {
        await mkdir(this.cwd, { recursive: true });
        this.log(`工作目录不存在，已创建: ${this.cwd}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus("error", `工作目录不可用: ${this.cwd}（${message}）`);
      return;
    }

    const scope: Record<string, string> = { HG_SESSION_ID: this.id, ...this.vars };
    const specEnv = Object.fromEntries(
      Object.entries(this.spec.env ?? {}).map(([k, v]) => [
        k,
        String(v).replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_, name: string, def?: string) => scope[name] ?? def ?? ""),
      ]),
    );
    const env: NodeJS.ProcessEnv = { ...process.env, ...specEnv };
    if (this.spec.proxy) {
      env.HTTPS_PROXY = env.HTTPS_PROXY ?? this.spec.proxy;
      env.HTTP_PROXY = env.HTTP_PROXY ?? this.spec.proxy;
      env.ALL_PROXY = env.ALL_PROXY ?? this.spec.proxy;
      env.NO_PROXY = env.NO_PROXY ?? "localhost,127.0.0.1,::1,192.168.0.0/16,10.0.0.0/8,100.64.0.0/10";
    }
    const child = spawn(this.spec.cmd, this.spec.args, {
      cwd: this.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as Child;
    this.child = child;

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      if (text) this.log(`stderr: ${text.slice(0, 2000)}`);
    });
    child.on("exit", (code, signal) => {
      this.log(`harness 进程退出 code=${code ?? "null"} signal=${signal ?? "null"}`);
      if (!this.stopRequested) this.setStatus("error", `harness 进程退出 (${code ?? signal})`);
      // 进程没了必须释放工作区席位：否则递归 watcher 永不关闭（inotify 泄漏会把系统配额吃光），
      // 死会话还会继续接文件改动的归因。resume 会重新 register，这里不会误伤。
      this.hub.setInTurn(this.id, false);
      this.hub.setLive(this.id, false);
      this.hub.unregister(this.id);
    });
    child.on("error", (err) => this.setStatus("error", `无法启动 harness: ${err.message}`));

    const app = acp
      .client({ name: "harnessgate" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this.requestPermission(ctx.params),
      )
      .onRequest(acp.methods.client.fs.readTextFile, (ctx) => this.readTextFile(ctx.params))
      .onRequest(acp.methods.client.fs.writeTextFile, (ctx) => this.writeTextFile(ctx.params))
      .onNotification(acp.methods.client.session.update, (ctx) =>
        this.handleUpdate(ctx.params as { sessionId?: string; update?: Update }),
      );

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    );

    app
      .connectWith(stream, async (ctx) => {
        const init = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        });
        this.log(
          `initialized: protocol v${init.protocolVersion} agent=${JSON.stringify(init.agentInfo ?? {})}`,
        );
        this.resumable = Boolean(init.agentCapabilities?.loadSession);
        this.log(`会话可恢复(loadSession)=${this.resumable}`);
        if (init.authMethods?.length) {
          const ids = init.authMethods.map((m: { id: string }) => m.id);
          this.log(`agent 声明了认证方式: ${ids.join(", ")}`);
          if (this.spec.authMethod) {
            if (!ids.includes(this.spec.authMethod)) {
              this.log(`⚠️ 配置的 authMethod=${this.spec.authMethod} 不在 agent 声明的列表里，仍然尝试`);
            }
            try {
              await this.withTimeout(
                ctx.request(acp.methods.agent.authenticate, { methodId: this.spec.authMethod }),
                15_000,
                "认证",
              );
              this.log(`已按配置认证: ${this.spec.authMethod}`);
            } catch (err) {
              this.log(`认证失败（${this.spec.authMethod}）: ${err instanceof Error ? err.message : String(err)}`);
            }
          } else {
            this.log("未配置 authMethod，不主动调用 authenticate");
          }
        }
        this.ctx = ctx;

        if (mode === "resume") {
          const tryFork = async (): Promise<boolean> => {
            try {
              const f = await ctx.request(acp.methods.agent.session.fork, {
                sessionId: this.acpSessionId!,
                cwd: this.cwd,
                mcpServers: [],
              });
              const fid = (f as { sessionId?: string }).sessionId;
              if (!fid) return false;
              this.log(`会话已 fork 出一个可继续的副本: ${this.acpSessionId} → ${fid}`);
              this.acpSessionId = fid;
              this.replaying = false;
              const fc = (f as { configOptions?: ConfigOption[] }).configOptions;
              if (fc?.length) this.configOptions = fc;
              return true;
            } catch (err) {
              this.log(`session/fork 不可用：${err instanceof Error ? err.message : String(err)}`);
              return false;
            }
          };
          const tryResume = async (): Promise<boolean> => {
            try {
              const r = await ctx.request(acp.methods.agent.session.resume, {
                sessionId: this.acpSessionId!,
                cwd: this.cwd,
                mcpServers: [],
              });
              const rr = r as { configOptions?: ConfigOption[]; modes?: { currentModeId?: string; availableModes?: { id: string; name?: string }[] } };
              if (rr.configOptions?.length) this.configOptions = rr.configOptions;
              if (rr.modes?.availableModes?.length) this.modes = rr.modes;
              this.replaying = false;
              this.log("会话已恢复（session/resume）");
              return true;
            } catch (err) {
              this.log(`session/resume 不可用（${err instanceof Error ? err.message : String(err)}）`);
              return false;
            }
          };
          const tryLoad = async (): Promise<boolean> => {
            if (!this.resumable) return false;
            this.replaying = this.transcript.length > 0;
            if (!this.replaying) this.log("本地台账为空，本次将采用 harness 回放的历史重建台账");
            await ctx.request(acp.methods.agent.session.load, {
              sessionId: this.acpSessionId!,
              cwd: this.cwd,
              mcpServers: [],
            });
            this.log(`会话已恢复（session/load）：${this.acpSessionId}`);
            return true;
          };

          const order = this.origin === "imported"
            ? [tryFork, tryResume, tryLoad]
            : [tryResume, tryFork, tryLoad];
          let ok = false;
          for (const step of order) {
            ok = await step();
            if (ok) break;
          }
          if (!ok) throw new Error("session/fork、session/resume、session/load 都不可用，无法恢复会话");
          this.log(`恢复方式完成（origin=${this.origin}）`);
        } else {
          const created = await ctx.request(acp.methods.agent.session.new, {
            cwd: this.cwd,
            mcpServers: [],
          });
          this.acpSessionId = created.sessionId;
          this.modes = created.modes
            ? { currentModeId: created.modes.currentModeId, availableModes: created.modes.availableModes }
            : undefined;
          this.configOptions = (created as { configOptions?: ConfigOption[] }).configOptions;
          if (this.modes) {
            this.log(
              `权限模式: 当前=${this.modes.currentModeId} 可选=${(this.modes.availableModes ?? []).map((m) => m.id).join("/")}`,
            );
          }
          this.log(`ACP 会话就绪: ${this.acpSessionId}`);
        }

        this.setStatus("ready");
        const hadModeCfg = this.pendingConfigs.some((c) => /mode/i.test(c.configId));
        if (this.pendingConfigs.length) {
          const pending = [...this.pendingConfigs];
          this.pendingConfigs = [];
          for (const c of pending) {
            try {
              await this.setConfigOption(c.configId, c.value);
            } catch (err) {
              this.log(`预置配置下发失败 ${c.configId}=${c.value}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
        // 房间 worker：自动切到可用的最宽权限模式。宽度序：yolo > dont_ask > auto > acceptEdits > edit > build
        // （2026-09-21 实测教训：zcode 的 "auto" 仍会内部拦截工具且不发 request_permission，yolo 才是真全放行；
        //  已是 yolo/dontAsk 时绝不能"降级"到 auto）
        if (this.permissiveMode && this.modes?.availableModes?.length && !hadModeCfg) {
          const low = (s: string) => s.toLowerCase().replace(/[-_]/g, "");
          const cur = low(this.modes?.currentModeId ?? "");
          const WIDEST = ["yolo", "dontask"];
          if (!WIDEST.some((w) => cur.includes(w))) {
            const PREF = ["yolo", "dontask", "auto", "acceptedits", "edit", "build"];
            const pick = PREF.map((p) => this.modes!.availableModes!.find((m) => low(m.id) === p)).find(Boolean)
              ?? PREF.map((p) => this.modes!.availableModes!.find((m) => low(m.id).includes(p))).find(Boolean);
            if (pick && pick.id !== this.modes?.currentModeId) {
              try {
                await this.setMode(pick.id);
                this.log(`房间 worker 已切宽松模式: ${pick.id}（worktree 隔离 + git 兜底）`);
              } catch (err) {
                this.log(`切宽松模式失败（忽略，靠自动批准兜底）: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }
        }
        void this.flushQueue();
        this.hub.register({
          sessionId: this.id,
          harnessId: this.harnessId,
          harnessLabel: this.harnessLabel,
          cwd: this.cwd,
          inTurn: false,
          live: true,
          worktree: this.worktree,
        });
        await new Promise<void>((resolve) => {
          this.releaseConn = resolve;
        });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!this.stopRequested) {
          this.setStatus("error", message);
          this.push({ kind: "error", ts: now(), message });
        }
        this.log(`ACP 连接失败: ${message}`);
      });
  }

  async prompt(text: string, attachments: Attachment[] = []): Promise<void> {
    const blocked =
      this.status === "awaiting" ||
      (this.status === "starting" && (!this.ctx || !this.acpSessionId));
    if (!this.stopRequested && blocked) {
      if (this.queued.length >= 5) {
        this.push({ kind: "error", ts: now(), message: "排队消息过多（会话仍在启动），请稍后再试" });
        this.hooks.onTurnEnd(this.id, "error");
        return;
      }
      this.queued.push({ text, attachments });
      if (!this.title) {
        this.title = text.slice(0, 40);
        this.hooks.onStatus(this.info());
      }
      this.push({
        kind: "user",
        ts: now(),
        text,
        attachments: attachments.length ? attachments.map((a) => ({ name: a.name, mimeType: a.mimeType })) : undefined,
      });
      this.log(`会话${this.status === "awaiting" ? "正在等你想授权" : "尚未就绪"}，消息已排队（第 ${this.queued.length} 条），恢复后自动发出`);
      this.hooks.onUpdate(this.id, { sessionUpdate: "hg_queued", queueLength: this.queued.length });
      return;
    }
    await this.sendNow(text, attachments);
  }

  private async flushQueue(): Promise<void> {
    while (this.queued.length) {
      const item = this.queued.shift()!;
      this.log(`发送排队消息：${item.text.slice(0, 40)}`);
      await this.sendNow(item.text, item.attachments);
    }
  }

  private async sendNow(text: string, attachments: Attachment[] = []): Promise<void> {
    if (this.stopRequested || (this.status !== "ready" && this.status !== "starting")) {
      this.hooks.onUpdate(this.id, {
        sessionUpdate: "hg_error",
        message: `会话未就绪（${this.status}）`,
      });
      this.finishTurn("error");
      this.hooks.onTurnEnd(this.id, "error");
      return;
    }
    if (!this.ctx || !this.acpSessionId) {
      this.hooks.onUpdate(this.id, { sessionUpdate: "hg_error", message: "会话上下文尚未建立" });
      this.finishTurn("error");
      this.hooks.onTurnEnd(this.id, "error");
      return;
    }
    this.assistantOpen = false;
    this.replaying = false;
    this.markInTurn(true);
    this.push({
      kind: "user",
      ts: now(),
      text,
      attachments: attachments.length
        ? attachments.map((a) => ({ name: a.name, mimeType: a.mimeType }))
        : undefined,
    });
    if (!this.title) {
      this.title = text.slice(0, 40);
      this.hooks.onStatus(this.info());
    }
    const marks = this.transcript.length;
    this.audit.append({
      session: this.id,
      harness: this.harnessId,
      op: "prompt",
      chars: text.length,
    });

    try {
      const blocks: Record<string, unknown>[] = [];
      if (text) blocks.push({ type: "text", text });
      for (const a of attachments) {
        if (a.mimeType.startsWith("image/")) {
          blocks.push({ type: "image", mimeType: a.mimeType, data: a.data });
        } else if (a.mimeType.startsWith("text/") || a.mimeType === "application/json") {
          const decoded = Buffer.from(a.data, "base64").toString("utf8");
          blocks.push({ type: "text", text: `[附件 ${a.name}]\n${decoded}` });
        } else {
          throw new Error(`暂不支持的附件类型: ${a.mimeType}（目前支持图片与文本）`);
        }
      }
      if (!blocks.length) blocks.push({ type: "text", text: "" });
      const t0 = Date.now();
      const res = await this.ctx.request(acp.methods.agent.session.prompt, {
        sessionId: this.acpSessionId,
        prompt: blocks as never,
      });
      const elapsed = Date.now() - t0;
      const produced = this.transcript.length > marks;
      const usage = (res as { usage?: { outputTokens?: number } }).usage;
      const outTokens = usage?.outputTokens ?? 0;
      if (!produced && elapsed < 1500 && outTokens === 0) {
        this.log(`空 turn（${elapsed}ms，无任何产出）——该会话在 agent 侧可能无法继续`);
        this.hooks.onUpdate(this.id, {
          sessionUpdate: "hg_noop_turn",
          message: `agent 在 ${elapsed}ms 内返回但没有任何输出：这条会话在 agent 侧跑不动（旧版本创建的会话常见）。可以点「接续」把历史带进一个新会话继续。`,
        });
      }
      this.markInTurn(false);
      this.closeAssistant(res.stopReason);
      this.finishTurn(res.stopReason);
      this.hooks.onTurnEnd(this.id, res.stopReason);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`prompt 失败: ${message}`);
      this.markInTurn(false);
      this.push({ kind: "error", ts: now(), message });
      this.hooks.onUpdate(this.id, { sessionUpdate: "hg_error", message });
      this.finishTurn("error");
      this.hooks.onTurnEnd(this.id, "error");
    }
  }

  /** 设置自动决策档位（持久化；房间会话恒为 all 不允许改） */
  setAutoApprove(level: "off" | "readonly" | "all"): void {
    if (this.roomId) return;   // 房间会话的自动决策不可关（没有审批界面）
    this.autoApprove = level;
    this.audit.append({ session: this.id, harness: this.harnessId, op: "auto_approve.set", level });
    this.hooks.onStatus(this.info());
    this.hooks.onPersist(this.record());
  }

  /** 打断当前回合：给 agent 发 session/cancel，并在本地立刻放行等待方（不等 agent 确认——
   *  有的 harness 会无视 cancel 继续吐字，那也按已打断处理，别让 UI/圆桌干等） */
  async cancelTurn(stopReason = "cancelled"): Promise<void> {
    // 顺序铁律：先本地放行，再（尽力）通知 agent。
    // 2026-09-21 antigravity 静默挂起事故：旧实现先 await notify——agent 挂死时 notify 永不返回，
    // 本地放行永远执行不到，看门狗判对了病却卡在行刑，整场工作队冻结。
    if (!this.inTurnFlag) return;
    if (!this.ctx || !this.acpSessionId) {
      this.markInTurn(false);
      this.closeAssistant(stopReason);
      this.finishTurn(stopReason);
      this.hooks.onTurnEnd(this.id, stopReason);
      return;
    }
    this.audit.append({ session: this.id, harness: this.harnessId, op: "session.cancel", reason: stopReason });
    this.markInTurn(false);
    this.closeAssistant(stopReason);
    this.finishTurn(stopReason);
    this.hooks.onTurnEnd(this.id, stopReason);
    // 通知带 3 秒超时、失败不追究——agent 还活着就停下，挂死了也无所谓（等待方已放行）
    void Promise.race([
      this.ctx.notify(acp.methods.agent.session.cancel, { sessionId: this.acpSessionId } as never),
      new Promise((r) => setTimeout(r, 3000)),
    ]).catch((err) => {
      this.log(`session/cancel 发送失败（本地已放行，不影响）: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private markInTurn(inTurn: boolean): void {
    if (this.inTurnFlag === inTurn) {
      this.hub.setInTurn(this.id, inTurn);
      return;
    }
    this.inTurnFlag = inTurn;
    if (inTurn) {
      this.turnStartedAt = Date.now();
      this.lastProgressAt = Date.now();   // 回合开始即视为有进展，静默时钟从这里起算
    } else {
      this.turnStartedAt = undefined;
    }
    this.hub.setInTurn(this.id, inTurn);
    this.hooks.onStatus(this.info());   // 前端靠这个显示/隐藏「停止」按钮和运行时长
  }

  async promptAndWait(text: string, timeoutMs = 0): Promise<{ text: string; stopReason: string }> {
    const from = this.transcript.length;
    let resolveTurn!: (r: { text: string; stopReason: string }) => void;
    const wait = new Promise<{ text: string; stopReason: string }>((resolve) => {
      resolveTurn = resolve;
      this.turnWaiter = { from, resolve };
    });
    // 关键：不 await 底层 RPC——它可能永远不回（agent 挂死/等后台任务），
    // 旧实现「先 await 再装定时器」导致超时永远不触发（2026-09-21 论文工作队冻结事故）
    const p = this.prompt(text);
    p.catch(() => {});   // prompt 内部已自理错误；这里只防未处理拒绝
    if (timeoutMs <= 0) return wait;
    // 看门狗（Temporal 式）：不看总时长，只看「静默多久」——只要 agent 还在吐事件就不打断；
    // 静默超线才判死，并走优雅 cancel（释放回合 + 放行等待方）
    const iv = setInterval(() => {
      const silentMs = Date.now() - this.lastProgressAt;
      if (silentMs > timeoutMs) {
        this.log(`静默 ${Math.round(silentMs / 60000)} 分钟超过阈值 ${Math.round(timeoutMs / 60000)} 分钟，按无进展处理`);
        void this.cancelTurn("idle-timeout");
      }
    }, 5_000);
    wait.then(
      () => clearInterval(iv),
      () => clearInterval(iv),
    );
    return wait;
  }

  /** 把 ACP 的 session/update 翻译成台账 + 前端事件 */
  private handleUpdate(params: { sessionId?: string; update?: Update }): void {
    const u = params.update;
    if (!u?.sessionUpdate) return;
    if (params.sessionId && this.acpSessionId && params.sessionId !== this.acpSessionId) {
      return;
    }
    if (this.replaying) return;

    this.lastProgressAt = Date.now();   // 任何 agent 事件都算「活着」——看门狗按静默判死，不看总时长
    this.hooks.onUpdate(this.id, u);

    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        if (u.content?.type === "text" && typeof u.content.text === "string") {
          this.appendAssistant(u.content.text);
        }
        break;
      }
      case "agent_thought_chunk": {
        if (u.content?.type === "text" && typeof u.content.text === "string") {
          this.appendThought(u.content.text);
        }
        break;
      }
      case "config_option_update": {
        const opts = (u as { configOptions?: ConfigOption[] }).configOptions;
        if (opts?.length) {
          this.configOptions = opts;
          this.hooks.onStatus(this.info());
        }
        break;
      }
      case "tool_call": {
        const input = textOf(u.rawInput ?? (u as Record<string, unknown>).input);
        const title = formatToolTitle(u as Record<string, unknown>);
        this.upsertTool({
          toolCallId: String(u.toolCallId ?? (u as Record<string, unknown>).id ?? ""),
          title,
          status: String(u.status ?? "in_progress"),
          detail: input && input !== "{}" ? input : undefined,
        });
        break;
      }
      case "tool_call_update": {
        const raw = textOf((u as { rawOutput?: unknown }).rawOutput ?? (u as Record<string, unknown>).output);
        const content = textOf(u.content);
        const hasTitle = Boolean(u.title || (u as Record<string, unknown>).name || (u as Record<string, unknown>).toolName);
        const title = hasTitle ? formatToolTitle(u as Record<string, unknown>) : undefined;
        this.upsertTool({
          toolCallId: String(u.toolCallId ?? (u as Record<string, unknown>).id ?? ""),
          status: String(u.status ?? "completed"),
          title,
          output: raw ? cap(raw) : content ? cap(content) : undefined,
          outputAppend: !raw && Boolean(content),
        });
        break;
      }
    }
  }

  private finishTurn(stopReason: string): void {
    const w = this.turnWaiter;
    this.turnWaiter = undefined;
    if (this.queued.length) void this.flushQueue();
    if (!w) return;
    const text = this.transcript
      .slice(w.from)
      .filter((e): e is Extract<TranscriptEntry, { kind: "assistant" }> => e.kind === "assistant")
      .map((e) => e.text)
      .join("\n")
      .trim();
    w.resolve({ text, stopReason });
  }

  private appendAssistant(text: string): void {
    const last = this.transcript[this.transcript.length - 1];
    if (last && last.kind === "assistant" && this.assistantOpen) {
      last.text += text;
      this.persist();
      return;
    }
    this.assistantOpen = true;
    this.push({ kind: "assistant", ts: now(), text });
  }

  private closeAssistant(stopReason?: string): void {
    const last = this.transcript[this.transcript.length - 1];
    if (last && last.kind === "assistant") last.stopReason = stopReason;
    this.assistantOpen = false;
    this.persist();
  }

  private appendThought(text: string): void {
    const last = this.transcript[this.transcript.length - 1];
    if (last && last.kind === "thought") {
      last.text += text;
      this.persist();
      return;
    }
    this.push({ kind: "thought", ts: now(), text });
  }

  private upsertTool(t: {
    toolCallId: string;
    title?: string;
    status: string;
    detail?: string;
    output?: string;
    append?: boolean;
    outputAppend?: boolean;
  }): void {
    for (let i = this.transcript.length - 1; i >= 0; i--) {
      const e = this.transcript[i]!;
      if (e.kind === "tool" && (e.toolCallId === t.toolCallId || (t.toolCallId === "" && i === this.transcript.length - 1))) {
        e.status = t.status;
        if (t.title && t.title !== "tool") e.title = t.title;
        if (t.detail) e.detail = t.append ? appendDetail(e.detail, t.detail) : t.detail;
        if (t.output) e.output = t.outputAppend ? appendDetail(e.output, t.output) : t.output;
        this.persist();
        return;
      }
    }
    this.push({
      kind: "tool",
      ts: now(),
      toolCallId: t.toolCallId,
      title: t.title ?? "tool",
      status: t.status,
      detail: t.detail,
      output: t.output,
    });
  }

  private withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const guard = new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} 超时（${ms / 1000}s），harness 未响应`)), ms);
      timer.unref?.();
    });
    return Promise.race([p, guard]).finally(() => clearTimeout(timer)) as Promise<T>;
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.ctx || !this.acpSessionId) throw new Error("会话上下文尚未建立");
    await this.withTimeout(
      this.ctx.request(acp.methods.agent.session.setMode, {
        sessionId: this.acpSessionId,
        modeId,
      }),
      10_000,
      "切换权限模式",
    );
    if (this.modes) this.modes.currentModeId = modeId;
    this.log(`权限模式已切换: ${modeId}`);
    this.hooks.onStatus(this.info());
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    if (!this.ctx || !this.acpSessionId) throw new Error("会话上下文尚未建立");
    await this.withTimeout(
      this.ctx.request(acp.methods.agent.session.setConfigOption, {
        sessionId: this.acpSessionId,
        configId,
        value,
      }),
      10_000,
      `切换配置项 ${configId}`,
    );
    const opt = this.configOptions?.find((o) => o.id === configId);
    if (opt) opt.currentValue = value;
    this.chosen[configId] = value;   // 记住用户的选择：落盘 + 恢复时重放
    this.log(`配置项已切换: ${configId}=${value}`);
    this.hooks.onStatus(this.info());
    this.hooks.onPersist(this.record());
  }

  answerPermission(requestId: string, optionId: string): boolean {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) return false;
    this.pendingPermissions.delete(requestId);
    if (this.pendingPerm?.requestId === requestId) this.pendingPerm = undefined;
    this.audit.append({
      session: this.id,
      harness: this.harnessId,
      op: "permission.answer",
      requestId,
      optionId,
    });
    const mark =
      [...this.transcript].reverse().find((e) => e.kind === "permission" && e.requestId === requestId) ??
      this.transcript[this.transcript.length - 1];
    if (mark && mark.kind === "permission" && !mark.answered) mark.answered = optionId;
    if (this.status === "awaiting" && !this.pendingPermissions.size) this.setStatus("ready");
    else this.persist();
    resolve(optionId);
    return true;
  }

  /** 自动决策：按选项语义打分挑最优（不只是 allow/deny——覆盖还是跳过这类选择题也按「行动导向」挑）。
   *  返回 { optionId, name, reason }；没有任何可放行选项时返回 undefined（按 cancelled 回答，宁可不干也不瞎选）。 */
  private decidePermission(
    options: Array<{ optionId: string; name?: string; kind?: string }>,
  ): { optionId: string; name: string; reason: string } | undefined {
    const CLASSES: Array<{ re: RegExp; score: number; why: string }> = [
      { re: /reject|deny|refuse|cancel|abort|quit|拒绝|取消|中止|放弃/, score: -1, why: "拒绝类（永不自动选）" },
      { re: /allow_always|allow-always|always|总是|记住/, score: 6, why: "always 放行" },
      { re: /allow_once|allow-once|allow|approve|accept|yes|ok|proceed|continue|run|exec|允许|批准|同意|继续|执行/, score: 5, why: "放行/继续类" },
      { re: /recommend|default|suggest|推荐|默认/, score: 4, why: "官方推荐/默认项" },
      { re: /keep|use|save|confirm|overwrite|采用|保留|确认|覆盖/, score: 3, why: "行动导向（保留/确认/覆盖）" },
      { re: /skip|later|postpone|not now|跳过|稍后/, score: 0, why: "跳过类（非最优）" },
    ];
    const scoreOf = (o: { optionId: string; name?: string; kind?: string }) => {
      const hay = `${o.kind ?? ""} ${o.name ?? ""} ${o.optionId ?? ""}`.toLowerCase();
      for (const c of CLASSES) if (c.re.test(hay)) return c;
      return { score: 1, why: "中性" } as { score: number; why: string };
    };
    let best: { optionId: string; name: string; reason: string; score: number } | undefined;
    for (const o of options) {
      const c = scoreOf(o);
      if (c.score < 0) continue;
      if (!best || c.score > best.score) {
        best = { optionId: o.optionId, name: String(o.name ?? o.optionId), reason: c.why, score: c.score };
      }
    }
    return best ? { optionId: best.optionId, name: best.name, reason: best.reason } : undefined;
  }

  /** 权限决策的上下文：agent 发起工具调用前最近一次「说明自己在干什么」（思考/正文，截断） */
  private recentIntent(): string | undefined {
    for (let i = this.transcript.length - 1; i >= Math.max(0, this.transcript.length - 12); i--) {
      const e = this.transcript[i] as { kind?: string; text?: string };
      if ((e.kind === "thought" || e.kind === "assistant") && e.text?.trim()) {
        return e.text.replace(/\s+/g, " ").trim().slice(0, 300);
      }
    }
    return undefined;
  }

  /** 自动决策（autoApprove!=="off" 且通过闸门时走这里）：决策 + 记账 + 应答 */
  private autoDecide(
    params: { toolCall?: { title?: string | null; kind?: string | null; locations?: unknown; rawInput?: unknown }; options?: Array<{ optionId: string; name?: string; kind?: string }> },
    requestId: string,
    intent: string | undefined,
    extra: { permKind?: string; danger?: boolean },
  ): Promise<acp.RequestPermissionResponse> {
    const options = params.options ?? [];
    const decision = this.decidePermission(options);
    const title = String(params.toolCall?.title ?? "工具调用");
    const locations = Array.isArray(params.toolCall?.locations)
      ? (params.toolCall?.locations as Array<Record<string, unknown>>).map((l) => (typeof l?.path === "string" ? (l.path as string) : JSON.stringify(l))).slice(0, 6)
      : undefined;
    const input = params.toolCall?.rawInput != null ? JSON.stringify(params.toolCall.rawInput).slice(0, 600) : undefined;
    const raw = JSON.stringify({ ...params, options: undefined }).slice(0, 900);
    this.audit.append({
      session: this.id, harness: this.harnessId, op: "permission.request", requestId, title,
      auto: true, level: this.autoApprove, danger: extra.danger === true,
      chosen: decision?.optionId, chosenName: decision?.name,
      reason: decision?.reason ?? "无可放行选项（全部为拒绝类）",
      task: this.intentTag, intent, permKind: extra.permKind, locations, input, raw,
      options: options.map((o) => ({ id: o.optionId, name: o.name, kind: o.kind })),
    });
    this.log(`自动决策(${this.autoApprove})${extra.danger ? "[⚠危险]" : ""}: ${title} → ${decision?.name ?? "(无选项)"}（${decision?.reason ?? "cancelled"}）`);
    this.push({
      kind: "permission", ts: now(), title, requestId,
      answered: decision?.name ?? "（无选项，已取消）", auto: true, danger: extra.danger === true,
      level: this.autoApprove, task: this.intentTag, context: intent,
      permKind: extra.permKind, locations, input, raw,
      options: options.map((o) => ({ optionId: o.optionId, name: String(o.name ?? o.optionId), kind: o.kind })),
    });
    if (!decision) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    return Promise.resolve({ outcome: { outcome: "selected", optionId: decision.optionId } });
  }

  private requestPermission(params: {
    toolCall?: { title?: string | null; kind?: string | null; locations?: unknown; rawInput?: unknown };
    options?: Array<{ optionId: string; name?: string; kind?: string }>;
  }): Promise<acp.RequestPermissionResponse> {
    const requestId = `perm-${++this.permSeq}`;
    const intent = this.recentIntent();
    // 权限请求的完整上下文：kind（工具类型）/ locations（涉及文件）/ rawInput（工具原始入参，
    // 文字型说明和 edit 的 file_path 都在这里）——只存 title 会把信息丢掉
    const permKind = params.toolCall?.kind ?? undefined;
    const title0 = String(params.toolCall?.title ?? "工具调用");
    const allText = `${title0} ${JSON.stringify(params.toolCall?.rawInput ?? "")}`;
    const danger = HarnessSession.DANGER_RE.test(allText);
    // 档位分流：off=人工；readonly=只读自动/其余人工；all=全自动（危险操作也决策，只打标记不拦截——
    // 全自动还停下来问就名不副实，而且房间场景没有审批按钮会挂死）。
    // 危险硬闸改为可选：HG_DANGER_HOLD=1 时危险操作强制人工（房间场景自动拒绝，不挂起）
    const dangerHold = HarnessSession.DANGER_HOLD;
    if (this.autoApprove === "all" && !(danger && dangerHold)) {
      return this.autoDecide(params, requestId, intent, { permKind, danger });
    }
    if (this.autoApprove === "readonly") {
      const readOnlyReq = permKind === "read" || /\b(read|grep|glob|ls|cat|list|find|search|view)\b/i.test(title0);
      if (readOnlyReq && !(danger && dangerHold)) {
        return this.autoDecide(params, requestId, intent, { permKind, danger });
      }
      // 半自动档下被拦下的请求走人工按钮，补记一条"拦截"便于回溯
      this.audit.append({ session: this.id, harness: this.harnessId, op: "permission.request", requestId, title: title0, held: true, level: this.autoApprove, reason: danger && dangerHold ? "危险操作硬闸" : "非只读操作", task: this.intentTag, intent });
    }
    if (danger && dangerHold) {
      this.audit.append({ session: this.id, harness: this.harnessId, op: "permission.request", requestId, title: title0, held: true, level: this.autoApprove, reason: "危险操作硬闸", task: this.intentTag, intent });
      if (this.roomId) {
        // 房间场景没有审批界面：自动拒绝并落时间线，绝不挂起
        this.push({ kind: "permission", ts: now(), title: title0, requestId, answered: "（危险操作，自动拒绝）", auto: true, level: this.autoApprove, task: this.intentTag, context: intent, permKind });
        return Promise.resolve({ outcome: { outcome: "cancelled" } });
      }
    }
    const locations = Array.isArray(params.toolCall?.locations)
      ? (params.toolCall?.locations as Array<Record<string, unknown>>)
          .map((l) => (typeof l?.path === "string" ? (l.path as string) : JSON.stringify(l)))
          .slice(0, 6)
      : undefined;
    const input = params.toolCall?.rawInput != null ? JSON.stringify(params.toolCall.rawInput).slice(0, 600) : undefined;
    const raw = JSON.stringify({ ...params, options: undefined }).slice(0, 900);
    // 兼容：圆桌/工作队会话（autoApprove 恒为 "all"）走统一决策路径
    if (this.autoApprove === "all") {
      return this.autoDecide(params, requestId, intent, { permKind });
    }
    const title = String(params.toolCall?.title ?? "工具调用");
    const options: PermissionOption[] = (params.options ?? []).map((o) => ({
      optionId: o.optionId,
      name: String(o.name ?? o.optionId),
      kind: o.kind,
    }));
    this.audit.append({
      session: this.id,
      harness: this.harnessId,
      op: "permission.request",
      requestId,
      title,
      options: options.map((o) => o.optionId),
    });
    this.push({ kind: "permission", ts: now(), title, requestId, options });
    this.pendingPerm = { requestId, title, options };
    if (this.status === "ready") this.setStatus("awaiting");
    this.log(`请求授权: ${title}（会话挂起等答复，状态=awaiting）`);
    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      this.pendingPermissions.set(requestId, (optionId) => {
        resolve({ outcome: { outcome: "selected", optionId } });
      });
      this.hooks.onPermission(this.id, requestId, title, options);
    });
  }

  private async readTextFile(params: { path: string }): Promise<{ content: string }> {
    this.audit.append({
      session: this.id,
      harness: this.harnessId,
      op: "fs.read",
      path: params.path,
      insideWorkspace: isInside(this.cwd, params.path),
    });
    const content = await readFile(params.path, "utf8");
    return { content };
  }

  private async writeTextFile(params: { path: string; content: string }): Promise<object> {
    const inside = isInside(this.cwd, params.path);
    this.audit.append({
      session: this.id,
      harness: this.harnessId,
      op: "fs.write",
      path: params.path,
      allowed: inside,
      bytes: params.content?.length ?? 0,
    });
    if (!inside) {
      throw new acp.RequestError(
        -32603,
        `HarnessGate 拒绝写入工作区之外的路径: ${params.path}（工作区 ${this.cwd}）`,
      );
    }
    await mkdir(dirname(params.path), { recursive: true });
    await writeFile(params.path, params.content, "utf8");
    return {};
  }

  /** 停掉进程但保留会话记录（可再 resume） */
  async stop(): Promise<void> {
    this.stopRequested = true;
    this.audit.append({ session: this.id, harness: this.harnessId, op: "session.stop" });
    this.ctx = undefined;
    this.pendingPerm = undefined;
    this.pendingPermissions.clear();
    this.markInTurn(false);
    this.hub.setLive(this.id, false);
    this.hub.unregister(this.id);
    this.releaseConn?.();
    this.child?.kill("SIGTERM");
    setTimeout(() => {
      if (this.child && this.child.exitCode === null) this.child.kill("SIGKILL");
    }, 3000).unref();
    this.status = "saved";
    this.hooks.onStatus(this.info());
    this.persist();
  }
}

/**
 * HarnessGate 服务端的 WS 协议（与服务端 server/types.ts 对齐）。
 * 插件是瘦客户端：只发消息、收消息，agent 与文件都在服务器上。
 */

export type SessionStatus = "starting" | "ready" | "awaiting" | "saved" | "error" | "stopped";

export type ConfigOption = {
  id: string;
  name?: string;
  category?: string;
  currentValue?: string;
  options?: Array<{ value: string; name?: string; description?: string }>;
};

export type SessionInfo = {
  id: string;
  harnessId: string;
  harnessLabel: string;
  cwd: string;
  status: SessionStatus;
  createdAt: string;
  lastActiveAt: string;
  live: boolean;
  resumable: boolean;
  acpSessionId?: string;
  error?: string;
  /** 正在等用户点授权（此时 status === "awaiting"） */
  pendingPermission?: { requestId: string; title: string; options: PermissionOption[] };
  title?: string;
  modes?: { currentModeId?: string; availableModes?: Array<{ id: string; name?: string }> };
  configOptions?: ConfigOption[];
  worktree?: { dir: string; branch: string; baseCwd: string };
  /** 一个 turn 正在跑（面板据此显示「打断」按钮） */
  inTurn?: boolean;
};

export type HarnessAvailability = {
  id: string;
  label: string;
  available: boolean;
  binPath: string | null;
  note?: string;
  version?: string;
  description?: string;
  tier?: "vendor" | "known" | "unknown";
  trustReason?: string;
  blocked?: boolean;
  state?: string;
  configs?: ConfigOption[];
};

export type PermissionOption = { optionId: string; name: string; kind?: string };

export type TranscriptEntry =
  | { kind: "user"; text: string; ts: string }
  | { kind: "assistant"; text: string; ts: string }
  | { kind: "thought"; text: string; ts: string }
  | { kind: "tool"; title: string; status: string; ts: string; toolCallId?: string }
  | { kind: "permission"; title: string; ts: string; answered?: string; requestId?: string; options?: PermissionOption[] }
  | { kind: "error"; message: string; ts: string }
  | { kind: "log"; text: string; ts: string };

export type DirListing = {
  reqId: string;
  input: string;
  dir: string;
  exists: boolean;
  isDir: boolean;
  entries: Array<{ name: string; path: string; git: boolean }>;
  error?: string;
};

export type ClientMsg =
  | { type: "create"; harnessId: string; cwd?: string; isolate?: boolean }
  | { type: "resume"; sessionId: string }
  | { type: "mode"; sessionId: string; modeId: string }
  | { type: "config"; sessionId: string; configId: string; value: string }
  | { type: "prompt"; sessionId: string; text: string }
  | { type: "permission"; sessionId: string; requestId: string; optionId: string }
  | { type: "close"; sessionId: string }
  /** 打断当前回合（session/cancel），会话保持可用；不同于 close（停整个会话进程） */
  | { type: "interrupt"; sessionId: string }
  | { type: "delete"; sessionId: string }
  | { type: "handoff"; sessionId: string; keep?: number }
  | { type: "sync-history"; harnessId?: string; force?: boolean }
  | { type: "transcript"; sessionId: string }
  | { type: "dirs"; reqId: string; input: string; base?: string }
  | { type: "list" };

export type ServerMsg =
  | {
      type: "hello";
      harnesses: HarnessAvailability[];
      sessions: SessionInfo[];
      defaultCwd: string;
      providers?: Array<{ id: string; label: string }>;
    }
  | { type: "session"; session: SessionInfo }
  | { type: "update"; sessionId: string; update: Record<string, unknown> }
  | { type: "turn_end"; sessionId: string; stopReason: string }
  | { type: "permission"; sessionId: string; requestId: string; title: string; options: PermissionOption[] }
  | { type: "transcript"; sessionId: string; entries: TranscriptEntry[] }
  | { type: "dirs" } & DirListing
  | { type: "history"; providers: Array<{ id: string; label: string }>; summaries?: Array<{ label: string; imported: number; updated: number; skipped: number }> }
  | { type: "log"; sessionId: string; line: string }
  | { type: "deleted"; sessionId: string }
  | { type: "error"; sessionId?: string; message: string };

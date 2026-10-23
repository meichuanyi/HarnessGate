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
  /** 权限自动决策档位（与网页版对齐；房间会话恒为 all 不可改） */
  autoApprove?: "off" | "readonly" | "all";
  roomId?: string;
  /** 用户收藏（置顶展示） */
  starred?: boolean;
  /** 用户自定义标签（筛选用） */
  tags?: string[];
  /** 常驻助理会话（树顶直达、永不空闲回收） */
  assistant?: boolean;
  /** 分支关系：fork/分支自哪个父会话（树形嵌套展示） */
  parentId?: string;
  branchName?: string;
  /** 侧问分身标记：临时分身不进常规列表 */
  sideOf?: string;
  /** 本会话挂载的 MCP 服务器（会话 gear 可改） */
  mcpServerIds?: string[];
  /** 本会话挂载的 MCP 服务器（gear 里可改） */
  /** 版本管理（harness.json manage 声明的才有） */
  installedVersion?: string;
  latestVersion?: string;
  manageBusy?: boolean;
  manageSupported?: boolean;
};

export type HarnessManageInfo = {
  id: string;
  label: string;
  installedVersion?: string;
  latestVersion?: string;
  busy?: boolean;
};

export type HarnessAvailability = {
  id: string;
  label: string;
  available: boolean;
  binPath: string | null;
  note?: string;
  proxy?: string;
  version?: string;
  description?: string;
  tier?: "vendor" | "known" | "unknown";
  trustReason?: string;
  blocked?: boolean;
  state?: string;
  configs?: ConfigOption[];
  /** 版本管理（harness.json manage 声明的才有） */
  installedVersion?: string;
  latestVersion?: string;
  manageBusy?: boolean;
  manageSupported?: boolean;
};

export type PermissionOption = { optionId: string; name: string; kind?: string };

/** 受管 MCP 服务器（mcp.json；type=stdio 走 command，http/sse 走 url） */
export type McpServerInfo = {
  id: string;
  name: string;
  type: "stdio" | "http" | "sse";
  enabled?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  note?: string;
};

export type SkillMetaView = { name: string; description?: string; tokens?: number; mountedOn?: string[] };
export type SkillsSnapshotView = {
  library: SkillMetaView[];
  mounts: Array<{ harnessId: string; skills: Array<{ name: string; native: boolean; tokens: number }>; totalTokens: number }>;
};

export type TranscriptEntry =
  | { kind: "user"; text: string; ts: string; attachments?: Array<{ name: string; mimeType?: string }> }
  | { kind: "assistant"; text: string; ts: string }
  | { kind: "thought"; text: string; ts: string }
  | { kind: "tool"; title: string; status: string; ts: string; toolCallId?: string }
  | { kind: "permission"; title: string; ts: string; answered?: string; requestId?: string; options?: PermissionOption[]; auto?: boolean }
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

/* ---------- 圆桌（room）：与服务端 server/room.ts 对齐的子集 ---------- */

export type RoomTurn = {
  round: number;
  sessionId: string;
  harnessId: string;
  harnessLabel: string;
  prompt: string;
  reply: string;
  stopReason: string;
  ts: string;
  /** 主持人发言（开场/轮间小结/最终汇总）横跨整行 */
  kind?: "member" | "host" | "review";
  hostRole?: "opening" | "round-summary" | "final";
  crewTaskId?: string;
  score?: number;
  scoreNote?: string;
};

export type RoomTopic = {
  id: string;
  topic: string;
  rounds: number;
  mode: "parallel" | "sequential";
  converge?: boolean;
  tournament?: boolean;
  convergedRound?: number;
  status: "idle" | "running" | "done" | "error" | "stopped";
  turns: RoomTurn[];
  /** 正在进行的轮次（0 = 主持人开场阶段） */
  currentRound?: number;
  createdAt: string;
  error?: string;
};

export type RoomMember = { sessionId: string; harnessId: string; harnessLabel: string };

export type CrewTaskLite = {
  id: string;
  title: string;
  status: string;
  assignee?: string;
  files?: string[];
  summary?: string;
  review?: { reviewer: string; verdict: string; score?: number; comments: string };
};

export type Room = {
  id: string;
  topic: string;
  members: string[];
  memberInfo?: RoomMember[];
  host?: { sessionId: string; harnessId: string; harnessLabel?: string } & Record<string, unknown>;
  cwd?: string;
  rounds: number;
  mode: "parallel" | "sequential";
  converge?: boolean;
  tournament?: boolean;
  writeAllowed: boolean;
  status: "idle" | "running" | "done" | "error" | "stopped";
  turns: RoomTurn[];
  topics?: RoomTopic[];
  /** 工作队模式：任务板（简化视图，完整面板在网页版） */
  crew?: { phase: string; tasks: CrewTaskLite[]; mergeLines?: string[]; conflicts?: Array<{ branch: string }> } & Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  error?: string;
};

/* ---------- 目标系统（Goals）与生活运转 ---------- */

export type GoalStatus = "active" | "paused" | "completed" | "archived";

export type GoalCategory = "career" | "academic" | "trading" | "life" | "general";

export type SpeculativePrescriptionAction = {
  label: string;
  actionType: "reschedule_task" | "prepare_worktree" | "notify" | string;
  payload?: Record<string, any>;
};

export type SpeculativePrescription = {
  itemId: string;
  status: "ready" | "warning" | "optimized" | string;
  summary: string;
  evidence?: {
    perceptions?: string[];
    memories?: string[];
  };
  actions?: SpeculativePrescriptionAction[];
};

export type MindwtrTaskView = {
  id: string;
  title: string;
  status?: string;
  startTime?: string;
  dueDate?: string;
  notes?: string;
  tags?: string[];
  projectId?: string;
  timeEstimate?: number;
  prescription?: SpeculativePrescription;
};

export type Goal = {
  id: string;
  title: string;
  description?: string;
  category?: GoalCategory;
  status: GoalStatus;
  progress?: number; // 0 - 100
  cwd?: string;
  deadline?: string;
  createdAt: string;
  updatedAt: string;
  lastSpeculatedAt?: string;
  lastSpeculatedResult?: {
    ok: boolean;
    summary?: string;
    branch?: string;
  };
};

export type GoalView = Goal & {
  linkedTasks?: MindwtrTaskView[];
};

export type ClientMsg =
  | { type: "create"; harnessId: string; cwd?: string; isolate?: boolean; mcpServerIds?: string[] }
  | { type: "session-gear-save"; sessionId: string; mcpServerIds: string[] }
  | { type: "archive"; sessionId: string; q?: string }
  | { type: "side-question"; sessionId: string; text: string }
  /** 找回在跑的侧问分身（按源会话查 live）——切走再回来不丢分身，追问复用同一个 */
  | { type: "side-find"; srcId: string }
  /** ⎇ 分支：fork 当前会话上下文开新会话（回 branch-created，与网页版/APP 对齐） */
  | { type: "branch"; sessionId: string; branchName?: string }
  /** ⇱ 收编：把分支结论蒸馏后注入主线并删除分支（广播 branch-adopted） */
  | { type: "adopt-branch"; branchId: string; mainId: string }
  /** 🧾 决策记录 + 改动文件（回 session-detail） */
  | { type: "session-detail"; sessionId: string }
  /** 技能与 MCP 管理（对齐网页版设置抽屉）：MCP 增删改 + 技能增删改/挂载/读全文 */
  | { type: "mcp-list" }
  | { type: "mcp-save"; server: McpServerInfo }
  | { type: "mcp-delete"; id: string }
  | { type: "skills" }
  | { type: "skills-save"; skill: { name: string; description: string; body: string; renameFrom?: string } }
  | { type: "skills-delete"; name: string }
  | { type: "skills-mount"; name: string; harnessId: string; on: boolean }
  | { type: "skills-read"; reqId: string; name: string; nativeHarness?: string }
  | { type: "harness-manage"; harnessId: string; action: "install" | "update" }
  | { type: "resume"; sessionId: string }
  | { type: "mode"; sessionId: string; modeId: string }
  | { type: "set-auto-approve"; sessionId: string; level: "off" | "readonly" | "all" }
  /** 工作队：请求决策记录 + 交付件面板数据；确认合并到主目录 */
  | { type: "crew-detail"; roomId: string }
  | { type: "crew-merge"; roomId: string }
  | { type: "config"; sessionId: string; configId: string; value: string }
  | { type: "prompt"; sessionId: string; text: string; attachments?: Array<{ name: string; mimeType: string; data: string }> }
  | { type: "permission"; sessionId: string; requestId: string; optionId: string }
  | { type: "close"; sessionId: string }
  /** 打断当前回合（session/cancel），会话保持可用；不同于 close（停整个会话进程） */
  | { type: "interrupt"; sessionId: string }
  | { type: "delete"; sessionId: string }
  | { type: "star"; sessionId: string; starred: boolean }
  | { type: "archive-content"; sessionId: string; total: number; lines: string[] }
  | { type: "side-created"; sessionId: string; srcId: string }
  | { type: "side-found"; srcId: string; sessionId: string | null }
  | { type: "harness-managed"; harnessId: string; action: "install" | "update"; ok: boolean; from?: string; to?: string; output?: string }
  | { type: "set-tags"; sessionId: string; tags: string[] }
  /** 确保助理会话存在（无则服务端用默认 harness 创建） */
  | { type: "assistant-ensure"; harnessId?: string }
  /** 定时任务：列表/立即运行/删除（启停走 schedule-save 的 enabled） */
  | { type: "schedules-list" }
  | { type: "schedule-run"; id: string }
  | { type: "schedule-delete"; id: string }
  /** 目标系统与生活运转 */
  | { type: "goals-get" }
  | { type: "goals-list" }
  | { type: "goal-task-complete"; taskId: string; goalId?: string }
  | { type: "goal-task-reschedule"; taskId: string; dueDate?: string; startTime?: string }
  /** 工作区归因（只读） */
  | { type: "workspace"; cwd?: string }
  | { type: "ping" }
  /** ⇄ 接续：带着最近历史接到新会话（可换 harness/模型），完整历史落快照文件（回 handoff_done） */
  | { type: "handoff"; sessionId: string; targetHarnessId?: string; model?: string }
  | { type: "sync-history"; harnessId?: string; force?: boolean }
  | { type: "transcript"; sessionId: string }
  | { type: "dirs"; reqId: string; input: string; base?: string }
  | {
      type: "room-start";
      cwd: string;
      harnessIds: string[];
      topic: string;
      rounds: number;
      mode?: "parallel" | "sequential";
      converge?: boolean;
      tournament?: boolean;
      writeAllowed?: boolean;
      /** 工作队模式：评审打回上限与合并方式 */
      crew?: { maxAttempts: number; mergeMode: "manual" | "auto" };
      host?: {
        harnessId?: string;
        opening?: boolean;
        roundSummary?: boolean;
        finalSummary?: boolean;
        /** 工头/主持人自己的模型等配置 */
        configs?: Array<{ configId: string; value: string }>;
      };
      memberConfigs?: Record<string, Array<{ configId: string; value: string }>>;
    }
  | { type: "room-topic"; roomId: string; topic: string; rounds: number; mode?: "parallel" | "sequential" }
  | { type: "room-mode"; roomId: string; mode: "parallel" | "sequential" }
  | { type: "room-delete"; roomId: string; deleteSessions?: boolean }
  | { type: "room-run"; roomId: string }
  | { type: "room-stop"; roomId: string }
  | { type: "list" };

export type Schedule = {
  id: string;
  name: string;
  enabled: boolean;
  harnessId: string;
  cwd?: string;
  cadence:
    | { type: "daily"; at: string }
    | { type: "interval"; everyMinutes: number }
    | { type: "weekly"; days: number[]; at: string }
    | { type: "cron"; expr: string };
  promptTemplate: string;
  state?: {
    running?: boolean;
    nextFireAt?: string;
    lastRunAt?: string;
    lastStatus?: "ok" | "error" | "contract-fail" | "timeout" | "skipped-running" | "missing-files";
    lastSessionId?: string;
    consecutiveFailures?: number;
  };
};

export type WorkspaceReport = {
  cwd: string;
  sessions: Array<{ id: string; harnessLabel: string; live: boolean; inTurn: boolean; mode: "shared" | "worktree"; branch?: string; changedFiles?: string[]; diffStat?: string }>;
  files: Array<{ path: string; rel: string; touches: Array<{ sessionId: string; harnessId: string }>; conflict: boolean; lastTs: string }>;
  conflicts: number;
  note: string;
};

export type ServerMsg =
  | {
      type: "hello";
      harnesses: HarnessAvailability[];
      sessions: SessionInfo[];
      defaultCwd: string;
      rooms?: Room[];
      providers?: Array<{ id: string; label: string }>;
      schedules?: Schedule[];
      /** 常驻助理会话 id（null = 尚未创建） */
      assistantSessionId?: string | null;
      mcpServers?: Array<{ id: string; name: string; type: string; enabled?: boolean; command?: string; url?: string }>;
      skills?: SkillsSnapshotView;
      goals?: Goal[];
      lifeTasks?: MindwtrTaskView[];
    }
  | { type: "session"; session: SessionInfo }
  | { type: "update"; sessionId: string; update: Record<string, unknown> }
  | { type: "turn_end"; sessionId: string; stopReason: string }
  | { type: "permission"; sessionId: string; requestId: string; title: string; options: PermissionOption[] }
  | { type: "transcript"; sessionId: string; entries: TranscriptEntry[] }
  | { type: "rooms"; rooms: Room[] }
  | { type: "room"; room: Room }
  | { type: "dirs" } & DirListing
  | { type: "history"; providers: Array<{ id: string; label: string }>; summaries?: Array<{ label: string; imported: number; updated: number; skipped: number }> }
  | { type: "log"; sessionId: string; line: string }
  | { type: "deleted"; sessionId: string }
  | { type: "branch-created"; from: string; to: string }
  | { type: "branch-adopted"; branchId: string; mainId: string; summary: string }
  | { type: "handoff_done"; from: string; to: string }
  | { type: "mcp"; servers: McpServerInfo[] }
  | { type: "skills"; library?: SkillMetaView[]; mounts?: SkillsSnapshotView["mounts"]; reqId?: string }
  | { type: "skills-content"; reqId: string; name: string; content: string }
  | { type: "settings"; settings: Record<string, unknown> }
  | { type: "schedules"; schedules: Schedule[] }
  | { type: "goals"; goals: GoalView[]; lifeTasks?: MindwtrTaskView[] }
  | { type: "workspace"; reports: WorkspaceReport[] }
  | { type: "pong" }
  | {
      type: "crew-detail";
      roomId: string;
      /** 自动权限决策记录（新→旧） */
      decisions: Array<{
        ts: string; harness: string; title: string; chosen?: string; reason?: string; task?: string; intent?: string;
        permKind?: string; locations?: string[]; input?: string; raw?: string; danger?: boolean; held?: boolean;
      }>;
      /** 交付件：每个任务的产物概要、评审结论、分支提交与 diff */
      deliverables: Array<{
        taskId: string;
        title: string;
        status: string;
        assignee?: string;
        files: string[];
        summary?: string;
        review?: { reviewer: string; verdict: string; score?: number; comments: string };
        commits: string[];
        artifacts: Array<{ path: string; size: number }>;
        diff?: string;
      }>;
    }
  | {
      type: "session-detail";
      sessionId: string;
      decisions: Array<{ ts: string; title: string; chosen?: string; reason?: string; level?: string; auto?: boolean; held?: boolean; danger?: boolean; task?: string; intent?: string; permKind?: string; input?: string }>;
      changes: Array<{ path: string; size: number; source: "git" | "audit" }>;
      git: boolean;
    }
  | { type: "error"; sessionId?: string; message: string };

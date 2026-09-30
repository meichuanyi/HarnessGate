import type { WorkspaceReport } from "./workspace.ts";
import type { Room } from "./room.ts";
import type { Schedule } from "./schedules.ts";

export type HarnessSpec = {
  id: string;
  label: string;
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  /** 该 harness 走代理启动（HTTP(S)_PROXY/ALL_PROXY），本机地址自动排除在 NO_PROXY 之外 */
  proxy?: string;
  /** 需要显式认证的适配器：initialize 之后用这个方法 id 调 authenticate（ZCode 那种声明了却没实现的，留空即可） */
  authMethod?: string;
  note?: string;
  experimental?: boolean;
  /** harness 支持的子 agent 列表（如 openclaw 的 main/architect/…）：UI 建会话前展示选择，取值经 env 占位符注入 */
  extraAgents?: string[];
  /** 来自 ACP 官方注册表的条目会带这些字段 */
  source?: string;
  version?: string;
  description?: string;
  repository?: string;
  requiresDownload?: boolean;
  download?: { archive: string; cmd: string };
};

export type Registry = {
  defaults?: { cwd?: string };
  harnesses: HarnessSpec[];
};

/** saved = 已落盘但进程未运行；awaiting = 卡在等用户点授权；starting/ready/error/stopped 同 M1 */
export type SessionStatus = "saved" | "starting" | "ready" | "awaiting" | "error" | "stopped";

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
  /** 正在等用户点授权（只有非圆桌会话会有），此时 status === "awaiting"。
   *  带上它是为了让重连/刷新的客户端也能看到「这个会话在等人点按钮」。 */
  pendingPermission?: { requestId: string; title: string; options: PermissionOption[] };
  title?: string;
  modes?: { currentModeId?: string; availableModes?: { id: string; name?: string }[] };
  configOptions?: ConfigOption[];
  worktree?: WorktreeInfo;
  /** 一个 turn 正在跑（前端据此把发送区变成「停止」） */
  inTurn?: boolean;
  /** 本回合开始时间（epoch ms）；不在回合中时无 */
  turnStartedAt?: number;
  /** 最近一次 agent 事件时间（epoch ms）——「最后活动 X 前」和静默看门狗共用 */
  lastProgressAt?: number;
  /** 自动决策档位（off/readonly/all） */
  autoApprove?: string;
  /** 属于哪个圆桌/工作队（前端据此隐藏自动决策下拉） */
  roomId?: string;
  /** 用户收藏（重要/常用会话）：列表置顶展示 */
  starred?: boolean;
  /** 该会话的 harness 是否声明支持音频 prompt（promptCapabilities.audio）——决定通话能否「直传音频」 */
  promptAudio?: boolean;
  /** 本会话由哪次「接续」分叉而来（UI 显示「↩ 原会话」入口） */
  handoffFrom?: string;
};

export type TranscriptEntry =
  | { kind: "user"; ts: string; text: string; attachments?: { name: string; mimeType: string }[] }
  | { kind: "assistant"; ts: string; text: string; stopReason?: string }
  | { kind: "thought"; ts: string; text: string }
  | { kind: "tool"; ts: string; toolCallId: string; title: string; status: string; detail?: string; output?: string }
  /** requestId 是授权答复的钥匙：必须落盘，否则刷新/切走后按钮就再也点不动了 */
  | {
      kind: "permission";
      ts: string;
      title: string;
      answered?: string;
      requestId?: string;
      options?: PermissionOption[];
      /** 房间会话的自动决策（回答右侧会显示「（自动）」） */
      auto?: boolean;
      /** 自动决策档位（all/readonly），时间线展示用 */
      level?: string;
      /** 危险操作（全自动档也决策，但打 ⚠ 供回溯） */
      danger?: boolean;
      /** 正在做的任务（工作队设置，如「T1 实证分析」） */
      task?: string;
      /** agent 发起工具调用前的自述（说明这是要干什么） */
      context?: string;
      /** 工具类型（bash/edit/read…） */
      permKind?: string;
      /** 涉及的文件 */
      locations?: string[];
      /** 工具原始入参（JSON 截断）——文字型说明在这里 */
      input?: string;
      /** 完整原始请求（JSON 截断），保底不丢字段 */
      raw?: string;
    }
  | { kind: "error"; ts: string; message: string }
  | { kind: "log"; ts: string; text: string };

export type PermissionOption = { optionId: string; name: string; kind?: string };

/** ACP 的会话配置项（模型、推理强度等，返回 category="model" 的就是模型选择） */
export type ConfigOption = {
  id: string;
  name: string;
  category?: string;
  currentValue?: string;
  options?: { value: string; name: string }[];
};

export type Attachment = { name: string; mimeType: string; data: string };

export type WorktreeInfo = { dir: string; branch: string; repo: string };

export type HarnessAvailability = {
  id: string;
  label: string;
  available: boolean;
  binPath: string | null;
  note?: string;
  experimental?: boolean;
  proxy?: string;
  source?: string;
  version?: string;
  description?: string;
  /** vendor=厂商官方/一线；known=可验证的社区项目；unknown=存疑 */
  tier?: "vendor" | "known" | "unknown";
  trustReason?: string;
  blocked?: boolean;
  /** probed-ok=探活通过；installed=本机有但未探活；needs-download=本机没有；probed-auth/failed；missing；blocked */
  state?: string;
  /** harness 支持的子 agent 列表（如 openclaw 的 main/architect/…），供建会话前选择 */
  extraAgents?: string[];
  /** 探活时从 session/new 收集到的可切换配置（模型列表、权限模式等），供建会话前展示 */
  configs?: Array<{
    id: string;
    name: string;
    category?: string;
    currentValue?: string;
    options: Array<{ value: string; name: string }>;
  }>;
};

export type ClientMsg =
  | { type: "create"; harnessId: string; cwd?: string; isolate?: boolean; vars?: Record<string, string> }
  | { type: "resume"; sessionId: string }
  | { type: "mode"; sessionId: string; modeId: string }
  | { type: "config"; sessionId: string; configId: string; value: string }
  | { type: "prompt"; sessionId: string; text: string; attachments?: Attachment[] }
  | { type: "permission"; sessionId: string; requestId: string; optionId: string }
  | { type: "close"; sessionId: string }
  /** 收藏/取消收藏会话（列表置顶展示；对已存档未运行的会话也生效） */
  | { type: "star"; sessionId: string; starred: boolean }
  /** 打断当前回合（session/cancel），会话保持可用；不同于 close（停整个会话进程） */
  | { type: "interrupt"; sessionId: string }
  /** 设置单会话自动决策档位（off=人工，readonly=只读自动，all=全自动；危险操作永远人工） */
  | { type: "set-auto-approve"; sessionId: string; level: "off" | "readonly" | "all" }
  /** UI 里按 harness 配置代理（空串 = 清除，直连） */
  | { type: "harness-proxy"; id: string; proxy: string }
  /** 单会话右侧面板：决策记录 + 改动/交付件 */
  | { type: "session-detail"; sessionId: string }
  | { type: "delete"; sessionId: string }
  /** 语音转文字：audio = base64(WAV，16k 单声道最佳)。模型缺失时服务端后台下载并回 downloading */
  | { type: "voice-stt"; reqId: string; audio: string }
  /** 文字转语音：provider 缺省 edge；返回 base64 音频 */
  | { type: "voice-tts"; reqId: string; text: string; provider?: string; voice?: string }
  /** 实时通话：绑定一个会话，麦克风 PCM（s16le/16k/单声道，~100ms 帧）持续上行 */
  | {
      type: "voice-live-start";
      sessionId: string;
      model?: string;
      cancelOnBarge?: boolean;
      /** 语音模式：stt=本地识别成文字再发给 harness（默认）；audio=把整句音频直传 harness（需其支持 promptCapabilities.audio） */
      mode?: "stt" | "audio";
      /** audio 模式下：是否仍本地转写并把文字记进会话台账（默认 false，只把音频当输入） */
      transcribe?: boolean;
    }
  | { type: "voice-live-chunk"; pcm: string }
  /** 插话：客户端检测到（AEC 后）说话能量，要求立即停播 */
  | { type: "voice-live-barge" }
  | { type: "voice-live-stop" }
  /** 接续：把老会话历史带进新会话。targetHarnessId 不填 = 沿用源会话的 harness；
   *  model 填了且在目标 harness 的探活模型列表里，则作为 chosen 配置在启动时自动重放 */
  | { type: "handoff"; sessionId: string; targetHarnessId?: string; model?: string }
  | { type: "sync-history"; harnessId?: string; force?: boolean }
  /** 取台账；limit 给定时只回「最近 limit 条」窗口，before 用于向前翻更早一窗（端点是绝对下标） */
  | { type: "transcript"; sessionId: string; limit?: number; before?: number }
  | { type: "workspace"; cwd?: string }
  | { type: "dirs"; reqId: string; input: string; base?: string }
  | { type: "room-create"; topic: string; members: string[]; rounds: number; writeAllowed?: boolean }
  | {
      type: "room-start";
      cwd: string;
      harnessIds: string[];
      topic: string;
      /** 最多轮数；0 = 无上限（此时必须设主持人做收敛判定，或接受只能手动停止） */
      rounds: number;
      mode?: "parallel" | "sequential";
      /** 共识即停：每轮小结时让主持人判定是否已收敛，至少 2 轮后才可能提前结束 */
      converge?: boolean;
      /** 评分锦标赛：主持人逐轮打分，摘录按分数差异化投喂，最终按累计分加权 */
      tournament?: boolean;
      writeAllowed?: boolean;
      host?: {
        harnessId?: string;
        sessionId?: string;
        opening?: boolean;
        roundSummary?: boolean;
        finalSummary?: boolean;
        style?: "divergent" | "convergent";
        configs?: Array<{ configId: string; value: string }>;
        vars?: Record<string, string>;
      };
      /** 每个成员建会话时要应用的配置（模型等），key = harnessId */
      memberConfigs?: Record<string, Array<{ configId: string; value: string }>>;
      /** 每个成员的环境变量占位符取值（如 openclaw 的 HG_OPENCLAW_AGENT），key = harnessId */
      memberVars?: Record<string, Record<string, string>>;
      hostVars?: Record<string, string>;
      /** 工作队模式：给目标后由主持人拆任务，成员在各自 worktree 并行干活，评审后合并 */
      crew?: { maxAttempts?: number; mergeMode?: "manual" | "auto" };
    }
  | { type: "room-topic"; roomId: string; topic: string; rounds: number; mode?: "parallel" | "sequential"; converge?: boolean; tournament?: boolean; writeAllowed?: boolean }
  | { type: "room-mode"; roomId: string; mode: "parallel" | "sequential" }
  | { type: "room-delete"; roomId: string; deleteSessions?: boolean }
  | { type: "crew-merge"; roomId: string }
  /** 工作队右侧面板：自动权限决策记录 + 交付件（任务产物/分支提交/评审结论） */
  | { type: "crew-detail"; roomId: string }
  | { type: "room-run"; roomId: string }
  | { type: "room-stop"; roomId: string }
  | { type: "schedules-list" }
  | { type: "schedule-save"; schedule: Schedule }
  | { type: "schedule-delete"; id: string }
  | { type: "schedule-run"; id: string }
  | { type: "schedule-distill"; sessionId: string; fromTs?: string; toTs?: string }
  | { type: "schedule-segment"; sessionId: string }
  | { type: "schedule-segmented-get"; sessionId: string }
  /** 检查 GitHub 上的新版本（git fetch + 比较），不动任何东西 */
  | { type: "check-update" }
  /** 应用更新：git pull --ff-only 后退出进程，交给 systemd Restart 拉起新代码 */
  | { type: "apply-update" }
  | { type: "list" };

export type ServerMsg =
  | {
      type: "hello";
      harnesses: HarnessAvailability[];
      sessions: SessionInfo[];
      defaultCwd: string;
      rooms?: Room[];
      schedules?: Schedule[];
      providers?: Array<{ id: string; label: string }>;
      /** 服务版本（package.json）与 git 短 commit——前端据此显示/检查更新 */
      version?: string;
      commit?: string;
    }
  | { type: "session"; session: SessionInfo }
  | { type: "update"; sessionId: string; update: unknown }
  | { type: "turn_end"; sessionId: string; stopReason: string }
  | {
      type: "permission";
      sessionId: string;
      requestId: string;
      title: string;
      options: PermissionOption[];
    }
  | {
      type: "transcript";
      sessionId: string;
      entries: TranscriptEntry[];
      /** 台账总条数（窗口模式下用于显示「还有 N 条更早」） */
      total?: number;
      /** 本次 entries[0] 在整份台账中的绝对下标（0=从头；>0 表示前面还有更早的） */
      start?: number;
    }
  | { type: "workspace"; reports: WorkspaceReport[] }
  | {
      type: "dirs";
      reqId: string;
      input: string;
      dir: string;
      exists: boolean;
      isDir: boolean;
      entries: Array<{ name: string; path: string; git: boolean }>;
      error?: string;
    }
  | { type: "rooms"; rooms: Room[] }
  | {
      type: "crew-detail";
      roomId: string;
      /** 自动权限决策记录（新→旧） */
      decisions: Array<{
        ts: string; harness: string; title: string; chosen?: string; reason?: string; task?: string; intent?: string;
        permKind?: string; locations?: string[]; input?: string; raw?: string; danger?: boolean; held?: boolean;
      }>;
      /** 交付件：每个任务的产物摘要、评审结论、分支提交与 diff */
      deliverables: Array<{
        taskId: string;
        title: string;
        status: string;
        assignee?: string;
        files: string[];
        summary?: string;
        review?: { reviewer: string; verdict: string; score?: number; comments: string };
        commits: string[];
        /** 实际产物（相对 base 的改动文件 + 大小），可下载 */
        artifacts: Array<{ path: string; size: number }>;
        diff?: string;
      }>;
    }
  | {
      type: "session-detail";
      sessionId: string;
      /** 权限决策记录（新→旧），含人工/自动/拦截 */
      decisions: Array<{ ts: string; title: string; chosen?: string; reason?: string; level?: string; auto?: boolean; held?: boolean; danger?: boolean; task?: string; intent?: string; permKind?: string; input?: string }>;
      /** 本会话改动过的文件（git 仓库=对 HEAD 的 diff；否则来自 fs.change 台账，标注来源） */
      changes: Array<{ path: string; size: number; source: "git" | "audit" }>;
      git: boolean;
    }
  | { type: "handoff_done"; from: string; to: string }
  | { type: "voice-stt-result"; reqId: string; text?: string; error?: string; downloading?: boolean }
  | { type: "voice-tts-result"; reqId: string; audio?: string; mime?: string; provider?: string; error?: string }
  | { type: "voice-live-partial"; text: string }
  | { type: "voice-live-user"; text: string }
  | { type: "voice-live-agent-audio"; seq: number; audio: string; mime: string }
  | { type: "voice-live-phase"; phase: "listening" | "thinking" | "speaking" | "done" | "error"; note?: string }
  | { type: "voice-live-ended" }
  | { type: "history", providers: Array<{ id: string; label: string }>; summaries?: Array<{ provider: string; label: string; found: number; imported: number; updated: number; skipped: number }> }
  | { type: "room"; room: Room }
  | { type: "schedules"; schedules: Schedule[] }
  | { type: "schedule-segmented"; sessionId: string; segments: Array<{ head: string; fromTs: string; toTs: string; turns: number; score: number }> }
  | {
      /** 从会话蒸馏出的定时任务草稿（schedule-distill 的回复） */
      type: "schedule-distilled";
      sessionId: string;
      spec: {
        name?: string;
        prompt?: string;
        outputFile?: string;
        cadence?: { type: "daily"; at: string } | { type: "weekly"; days: number[]; at: string } | { type: "interval"; everyMinutes: number };
        reason?: string;
      };
    }
  | {
      /** check-update 的回复：与 origin 的比较结果 */
      type: "update-check";
      current: string;
      commit: string;
      branch: string;
      /** 落后上游的提交数（>0 即有更新） */
      behind: number;
      /** 本地领先上游的提交数（未推送的本地修改） */
      ahead: number;
      /** 工作区有未提交修改（此时拒绝应用更新） */
      dirty: boolean;
      /** 上游新提交摘要（oneline，最多 10 条） */
      commits: string[];
      updateAvailable: boolean;
      error?: string;
    }
  | { type: "update-applied"; version: string; message: string }
  | { type: "log"; sessionId: string; line: string }
  | { type: "error"; sessionId?: string; message: string };

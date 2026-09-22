import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { AuditLog } from "./audit.ts";
import type { CrewTask } from "./crew.ts";
import {
  parseTaskBreakdown,
  parseReview,
  CREW_APPROVE_SCORE,
  stageAndDiff,
  commitAll,
  isClean,
  mergeBranch,
  headOf,
  currentBranch,
  mergeBaseWith,
  crewBreakdownPrompt,
  crewWorkerPrompt,
  crewReviewPrompt,
  crewFinalPrompt,
} from "./crew.ts";
import { createWorktree, type WorktreeInfo } from "./worktree.ts";
import type { HarnessSession } from "./session.ts";

/**
 * 圆桌会议：让多个 harness 就一个议题轮流发言，并把彼此的发言投喂给对方。
 *
 * 诚实边界：跨 harness 无法共享上下文窗口。这里的"讨论"就是
 * **独立会话之间的消息传递 + 摘录**，每个成员只在自己会话里累积上下文。
 */

export type RoomTurn = {
  round: number;
  sessionId: string;
  harnessId: string;
  harnessLabel: string;
  prompt: string;
  reply: string;
  stopReason: string;
  ts: string;
  /** 主持人发言（开场拆题 / 每轮小结 / 最终汇总），UI 里横跨整行 */
  kind?: "member" | "host" | "review";
  /** 主持人的作用：开场 / 轮间小结 / 收尾 */
  hostRole?: "opening" | "round-summary" | "final";
  /** 工作队模式：这条发言属于哪个任务 */
  crewTaskId?: string;
  /** 锦标赛模式：主持人给这条发言的评分（0-10），随轮间小结产出 */
  score?: number;
  /** 一句话点评（私密投喂给本人，用于下一轮针对性改进） */
  scoreNote?: string;
};

/** 发言模式：并行 = 同轮所有人同时开始（只看前几轮）；串行 = 依次发言，后发言者能看到同轮前面的 */
export type SpeakMode = "parallel" | "sequential";

/** 一个议题（圆桌可以围绕同一批成员连续开多个议题） */
export type RoomTopic = {
  id: string;
  topic: string;
  /** 最多轮数；0 = 无上限（靠收敛判定或手动停止收尾） */
  rounds: number;
  /** 逐轮可切；切换在下一轮开始时生效 */
  mode: SpeakMode;
  /** 共识即停：轮间小结时让主持人判定收敛，第 2 轮起可提前结束 */
  converge?: boolean;
  /** 评分锦标赛：主持人逐轮给成员发言打分，摘录按分数差异化投喂，最终按累计分加权汇总 */
  tournament?: boolean;
  /** 在第几轮判定收敛（提前结束的记录，UI 展示用） */
  convergedRound?: number;
  status: "idle" | "running" | "done" | "error" | "stopped";
  turns: RoomTurn[];
  /** 正在进行的轮次（0 = 主持人开场阶段；未运行时为 undefined）——前端据此把流式写进对应轮次的分栏 */
  currentRound?: number;
  createdAt: string;
  error?: string;
};

export type RoomMember = { sessionId: string; harnessId: string; harnessLabel: string };

/** 工作队的一个 worker：会话跑在自己的 worktree 里，改完由系统提交、评审、合并 */
export type CrewWorker = {
  sessionId: string;
  harnessId: string;
  harnessLabel: string;
  dir: string;     // worktree 目录
  branch: string;  // worktree 分支
  /** worktree 创建时的提交——评审 diff 的基线；老房间没有，用时回退 merge-base */
  base?: string;
};

export type CrewPhase = "working" | "ready-merge" | "merged" | "conflict";

export type CrewState = {
  goal: string;
  maxAttempts: number;               // 每个任务的评审打回上限
  mergeMode: "manual" | "auto";
  phase: CrewPhase;
  tasks: CrewTask[];
  workers: CrewWorker[];
  mergeLines: string[];
  conflicts: Array<{ branch: string; output: string }>;
  /** 分支是否已合并回主目录 */
  integrated: boolean;
};

export type HostConfig = {
  sessionId: string;
  harnessLabel: string;
  /** 开场把议题拆成几个切入角度 */
  opening: boolean;
  /** 每轮结束做小结，并指示下一轮重点发散方向 */
  roundSummary: boolean;
  /** 最后汇总共识/分歧/待决 */
  finalSummary: boolean;
  /** divergent = 头脑风暴（主动指出没人碰的角度）；convergent = 推动收敛出结论 */
  style: "divergent" | "convergent";
};

export type Room = {
  id: string;
  /** 当前议题（= topics 里最后一条，保留顶层字段是为了兼容旧数据与旧客户端） */
  topic: string;
  members: string[];
  memberInfo?: RoomMember[];
  host?: HostConfig;
  cwd?: string;
  rounds: number;
  mode: SpeakMode;
  converge?: boolean;
  tournament?: boolean;
  writeAllowed: boolean;
  status: "idle" | "running" | "done" | "error" | "stopped";
  turns: RoomTurn[];
  topics?: RoomTopic[];
  /** 工作队模式（crew）：多 agent 协同干活——任务板 + worktree 隔离 + 评审 + 合并 */
  crew?: CrewState;
  createdAt: string;
  updatedAt: string;
  error?: string;
};

type RoomHooks = {
  onRoom: (room: Room) => void;
  getSession: (id: string) => HarnessSession | undefined;
  /**
   * 会话不在内存里（已归档/服务重启过）时把它拉起来。
   * 圆桌的成员和主持人可能是上一次跑完就归档的会话，直接查 live 会"不存在"。
   */
  reviveSession?: (id: string) => boolean;
  /** 圆桌自动建会话（主持人是额外成员时需要） */
  createSession?: (harnessId: string, cwd: string) => HarnessSession | undefined;
};

const now = () => new Date().toISOString();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…（已截断）` : s);
/** 轮数归一化：0 = 无上限原样保留；有限值夹在 1..8 */
const normRounds = (n: number | undefined) => (n === 0 ? 0 : Math.min(Math.max(n ?? 1, 1), 8));
/** 收敛判定的最低轮数：第 1 轮各自独立发言、还没见过别人的观点，那时的"共识"是假的 */
const MIN_CONVERGE_ROUNDS = 2;
/** 单次发言的静默上限（Temporal 式心跳看门狗）：agent 还在吐事件就不打断，静默这么久才判死。
 *  不是总时长上限——重任务可以合法地跑很久，只要一直有进展。 */
const TURN_TIMEOUT_MS = Number(process.env.HG_ROOM_TURN_TIMEOUT_MS ?? 300_000);
/** 工作队任务的静默上限（同理，只看无进展时长） */
const CREW_TURN_TIMEOUT_MS = Number(process.env.HG_CREW_TURN_TIMEOUT_MS ?? 1_200_000);

/** 从主持人轮间小结里抠收敛判定：认「收敛判定：已收敛/未收敛」标记行，兼容 JSON 的 converged 字段。
 *  抠不到返回 null（按未收敛处理，宁可多聊一轮也不能瞎停）。 */
export function parseConverged(text: string): boolean | null {
  const m = /收敛判定[:：]?\s*(已收敛|未收敛)/.exec(text);
  if (m) return m[1] === "已收敛";
  const j = /"?converged"?\s*[:：]\s*(true|false)/i.exec(text);
  if (j?.[1]) return j[1].toLowerCase() === "true";
  return null;
}

/** 锦标赛：从主持人小结里抠逐成员评分行，如【评分】ZCode=8（点评）；Hermes=5（点评） */
export function parseRoundScores(text: string): Array<{ member: string; score: number; note: string }> {
  const section = /【评分】([^\n]+)/.exec(text)?.[1] ?? "";
  const out: Array<{ member: string; score: number; note: string }> = [];
  if (!section) return out;
  const re = /([^，,；;=＝]+?)\s*[=＝]\s*(\d{1,2})(?:\s*[（(]([^）)]{0,100})[）)])?/g;
  for (const m of section.matchAll(re)) {
    const member = (m[1] ?? "").trim();
    const score = Number(m[2]);
    if (member.length >= 2 && Number.isFinite(score) && score >= 0 && score <= 10) {
      out.push({ member, score, note: (m[3] ?? "").trim() });
    }
  }
  return out;
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private running = new Set<string>();
  /** 仅用于审计标注（哪个房间触发的复活） */
  private currentRoomId?: string;

  constructor(
    private readonly file: string,
    private readonly audit: AuditLog,
    private readonly hooks: RoomHooks,
  ) {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      try {
        for (const r of JSON.parse(readFileSync(file, "utf8")).rooms ?? []) {
          if (r.status === "running") r.status = "stopped"; // 进程重启后不可能还在跑
          this.rooms.set(r.id, r);
        }
      } catch (err) {
        console.error(`[room] 读取 ${file} 失败:`, err instanceof Error ? err.message : err);
      }
    }
  }

  list(): Room[] {
    return [...this.rooms.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: 1, rooms: this.list() }, null, 1));
      renameSync(tmp, this.file);
    } catch (err) {
      console.error("[room] 写入失败:", err instanceof Error ? err.message : err);
    }
  }

  private emit(room: Room): void {
    room.updatedAt = now();
    this.hooks.onRoom(room);
  }

  create(opts: {
    topic: string;
    members: string[];
    rounds: number;
    mode?: SpeakMode;
    converge?: boolean;
    tournament?: boolean;
    writeAllowed?: boolean;
    cwd?: string;
    memberInfo?: RoomMember[];
    host?: HostConfig;
    crew?: CrewState;
  }): Room {
    const topic: RoomTopic = {
      id: randomUUID().slice(0, 8),
      topic: opts.topic.trim(),
      rounds: normRounds(opts.rounds),
      mode: opts.mode ?? "parallel",
      converge: opts.converge ?? true,
      tournament: Boolean(opts.tournament),
      status: "idle",
      turns: [],
      createdAt: now(),
    };
    const room: Room = {
      id: randomUUID().slice(0, 8),
      topic: topic.topic,
      members: opts.members,
      memberInfo: opts.memberInfo,
      host: opts.host,
      crew: opts.crew,
      cwd: opts.cwd,
      rounds: topic.rounds,
      mode: topic.mode,
      converge: topic.converge,
      tournament: topic.tournament,
      writeAllowed: Boolean(opts.writeAllowed),
      status: "idle",
      turns: [],
      topics: [topic],
      createdAt: now(),
      updatedAt: now(),
    };
    this.rooms.set(room.id, room);
    this.audit.append({
      op: "room.create",
      room: room.id,
      topic: room.topic,
      members: room.members,
      rounds: room.rounds,
      mode: room.mode,
      host: room.host?.harnessLabel,
      crew: Boolean(room.crew),
      cwd: room.cwd,
    });
    this.save();
    this.hooks.onRoom(room);
    return room;
  }

  /** 在已有圆桌上追加一个新议题（同一批成员，继续讨论） */
  addTopic(
    roomId: string,
    opts: { topic: string; rounds: number; mode?: SpeakMode; converge?: boolean; tournament?: boolean; writeAllowed?: boolean },
  ): RoomTopic | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    if (room.status === "running") throw new Error("这个圆桌正在讨论中，先等它结束或点停止");
    if (opts.rounds === 0 && !room.host) {
      throw new Error("轮数无上限需要主持人做收敛判定——先设一个主持人，或改用有限轮数");
    }
    const t: RoomTopic = {
      id: randomUUID().slice(0, 8),
      topic: opts.topic.trim(),
      rounds: normRounds(opts.rounds),
      mode: opts.mode ?? room.mode ?? "parallel",
      converge: opts.converge ?? room.converge ?? true,
      tournament: opts.tournament ?? room.tournament ?? false,
      status: "idle",
      turns: [],
      createdAt: now(),
    };
    room.topics = [...(room.topics ?? []), t];
    room.topic = t.topic;
    room.rounds = t.rounds;
    room.mode = t.mode;
    room.converge = t.converge;
    room.tournament = t.tournament;
    room.writeAllowed = Boolean(opts.writeAllowed);
    room.status = "idle";
    room.error = undefined;
    this.audit.append({ op: "room.topic.add", room: room.id, topic: t.topic, rounds: t.rounds, mode: t.mode, converge: t.converge, tournament: t.tournament });
    this.emit(room);
    this.save();
    return t;
  }

  /** 切换发言模式：不打断正在跑的那一轮，从下一轮开始生效 */
  setMode(roomId: string, mode: SpeakMode): Room | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    const topic = this.currentTopic(room);
    room.mode = mode;
    if (topic) topic.mode = mode;
    this.audit.append({ op: "room.mode", room: roomId, mode, status: room.status });
    this.emit(room);
    this.save();
    return room;
  }

  /** 当前正在讨论（或最后讨论过）的议题 */
  private currentTopic(room: Room): RoomTopic | undefined {
    const list = room.topics ?? [];
    return list[list.length - 1];
  }

  stop(id: string): void {
    const room = this.rooms.get(id);
    if (!room) return;
    room.status = "stopped";
    // 立刻打断在途的发言——否则要等当前轮所有成员自然说完才退场（分钟级），
    // 期间的 room-run 还会被 running 防重入哨兵吞掉，看起来像「停止失灵/继续无反应」
    for (const sid of [...room.members, ...(room.host ? [room.host.sessionId] : [])]) {
      const s = this.hooks.getSession(sid);
      if (s?.info().inTurn) void s.cancelTurn("room-stopped");
    }
    this.audit.append({ op: "room.stop", room: id });
    this.emit(room);
    this.save();
  }

  delete(id: string): void {
    this.stop(id);
    this.rooms.delete(id);
    this.save();
  }

  private memberLabels(room: Room): string {
    return room.members.map((m) => this.hooks.getSession(m)?.harnessLabel ?? m).join("、");
  }

  /** 拼「前几轮发言」摘录；hostNotes 是主持人小结，放在最前面（信息密度更高） */
  private relayHistory(
    room: Room,
    topic: RoomTopic,
    sessionId: string,
    opts: { uptoRound: number; includeHost: boolean; excludeSameRound?: boolean },
  ): string {
    const lines: string[] = [];
    if (opts.includeHost) {
      const notes = topic.turns.filter((t) => t.kind === "host" && t.hostRole === "round-summary" && t.round < opts.uptoRound);
      if (notes.length) {
        lines.push("【主持人此前的小结（主持人观察，可能有偏差，可质疑）】");
        for (const n of notes) {
          lines.push(`— 第 ${n.round} 轮后：${clip(n.reply, 500)}`);
        }
        lines.push("");
      }
    }
    const others = topic.turns.filter(
      (t) =>
        t.kind !== "host" &&
        t.sessionId !== sessionId &&
        t.round < opts.uptoRound + 1 &&
        !(opts.excludeSameRound && t.round === opts.uptoRound),
    );
    if (others.length) {
      lines.push(
        topic.tournament
          ? "【成员发言摘录（锦标赛：分数越高摘录越全）】"
          : "【成员发言摘录（由主持人转录，可能有截断）】",
      );
      for (const t of others) {
        lines.push(`--- ${t.harnessLabel}（第 ${t.round} 轮${t.score != null ? `，${t.score} 分` : ""}）---`);
        // 锦标赛的筛选压力：高分发言完整投喂，低分狠截——分数直接决定被听见多少
        const cap = !topic.tournament
          ? 700
          : t.score == null
            ? 700
            : t.score >= 8
              ? 900
              : t.score >= 5
                ? 500
                : 150;
        lines.push(clip(t.reply || "(无输出)", cap));
        lines.push("");
      }
    }
    return lines.join("\n");
  }

  private buildPrompt(room: Room, topic: RoomTopic, round: number, sessionId: string): string {
    const me = this.hooks.getSession(sessionId);
    const label = me?.harnessLabel ?? sessionId;
    const lines: string[] = [];
    lines.push(`【圆桌会议·议题】${topic.topic}`, "");
    lines.push(`你是圆桌成员「${label}」（共 ${room.members.length} 位成员：${this.memberLabels(room)}）。`);
    if (room.host) lines.push(`本场主持人是「${room.host.harnessLabel}」。`);
    if (room.cwd) lines.push(`共同工作目录：${room.cwd}`);
    lines.push("");

    if (round === 1) {
      lines.push("这是第 1 轮：请独立给出你的判断或方案，直接说结论和关键理由，控制在 400 字以内。");
      // 主持人的开场拆题：给所有人同样的切入角度
      const opening = topic.turns.find((t) => t.hostRole === "opening");
      if (opening) {
        lines.push("", "【主持人给出的切入角度】", clip(opening.reply, 900));
      }
    } else {
      lines.push(`这是第 ${round} 轮。`);
      lines.push("");
      // 锦标赛的私密点评：只投喂本人的分数和批评，避免公开分数引发迎合级联
      if (topic.tournament) {
        const mine = [...topic.turns].reverse().find((t) => t.sessionId === sessionId && t.kind !== "host" && t.score != null);
        if (mine) {
          lines.push(`【主持人对你此前发言的点评】${mine.score}/10${mine.scoreNote ? `：${mine.scoreNote}` : ""}——本轮请针对性改进。`, "");
        }
      }
      lines.push(this.relayHistory(room, topic, sessionId, { uptoRound: round - 1, includeHost: true }));
      lines.push(
        room.host?.style === "divergent"
          ? "请指出你同意和反对的具体点；如果你发现还有没被讨论到的角度，直接提出来。控制在 400 字以内。"
          : "请指出你同意和反对的具体点，并给出你修正后的结论，控制在 400 字以内。",
      );
    }
    lines.push("");
    lines.push(
      room.writeAllowed
        ? "你可以在工作目录里动手验证，但不要执行破坏性命令。"
        : "注意：本轮只做讨论，不要修改任何文件，也不要执行命令。",
    );
    return lines.join("\n");
  }

  /** 主持人：开场拆题 */
  private buildOpeningPrompt(room: Room, topic: RoomTopic): string {
    const style =
      room.host?.style === "divergent"
        ? "你的目标是让讨论充分发散：列出 3-5 个彼此不同的切入角度（包含一个容易被忽略的刁钻角度），并明确说不要急于收敛。"
        : "你的目标是推动讨论收敛：列出 3-5 个必须回答的关键问题，指出哪些点需要形成结论。";
    return [
      `【圆桌会议·主持人开场】议题：${topic.topic}`,
      "",
      `你是本场主持人「${room.host?.harnessLabel}」。成员：${this.memberLabels(room)}。`,
      room.cwd ? `共同工作目录：${room.cwd}` : "",
      "",
      style,
      "只输出角度清单和一句话说明，不要展开论述，控制在 300 字以内。",
      "",
      "注意：你只做主持，本轮不需要给出你自己的方案。",
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** 主持人：本轮小结 + 下一轮方向（askConverged 时顺带做收敛判定；scored 时顺带逐成员打分，不加调用） */
  private buildRoundSummaryPrompt(room: Room, topic: RoomTopic, round: number, askConverged: boolean, scored: boolean): string {
    const thisRound = topic.turns.filter((t) => t.kind !== "host" && t.round === round);
    const style =
      room.host?.style === "divergent"
        ? "重点指出：哪些角度已经充分讨论、哪些角度**还没人碰**（这是最重要的），以及下一轮请重点发散的方向。不要急于下结论。"
        : "重点指出：哪些点已经形成共识、哪些还存在分歧、下一轮必须解决什么。";
    return [
      `【圆桌会议·主持人小结（第 ${round} 轮后）】议题：${topic.topic}`,
      "",
      `你是主持人「${room.host?.harnessLabel}」。以下是本轮各成员的发言：`,
      "",
      ...thisRound.map((t) => [`--- ${t.harnessLabel} ---`, clip(t.reply || "(无输出)", 900), ""].join("\n")),
      style,
      "用「共识 / 分歧 / 还没人碰的角度」三段来写，控制在 350 字以内。你的小结会作为下一轮成员的输入。",
      ...(scored
        ? [
            "",
            `然后单独一行给本轮每位成员的发言打分（0-10：论证质量、切题度、新颖性；简洁与详实同权，不要因篇幅长而加分）。成员名必须原样使用：${thisRound.map((t) => t.harnessLabel).join("、")}`,
            "【评分】成员名=分数（一句话点评）；成员名=分数（一句话点评）。分数决定该发言下一轮被摘录的完整度",
          ]
        : []),
      ...(askConverged
        ? [
            "",
            "最后单独再输出一行收敛判定。判定标准：主要分歧是否都已充分辩论、各方立场和理由是否已经明确——**不是要求大家意见一致**（保留分歧也算收敛，只要它已被充分表达）：",
            "收敛判定：已收敛（一句话理由） 或 收敛判定：未收敛（还差什么）",
          ]
        : []),
    ].join("\n");
  }

  /** 主持人：最终汇总 */
  private buildFinalPrompt(room: Room, topic: RoomTopic): string {
    const all = topic.turns.filter((t) => t.kind !== "host");
    const style =
      room.host?.style === "divergent"
        ? "这是头脑风暴，请**不要**强行统一意见；把有价值的点子和分歧都保留下来。"
        : "请给出明确的结论与建议。";
    const ending = topic.convergedRound
      ? `本场在第 ${topic.convergedRound} 轮由你判定收敛后提前结束。`
      : topic.rounds === 0
        ? "本场未设轮数上限。"
        : `本场达到最大轮数（${topic.rounds} 轮）结束，未必完全收敛——请如实区分已共识与仍待决的部分。`;
    const board = topic.tournament && topic.turns.some((t) => t.score != null)
      ? `\n本场是评分锦标赛，累计得分：${this.leaderboard(room, topic)}。采纳观点时以累计得分为权重参考；最后请单列一段「本场最佳贡献」——点名谁的那一条发言最有价值、为什么。`
      : "";
    return [
      `【圆桌会议·主持人总结】议题：${topic.topic}`,
      "",
      `你是主持人「${room.host?.harnessLabel}」。${ending}全部 ${all.length} 条成员发言如下：`,
      "",
      ...all.map((t) => [`--- ${t.harnessLabel}（第 ${t.round} 轮${t.score != null ? `，${t.score} 分` : ""}）---`, clip(t.reply || "(无输出)", 900), ""].join("\n")),
      style,
      board,
      "请用四段输出：① 共识 ② 主要分歧 ③ 待决问题 ④ 值得跟进的点子清单。控制在 600 字以内。",
    ].join("\n");
  }

  /** 主持人说一句，记为 host turn（返回这条发言，供收敛判定解析） */
  private async hostSpeak(
    room: Room,
    topic: RoomTopic | null,
    role: NonNullable<RoomTurn["hostRole"]>,
    round: number,
    prompt: string,
  ): Promise<RoomTurn | undefined> {
    const hostId = room.host?.sessionId;
    if (!hostId) return undefined;
    const session = await this.waitReady(hostId);
    this.audit.append({ op: "room.host.start", room: room.id, topic: topic?.id, role, round });
    const r = await session.promptAndWait(prompt, TURN_TIMEOUT_MS);
    const turn: RoomTurn = {
      round,
      sessionId: hostId,
      harnessId: session.harnessId,
      harnessLabel: session.harnessLabel,
      prompt,
      reply: r.text,
      stopReason: r.stopReason,
      ts: now(),
      kind: "host",
      hostRole: role,
    };
    if (topic) topic.turns.push(turn);
    room.turns.push(turn);
    this.audit.append({
      op: "room.host.end",
      room: room.id,
      topic: topic?.id,
      role,
      round,
      stopReason: r.stopReason,
      replyChars: r.text.length,
    });
    this.emit(room);
    this.save();
    return turn;
  }

  /** 成员会话可能刚建好还没就绪；等它就绪（圆桌是自动建会话的，不能要求用户先手动恢复） */
  private async waitReady(sessionId: string, timeoutMs = 180_000): Promise<HarnessSession> {
    const deadline = Date.now() + timeoutMs;
    let revived = false;
    for (;;) {
      let s = this.hooks.getSession(sessionId);
      // 不在内存里但落盘还在 → 拉起来（只试一次，避免反复 spawn）
      if (!s && !revived) {
        revived = true;
        if (this.hooks.reviveSession?.(sessionId)) {
          this.audit.append({ op: "room.member.revive", session: sessionId, room: this.currentRoomId });
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
      }
      if (!s) throw new Error(`成员会话 #${sessionId} 不存在（可能已被删除）`);
      const info = s.info();
      if (info.status === "ready" && info.live) return s;
      if (info.status === "error") throw new Error(`成员会话 #${sessionId}（${s.harnessLabel}）起不来：${info.error ?? "未知错误"}`);
      if (info.status === "saved" && !info.live && !info.resumable) {
        throw new Error(`成员会话 #${sessionId}（${s.harnessLabel}）没有在运行，也无法恢复`);
      }
      if (Date.now() > deadline) throw new Error(`成员会话 #${sessionId}（${s.harnessLabel}）等了 ${Math.round(timeoutMs / 1000)}s 还没就绪`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private isStopped(room: Room): boolean {
    return (room.status as Room["status"]) === "stopped";
  }

  /** 锦标赛：把主持人写的名字匹配回成员会话（label 互为包含，主持人常简写），分数写回该轮发言。返回匹配上的数量。 */
  private applyRoundScores(room: Room, topic: RoomTopic, round: number, summaryReply: string): number {
    const parsed = parseRoundScores(summaryReply);
    if (!parsed.length) return 0;
    const infos = room.memberInfo?.length
      ? room.memberInfo
      : room.members.map((m) => {
          const s = this.hooks.getSession(m);
          return { sessionId: m, harnessId: s?.harnessId ?? m, harnessLabel: s?.harnessLabel ?? m };
        });
    const used = new Set<string>();
    let applied = 0;
    for (const p of parsed) {
      const name = p.member.toLowerCase();
      const hit = infos.find(
        (i) =>
          !used.has(i.sessionId) &&
          name.length >= 2 &&
          (i.harnessLabel.toLowerCase().includes(name) ||
            name.includes(i.harnessLabel.toLowerCase()) ||
            i.harnessId.toLowerCase() === name),
      );
      if (!hit) continue;
      used.add(hit.sessionId);
      // memberSpeak 把同一个 turn 对象推进 topic.turns 和 room.turns，改一处两端可见
      const turn = topic.turns.find((t) => t.round === round && t.kind !== "host" && t.sessionId === hit.sessionId);
      if (!turn) continue;
      turn.score = p.score;
      turn.scoreNote = p.note || undefined;
      applied++;
    }
    return applied;
  }

  /** 锦标赛：累计得分榜（按会话汇总所有已评分发言，降序） */
  private leaderboard(room: Room, topic: RoomTopic): string {
    const sums = new Map<string, { label: string; total: number; n: number }>();
    for (const t of topic.turns) {
      if (t.kind === "host" || t.score == null) continue;
      const cur = sums.get(t.sessionId) ?? { label: t.harnessLabel, total: 0, n: 0 };
      cur.total += t.score;
      cur.n += 1;
      sums.set(t.sessionId, cur);
    }
    return [...sums.values()].sort((a, b) => b.total - a.total).map((x) => `${x.label}：${x.total} 分（${x.n} 次）`).join("、");
  }

  /** 一位成员发言一次，落库并广播 */
  private async memberSpeak(room: Room, topic: RoomTopic, round: number, sessionId: string): Promise<void> {
    const session = await this.waitReady(sessionId);
    const prompt = this.buildPrompt(room, topic, round, sessionId);
    this.audit.append({ op: "room.turn.start", room: room.id, topic: topic.id, round, session: sessionId });
    const r = await session.promptAndWait(prompt, TURN_TIMEOUT_MS);
    if (r.stopReason === "timeout") {
      this.audit.append({ op: "room.turn.timeout", room: room.id, topic: topic.id, round, session: sessionId });
    }
    const turn: RoomTurn = {
      round,
      sessionId,
      harnessId: session.harnessId,
      harnessLabel: session.harnessLabel,
      prompt,
      reply: r.text,
      stopReason: r.stopReason,
      ts: now(),
      kind: "member",
    };
    topic.turns.push(turn);
    room.turns.push(turn);
    this.audit.append({
      op: "room.turn.end",
      room: room.id,
      topic: topic.id,
      round,
      session: sessionId,
      stopReason: r.stopReason,
      replyChars: r.text.length,
    });
    this.emit(room);
    this.save();
  }

  /** 主持人循环：逐轮推进；每轮内并行或串行（模式可在界面上逐轮切换） */
  /** 圆桌（讨论）与工作队（协同干活）共用的入口 */
  async run(id: string): Promise<void> {
    const room = this.rooms.get(id);
    if (!room) return;
    if (this.running.has(id)) return;
    this.running.add(id);
    this.currentRoomId = id;
    const topic = this.currentTopic(room);
    try {
      if (room.crew) {
        await this.runCrewFlow(room);
      } else {
        if (!topic) return;
        room.status = "running";
        topic.status = "running";
        room.error = undefined;
        this.emit(room);
        this.save();
        this.audit.append({ op: "room.run", room: id, topic: topic.id, mode: topic.mode, host: room.host?.harnessLabel });
        await this.runDiscussFlow(room, topic);
      }
    } finally {
      if (topic) topic.currentRound = undefined;
      this.running.delete(id);
      this.emit(room);
      this.save();
    }
  }

  /** 讨论流：开场拆题 → 逐轮发言（并行/串行）→ 轮间小结 → 最终汇总 */
  private async runDiscussFlow(room: Room, topic: RoomTopic): Promise<void> {
    const id = room.id;
    {
      room.status = "running";
      topic.status = "running";
      room.error = undefined;
      this.emit(room);
      this.save();
      this.audit.append({ op: "room.run", room: id, topic: topic.id, mode: topic.mode, host: room.host?.harnessLabel });

      try {
        // 断点续跑：重启/中断后「继续运行」——从第一个未完成的轮继续；该轮已有的残缺发言丢弃重说
        let startRound = 1;
        if (topic.turns.some((t) => t.kind === "member")) {
          let lastComplete = 0;
          for (;;) {
            const next = lastComplete + 1;
            const spoke = new Set(
              topic.turns.filter((t) => t.kind === "member" && t.round === next).map((t) => t.sessionId),
            );
            if (spoke.size >= room.members.length) lastComplete = next;
            else break;
          }
          startRound = lastComplete + 1;
          const partial = topic.turns.filter((t) => t.kind === "member" && t.round > lastComplete);
          if (partial.length) {
            this.audit.append({ op: "room.resume.trim", room: id, topic: topic.id, round: startRound, dropped: partial.length });
          }
          topic.turns = topic.turns.filter((t) => !(t.kind === "member" && t.round > lastComplete));
          room.turns = (room.topics ?? []).flatMap((t) => t.turns);   // 同对象重建，避免残留引用
          if (startRound > 1 || topic.turns.length) {
            this.audit.append({ op: "room.resume", room: id, topic: topic.id, fromRound: startRound });
          }
        }

        if (room.host?.opening && !topic.turns.some((t) => t.hostRole === "opening")) {
          topic.currentRound = 0;
          this.emit(room);
          await this.hostSpeak(room, topic, "opening", 0, this.buildOpeningPrompt(room, topic));
        }

        for (let round = startRound, total = topic.rounds; total === 0 || round <= total; round++) {
        if (this.isStopped(room)) throw new Error("已被手动停止");
        const mode = topic.mode ?? "parallel";
        topic.currentRound = round;
        this.emit(room);
        this.audit.append({ op: "room.round.start", room: id, topic: topic.id, round, mode });

        if (mode === "parallel") {
          // 同轮并行：所有人都只看「前几轮」的结果，信息对称
          const results = await Promise.allSettled(
            room.members.map((sid) => this.memberSpeak(room, topic, round, sid)),
          );
          const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
          // 只有全部成员都失败才判定整场失败；个别成员起不来就记为无输出继续
          if (failed.length === room.members.length) {
            const why = failed.map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason))).join("；");
            throw new Error(`本轮全部成员失败：${why}`);
          }
          for (const f of failed) {
            const why = f.reason instanceof Error ? f.reason.message : String(f.reason);
            this.audit.append({ op: "room.turn.failed", room: id, topic: topic.id, round, error: why });
          }
        } else {
          for (const sessionId of room.members) {
            if (this.isStopped(room)) throw new Error("已被手动停止");
            await this.memberSpeak(room, topic, round, sessionId);
          }
        }

        // 轮间小结：写进下一轮成员的 prompt；「共识即停」的收敛判定和锦标赛打分都搭这班车（不加调用）
        const hasNextRound = total === 0 || round < total;
        const askConverged = Boolean(topic.converge && room.host && hasNextRound && round >= MIN_CONVERGE_ROUNDS);
        const scored = Boolean(topic.tournament && room.host && hasNextRound);
        if (room.host && hasNextRound && (room.host.roundSummary || askConverged || scored)) {
          if (this.isStopped(room)) throw new Error("已被手动停止");
          const summary = await this.hostSpeak(
            room,
            topic,
            "round-summary",
            round,
            this.buildRoundSummaryPrompt(room, topic, round, askConverged, scored),
          );
          if (scored && summary) {
            const applied = this.applyRoundScores(room, topic, round, summary.reply);
            this.audit.append({ op: "room.tournament.scores", room: id, topic: topic.id, round, applied });
            if (applied > 0) {
              this.emit(room);   // 分数写回了成员发言上，广播给前端
              this.save();
            }
          }
          if (askConverged) {
            // 解析不出来按未收敛处理：宁可多聊一轮，不能瞎停
            const converged = parseConverged(summary?.reply ?? "");
            this.audit.append({
              op: "room.converge",
              room: id,
              topic: topic.id,
              round,
              converged: converged === true,
              parsed: converged === null ? "unparsed" : "ok",
            });
            if (converged === true) {
              topic.convergedRound = round;
              break; // 提前结束，直接进最终汇总
            }
          }
        }
      }

      if (room.host?.finalSummary) {
        if (this.isStopped(room)) throw new Error("已被手动停止");
        await this.hostSpeak(room, topic, "final", topic.rounds, this.buildFinalPrompt(room, topic));
      }

      room.status = "done";
      topic.status = "done";
      } catch (err) {
        const stopped = this.isStopped(room);
        room.status = stopped ? "stopped" : "error";
        topic.status = stopped ? "stopped" : "error";
        room.error = err instanceof Error ? err.message : String(err);
        topic.error = room.error;
        this.audit.append({ op: "room.error", room: id, error: room.error });
      } finally {
        this.running.delete(id);
        this.emit(room);
        this.save();
      }
    }
  }

  /** 工作队流：拆解 → worktree 并行干活 → 零上下文评审 → 合并 → 收尾报告 */
  private async runCrewFlow(room: Room): Promise<void> {
    const id = room.id;
    const crew = room.crew!;
    const host = room.host;
    if (!host) {
      room.status = "error";
      room.error = "工作队需要主持人（工头）";
      return;
    }
    room.status = "running";
    crew.phase = "working";
    room.error = undefined;
    this.emit(room);
    this.save();
    this.audit.append({ op: "room.run.crew", room: id, goal: crew.goal, workers: crew.workers.length, resumed: crew.tasks.length > 0 });

    try {
      // ① 主持人拆解（断点续跑：已有任务板就跳过，保留进度——重启/中断后「继续运行」走这里）
      if (!crew.tasks.length) {
        const hostSession = await this.waitReady(host.sessionId);
        const breakdownPrompt = crewBreakdownPrompt(
          crew.goal,
          crew.workers.map((w) => `${w.harnessLabel}（worktree: ${w.dir}）`),
          host.harnessLabel,
        );
        await this.hostSpeak(room, null, "opening", 0, breakdownPrompt);
        const lastHost = [...room.turns].reverse().find((t) => t.kind === "host");
        const parsed = parseTaskBreakdown(lastHost?.reply ?? "");
        if (!parsed.length) {
          throw new Error("主持人没有产出可解析的任务拆解（建议换个更强的模型当工头，或重开一次）");
        }
        const ids = new Set(parsed.map((t) => t.id));
        crew.tasks = parsed.map((t) => ({
          ...t,
          deps: t.deps.filter((d) => ids.has(d)),
          status: "pending" as const,
          attempts: 0,
        }));
        this.audit.append({ op: "room.crew.tasks", room: id, count: crew.tasks.length });
      } else {
        // 续跑：被打断的任务退回待办；失败的任务也重置（重试预算重新计）——
        // 否则依赖它的任务永远解锁不了，整个队就死在半路（论文工作队 T1 failed → T3/T4 永远 pending）
        for (const t of crew.tasks) {
          if (t.status === "working") {
            t.status = "pending";
            this.audit.append({ op: "room.crew.resume", room: id, task: t.id });
          } else if (t.status === "failed") {
            t.status = "pending";
            t.attempts = 0;
            t.error = undefined;
            this.audit.append({ op: "room.crew.resume.requeue-failed", room: id, task: t.id });
          }
        }
        this.audit.append({ op: "room.crew.resume.board", room: id, tasks: crew.tasks.length });
      }
      this.emit(room);
      this.save();

      // ② 持续派发（work-conserving）：不按批栅栏等所有人——空闲 worker 立刻领活，
      //    一个任务结束/进入待评审就重新分配；评审串行排队（评审员是会话，不能并发 turn）。
      //    单个 worker 挂死只影响它自己的任务，不再冻结全场。
      const inflight = new Map<string, Promise<void>>();
      const sweepFallen = () => {
        // workerRun 异常退出的任务还挂在 working：退回待办（重试超限标失败）
        for (const t of crew.tasks) {
          if (t.status !== "working" || inflight.has(t.id)) continue;
          t.attempts++;
          if (t.attempts >= crew.maxAttempts + 1) {
            t.status = "failed";
            t.error = "执行失败（重试超限）";
          } else {
            t.status = "pending";
          }
        }
      };
      const guard = crew.tasks.length * (crew.maxAttempts + 2) + crew.tasks.length + 16;
      for (let iter = 0; iter < guard; iter++) {
        if (this.isStopped(room)) throw new Error("已被手动停止");

        // 给空闲 worker 认领任务（deps 全部 done 才解锁）——认领即开跑，不等批
        for (const w of crew.workers) {
          const busy = crew.tasks.some((t) => t.status === "working" && t.assignee === w.sessionId);
          if (busy) continue;
          const next = crew.tasks.find(
            (t) =>
              t.status === "pending" &&
              t.deps.every((d) => crew.tasks.find((x) => x.id === d)?.status === "done"),
          );
          if (!next) continue;
          next.status = "working";
          next.assignee = w.sessionId;
          this.audit.append({ op: "room.crew.assign", room: id, task: next.id, session: w.sessionId });
          const p = this.crewWorkerRun(room, crew, next)
            .catch((err) => {
              this.audit.append({ op: "room.crew.worker-failed", room: id, task: next.id, error: err instanceof Error ? err.message : String(err) });
            })
            .finally(() => inflight.delete(next.id));
          inflight.set(next.id, p);
        }
        sweepFallen();
        this.emit(room);
        this.save();

        const working = [...inflight.keys()];
        const reviewables = crew.tasks.filter((t) => t.status === "review");
        if (!working.length && !reviewables.length) {
          const unsettled = crew.tasks.filter((t) => t.status === "pending" || t.status === "blocked");
          if (unsettled.length) {
            // 没人在干、没有待评审、还有待办 → 依赖死锁（deps 指向失败任务等），终止并说明
            throw new Error(`剩余 ${unsettled.length} 个任务无法解锁（依赖的任务已失败）：${unsettled.map((t) => t.id).join("、")}`);
          }
          break;   // 全部终态
        }

        if (reviewables.length) {
          // 评审串行：一次一个；期间 worker 继续并行干活
          const toReview = reviewables[0];
          if (toReview) await this.crewReview(room, crew, toReview);
          continue;
        }
        if (working.length) {
          await Promise.race([...inflight.values()]);   // 任一 worker 完成 → 回到循环顶部重新分配
        }
      }
      sweepFallen();

      // ③ 合并
      if (crew.mergeMode === "auto") {
        if (!(await isClean(room.cwd ?? "."))) {
          // 主目录不脏不等于失败：任务全做完了，降级为"待人工合并"，别把整场标成 error
          crew.mergeLines = ["主目录有未提交改动，自动合并已跳过——先提交/还原主目录改动，再点「合并到主目录」"];
          crew.phase = "ready-merge";
          this.emit(room);
          this.save();
          await this.hostSpeak(room, null, "final", 0, this.crewFinalPromptOf(room));
          for (const w of crew.workers) {
            const ws2 = this.hooks.getSession(w.sessionId);
            if (ws2 && ws2.info().live) { try { await ws2.stop(); } catch { /* 尽力 */ } }
          }
          room.status = "done";
          this.audit.append({ op: "room.crew.merge.degraded", room: id, reason: "main-dir-dirty" });
          return;
        }
        await this.crewDoMerge(room);
        crew.integrated = crew.conflicts.length === 0;
        crew.phase = crew.conflicts.length ? "conflict" : "merged";
        this.emit(room);
        this.save();
        await this.hostSpeak(room, null, "final", 0, this.crewFinalPromptOf(room));
      } else {
        // 人工确认：先写收尾报告，等用户点「合并」
        await this.hostSpeak(room, null, "final", 0, this.crewFinalPromptOf(room));
        if (crew.tasks.some((t) => t.status === "done")) crew.phase = "ready-merge";
        this.emit(room);
        this.save();
      }
      // 任务全部终态：worker 进程没用了（产物都在 git 分支上），停掉——
      // 会话转「已存档」，用户能明确看到"跑完了"而不是一直"运行中"；继续运行会自动 revive
      for (const w of crew.workers) {
        const s = this.hooks.getSession(w.sessionId);
        if (s && s.info().live) {
          try { await s.stop(); } catch { /* 尽力而为 */ }
        }
      }
      room.status = "done";
    } catch (err) {
      const stopped = this.isStopped(room);
      room.status = stopped ? "stopped" : "error";
      room.error = err instanceof Error ? err.message : String(err);
      this.audit.append({ op: "room.error", room: id, error: room.error });
    } finally {
      this.currentRoomId = undefined;
    }
  }

  /** 一个 worker 干一个任务：干活 → 采集 diff → 提交 → 进评审 */
  private async crewWorkerRun(room: Room, crew: CrewState, task: CrewTask): Promise<void> {
    const worker = crew.workers.find((w) => w.sessionId === task.assignee) ?? crew.workers[0];
    if (!worker) throw new Error(`任务 ${task.id} 没有可用的 worker`);
    const session = await this.waitReady(worker.sessionId);
    // diff 基线：优先 worker 创建时记录的 base；老房间没有 → 用与主仓当前分支的分叉点
    // （agent 自己 commit 过的内容也在其中——空 diff 会让零上下文评审误判"未开工"）
    if (!worker.base) {
      const mb = await currentBranch(room.cwd ?? ".");
      worker.base = (mb ? await mergeBaseWith(worker.dir, mb) : null) ?? (await headOf(worker.dir)) ?? undefined;
    }
    const reviseComments = task.attempts > 0 ? task.review?.comments : undefined;
    const prompt = crewWorkerPrompt({ goal: crew.goal, task, worktreeDir: worker.dir, reviseComments });
    session.intentTag = `${task.id} ${task.title}`;   // 权限决策记录的任务上下文
    this.audit.append({ op: "room.crew.work.start", room: room.id, task: task.id, session: worker.sessionId, attempt: task.attempts, base: worker.base });
    try {
      const r = await session.promptAndWait(prompt, CREW_TURN_TIMEOUT_MS);
      const diff = await stageAndDiff(worker.dir, task.files, worker.base);
      task.diff = diff;
      task.summary = (r.text || "(无文字摘要)").slice(0, 800);
      let sha: string | null = null;
      try {
        sha = await commitAll(worker.dir, `crew(${room.id}): ${task.id} ${task.title}${task.attempts ? ` (rev${task.attempts})` : ""}`);
      } catch (err) {
        this.audit.append({ op: "room.crew.commit-failed", room: room.id, task: task.id, error: err instanceof Error ? err.message : String(err) });
      }
      if (!sha && diff) task.summary += "\n（改动已由 worker 自行提交或在基线 diff 中体现）";
      task.status = "review";
      const turn: RoomTurn = {
        round: 0,
        sessionId: worker.sessionId,
        harnessId: session.harnessId,
        harnessLabel: session.harnessLabel,
        prompt,
        reply: (r.text || "(无输出)") + (sha ? `

（已提交 ${sha}）` : ""),
        stopReason: r.stopReason,
        ts: new Date().toISOString(),
        kind: "member",
        crewTaskId: task.id,
      };
      room.turns.push(turn);
      this.audit.append({ op: "room.crew.work.end", room: room.id, task: task.id, stopReason: r.stopReason, chars: r.text.length });
    } finally {
      session.intentTag = undefined;
    }
    this.emit(room);
    this.save();
  }

  /** 零上下文评审：评审员与实现者不同 harness（异厂商去相关），只看任务书和 diff */
  private async crewReview(room: Room, crew: CrewState, task: CrewTask): Promise<void> {
    const coder = crew.workers.find((w) => w.sessionId === task.assignee);
    const other = crew.workers.find((w) => w.sessionId !== task.assignee && w.harnessId !== coder?.harnessId)
      ?? crew.workers.find((w) => w.sessionId !== task.assignee);
    const reviewerSessionId = other?.sessionId ?? room.host!.sessionId;
    const reviewerSession = await this.waitReady(reviewerSessionId);
    const prompt = crewReviewPrompt({
      goal: crew.goal,
      task,
      reviewerLabel: reviewerSession.harnessLabel,
      coderLabel: coder?.harnessLabel ?? String(task.assignee),
    });
    this.audit.append({ op: "room.crew.review.start", room: room.id, task: task.id, reviewer: reviewerSessionId });
    const CREW_REASK = "你上一条回复没有按要求给出评审结论。请立即只输出一个 JSON 对象（可放在 ```json 围栏里），不要再解释、不要调用工具：{\"verdict\":\"approve\" 或 \"revise\", \"score\":0-10, \"comments\":\"理由\", \"rubric\":[{\"item\":\"验收点\",\"pass\":true|false}]}";
    let r = await reviewerSession.promptAndWait(prompt, CREW_TURN_TIMEOUT_MS);
    let parsed = parseReview(r.text);
    // 有些 harness（实测 zcode）会把评审当任务"开工致辞"然后结束回合——先追讨结论，别急着烧任务重试次数
    let reasks = 0;
    while (!parsed && reasks < 2) {
      reasks++;
      this.audit.append({ op: "room.crew.review.reask", room: room.id, task: task.id, n: reasks });
      r = await reviewerSession.promptAndWait(CREW_REASK, CREW_TURN_TIMEOUT_MS);
      parsed = parseReview(r.text);
    }
    // 连 verdict 都解析不出 → 按打回处理：垃圾评审不能放行改动（宁可重试/失败，不能假通过）
    const v = parsed ?? { verdict: "revise" as const, comments: `（评审输出无法解析，已追问 ${reasks} 次仍无格式化结论，按不通过处理）` };
    let verdict = v.verdict;
    if (verdict === "approve" && v.score != null && v.score < CREW_APPROVE_SCORE) {
      verdict = "revise";
      v.comments = `总分 ${v.score} 未达通过线 ${CREW_APPROVE_SCORE}。${v.comments}`;
    }
    // 逐条判定附进意见：worker 重做时按条对照，UI 上也可展开
    if (parsed?.rubric?.length) {
      v.comments += "\n逐条判定：" + parsed.rubric.map((x) => `\n- ${x.pass ? "✓" : "✗"} ${x.item}${x.note ? `（${x.note}）` : ""}`).join("");
    }
    task.review = {
      reviewer: reviewerSession.harnessLabel,
      verdict,
      comments: v.comments,
      score: parsed?.score,
      rubric: parsed?.rubric,
    };
    if (verdict === "approve") {
      task.status = "done";
    } else {
      task.attempts++;
      if (task.attempts >= crew.maxAttempts + 1) {
        task.status = "failed";
        task.error = `评审打回超限：${v.comments.slice(0, 200)}`;
      } else {
        task.status = "pending";   // 回到待办，下一轮由同一 worker 带着意见重做
      }
    }
    const turn: RoomTurn = {
      round: 0,
      sessionId: reviewerSessionId,
      harnessId: reviewerSession.harnessId,
      harnessLabel: reviewerSession.harnessLabel,
      prompt,
      reply: r.text,
      stopReason: r.stopReason,
      ts: new Date().toISOString(),
      kind: "review",
      crewTaskId: task.id,
    };
    room.turns.push(turn);
    this.audit.append({ op: "room.crew.review.end", room: room.id, task: task.id, verdict, score: parsed?.score });
    this.emit(room);
    this.save();
  }

  /** 合并所有「有完成任务」的 worker 分支回主目录（顺序 merge，冲突 abort 继续） */
  async mergeCrew(id: string): Promise<Room | undefined> {
    const room = this.rooms.get(id);
    if (!room?.crew) return undefined;
    const crew = room.crew;
    if (crew.phase === "working") throw new Error("任务还在进行中");
    if (crew.phase === "merged") return room;
    if (!(await isClean(room.cwd ?? "."))) {
      crew.mergeLines = ["主目录有未提交改动，已暂停合并——请先提交或还原，再点一次合并"];
      crew.phase = "ready-merge";
      this.emit(room);
      this.save();
      return room;
    }
    crew.mergeLines = [];
    crew.conflicts = [];
    await this.crewDoMerge(room);
    crew.integrated = crew.conflicts.length === 0;
    crew.phase = crew.conflicts.length ? "conflict" : "merged";
    this.emit(room);
    this.save();
    return room;
  }

  private async crewDoMerge(room: Room): Promise<void> {
    const crew = room.crew!;
    crew.mergeLines = [];
    crew.conflicts = [];
    for (const w of crew.workers) {
      const done = crew.tasks.filter((t) => t.status === "done" && t.assignee === w.sessionId).length;
      if (!done) continue;
      const r = await mergeBranch(room.cwd ?? ".", w.branch);
      crew.mergeLines.push(`${w.branch}（${done} 个任务，${w.harnessLabel}）: ${r.ok ? "已合并" : r.conflict ? "冲突，已 abort，该分支留待人工处理" : "合并失败"}`);
      if (!r.ok) crew.conflicts.push({ branch: w.branch, output: r.output });
      this.audit.append({ op: "room.crew.merge", room: room.id, branch: w.branch, ok: r.ok, conflict: r.conflict });
    }
  }

  private crewFinalPromptOf(room: Room): string {
    const crew = room.crew!;
    return crewFinalPrompt({
      goal: crew.goal,
      hostLabel: room.host?.harnessLabel ?? "工头",
      tasks: crew.tasks,
      mergeLines: crew.mergeLines.length ? crew.mergeLines : ["（合并尚未执行）"],
    });
  }
}

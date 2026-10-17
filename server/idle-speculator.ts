import type { GoalView } from "./goals.ts";

export type SessionSnapshot = {
  id: string;
  inTurn: boolean;
  status: string;
  isHuman: boolean;
  intentTag?: string;
};

export type SensorWakeContext = {
  sensorIds?: string[];
  sensorKinds?: string[];
  baseDirs?: string[];
};

export type IdleSpeculatorOptions = {
  /** 判定人类进入闲时的静默时长（毫秒），默认 15 分钟 */
  idleThresholdMs?: number;
  /** 两次沙箱深推演之间的最小冷却时长（毫秒），默认 45 分钟 */
  cooldownMs?: number;
  /** 轮询 tick 检查心跳间隔（毫秒），默认 30 秒（仅做极低开销的心跳检测） */
  tickIntervalMs?: number;
  /** 获取当前系统内活跃会话的快照 */
  getSessions: () => SessionSnapshot[];
  /** 获取当前所有目标 */
  getGoals: () => GoalView[];
  /** 触发指定目标的沙箱深度推演 */
  runGoalSpeculation: (goalId: string, reason: string) => Promise<void>;
  /** 触发生活轨迹与待办的自适应重算（按需执行，定向失效） */
  refreshLifeTrajectory: (context?: SensorWakeContext) => Promise<void>;
  log?: (msg: string) => void;
};

export type IdleSpeculatorStatus = {
  /** 最近一次人类真实操作时间戳 */
  lastHumanActiveAt: number;
  /** 人类静默总秒数 */
  idleSeconds: number;
  /** 当前是否达到闲时判定标准 */
  isIdle: boolean;
  /** 最近一次执行深推演的时间戳 */
  lastSpeculatedAt: number | null;
  /** 最近一次生活轨迹微调时间戳 */
  lastLifeRefreshedAt: number | null;
  /** 计划下一次微闲时生活轨迹推演的时间戳（由处方自适应估算，无事件发生前不重复推演） */
  nextLifeSpeculateAt: number | null;
  /** 是否当前正有推演任务在沙箱中运行 */
  isSpeculating: boolean;
};

/**
 * 闲时推演调度器（Idle Speculator）：
 * 
 * 核心原则升级（双轮驱动 + 精准感官隔离）：
 * 1. 【自适应推演寿命（Self-Scheduled TTL）】：
 *    - 废除每 10 分钟死循环轮询！推演结果生成时自带「保质期」与「下次推演时间点（nextLifeSpeculateAt）」。
 *    - 在此时间到达前，系统保持绝对休眠，不产生任何无谓算力开销。
 * 2. 【传感器张力阶跃唤醒（Sensor Tension Trigger）】：
 *    - 接入 Sentinel 伴生神经中枢。当传感器突破张力阈值（onBreach）时，携带具体 sensorIds 与 baseDirs。
 *    - 定向唤醒受影响的任务/目标；无传感器依赖的静态目标与无关待办严格保持休眠。
 * 3. 【人类触角与存量保护】：
 *    - 人类活跃时不派发新推演；正在独立沙箱运行的重度探索绝不暴力掐断。
 */
export class IdleSpeculator {
  private lastHumanActiveAt: number = Date.now();
  private lastSpeculatedAt: number | null = null;
  private lastLifeRefreshedAt: number | null = null;
  private nextLifeSpeculateAt: number | null = null;
  private isSpeculating = false;
  private timer?: NodeJS.Timeout;
  private readonly idleThresholdMs: number;
  private readonly cooldownMs: number;
  private readonly tickIntervalMs: number;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: IdleSpeculatorOptions) {
    this.idleThresholdMs = opts.idleThresholdMs ?? 15 * 60_000;      // 15 分钟
    this.cooldownMs = opts.cooldownMs ?? 45 * 60_000;                // 45 分钟
    this.tickIntervalMs = opts.tickIntervalMs ?? 30_000;             // 30 秒轻量心跳
    this.log = opts.log ?? ((m) => console.log(`[idle-speculator] ${m}`));
  }

  /** 人类产生直接交互时调用（WS 消息、UI 操作等） */
  touchHuman(source = "interaction"): void {
    const prevSilent = Math.round((Date.now() - this.lastHumanActiveAt) / 1000);
    this.lastHumanActiveAt = Date.now();
    if (prevSilent > 60) {
      this.log(`人类恢复活跃（来源: ${source}，此前静默 ${prevSilent}s）`);
    }
  }

  /**
   * 由 Sentinel 传感器张力突破（Tension Breach）主动唤醒
   * 仅对受该传感器波及的任务/目标执行定向重算，无传感器依赖的目标保持原样休眠
   */
  wakeBySensor(reason: string, context?: SensorWakeContext): void {
    const sensorListStr = context?.sensorIds?.length ? context.sensorIds.join(",") : "unknown";
    this.log(`⚡ 传感器张力破线唤醒: ${reason} (sensors: ${sensorListStr})，执行定向增量推演`);
    this.nextLifeSpeculateAt = 0; // 强制检查
    void this.tick(context).catch((err) => {
      this.log(`传感器唤醒推演异常: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** 注册下一次自适应推演的时间戳 */
  scheduleNextLifeSpeculate(timestampMs: number): void {
    this.nextLifeSpeculateAt = timestampMs;
    const waitMin = Math.round((timestampMs - Date.now()) / 60_000);
    this.log(`自适应规划完成：下次生活轨迹推演休眠至 ${new Date(timestampMs).toLocaleTimeString()}（约 ${waitMin} 分钟后）`);
  }

  getStatus(): IdleSpeculatorStatus {
    const now = Date.now();
    const silentMs = Math.max(0, now - this.lastHumanActiveAt);
    const idleSeconds = Math.round(silentMs / 1000);
    return {
      lastHumanActiveAt: this.lastHumanActiveAt,
      idleSeconds,
      isIdle: silentMs >= this.idleThresholdMs,
      lastSpeculatedAt: this.lastSpeculatedAt,
      lastLifeRefreshedAt: this.lastLifeRefreshedAt,
      nextLifeSpeculateAt: this.nextLifeSpeculateAt,
      isSpeculating: this.isSpeculating,
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.log(`轮询异常: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.tickIntervalMs);
    this.timer.unref?.();
    this.log(`双轮驱动调度器启动完成（闲时阈值: ${Math.round(this.idleThresholdMs / 60000)}m, 冷却: ${Math.round(this.cooldownMs / 60000)}m）`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 单次评估与调度 */
  async tick(sensorContext?: SensorWakeContext): Promise<void> {
    const now = Date.now();
    const silentMs = now - this.lastHumanActiveAt;

    // 1. 检查是否达到人类闲时标准（如果是由传感器强破线唤醒，可提前微调，但人类如果在打字则不打扰）
    if (silentMs < this.idleThresholdMs && !sensorContext) {
      return;
    }

    // 2. 检查是否有前台人类会话正在跑回合（人类在等待 AI 回复中）
    const sessions = this.opts.getSessions();
    const humanBusy = sessions.some((s) => s.isHuman && s.inTurn);
    if (humanBusy) {
      return;
    }

    const idleMinutes = Math.round(silentMs / 60_000);

    // 3. 梯次 1：微闲时 —— 生活轨迹自适应推演
    // 严格按需触发：首次启动、或自适应定时器到期、或被传感器张力提前定向唤醒
    const isLifeExpired = this.nextLifeSpeculateAt !== null && now >= this.nextLifeSpeculateAt;
    const isFirstRun = this.lastLifeRefreshedAt === null;

    if (isFirstRun || isLifeExpired || sensorContext) {
      this.lastLifeRefreshedAt = now;
      this.nextLifeSpeculateAt = now + 3 * 3600_000;
      try {
        await this.opts.refreshLifeTrajectory(sensorContext);
      } catch (err) {
        this.log(`微闲时生活轨迹推演告警: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 4. 梯次 2：深闲时 —— 独立沙箱深度试错推演
    if (this.isSpeculating) {
      return;
    }

    const shouldSpeculate =
      Boolean(sensorContext) ||
      this.lastSpeculatedAt === null ||
      now - this.lastSpeculatedAt >= this.cooldownMs;

    if (!shouldSpeculate) {
      return;
    }

    const goals = this.opts.getGoals();
    let eligibleGoals = goals.filter(
      (g) =>
        g.status === "active" &&
        g.speculative?.enabled &&
        Boolean(g.speculative.promptTemplate?.trim()),
    );

    if (eligibleGoals.length === 0) {
      return;
    }

    // 传感器定向唤醒过滤：
    // 只有目标明确声明了对应的传感器 ID，或者其 cwd 属于变动目录，才会被传感器事件提前唤醒；
    // 绝不波及无传感器依赖的目标！
    if (sensorContext && (sensorContext.sensorIds?.length || sensorContext.baseDirs?.length)) {
      eligibleGoals = eligibleGoals.filter((g) => {
        const hasTag = g.tags?.some((t) => sensorContext.sensorIds?.includes(t.replace(/^#/, "")));
        const hasDir = g.cwd && sensorContext.baseDirs?.some((bd) => g.cwd === bd || g.cwd?.startsWith(bd + "/"));
        return Boolean(hasTag || hasDir);
      });
      if (eligibleGoals.length === 0) {
        // 没有目标关联该传感器，无需在沙箱中推演
        return;
      }
    }

    // 公平轮转：挑选最久没有推演过的目标
    eligibleGoals.sort((a, b) => {
      const atA = a.lastSpeculatedAt ? new Date(a.lastSpeculatedAt).getTime() : 0;
      const atB = b.lastSpeculatedAt ? new Date(b.lastSpeculatedAt).getTime() : 0;
      return atA - atB;
    });

    const targetGoal = eligibleGoals[0]!;
    this.log(`检测到闲时静默 ${idleMinutes} 分钟，自主派发深闲时推演: [${targetGoal.title}] (ID: ${targetGoal.id})`);

    this.isSpeculating = true;
    this.lastSpeculatedAt = now;

    try {
      await this.opts.runGoalSpeculation(
        targetGoal.id,
        sensorContext ? `传感器定向破线激发 (${sensorContext.sensorIds?.join(",") || "fs"})` : `人类静默 ${idleMinutes} 分钟，自主深闲时推演`,
      );
    } catch (err) {
      this.log(`深闲时推演异常: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.isSpeculating = false;
    }
  }
}

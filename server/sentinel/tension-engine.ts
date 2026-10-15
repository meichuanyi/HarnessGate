/**
 * [vendored] 复制自独立验证项目 /root/projects/sentinel-hub（Sentinel 伴生感知框架）。
 * 本目录是 HarnessGate 内嵌副本，仅调整了相对导入路径；与上游的功能性差异以 [hg-diff] 标注。
 */
import type { BreachTrigger, Salience, SensoryEvent, TensionBreach, TensionReading } from "./types.ts";
import { DEFAULT_SALIENCE_WEIGHTS } from "./types.ts";

/**
 * 张力引擎（Tension Engine）：Sentinel Hub 的唤醒裁判。
 *
 * 告别 IFTTT 和分钟级轮询：每个感官事件往「张力水池」里注入一份压力，水位按
 * 指数半衰期自然回落（halfLifeMs 内衰减一半）。只有：
 *   1. 累积水位 ≥ threshold（一波相关刺激攒够了），或
 *   2. 来了 salience="siren" 的强显著性事件（火上房了，不等攒够），
 * 才发起一次「突破（breach）」唤起认知层。
 *
 * 突破后按 drain 比例泄洪（默认全放），并有 refractoryMs 不应期——同一波压力
 * 不允许连续触发；不应期内水位仍在涨，则到期后自动复查补发。
 */

export type TensionEngineOptions = {
  /** 突破阈值（默认 10；whisper≈0.6/normal=2/loud=5 的量纲下，约 5 个常规事件攒满） */
  threshold?: number;
  /** 张力半衰期 ms（默认 30s）：多久没人理会，压力就凉一半 */
  halfLifeMs?: number;
  /** 不应期 ms（默认 5s）：两次突破的最小间隔，防抖 */
  refractoryMs?: number;
  /** 突破后泄洪比例 0..1（默认 1 = 全放） */
  drain?: number;
  /** 显著性 → 增量映射覆盖 */
  weights?: Partial<Record<Salience, number>>;
  /** 突破凭证最多携带多少个来源事件（默认 64，多丢留新） */
  keepEvents?: number;
};

type Spike = { ts: number; w: number; evt: SensoryEvent };

/** 超过 12 个半衰期的压力视为彻底冷却，物理删除防数组膨胀 */
const HALF_LIVES_FORGET = 12;

export class TensionEngine {
  private readonly threshold: number;
  private readonly halfLifeMs: number;
  private readonly refractoryMs: number;
  private readonly drain: number;
  private readonly weights: Record<Salience, number>;
  private readonly keepEvents: number;
  private spikes: Spike[] = [];
  /** -∞ = 从未突破过（epoch ms 减 0 会永远落在「不应期」里，首次突破就永远触发不了） */
  private lastBurstAt = Number.NEGATIVE_INFINITY;
  private recheckTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    opts: TensionEngineOptions = {},
    private readonly onBreach: (breach: TensionBreach) => void,
  ) {
    this.threshold = Math.max(0.001, opts.threshold ?? 10);
    this.halfLifeMs = Math.max(20, opts.halfLifeMs ?? 30_000);
    this.refractoryMs = Math.max(0, opts.refractoryMs ?? 5_000);
    this.drain = Math.min(1, Math.max(0, opts.drain ?? 1));
    this.weights = { ...DEFAULT_SALIENCE_WEIGHTS, ...(opts.weights ?? {}) };
    this.keepEvents = Math.max(1, opts.keepEvents ?? 64);
  }

  /** 当前张力水位（对过去压力按半衰期指数衰减求和） */
  level(at = Date.now()): number {
    this.prune(at);
    let sum = 0;
    for (const s of this.spikes) sum += s.w * Math.pow(2, -(at - s.ts) / this.halfLifeMs);
    return sum;
  }

  private prune(at: number): void {
    const horizon = HALF_LIVES_FORGET * this.halfLifeMs;
    if (this.spikes.length && at - this.spikes[0]!.ts > horizon) {
      this.spikes = this.spikes.filter((s) => at - s.ts <= horizon);
    }
  }

  /**
   * 喂一个感官事件。siren 特判：不走数值路径，直接突破（阈值与不应期都拦不住着火）。
   * 返回本次读数（是否突破）；突破回调同步触发。
   */
  ingest(evt: SensoryEvent): TensionReading {
    if (this.stopped) return { level: 0, threshold: this.threshold, breached: false };
    const now = evt.ts || Date.now();

    if (evt.salience === "siren") {
      this.spikes.push({ ts: now, w: this.threshold, evt });
      this.fire(now, "siren");
      return { level: this.level(now), threshold: this.threshold, breached: true };
    }

    const w = evt.weight ?? this.weights[evt.salience] ?? this.weights.normal;
    this.spikes.push({ ts: now, w, evt });
    const level = this.level(now);

    if (level < this.threshold) {
      return { level, threshold: this.threshold, breached: false };
    }
    if (now - this.lastBurstAt < this.refractoryMs) {
      // 不应期内只记账不触发；水位还在线上，到期后由复查定时器补发
      this.armRecheck();
      return { level, threshold: this.threshold, breached: false };
    }
    this.fire(now, "threshold");
    return { level: this.level(now), threshold: this.threshold, breached: true };
  }

  /** 发起一次突破：回调 → 泄洪 */
  private fire(at: number, trigger: BreachTrigger): TensionBreach {
    this.lastBurstAt = at;
    const breach: TensionBreach = {
      at,
      level: Math.max(this.level(at), this.threshold),
      threshold: this.threshold,
      trigger,
      events: this.spikes.slice(-this.keepEvents).map((s) => s.evt),
    };
    if (this.drain >= 1) this.spikes = [];
    else this.spikes = this.spikes.map((s) => ({ ...s, w: s.w * (1 - this.drain) }));
    this.onBreach(breach);
    return breach;
  }

  /** 不应期结束后如果水位仍在阈值上（且过了不应期），补发一次突破 */
  private armRecheck(): void {
    if (this.recheckTimer || this.stopped) return;
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = undefined;
      if (this.stopped) return;
      const now = Date.now();
      if (this.level(now) >= this.threshold && now - this.lastBurstAt >= this.refractoryMs) {
        this.fire(now, "threshold");
      }
    }, this.refractoryMs);
    this.recheckTimer.unref?.();
  }

  snapshot(): { level: number; threshold: number; spikes: number; lastBurstAt?: number } {
    return {
      level: this.level(),
      threshold: this.threshold,
      spikes: this.spikes.length,
      lastBurstAt: Number.isFinite(this.lastBurstAt) ? this.lastBurstAt : undefined,
    };
  }

  reset(): void {
    this.spikes = [];
    this.lastBurstAt = Number.NEGATIVE_INFINITY;
  }

  stop(): void {
    this.stopped = true;
    if (this.recheckTimer) {
      clearTimeout(this.recheckTimer);
      this.recheckTimer = undefined;
    }
  }
}

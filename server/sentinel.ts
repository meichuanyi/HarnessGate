import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

import type { AuditLog } from "./audit.ts";
import type { Goal } from "./goals.ts";
import { DualSystem, wakePlanner, type Planner } from "./sentinel/dual-system.ts";
import { FsSensor } from "./sentinel/fs-sensor.ts";
import { SessionSensor } from "./sentinel/session-sensor.ts";
import { SiyuanPlanHubAdapter, toHarnessGateGoal } from "./sentinel/siyuan-adapter.ts";
import { TemporalSensor } from "./sentinel/temporal-sensor.ts";
import { makeEvent, type CognitionAction, type Dispatcher, type Salience, type Sensor, type SensoryEvent } from "./sentinel/types.ts";
import type { SentinelPulseView, SentinelSensorView, SentinelStatus } from "./types.ts";
import type { ServerMsg } from "./types.ts";

/**
 * Sentinel 服务：把伴生神经中枢（vendored 于 /root/projects/sentinel-hub）挂进 HarnessGate。
 *
 * 职责：
 * 1. 传感器注册表（fs/temporal/siyuan/session 四类）——用户可经 WS 增删改启停，
 *    配置持久化在 DATA_DIR/sentinel.json，重启自动恢复；首次启动播种「时间心跳」
 *    与「工兵完工监听」两个默认感官；
 * 2. 快慢双系统运行时：System 1 降噪聚类 → 张力引擎（半衰期衰减/阈值/泄洪）→
 *    System 2 规划分派——思源差异经 goal-save 直接写进目标看板（进程内，不走 WS）；
 * 3. 面向前端的快照与脉冲流：sentinel-status（全量）/ sentinel-pulse（逐事件）。
 *
 * 生命周期：index.ts 启动时 new + init()；makeHooks.onTurnEnd 喂工兵完工事件；
 * hub.ingest 等价物是 spark()（手动发射脉冲）。
 */

/** 传感器配置（持久化；UI 可增删改） */
export type SentinelSensorConfig = {
  id: string;
  label: string;
  kind: "fs" | "temporal" | "siyuan" | "session";
  enabled: boolean;
  /** 该感官事件的显著性等级（用户申报的信号强度；siren 保留给 spark 特权） */
  salience: Salience;
  /** fs：监听目录列表（递归） */
  dirs?: string[];
  /** temporal：脉冲间隔 ms */
  intervalMs?: number;
  /** siyuan：plans.json 绝对路径 */
  plansPath?: string;
  createdAt: string;
  updatedAt: string;
};

type SentinelFile = {
  version: 1;
  sensors: SentinelSensorConfig[];
  threshold?: number;
  halfLifeMs?: number;
};

const PULSE_BUFFER_MAX = 60;
const ACTION_BUFFER_MAX = 6;
/** 张力持续衰减，前端需要周期性快照刷新能量槽 */
const STATUS_BROADCAST_MS = 15_000;

const KIND_LABEL: Record<SentinelSensorConfig["kind"], string> = {
  fs: "目录监听",
  temporal: "时间心跳",
  siyuan: "目标罗盘",
  session: "工兵完工",
};

function defaultConfigs(): SentinelSensorConfig[] {
  const now = new Date().toISOString();
  return [
    { id: "sen-heartbeat", label: "时间心跳", kind: "temporal", enabled: true, salience: "whisper", intervalMs: 60_000, createdAt: now, updatedAt: now },
    { id: "sen-session", label: "工兵完工监听", kind: "session", enabled: true, salience: "normal", createdAt: now, updatedAt: now },
  ];
}

export class SentinelService {
  private dual!: DualSystem;
  private configs: SentinelSensorConfig[] = [];
  private thresholdCfg?: number;
  private halfLifeCfg?: number;
  /** cfg.id → 运行中的感官实例（session 类共享单例，见 buildSensor） */
  private instances = new Map<string, Sensor>();
  private siyuanAdapters = new Map<string, SiyuanPlanHubAdapter>();
  private readonly sessionSensor = new SessionSensor();
  private readonly runtime = new Map<string, { lastFiredAt: number; events: number }>();
  private readonly pulses: SentinelPulseView[] = [];
  private readonly actions: Array<{ ts: number; kind: string; reason: string }> = [];
  private stats = { ingested: 0, noise: 0, breaches: 0, actions: 0 };
  private statusTimer?: NodeJS.Timeout;
  private stopped = false;

  /** index.ts 注入：全客户端广播 / 思源目标同步出口 */
  broadcast?: (msg: ServerMsg) => void;
  onGoalSave?: (goal: Partial<Goal>) => void;

  constructor(
    private readonly opts: {
      dataDir: string;
      audit: AuditLog;
      log?: (line: string) => void;
    },
  ) {}

  private get file(): string {
    return join(this.opts.dataDir, "sentinel.json");
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }

  /* ---------------- 生命周期 ---------------- */

  init(): void {
    this.configs = this.loadConfigs();
    this.rebuild();
    this.statusTimer = setInterval(() => this.pushStatus(), STATUS_BROADCAST_MS);
    this.statusTimer.unref?.();
    const on = this.configs.filter((c) => c.enabled).length;
    this.log(`[sentinel] 🛰 神经中枢已挂载：${on}/${this.configs.length} 个感官在线，张力阈值 ${this.dual.engine.snapshot().threshold}`);
  }

  stop(): void {
    this.stopped = true;
    if (this.statusTimer) clearInterval(this.statusTimer);
    for (const s of this.instances.values()) {
      try {
        s.stop();
      } catch {
        /* 尽力而为 */
      }
    }
    this.instances.clear();
    this.siyuanAdapters.clear();
  }

  /* ---------------- 配置持久化 ---------------- */

  private loadConfigs(): SentinelSensorConfig[] {
    if (!existsSync(this.file)) return defaultConfigs();
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as SentinelFile;
      this.thresholdCfg = raw.threshold;
      this.halfLifeCfg = raw.halfLifeMs;
      const out: SentinelSensorConfig[] = [];
      for (const c of raw.sensors ?? []) {
        if (!c || typeof c.id !== "string" || typeof c.label !== "string") continue;
        if (!["fs", "temporal", "siyuan", "session"].includes(c.kind)) continue;
        out.push(c);
      }
      return out;
    } catch {
      return defaultConfigs();
    }
  }

  private saveConfigs(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, sensors: this.configs, threshold: this.thresholdCfg, halfLifeMs: this.halfLifeCfg } satisfies SentinelFile, null, 2));
    renameSync(tmp, this.file);
  }

  /* ---------------- 双系统组装 ---------------- */

  /** 配置变化即整体重建：张力清零重新累积（可预期，避免跨代账本） */
  private rebuild(): void {
    for (const s of this.instances.values()) {
      try {
        s.stop();
      } catch {
        /* 尽力而为 */
      }
    }
    this.instances.clear();
    this.siyuanAdapters.clear();

    this.dual = new DualSystem({
      tension: {
        threshold: (this.thresholdCfg ?? Number(process.env.SENTINEL_THRESHOLD)) || 10,
        halfLifeMs: this.halfLifeCfg ?? 30_000,
      },
      reflex: { quietMs: 250, log: (l) => this.log(l) },
      planners: [this.siyuanSyncPlanner],
      dispatchers: this.dispatchers(),
      log: (l) => this.log(l),
    });
    this.dual.onReflex = (evt, verdict) => {
      if (verdict === "noise") {
        this.stats.noise++;
        this.recordPulse(evt, "noise");
      }
    };
    this.dual.onBreach = () => {
      this.stats.breaches++;
      this.opts.audit.append({ op: "sentinel.breach", level: Number(this.dual.engine.level().toFixed(2)) });
    };

    for (const cfg of this.configs) {
      if (!cfg.enabled) continue;
      const sensor = this.buildSensor(cfg);
      if (!sensor) {
        this.log(`[sentinel] 感官 ${cfg.label}（${cfg.kind}）缺参数，跳过`);
        continue;
      }
      sensor.onEvent = (evt) => this.accept(cfg, evt);
      sensor.start();
      this.instances.set(cfg.id, sensor);
    }
  }

  private buildSensor(cfg: SentinelSensorConfig): Sensor | null {
    if (cfg.kind === "session") return this.sessionSensor;   // 进程内单例：宿主 onTurnEnd 直喂
    if (cfg.kind === "fs") return new FsSensor({ paths: cfg.dirs ?? [], log: (l) => this.log(l) });
    if (cfg.kind === "temporal") return new TemporalSensor({ intervalMs: cfg.intervalMs ?? 60_000, pulseSalience: cfg.salience });
    if (cfg.kind === "siyuan") {
      if (!cfg.plansPath) return null;
      const adapter = new SiyuanPlanHubAdapter({ plansPath: cfg.plansPath, log: (l) => this.log(l) });
      this.siyuanAdapters.set(cfg.id, adapter);
      return adapter;
    }
    return null;
  }

  /** 思源罗盘规划器：张力破线时把攒下的目标差分翻译成 goal-save（进程内直写目标看板） */
  private readonly siyuanSyncPlanner: Planner = (breach) => {
    const actions: CognitionAction[] = [];
    for (const adapter of this.siyuanAdapters.values()) {
      for (const d of adapter.takeDiffs()) {
        if (d.kind === "removed" || !d.after) continue;
        actions.push({
          kind: "harnessgate.goal-save",
          ts: breach.at,
          reason: `同步思源目标 ${d.id}（${d.kind}：${d.fields.join("/")}）→ HarnessGate goals`,
          payload: { goal: toHarnessGateGoal(d.after) },
        });
      }
    }
    return actions;
  };

  /** System 2 动作出口：审计留痕 + 思源同步直写 + 动作面板 + 广播快照 */
  private dispatchers(): Dispatcher[] {
    return [
      {
        dispatch: (action) => {
          this.stats.actions++;
          this.actions.unshift({ ts: action.ts, kind: action.kind, reason: action.reason });
          if (this.actions.length > ACTION_BUFFER_MAX) this.actions.length = ACTION_BUFFER_MAX;
          this.opts.audit.append({ op: "sentinel.action", kind: action.kind, reason: action.reason.slice(0, 300) });
          this.log(`[sentinel] ⚡ ${action.kind}: ${action.reason}`);
        },
      },
      {
        dispatch: (action) => {
          if (action.kind !== "harnessgate.goal-save") return;
          const goal = action.payload?.goal as Partial<Goal> | undefined;
          if (!goal) return;
          try {
            this.onGoalSave?.(goal);
          } catch (err) {
            this.log(`[sentinel] goal-sync 失败: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      },
      {
        dispatch: () => this.pushStatus(),   // 认知动作落地后立刻刷新前端
      },
    ];
  }

  /* ---------------- 事件入口 ---------------- */

  /** 感官事件统一入口：显著性按配置改写 → System 1 → 张力 → 脉冲广播 */
  private accept(cfg: SentinelSensorConfig | undefined, evt0: SensoryEvent): void {
    if (this.stopped) return;
    if (cfg && !cfg.enabled) return;
    // 用户为该感官申报的显著性优先（siren 是 spark 特权，不被配置降级/冒领）
    const evt = cfg && cfg.salience && evt0.salience !== "siren" ? { ...evt0, salience: cfg.salience } : evt0;
    this.stats.ingested++;
    this.dual.ingest(evt);
    this.recordPulse(evt, "queued");
    if (cfg) {
      const rt = this.runtime.get(cfg.id) ?? { lastFiredAt: 0, events: 0 };
      rt.lastFiredAt = evt.ts;
      rt.events++;
      this.runtime.set(cfg.id, rt);
    }
  }

  /** makeHooks.onTurnEnd 转接：工兵完工事件（session 感官未启用则零开销跳过） */
  sessionTurnEnd(sessionId: string, harnessLabel: string | undefined, stopReason: string): void {
    const cfg = this.configs.find((c) => c.kind === "session" && c.enabled);
    if (!cfg) return;
    this.sessionSensor.emitTurnEnd({ sessionId, harnessLabel, stopReason });
    // emitTurnEnd → onEvent → accept(cfg, evt)，运行时计数在同一条路上
  }

  /** ⚡ 手动发射脉冲（sentinel-spark）：绕过感官直接注一张 normal 牌进张力水池 */
  spark(summary?: string, weight?: number): void {
    const evt = makeEvent({
      modality: "webhook",
      kind: "webhook.spark",
      subject: "manual",
      summary: summary?.trim() || "⚡ 手动激发脉冲",
      salience: "normal",
      weight: typeof weight === "number" && weight > 0 ? Math.min(weight, 50) : undefined,
    });
    this.log(`[sentinel] 手动脉冲: ${evt.summary}`);
    this.accept(undefined, evt);
    this.pushStatus();
  }

  private recordPulse(evt: SensoryEvent, verdict: "noise" | "queued"): void {
    const view: SentinelPulseView = {
      id: evt.id,
      ts: evt.ts,
      modality: evt.modality,
      kind: evt.kind,
      subject: evt.subject,
      summary: evt.summary.slice(0, 200),
      salience: evt.salience,
      verdict,
      tension: Math.round(this.dual.engine.level() * 10) / 10,
    };
    this.pulses.unshift(view);
    if (this.pulses.length > PULSE_BUFFER_MAX) this.pulses.length = PULSE_BUFFER_MAX;
    this.broadcast?.({ type: "sentinel-pulse", pulse: view });
  }

  /* ---------------- WS 配置操作 ---------------- */

  toggle(id: string, enabled: boolean): void {
    const cfg = this.configs.find((c) => c.id === id);
    if (!cfg) throw new Error(`找不到感官: ${id}`);
    cfg.enabled = Boolean(enabled);
    cfg.updatedAt = new Date().toISOString();
    this.opts.audit.append({ op: "sentinel.sensor.toggle", id, enabled: cfg.enabled, label: cfg.label });
    this.saveConfigs();
    this.rebuild();
    this.pushStatus();
  }

  saveSensor(partial: Partial<SentinelSensorConfig>): SentinelSensorConfig {
    const now = new Date().toISOString();
    const kind = partial.kind;
    let cfg: SentinelSensorConfig;
    if (partial.id) {
      const found = this.configs.find((c) => c.id === partial.id);
      if (!found) throw new Error(`找不到感官: ${partial.id}`);
      cfg = found;
    } else {
      if (kind !== "fs" && kind !== "temporal" && kind !== "siyuan" && kind !== "session") {
        throw new Error("新感官必须指定类型（fs/temporal/siyuan/session）");
      }
      if (kind === "session" && this.configs.some((c) => c.kind === "session")) {
        throw new Error("会话感官是进程内单例，最多一个");
      }
      cfg = {
        id: `sen-${randomUUID().slice(0, 8)}`,
        label: (partial.label || "未命名感官").slice(0, 40),
        kind,
        enabled: partial.enabled !== false,
        salience: partial.salience ?? "normal",
        createdAt: now,
        updatedAt: now,
      };
      this.configs.push(cfg);
    }
    if (partial.label !== undefined) cfg.label = String(partial.label).slice(0, 40) || cfg.label;
    if (partial.enabled !== undefined) cfg.enabled = Boolean(partial.enabled);
    if (partial.salience !== undefined) cfg.salience = partial.salience;
    if (partial.dirs !== undefined) {
      const dirs = (Array.isArray(partial.dirs) ? partial.dirs : String(partial.dirs).split(",")).map((d) => String(d).trim()).filter(Boolean);
      if (cfg.kind === "fs" && !dirs.length) throw new Error("目录监听至少要给一个目录");
      cfg.dirs = dirs;
    }
    if (partial.intervalMs !== undefined) cfg.intervalMs = Math.max(1000, Number(partial.intervalMs) || 60_000);
    if (partial.plansPath !== undefined) {
      if (cfg.kind === "siyuan" && !String(partial.plansPath).trim()) throw new Error("目标罗盘需要 plans.json 路径");
      cfg.plansPath = String(partial.plansPath).trim() || undefined;
    }
    cfg.updatedAt = now;
    this.opts.audit.append({ op: "sentinel.sensor.save", id: cfg.id, label: cfg.label, kind: cfg.kind, enabled: cfg.enabled });
    this.saveConfigs();
    this.rebuild();
    this.pushStatus();
    return cfg;
  }

  deleteSensor(id: string): void {
    const before = this.configs.length;
    this.configs = this.configs.filter((c) => c.id !== id);
    if (this.configs.length === before) throw new Error(`找不到感官: ${id}`);
    this.opts.audit.append({ op: "sentinel.sensor.delete", id });
    this.saveConfigs();
    this.rebuild();
    this.pushStatus();
  }

  /* ---------------- 快照与广播 ---------------- */

  status(): SentinelStatus {
    const snap = this.dual.engine.snapshot();
    const sensors: SentinelSensorView[] = this.configs.map((c) => {
      const rt = this.runtime.get(c.id);
      return {
        id: c.id,
        label: c.label,
        kind: c.kind,
        kindLabel: KIND_LABEL[c.kind],
        enabled: c.enabled,
        salience: c.salience,
        dirs: c.dirs,
        intervalMs: c.intervalMs,
        plansPath: c.plansPath,
        lastFiredAt: rt?.lastFiredAt || undefined,
        events: rt?.events ?? 0,
      };
    });
    return {
      tension: {
        level: Math.round(snap.level * 100) / 100,
        threshold: snap.threshold,
        halfLifeMs: this.halfLifeCfg ?? 30_000,
        lastBurstAt: snap.lastBurstAt,
      },
      clusters: this.dual.pendingClusters,
      sensors,
      stats: { ...this.stats },
      pulses: [...this.pulses],
      actions: [...this.actions],
    };
  }

  pushStatus(): void {
    this.broadcast?.({ type: "sentinel-status", sentinel: this.status() });
  }
}

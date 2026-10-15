/**
 * [vendored] 复制自独立验证项目 /root/projects/sentinel-hub（Sentinel 伴生感知框架）。
 * 本目录是 HarnessGate 内嵌副本，仅调整了相对导入路径；与上游的功能性差异以 [hg-diff] 标注。
 */
import { WebSocket } from "ws";

import type {
  CognitionAction,
  Dispatcher,
  IntentCluster,
  SensoryEvent,
  TensionBreach,
} from "./types.ts";
import { TensionEngine, type TensionEngineOptions } from "./tension-engine.ts";

/**
 * 快慢双系统（Dual System）：脑干负责反射，皮层负责行动。
 *
 * System 1（快反射，ReflexLayer）：纯本地轻量规则——噪音过滤、同源事件防抖合并、
 *   意图聚类。它决定「什么值得进入张力水池」，也把碎片信号攒成有语义的意图簇，
 *   让 System 2 看到的是「编辑器在 src/ 里连续改了 4 个文件」而不是 4 次裸变动；
 *
 * System 2（慢行动，DualSystem.cognition）：只在张力突破（或警笛）时被唤起——
 *   冲刷全部意图簇 → 逐个 planner 把「突破+意图」翻译成动作 → 分派给各出口
 *   （控制台 / HarnessGate WS 桥 / 业务自定义）。没人唤醒就一分算力都不花。
 */

/* =====================================================================
   System 1：快反射层
   ===================================================================== */

export type ReflexVerdict = "noise" | "queued";

export type ReflexOptions = {
  /** 静默窗口 ms（默认 250）：同键事件在窗口内持续合并，窗口安静后才整体上交 */
  quietMs?: number;
  /** 聚类最长持有 ms（默认 4000）：持续嘈杂的源不允许无限攒着 */
  clusterTtlMs?: number;
  /** 噪音过滤器：命中 kind/subject/summary 的事件直接丢弃（siren 永不丢弃） */
  noise?: RegExp[];
  /** 聚类键（默认：模态 + 主语桶——fs 路径按目录归桶，其余按 subject） */
  keyOf?: (evt: SensoryEvent) => string;
  /** 单簇容量上限（默认 32）：满了立即冲刷 */
  maxPerCluster?: number;
  log?: (line: string) => void;
};

function defaultKeyOf(evt: SensoryEvent): string {
  const subject = evt.subject ?? "";
  if (evt.modality === "fs" && subject) {
    const cut = subject.lastIndexOf("/");
    return `fs:${cut > 0 ? subject.slice(0, cut) : "/"}`;
  }
  return `${evt.modality}:${subject || evt.kind}`;
}

export class ReflexLayer {
  private readonly clusters = new Map<string, IntentCluster>();
  private readonly quietTimers = new Map<string, NodeJS.Timeout>();
  private readonly ttlTimers = new Map<string, NodeJS.Timeout>();
  private readonly maxPerCluster: number;

  constructor(
    private readonly opts: ReflexOptions = {},
    private readonly onFlush: (cluster: IntentCluster) => void = () => {},
  ) {
    this.maxPerCluster = Math.max(2, opts.maxPerCluster ?? 32);
  }

  private isNoise(evt: SensoryEvent): boolean {
    const hay = `${evt.kind} ${evt.subject ?? ""} ${evt.summary}`;
    return (this.opts.noise ?? []).some((re) => re.test(hay));
  }

  /** 判定：noise = 丢弃（不进张力水池）；queued = 合入意图簇（进张力水池） */
  observe(evt: SensoryEvent): ReflexVerdict {
    // siren 是着火级别的事件，任何降噪规则都无权吃掉它
    if (evt.salience !== "siren" && this.isNoise(evt)) {
      this.opts.log?.(`[reflex] 噪音丢弃: ${evt.summary}`);
      return "noise";
    }
    const key = this.opts.keyOf?.(evt) ?? defaultKeyOf(evt);
    const now = evt.ts || Date.now();
    const existing = this.clusters.get(key);
    if (existing) {
      existing.events.push(evt);
      existing.lastTs = now;
      existing.summary = `${existing.events[0]!.summary} 等 ${existing.events.length} 个同源信号`;
      if (existing.events.length >= this.maxPerCluster) {
        this.flush(key);
        return "queued";
      }
    } else {
      this.clusters.set(key, { key, events: [evt], firstTs: now, lastTs: now, summary: evt.summary });
      const ttl = setTimeout(() => this.flush(key), this.opts.clusterTtlMs ?? 4_000);
      ttl.unref?.();
      this.ttlTimers.set(key, ttl);
    }
    this.armQuiet(key);
    return "queued";
  }

  /** 静默窗口：窗口内持续来事件就一直续期，安静了才把整簇交给认知层 */
  private armQuiet(key: string): void {
    const prev = this.quietTimers.get(key);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => this.flush(key), this.opts.quietMs ?? 250);
    t.unref?.();
    this.quietTimers.set(key, t);
  }

  private flush(key: string): void {
    const cluster = this.clusters.get(key);
    if (!cluster) return;
    this.clusters.delete(key);
    const q = this.quietTimers.get(key);
    if (q) clearTimeout(q);
    this.quietTimers.delete(key);
    const ttl = this.ttlTimers.get(key);
    if (ttl) clearTimeout(ttl);
    this.ttlTimers.delete(key);
    this.onFlush(cluster);
  }

  /** 认知层唤醒时用：把所有持中的意图簇一次性上交（返回快照，原地清空） */
  flushAll(): IntentCluster[] {
    const all = [...this.clusters.values()];
    this.clusters.clear();
    for (const t of this.quietTimers.values()) clearTimeout(t);
    for (const t of this.ttlTimers.values()) clearTimeout(t);
    this.quietTimers.clear();
    this.ttlTimers.clear();
    return all;
  }

  get pendingCount(): number {
    return this.clusters.size;
  }

  stop(): void {
    for (const t of this.quietTimers.values()) clearTimeout(t);
    for (const t of this.ttlTimers.values()) clearTimeout(t);
    this.quietTimers.clear();
    this.ttlTimers.clear();
    this.clusters.clear();
  }
}

/* =====================================================================
   System 2：慢行动层
   ===================================================================== */

/** 规划器：把「张力突破 + 意图簇」翻译成认知动作。抛错只记日志，不炸主管线 */
export type Planner = (
  breach: TensionBreach,
  clusters: IntentCluster[],
) => CognitionAction[] | Promise<CognitionAction[]>;

/** 兜底规划器：没有业务 planner 接手时，至少产出一条「唤醒」动作留痕 */
export function wakePlanner(breach: TensionBreach, clusters: IntentCluster[]): CognitionAction[] {
  return [
    {
      kind: "cognition.wake",
      ts: breach.at,
      reason:
        (breach.trigger === "siren" ? "🚨 强信号唤起" : "张力累积破线") +
        ` level=${breach.level.toFixed(1)}：` +
        (clusters.map((c) => c.summary).join("；") || breach.events[breach.events.length - 1]?.summary || ""),
    },
  ];
}

export type DualSystemOptions = {
  /** 张力引擎参数（阈值/半衰期/不应期/泄洪） */
  tension?: TensionEngineOptions;
  /** System 1 参数（静默窗口/噪音/聚类键） */
  reflex?: ReflexOptions;
  /** System 2 规划器（默认 [wakePlanner]） */
  planners?: Planner[];
  /** 动作出口（必填：至少给一个，哪怕是控制台） */
  dispatchers: Dispatcher[];
  log?: (line: string) => void;
};

export class DualSystem {
  readonly engine: TensionEngine;
  /** [hg-diff] System 1 持中意图簇数量——前端张力槽的「聚类中」提示数据源 */
  get pendingClusters(): number {
    return this.reflex.pendingCount;
  }
  private readonly reflex: ReflexLayer;
  private readonly planners: Planner[];
  private readonly dispatchers: Dispatcher[];
  private readonly log: (line: string) => void;
  /** 观测钩子：每个动作产出时回调（测试/审计用） */
  onAction?: (action: CognitionAction) => void;
  onBreach?: (breach: TensionBreach) => void;
  /** [hg-diff] 反射观测钩子：每个事件经 System 1 判定后回调（noise=被吞噬，queued=入簇进张力），
   *  供宿主向前端广播「神经脉冲流水」——UI 展示 System 1 吞噬/聚类记录就靠它 */
  onReflex?: (evt: SensoryEvent, verdict: "noise" | "queued") => void;

  constructor(opts: DualSystemOptions) {
    this.planners = opts.planners ?? [];
    this.dispatchers = opts.dispatchers;
    this.log = opts.log ?? (() => {});
    this.reflex = new ReflexLayer(opts.reflex ?? {});
    this.engine = new TensionEngine(opts.tension ?? {}, (breach) => {
      void this.cognition(breach);
    });
  }

  /** 万物皆事件的唯一入口：System 1 把关 → 张力水池 →（破线时）System 2 行动 */
  ingest(evt: SensoryEvent): void {
    const verdict = this.reflex.observe(evt);
    this.onReflex?.(evt, verdict);
    if (verdict === "noise") return;
    this.engine.ingest(evt);
  }

  private async cognition(breach: TensionBreach): Promise<void> {
    this.onBreach?.(breach);
    const clusters = this.reflex.flushAll();
    const actions: CognitionAction[] = [];
    for (const planner of this.planners) {
      try {
        const out = await planner(breach, clusters);
        if (out?.length) actions.push(...out);
      } catch (err) {
        this.log(`[planner] 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!actions.length) actions.push(...wakePlanner(breach, clusters));
    await this.dispatchAll(actions);
    this.log(
      `[cognition] 张力突破(${breach.trigger} level=${breach.level.toFixed(1)}) → ${actions.length} 个动作 / ` +
        `${clusters.length} 个意图簇`,
    );
  }

  private async dispatchAll(actions: CognitionAction[]): Promise<void> {
    await Promise.allSettled(
      this.dispatchers.map(async (d) => {
        for (const action of actions) {
          this.onAction?.(action);
          try {
            await d.dispatch(action);
          } catch (err) {
            this.log(`[dispatch] ${action.kind} 失败: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }),
    );
  }

  stop(): void {
    this.engine.stop();
    this.reflex.stop();
  }
}

/* =====================================================================
   HarnessGate 桥：System 2 伸向 HarnessGate 的手（WS 协议）
   ===================================================================== */

export type HarnessGateBridgeOptions = {
  /** HarnessGate WS 地址（默认本机 9830） */
  url?: string;
  /** 访问 token（服务端开启认证时必填，走 query 参数） */
  token?: string;
  /** 断线重连间隔 ms（默认 5000） */
  reconnectMs?: number;
  /** 离线排队上限（默认 32，超出丢最老） */
  queueMax?: number;
  log?: (line: string) => void;
};

/** 纯函数：认知动作 → HarnessGate WS 线格式；null = 该动作不归桥管（静默忽略） */
export function toWireAction(action: CognitionAction): Record<string, unknown> | null {
  const p = action.payload ?? {};
  switch (action.kind) {
    case "harnessgate.goal-speculate":
      return typeof p.id === "string" ? { type: "goal-speculate", id: p.id } : null;
    case "harnessgate.goal-save":
      return p.goal ? { type: "goal-save", goal: p.goal } : null;
    case "harnessgate.raw":
      return typeof p.type === "string" ? { ...p } : null;
    default:
      return null;
  }
}

/**
 * 与 HarnessGate 内部 WS 接口联动：goal-speculate 唤起推测沙箱、goal-save 同步目标……
 * 惰性连接 + 断线自动重连 + 离线排队（HarnessGate 没起也不崩，恢复后补发）。
 */
export class HarnessGateBridge implements Dispatcher {
  private socket?: WebSocket;
  private readonly queue: Array<Record<string, unknown>> = [];
  private connecting = false;
  private closed = false;

  constructor(private readonly opts: HarnessGateBridgeOptions = {}) {}

  private get url(): string {
    const base = this.opts.url ?? "ws://127.0.0.1:9830/ws";
    return this.opts.token
      ? `${base}${base.includes("?") ? "&" : "?"}token=${encodeURIComponent(this.opts.token)}`
      : base;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  async dispatch(action: CognitionAction): Promise<void> {
    const wire = toWireAction(action);
    if (!wire) return;   // cognition.wake 之类的本地动作不外发
    this.enqueue(wire);
    this.ensureSocket();
  }

  /** 直接推一条原始 WS 消息（宿主自用） */
  sendRaw(msg: Record<string, unknown>): void {
    this.enqueue(msg);
    this.ensureSocket();
  }

  private enqueue(msg: Record<string, unknown>): void {
    this.queue.push(msg);
    const max = this.opts.queueMax ?? 32;
    if (this.queue.length > max) this.queue.shift();
  }

  private ensureSocket(): void {
    if (this.closed || this.socket || this.connecting) return;
    this.connecting = true;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (err) {
      this.connecting = false;
      this.opts.log?.(`[hg-bridge] 连接失败: ${err instanceof Error ? err.message : err}`);
      this.scheduleReconnect();
      return;
    }
    socket.on("open", () => {
      this.connecting = false;
      this.socket = socket;
      this.opts.log?.(`[hg-bridge] 已连接 ${this.opts.url ?? "ws://127.0.0.1:9830/ws"}`);
      this.flushQueue();
    });
    socket.on("error", (err) => {
      this.opts.log?.(`[hg-bridge] 连接错误（离线排队中）: ${err.message}`);
    });
    socket.on("close", () => {
      this.socket = undefined;
      this.connecting = false;
      if (!this.closed) this.scheduleReconnect();
    });
  }

  private flushQueue(): void {
    while (this.queue.length && this.socket?.readyState === WebSocket.OPEN) {
      const msg = this.queue.shift()!;
      this.socket.send(JSON.stringify(msg));
      this.opts.log?.(`[hg-bridge] → ${JSON.stringify(msg).slice(0, 160)}`);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const t = setTimeout(() => {
      if (!this.closed && this.queue.length) this.ensureSocket();
    }, this.opts.reconnectMs ?? 5_000);
    t.unref?.();
  }

  stop(): void {
    this.closed = true;
    try {
      this.socket?.close();
    } catch {
      /* 尽力而为 */
    }
    this.socket = undefined;
  }
}

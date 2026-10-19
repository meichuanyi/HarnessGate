/**
 * [vendored] 复制自独立验证项目 /root/projects/sentinel-hub（Sentinel 伴生感知框架）。
 * 本目录是 HarnessGate 内嵌副本，仅调整了相对导入路径；与上游的功能性差异以 [hg-diff] 标注。
 */
/**
 * Sentinel Hub 统一感官类型：万物皆事件（SensoryEvent）。
 *
 * 设计立场：
 * - 文件变动（fs）、时间脉冲（temporal）、命令/进程状态（process）、外部 Webhook/数据
 *   变动（webhook）……全部摊平成同一种事件流，上层只面对 SensoryEvent，不再为每种
 *   刺激写一套 if-else；
 * - 显著性（Salience）是事件自带的「这次刺激有多值得被注意」先验，由感知端打标，
 *   张力引擎据此决定垫底累积还是立即唤起。
 */

/** 感官通道：fs 文件系统 · temporal 时间 · process 进程/命令 · webhook 外部推送 · siyuan 思源数据 · custom 预留 */
/** 感知一级分类：外部客观现实（身外之物） vs 内部共生体（自身之态） */
export type SensoryCategory = "external" | "internal";

/** 感知二级分类（MECE 细分）：自然环境 · 外部信号 · 生活心智 · 数字工坊 */
export type SensorySubCategory = "environment" | "signal" | "life" | "workspace";

/** 感官通道：fs 文件系统 · temporal 时间 · process 进程/命令 · webhook 外部推送 · siyuan 思源数据 · custom 预留 */
export type SensoryModality = "fs" | "temporal" | "process" | "webhook" | "siyuan" | "custom";

/** 显著性四档：whisper 垫底累积 / normal 常规 / loud 强信号 / siren 警笛（无视阈值立即唤起） */
export type Salience = "whisper" | "normal" | "loud" | "siren";

/** 显著性 → 单次张力增量（siren 不走数值路径，由引擎特判为立即突破） */
export const DEFAULT_SALIENCE_WEIGHTS: Record<Salience, number> = {
  whisper: 0.6,
  normal: 2,
  loud: 5,
  siren: Number.POSITIVE_INFINITY,
};

export interface SensoryEvent {
  id: string;
  modality: SensoryModality;
  /** 触发此事件的感官实例 ID（如 sen-weather-hz, sen-fs-harnessgate） */
  sensorId?: string;
  /** 事件种类，如 fs.change / temporal.pulse / temporal.alarm / siyuan.goal-changed */
  kind: string;
  /** epoch ms */
  ts: number;
  /** 事件主语：文件路径 / 目标 id / 进程名……System 1 聚类键的主要来源 */
  subject?: string;
  /** 一句话人读摘要 */
  summary: string;
  salience: Salience;
  /** 张力增量覆盖；缺省按 salience 映射 */
  weight?: number;
  payload?: Record<string, unknown>;
}

let eventSeq = 0;

/** 事件构造器：补齐 id/ts，省得每个感官都手写 */
export function makeEvent(
  p: Omit<SensoryEvent, "id" | "ts"> & Partial<Pick<SensoryEvent, "id" | "ts">>,
): SensoryEvent {
  const { ts, id, ...rest } = p;
  return {
    id: id ?? `evt-${Date.now().toString(36)}-${(++eventSeq).toString(36)}`,
    ts: ts ?? Date.now(),
    ...rest,
  };
}

/** 张力突破的触发方式：threshold 累积到线 / siren 强信号直接破线 */
export type BreachTrigger = "threshold" | "siren";

/** 张力突破：认知层（System 2）的唤醒凭证 */
export interface TensionBreach {
  at: number;
  /** 突破时刻的张力水位 */
  level: number;
  threshold: number;
  trigger: BreachTrigger;
  /** 自上次突破以来贡献张力的（降噪后）事件，按时间升序；超长截断 */
  events: SensoryEvent[];
}

export interface TensionReading {
  level: number;
  threshold: number;
  /** 本次 ingest 是否触发突破 */
  breached: boolean;
}

/** System 1 意图聚类：同源事件在静默窗口内合并成一个「意图」再上交 */
export interface IntentCluster {
  key: string;
  events: SensoryEvent[];
  firstTs: number;
  lastTs: number;
  summary: string;
}

/** System 2 产出的认知动作 */
export interface CognitionAction {
  kind: string;
  /** 为什么做这个动作（审计与回溯） */
  reason: string;
  ts: number;
  payload?: Record<string, unknown>;
}

/** 动作出口：控制台日志 / HarnessGate WS 桥 / 测试录制器…… */
export interface Dispatcher {
  dispatch(action: CognitionAction): void | Promise<void>;
}

/** 感官统一生命周期 */
export interface Sensor {
  readonly name: string;
  /** 事件出口（宿主接到 DualSystem.ingest；[hg-diff] 从各类字段上提为接口约定） */
  onEvent?: (evt: SensoryEvent) => void;
  start(): void;
  stop(): void;
}

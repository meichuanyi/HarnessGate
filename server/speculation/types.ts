/**
 * 统一推演引擎（Speculation Engine）领域抽象实体与处方定义
 */

export type SpeculativeDomain = "life" | "career" | "skill" | "social" | "health" | "finance";

export type SpeculativeHorizon = "immediate" | "weekly" | "macro";

export type SpeculativeItem = {
  id: string;
  title: string;
  domain: SpeculativeDomain;
  horizon: SpeculativeHorizon;
  timeWindow?: {
    start?: string;
    due?: string;
  };
  sourceRef: {
    type: "mindwtr" | "siyuan_plan" | "calendar";
    rawId: string;
  };
  /**
   * 关联的传感器 ID 列表（如 ["sen-weather-hz"] 或 ["sen-fs-harnessgate"]）。
   * 注意：不是所有目标/待办都需要传感器！无外部传感器依赖的目标此项留空或为空数组，不受任何外部传感器破线波及。
   */
  sensorDependencies?: string[];
  context?: Record<string, any>;
};

export type SpeculativePrescriptionAction = {
  label: string;
  actionType: "reschedule_task" | "prepare_worktree" | "notify";
  payload: Record<string, any>;
};

export type SpeculativePrescription = {
  itemId: string;
  status: "ready" | "warning" | "optimized";
  summary: string;
  evidence: {
    perceptions: string[];
    memories: string[];
  };
  actions?: SpeculativePrescriptionAction[];
  /** 
   * 处方自估的保质期与下次复核时间戳（ISO 8601 或 epoch ms）
   * 系统休眠直至此时间戳，或中途被传感器张力突破唤醒
   */
  nextSpeculateAt?: string;
  /** 处方置信度与有效生命周期 (毫秒) */
  ttlMs?: number;
};

export interface SpeculativeEvaluator {
  readonly name: string;
  /** 检查当前 Evaluator 是否适应该条目 */
  canEvaluate?(item: SpeculativeItem): boolean;
  /** 评估条目并给出处方 */
  evaluate(item: SpeculativeItem): Promise<SpeculativePrescription | null>;
}

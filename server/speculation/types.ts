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
};

export interface SpeculativeEvaluator {
  readonly name: string;
  /** 检查当前 Evaluator 是否适应该条目 */
  canEvaluate?(item: SpeculativeItem): boolean;
  /** 评估条目并给出处方 */
  evaluate(item: SpeculativeItem): Promise<SpeculativePrescription | null>;
}

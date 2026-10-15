/**
 * 统一推演引擎调度总线（Speculation Engine）
 *
 * 职责：
 * 1. 统一维护 Evaluators 列表；
 * 2. 对 SpeculativeItem 列表执行并发评估与处方生成；
 * 3. 支持结果内存缓存与自适应策略选择。
 */

import type { SpeculativeEvaluator, SpeculativeItem, SpeculativePrescription } from "./types.ts";

export type SpeculationEngineOptions = {
  cacheTtlMs?: number;
  evaluators?: SpeculativeEvaluator[];
};

export class SpeculationEngine {
  private evaluators: SpeculativeEvaluator[] = [];
  private cache: Map<string, { prescription: SpeculativePrescription; expiresAt: number }> = new Map();
  private cacheTtlMs: number;

  constructor(options?: SpeculationEngineOptions) {
    this.cacheTtlMs = options?.cacheTtlMs ?? 5 * 60 * 1000; // 默认缓存 5 分钟
    if (options?.evaluators) {
      this.evaluators.push(...options.evaluators);
    }
  }

  registerEvaluator(evaluator: SpeculativeEvaluator): void {
    // 避免重复注册同名 evaluator
    this.evaluators = this.evaluators.filter((e) => e.name !== evaluator.name);
    this.evaluators.push(evaluator);
  }

  getEvaluator(name: string): SpeculativeEvaluator | undefined {
    return this.evaluators.find((e) => e.name === name);
  }

  clearCache(itemId?: string): void {
    if (itemId) {
      this.cache.delete(itemId);
    } else {
      this.cache.clear();
    }
  }

  /**
   * 针对输入条目进行并发推演，返回 itemId -> SpeculativePrescription 的映射
   */
  async speculate(
    items: SpeculativeItem[],
    options?: { forceFresh?: boolean },
  ): Promise<Map<string, SpeculativePrescription>> {
    const results = new Map<string, SpeculativePrescription>();
    const now = Date.now();

    const tasks = items.map(async (item) => {
      // 1. 检查缓存
      if (!options?.forceFresh) {
        const cached = this.cache.get(item.id);
        if (cached && cached.expiresAt > now) {
          results.set(item.id, cached.prescription);
          return;
        }
      }

      // 2. 依次匹配 Evaluator 进行求值
      for (const ev of this.evaluators) {
        if (ev.canEvaluate && !ev.canEvaluate(item)) {
          continue;
        }
        try {
          const pres = await ev.evaluate(item);
          if (pres) {
            results.set(item.id, pres);
            this.cache.set(item.id, {
              prescription: pres,
              expiresAt: now + this.cacheTtlMs,
            });
            break;
          }
        } catch (err) {
          console.warn(`[speculation-engine] Evaluator ${ev.name} 出错:`, err instanceof Error ? err.message : err);
        }
      }
    });

    await Promise.all(tasks);
    return results;
  }
}

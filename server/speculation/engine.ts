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

type CacheEntry = {
  prescription: SpeculativePrescription;
  expiresAt: number;
  sensorDependencies?: string[];
  cwd?: string;
};

export class SpeculationEngine {
  private evaluators: SpeculativeEvaluator[] = [];
  private cache: Map<string, CacheEntry> = new Map();
  private cacheTtlMs: number;

  constructor(options?: SpeculationEngineOptions) {
    this.cacheTtlMs = options?.cacheTtlMs ?? 5 * 60 * 1000; // 默认兜底缓存 5 分钟
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
   * 定向失效缓存：仅清除显式依赖了特定 sensorIds 或匹配 baseDirs 的项目。
   * 核心铁律：无传感器依赖的静态目标/待办缓存严格保留，绝不误触！
   */
  invalidateForSensors(context: { sensorIds?: string[]; baseDirs?: string[] }): number {
    const { sensorIds = [], baseDirs = [] } = context;
    if (sensorIds.length === 0 && baseDirs.length === 0) return 0;

    let invalidated = 0;
    for (const [id, entry] of this.cache.entries()) {
      let shouldInvalidate = false;

      // 1. 检查传感器 ID 是否匹配
      if (entry.sensorDependencies && entry.sensorDependencies.length > 0 && sensorIds.length > 0) {
        if (entry.sensorDependencies.some((dep) => sensorIds.includes(dep))) {
          shouldInvalidate = true;
        }
      }

      // 2. 检查 FS 目录是否重叠
      if (!shouldInvalidate && entry.cwd && baseDirs.length > 0) {
        if (baseDirs.some((bd) => entry.cwd === bd || entry.cwd?.startsWith(bd + "/"))) {
          shouldInvalidate = true;
        }
      }

      if (shouldInvalidate) {
        this.cache.delete(id);
        invalidated++;
      }
    }
    return invalidated;
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

    // 小模型评估器并发能力有限（本机 1.5B 只有 2 线程）：2 路池化，防止队尾请求撞超时
    const queue = [...items];
    const runOne = async (item: SpeculativeItem): Promise<void> => {
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
            const ttl = pres.ttlMs && pres.ttlMs > 0 ? pres.ttlMs : this.cacheTtlMs;
            this.cache.set(item.id, {
              prescription: pres,
              expiresAt: now + ttl,
              sensorDependencies: item.sensorDependencies,
              cwd: item.context?.cwd,
            });
            break;
          }
        } catch (err) {
          console.warn(`[speculation-engine] Evaluator ${ev.name} 出错:`, err instanceof Error ? err.message : err);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(2, queue.length) }, () => runOne(queue.shift()!)));
    while (queue.length) {
      await Promise.all(Array.from({ length: Math.min(2, queue.length) }, () => runOne(queue.shift()!)));
    }
    return results;
  }
}

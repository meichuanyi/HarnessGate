/**
 * 代码沙箱与 Worktree 推演求值器（Code Sandbox Evaluator）
 *
 * 包装原 server/speculative.ts 中的沙箱/Worktree能力，使之无缝接入统一推演流水线。
 */

import type { SpeculativeEvaluator, SpeculativeItem, SpeculativePrescription } from "../types.ts";
import { runSpeculativeTask, type SpeculativeDeps, type SpeculativeIntent } from "../../speculative.ts";

export class CodeSandboxEvaluator implements SpeculativeEvaluator {
  readonly name = "code-sandbox-evaluator";

  private deps: SpeculativeDeps;

  constructor(deps: SpeculativeDeps) {
    this.deps = deps;
  }

  canEvaluate(item: SpeculativeItem): boolean {
    return item.domain === "career" || item.domain === "skill" || item.domain === "finance";
  }

  async evaluate(item: SpeculativeItem): Promise<SpeculativePrescription | null> {
    const ctx = item.context ?? {};
    const cwd = ctx.cwd || process.cwd();
    const prompt = ctx.promptTemplate || ctx.prompt || `为任务【${item.title}】执行推演与代码沙箱预检`;

    const intent: SpeculativeIntent = {
      goalId: item.id,
      purpose: ctx.purpose || "speculative-evaluation",
      cwd,
      useWorktree: ctx.useWorktree ?? true,
      prompt,
      harnessId: ctx.harnessId,
      model: ctx.model,
      artifactCheck: ctx.artifactCheckCommand
        ? {
            kind: "command",
            cmd: ctx.artifactCheckCommand,
          }
        : undefined,
    };

    const res = await runSpeculativeTask(intent, this.deps);

    if (res.ok) {
      return {
        itemId: item.id,
        status: "ready",
        summary: `沙箱推演通过：${res.report.slice(0, 300)}`,
        evidence: {
          perceptions: [
            `执行耗时：${res.elapsedMs}ms`,
            `Harness：${res.harnessId}`,
            ...(res.branch ? [`已生成隔离分支：${res.branch}`] : []),
            ...(res.diffStat ? [`变更摘要：${res.diffStat.slice(0, 100)}`] : []),
          ],
          memories: [
            res.judgement ? `前置意图判定：${res.judgement.reason}` : "自动通过前置判定",
          ],
        },
        actions: res.branch
          ? [
              {
                label: `检视沙箱分支 (${res.branch})`,
                actionType: "prepare_worktree",
                payload: {
                  branch: res.branch,
                  patch: res.patch,
                  goalId: item.id,
                },
              },
            ]
          : undefined,
      };
    } else {
      return {
        itemId: item.id,
        status: "warning",
        summary: `沙箱推演失败（阶段 ${res.phase}）：${res.error}`,
        evidence: {
          perceptions: [`耗时：${res.elapsedMs}ms`, `失败原因：${res.error}`],
          memories: [
            res.judgement ? `前置判定：${res.judgement.reason}` : "执行失败即弃",
          ],
        },
      };
    }
  }
}

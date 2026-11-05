import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Claude Code 后台工作流（Workflow 工具 / 多 agent）进度可视化。
 *
 * 背景缺口：Workflow 是后台执行——主回合立即结束（「跑完通知你」），子 agent 在
 * claude 进程内部跑，ACP 线上只回传主循环的工具调用，子 agent 的中间过程不上 wire，
 * HG 的 web/插件端对「后台正在发生什么」完全黑箱，只能干等通知回合。
 *
 * 数据源：工作流状态会落盘在 claude 的会话转录目录（按需只读，不缓存不推送）：
 *   ~/.claude/projects/<cwd 斜杠转横线>/<claude会话uuid>/subagents/workflows/
 *     <run-id>/journal.jsonl   # {type:"launched"|"started"|"result", agentId, label, phase}
 *     <run-id>/agent-*.jsonl   # 子 agent 转录（mtime = 真实最近活动）
 * 映射：claude-code-acp 的 ACP 会话 id 即 claude 的会话 uuid，HG 会话记录里的
 * acpSessionId 可直接定位（cwd 变更/worktree 场景用全项目扫描兜底）。
 *
 * 约束：纯只读增强，任何 IO 异常都吞掉返回空——绝不能影响主流程。
 * journal 没有显式的 finish 事件：以「无 running agent 且 6 分钟无文件活动」判结束。
 */

export type WorkflowAgentView = {
  agentId: string;
  label: string;
  phase?: string;
  status: "running" | "done";
};

export type WorkflowRunView = {
  id: string;
  agents: WorkflowAgentView[];
  running: number;
  done: number;
  finished: boolean;
  /** running>0 但文件活动已停超 STALE_MS：进程多半已被回收，agent 状态是僵尸——客户端显示「失联」而非「进行中」 */
  stale: boolean;
  /** 最近一次文件活动（epoch ms）——客户端显示「X 分钟前活动」 */
  updatedAt: number;
};

const MAX_RUNS = 8;           // 最多展示的最近运行数
const STALE_MS = 6 * 60_000;  // 无 running agent 且超此时长无文件活动 → 视为已结束

/** 单个 run 目录 → 视图（journal 缺失/损坏返回 undefined） */
function readRun(runDir: string, id: string): WorkflowRunView | undefined {
  let updated = 0;
  try {
    const agents = new Map<string, WorkflowAgentView>();
    const started = new Map<string, { label: string; phase?: string }>();
    for (const line of readFileSync(join(runDir, "journal.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // 半截写入的行
      }
      if (e.type === "started" && typeof e.agentId === "string") {
        started.set(e.agentId, { label: String(e.label ?? e.agentId), phase: typeof e.phase === "string" ? e.phase : undefined });
      } else if (e.type === "result" && typeof e.agentId === "string" && started.has(e.agentId)) {
        const s = started.get(e.agentId)!;
        agents.set(e.agentId, { agentId: e.agentId, label: s.label, phase: s.phase, status: "done" });
      }
    }
    if (!started.size) return undefined; // 只有 launched 的空壳，不展示
    for (const [aid, s] of started) {
      if (!agents.has(aid)) agents.set(aid, { agentId: aid, label: s.label, phase: s.phase, status: "running" });
    }
    updated = statSync(runDir).mtimeMs;
    for (const f of readdirSync(runDir)) {
      try {
        const m = statSync(join(runDir, f)).mtimeMs;
        if (m > updated) updated = m;
      } catch { /* 并发删除等，忽略 */ }
    }
    const list = [...agents.values()];
    const running = list.filter((a) => a.status === "running").length;
    const idleMs = Date.now() - updated;
    return {
      id,
      agents: list,
      running,
      done: list.length - running,
      finished: running === 0 && idleMs > STALE_MS,
      stale: running > 0 && idleMs > STALE_MS,
      updatedAt: Math.round(updated),
    };
  } catch {
    return undefined;
  }
}

/** HG 会话 → 其 claude 会话目录下最近的工作流运行（无/非 claude/读不到 → 空数组） */
export function claudeWorkflowProgress(acpSessionId: string | undefined, cwd: string | undefined): WorkflowRunView[] {
  if (!acpSessionId) return [];
  const base = join(homedir(), ".claude", "projects");
  const dirs: string[] = [];
  if (cwd) dirs.push(join(base, cwd.replace(/\/+/g, "-"), acpSessionId, "subagents", "workflows"));
  try {
    // cwd 变过 / worktree 会话：uuid 兜底扫描（项目目录通常几十个，readdir 很便宜）
    for (const p of readdirSync(base)) {
      const d = join(base, p, acpSessionId, "subagents", "workflows");
      if (!dirs.includes(d)) dirs.push(d);
    }
  } catch { /* ~/.claude/projects 不存在（没跑过 claude） */ }
  const runs: WorkflowRunView[] = [];
  for (const d of dirs) {
    let ids: string[];
    try {
      ids = readdirSync(d);
    } catch {
      continue;
    }
    for (const id of ids) {
      const runDir = join(d, id);
      try {
        if (!statSync(runDir).isDirectory()) continue;
        const r = readRun(runDir, id);
        if (r) runs.push(r);
      } catch { /* 竞态消失，跳过 */ }
    }
  }
  return runs
    .sort((a, b) => Number(a.finished) - Number(b.finished) || b.updatedAt - a.updatedAt) // 进行中优先，其余按最近活动
    .slice(0, MAX_RUNS);
}

/**
 * [vendored] 复制自独立验证项目 /root/projects/sentinel-hub（Sentinel 伴生感知框架）。
 * 本目录是 HarnessGate 内嵌副本，仅调整了相对导入路径；与上游的功能性差异以 [hg-diff] 标注。
 */
import { watch, type FSWatcher } from "node:fs";
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";

import { makeEvent, type Salience, type Sensor, type SensoryEvent } from "./types.ts";
import type { CognitionAction } from "./types.ts";
import type { Planner } from "./dual-system.ts";

/**
 * 思源计划中枢适配器（SiyuanPlanHubAdapter）：业务世界的感官。
 *
 * 监听思源笔记的 plans.json（目标集控文件），当检测到目标变更（增/删/状态/进度）
 * 时：差异 → 按变更幅度定显著性的 SensoryEvent → 张力引擎自动累积；张力破线后由
 * siyuanPlanner 把差异翻译成 goal-save 动作，经 HarnessGate 桥同步进目标看板。
 *
 * 容错设计：
 * - plans.json 是思源原子写入（tmp→rename）的常见目标，监听父目录并按文件名过滤，
 *   读到半截 JSON 就静默放弃等下一次触发；
 * - 目标数组字段名不锁死（goals/plans/items…），自动探测「id+title 齐全的对象数组」；
 * - 启动时先读基线不产生事件——冷启动不把存量目标当成「变更」刷一波。
 */

export type SiyuanGoal = {
  id: string;
  title: string;
  status?: string;
  progress?: number;
  category?: string;
  note?: string;
  [k: string]: unknown;
};

export type SiyuanDiffKind = "added" | "removed" | "changed";

export interface SiyuanDiff {
  kind: SiyuanDiffKind;
  id: string;
  before?: SiyuanGoal;
  after?: SiyuanGoal;
  /** 本次变更涉及的字段 */
  fields: string[];
}

export type SiyuanAdapterOptions = {
  /** 思源 plans.json 绝对路径 */
  plansPath: string;
  /** 目标数组字段名；缺省自动探测 */
  goalsKey?: string;
  /** 变更去抖窗口 ms（默认 250，思源连续保存合并为一次差分） */
  quietMs?: number;
  log?: (line: string) => void;
};

/** HarnessGate 认可的目标分类 */
const HG_CATEGORIES = ["career", "academic", "trading", "life", "general"];

/** 纯函数：两份目标快照的差分（added/removed/changed + 涉及字段） */
export function diffPlans(before: SiyuanGoal[], after: SiyuanGoal[]): SiyuanDiff[] {
  const diffs: SiyuanDiff[] = [];
  const beforeById = new Map(before.map((g) => [g.id, g]));
  const afterById = new Map(after.map((g) => [g.id, g]));
  for (const g of after) {
    const prev = beforeById.get(g.id);
    if (!prev) {
      diffs.push({ kind: "added", id: g.id, after: g, fields: ["*"] });
      continue;
    }
    const fields: string[] = [];
    for (const key of ["title", "status", "progress", "category", "note"] as const) {
      if (JSON.stringify(prev[key]) !== JSON.stringify(g[key])) fields.push(key);
    }
    if (fields.length) diffs.push({ kind: "changed", id: g.id, before: prev, after: g, fields });
  }
  for (const g of before) {
    if (!afterById.has(g.id)) diffs.push({ kind: "removed", id: g.id, before: g, fields: ["*"] });
  }
  return diffs;
}

/** 差分幅度 → 显著性先验：改状态是意图信号（loud），大步进度是推进（normal），微调是碎语（whisper） */
export function salienceOfDiff(d: SiyuanDiff): Salience {
  if (d.kind === "removed") return "whisper";
  if (d.fields.includes("status")) return "loud";
  if (d.kind === "added") return "normal";
  const delta = Math.abs((d.after?.progress ?? 0) - (d.before?.progress ?? 0));
  return delta >= 25 ? "normal" : "whisper";
}

/** 思源目标 → HarnessGate goal-save 载荷（id 加 siyuan- 前缀保证幂等 upsert） */
export function toHarnessGateGoal(g: SiyuanGoal): Record<string, unknown> {
  const status = String(g.status ?? "todo").toLowerCase();
  const mapped =
    status === "done" ? "completed"
    : status === "paused" ? "paused"
    : status === "archived" ? "archived"
    : "active";
  const category = HG_CATEGORIES.includes(String(g.category)) ? String(g.category) : "general";
  const tags = Array.isArray(g.tags) ? g.tags.map(String) : undefined;
  const cwd = typeof g.cwd === "string" && g.cwd.trim() ? g.cwd.trim() : undefined;
  return {
    id: `siyuan-${g.id}`,
    title: String(g.title),
    description: typeof g.note === "string" && g.note.trim() ? g.note.trim() : undefined,
    category,
    progress: Math.max(0, Math.min(100, Math.round(Number(g.progress) || 0))),
    status: mapped,
    cwd,
    tags,
  };
}

/** 规划器工厂：张力破线时把 adapter 攒下的差异翻译成 goal-save 动作（removed 不同步，本地记忆即可） */
export function siyuanPlanner(adapter: SiyuanPlanHubAdapter): Planner {
  return (breach) => {
    const diffs = adapter.takeDiffs();
    const actions: CognitionAction[] = [];
    for (const d of diffs) {
      if (d.kind === "removed" || !d.after) continue;
      actions.push({
        kind: "harnessgate.goal-save",
        ts: breach.at,
        reason: `同步思源目标 ${d.id}（${d.kind}：${d.fields.join("/")}）→ HarnessGate goals`,
        payload: { goal: toHarnessGateGoal(d.after) },
      });
    }
    return actions;
  };
}

export class SiyuanPlanHubAdapter implements Sensor {
  readonly name = "siyuan-plan-hub";
  /** 事件出口（由宿主接到 DualSystem.ingest） */
  onEvent?: (evt: SensoryEvent) => void;
  private watcher?: FSWatcher;
  private pollTimer?: NodeJS.Timeout;
  private reloadTimer?: NodeJS.Timeout;
  private snapshot: SiyuanGoal[] = [];
  private pending: SiyuanDiff[] = [];
  private stopped = false;

  constructor(private readonly opts: SiyuanAdapterOptions) {}

  start(): void {
    const base = this.readGoals();   // 基线：存量目标不算「变更」
    if (base) this.snapshot = base;
    const dir = dirname(this.opts.plansPath);
    try {
      this.watcher = watch(dir, { persistent: false }, (_ev, filename) => {
        if (filename && basename(String(filename)) !== basename(this.opts.plansPath)) return;
        this.scheduleReload();
      });
    } catch (err) {
      // 目录不存在等场景：退化为 2s 轮询，文件出现后照样感知
      this.opts.log?.(
        `[siyuan] 无法监听 ${dir}（${err instanceof Error ? err.message : err}），退化为轮询`,
      );
      this.pollTimer = setInterval(() => this.scheduleReload(), 2_000);
      this.pollTimer.unref?.();
    }
  }

  private scheduleReload(): void {
    if (this.stopped) return;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      this.reload();
    }, this.opts.quietMs ?? 250);
    this.reloadTimer.unref?.();
  }

  private reload(): void {
    if (this.stopped) return;
    const after = this.readGoals();
    if (!after) return;   // 半截写入/暂时不可读：等下一次触发
    const diffs = diffPlans(this.snapshot, after);
    this.snapshot = after;
    if (!diffs.length) return;
    // 先入队差分再发事件：破线回调里 takeDiffs() 能拿到完整差异
    this.pending.push(...diffs);
    const now = Date.now();
    for (const d of diffs) {
      this.onEvent?.(
        makeEvent({
          modality: "siyuan",
          kind: `siyuan.goal-${d.kind}`,
          subject: d.id,
          summary: `思源目标 ${d.id}${d.after ? `「${d.after.title}」` : ""} ${d.kind}（${d.fields.join("/")}）`,
          salience: salienceOfDiff(d),
          payload: { diff: d },
        }),
      );
    }
    this.opts.log?.(`[siyuan] plans.json 变更: ${diffs.map((d) => `${d.kind}:${d.id}`).join(", ")}`);
  }

  /** 解析 plans.json → 目标数组（容错：坏 JSON/缺文件返回 null 表示「这次不算数」） */
  private readGoals(): SiyuanGoal[] | null {
    const p = this.opts.plansPath;
    let raw: string;
    try {
      raw = readFileSync(p, "utf8");
    } catch {
      return [];
    }
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      const arr = this.extractGoals(data);
      if (!arr) return null;   // 结构不认识：不盲目清空基线
      return arr.filter((g) => g && typeof g.id === "string" && typeof g.title === "string");
    } catch {
      return null;
    }
  }

  private extractGoals(data: Record<string, unknown>): SiyuanGoal[] | null {
    if (this.opts.goalsKey) {
      const v = data[this.opts.goalsKey];
      return Array.isArray(v) ? (v as SiyuanGoal[]) : null;
    }
    for (const v of Object.values(data)) {
      if (
        Array.isArray(v) &&
        v.length > 0 &&
        v.every((x) => x && typeof x === "object" && "id" in x && "title" in x)
      ) {
        return v as SiyuanGoal[];
      }
    }
    // 空数组/空对象也算合法快照（用户清空了计划）——取第一个数组字段
    for (const v of Object.values(data)) {
      if (Array.isArray(v)) return v as SiyuanGoal[];
    }
    return null;
  }

  /** 认知层取走攒下的差异（取走即清空） */
  takeDiffs(): SiyuanDiff[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  stop(): void {
    this.stopped = true;
    try {
      this.watcher?.close();
    } catch {
      /* 尽力而为 */
    }
    this.watcher = undefined;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
  }
}

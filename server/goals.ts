/**
 * 目标系统（Goals Engine）：自主智能的意图锚点。
 *
 * 存储：DATA_DIR/goals.json（原子写入）
 * 角色：
 * 1. 作为 HarnessGate 原生的一等公民，任何新安装用户开箱即用；
 * 2. 存储宏观意图与推测执行策略（绑定的 cwd、触发规则、推测任务模板）；
 * 3. 作为 Speculative Pipeline 的上游输入，供差分引擎计算落差与主动推动。
 * 4. Mindwtr 集成：拉取 GTD 任务并二分——「生活琐事」直接进看板的日常运转区，
 *    「目标支撑任务」按目标标题/项目名匹配挂到具体目标卡片下（本文件下半部）。
 * 5. Speculation Engine 集成：统一推演引擎计算生活处方与沙箱推演，回填到 task.prescription。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { SpeculativePrescription, SpeculativeItem } from "./speculation/types.ts";
import type { SpeculationEngine } from "./speculation/engine.ts";

export type GoalStatus = "active" | "paused" | "completed" | "archived";

export type GoalSpeculativeConfig = {
  enabled: boolean;
  harnessId?: string; // 默认使用全局推荐或 zcode
  model?: string;
  autoApprove?: "all" | "readonly";
  useWorktree?: boolean; // 默认 true：开启平行沙箱
  triggerOnCommit?: boolean; // git commit 后触发
  promptTemplate: string; // 推测执行的指令模板
  artifactCheckCommand?: string; // 校验命令
  notifyFeishu?: boolean; // 关键产出时是否推飞书
};

export type Goal = {
  id: string;
  title: string;
  description?: string;
  category?: "career" | "academic" | "trading" | "life" | "general";
  status: GoalStatus;
  progress?: number; // 0 - 100
  cwd?: string; // 关联的核心工作目录
  deadline?: string; // ISO 8601
  /**
   * 关联的传感器标签列表（可选）。
   * 注意：并非所有目标都需要传感器！仅当目标需要响应外部环境或代码变动时，才填入对应传感器 ID（如 'sen-weather-hz', 'sen-fs-xxx'）。
   */
  tags?: string[];
  speculative?: GoalSpeculativeConfig;
  createdAt: string;
  updatedAt: string;
  lastSpeculatedAt?: string;
  lastSpeculatedResult?: {
    ok: boolean;
    summary?: string;
    branch?: string;
  };
};

export type GoalsFile = {
  version: 1;
  goals: Goal[];
};

export function newGoalId(): string {
  return "goal_" + Math.random().toString(36).slice(2, 10);
}

export function loadGoals(file: string): Goal[] {
  try {
    if (!existsSync(file)) return [];
    const raw = JSON.parse(readFileSync(file, "utf8")) as GoalsFile;
    const out: Goal[] = [];
    for (const g of raw.goals ?? []) {
      if (!g || typeof g.id !== "string" || typeof g.title !== "string") continue;
      out.push(g);
    }
    return out;
  } catch (err) {
    console.error("[goals] 加载失败，按空库处理:", err instanceof Error ? err.message : err);
    return [];
  }
}

export function saveGoals(file: string, goals: Goal[]): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, goals } satisfies GoalsFile, null, 2));
  renameSync(tmp, file);
}

/* =====================================================================
   Mindwtr 集成：GTD 任务 → 「生活琐事」与「目标支撑任务」二分
   ===================================================================== */

/** 发给前端的 Mindwtr 任务视图（字段与 Cloud API 对齐，notes/tags 缺省收窄） */
export type MindwtrTaskView = {
  id: string;
  title: string;
  status?: string;
  startTime?: string;
  dueDate?: string;
  notes?: string;
  tags?: string[];
  projectId?: string;
  timeEstimate?: number;
  /** 推演处方（统一推演引擎评估产物） */
  prescription?: SpeculativePrescription;
};

/** 目标的前端视图：挂上关联的 Mindwtr 任务（运行时拼装，不落盘） */
export type GoalView = Goal & { linkedTasks?: MindwtrTaskView[] };

const MW_BASE = (): string => process.env.MINDWTR_BASE_URL || "https://mindwtr.meichuan.cloud";
const MW_TOKEN = (): string => process.env.MINDWTR_TOKEN || "GINn_ZfOs1Yw4q0I6gYEf8oL0Ni285l5JhOhBrP6Dcc";

function mwApi(method: string, path: string, params?: Record<string, string | number | undefined>, body?: unknown): Promise<unknown> {
  const qs = params
    ? "?" + Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join("&")
    : "";
  return fetch(MW_BASE().replace(/\/$/, "") + path + qs, {
    method,   // 铁律：不传 method = 一律 GET，complete 这类 POST 会得到 405
    headers: {
      authorization: `Bearer ${MW_TOKEN()}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  }).then(async (res) => {
    if (!res.ok) throw new Error(`Mindwtr API ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return res.json();
  });
}

function toView(t: Record<string, unknown>): MindwtrTaskView {
  return {
    id: String(t.id),
    title: String(t.title ?? ""),
    status: t.status as string | undefined,
    startTime: (t.startTime ?? t.startDate) as string | undefined,
    dueDate: (t.dueDate ?? t.due) as string | undefined,
    notes: (t.notes as string | undefined) || undefined,
    tags: Array.isArray(t.tags) ? (t.tags as string[]) : undefined,
    projectId: (t.projectId as string | undefined) || undefined,
    timeEstimate: typeof t.timeEstimate === "number" ? t.timeEstimate : undefined,
  };
}

function listOf(resp: unknown, key: string): Array<Record<string, unknown>> {
  if (Array.isArray(resp)) return resp as Array<Record<string, unknown>>;
  const arr = (resp as Record<string, unknown> | null)?.[key];
  return Array.isArray(arr) ? (arr as Array<Record<string, unknown>>) : [];
}

/** 拉取活跃任务（next + inbox）与项目表（projectId → 标题，关联匹配的强信号） */
export async function mindwtrFetchTasks(): Promise<{
  tasks: MindwtrTaskView[];
  projectTitles: Record<string, string>;
}> {
  const [next, inbox, projects] = await Promise.all([
    mwApi("GET", "/v1/tasks", { status: "next", limit: 100 }),
    mwApi("GET", "/v1/tasks", { status: "inbox", limit: 100 }),
    mwApi("GET", "/v1/projects", { limit: 100 }).catch(() => ({})),
  ]);
  const tasks = [...listOf(next, "tasks"), ...listOf(inbox, "tasks")].map(toView);
  const projectTitles: Record<string, string> = {};
  for (const p of listOf(projects, "projects")) {
    if (p.id) projectTitles[String(p.id)] = String(p.title ?? p.name ?? "");
  }
  return { tasks, projectTitles };
}

/** 完成（打勾）一个 Mindwtr 任务。FRP 隧道偶发抖动（重连窗口期 POST 可能被
 *  边缘节点转成 GET → 应用回 405），失败静候 800ms 重试一次。 */
export async function mindwtrCompleteTask(taskId: string): Promise<void> {
  try {
    await mwApi("POST", `/v1/tasks/${encodeURIComponent(taskId)}/complete`);
  } catch {
    await new Promise((r) => setTimeout(r, 800));
    await mwApi("POST", `/v1/tasks/${encodeURIComponent(taskId)}/complete`);
  }
}

/** 更新一个 Mindwtr 任务的字段（如顺延调度） */
export async function mindwtrUpdateTask(taskId: string, updates: Record<string, any>): Promise<void> {
  try {
    await mwApi("PATCH", `/v1/tasks/${encodeURIComponent(taskId)}`, undefined, updates);
  } catch {
    await new Promise((r) => setTimeout(r, 800));
    await mwApi("PATCH", `/v1/tasks/${encodeURIComponent(taskId)}`, undefined, updates);
  }
}

/** 目标标题里 ≥2 字的连续词（中英数字串），作为任务关联的匹配词 */
function titleRuns(title: string): string[] {
  return (title.match(/[\u4e00-\u9fa5A-Za-z0-9]+/g) ?? []).filter((r) => r.length >= 2);
}

/** 生活琐事关键词：晒/洗/做/吃/运动/家务的日常运转语义 */
const LIFE_RE =
  /晒|晾|洗衣|衣服|被子|鞋|洗碗|碗筷|做饭|煮|烤|买菜|早餐|午餐|晚餐|吃饭|超市|快递|取件|缴费|打扫|扫地|拖地|垃圾|浇花|喂|理发|羽毛球|篮球|足球|网球|乒乓|健身|跑步|锻炼|运动|游泳|散步|睡觉|午休/;

export type ClassifiedTasks = {
  /** 日常生活琐事（看板「☕ 今日生活与日常运转」区） */
  lifeTasks: MindwtrTaskView[];
  /** 目标支撑任务，按 goalId 分组（目标卡片「📋 关联 Mindwtr 任务」区） */
  linkedTasksByGoal: Record<string, MindwtrTaskView[]>;
};

/**
 * 任务二分：先按目标匹配（目标标题词命中任务的标题/备注/标签/所属项目名 → linked，
 * 一个任务可同时支撑多个目标），剩下的命中生活语义词的归 lifeTasks，其余忽略。
 * 项目名是强信号：Mindwtr 项目「论文」里的任务天然支撑标题含「论文」的目标。
 */
export function classifyMindwtrTasks(
  tasks: MindwtrTaskView[],
  goals: Goal[],
  projectTitles: Record<string, string> = {},
): ClassifiedTasks {
  const goalMatchers = goals.map((g) => ({ id: g.id, runs: titleRuns(g.title) }));
  const linkedTasksByGoal: Record<string, MindwtrTaskView[]> = {};
  const lifeTasks: MindwtrTaskView[] = [];
  for (const t of tasks) {
    const projectTitle = t.projectId ? projectTitles[t.projectId] ?? "" : "";
    const hay = [t.title, t.notes ?? "", projectTitle, ...(t.tags ?? [])].filter(Boolean).join(" ");
    let linked = false;
    for (const { id, runs } of goalMatchers) {
      if (runs.some((r) => hay.includes(r))) {
        (linkedTasksByGoal[id] ??= []).push(t);
        linked = true;
      }
    }
    if (!linked && LIFE_RE.test(hay)) lifeTasks.push(t);
  }
  return { lifeTasks, linkedTasksByGoal };
}

export type SensorMeta = {
  id: string;
  kind: string;
  dirs?: string[];
};

/**
 * 任务转 SpeculativeItem
 */
export function taskToSpeculativeItem(
  t: MindwtrTaskView,
  domain: "life" | "career" | "skill" | "social" | "health" | "finance" = "life",
  horizon: "immediate" | "weekly" | "macro" = "immediate",
  context?: Record<string, any>,
  availableSensors?: SensorMeta[],
): SpeculativeItem {
  const sensorDeps = new Set<string>();

  // 1. 任务显式 tags（如果打上了传感器 ID）
  if (Array.isArray(t.tags) && availableSensors) {
    for (const rawTag of t.tags) {
      const clean = rawTag.replace(/^#/, "");
      if (availableSensors.some((s) => s.id === clean)) {
        sensorDeps.add(clean);
      }
    }
  }

  // 2. 目标继承 tags（如果目标显式声明了传感器 ID）
  if (Array.isArray(context?.goalTags) && availableSensors) {
    for (const rawTag of context.goalTags) {
      const clean = String(rawTag).replace(/^#/, "");
      if (availableSensors.some((s) => s.id === clean)) {
        sensorDeps.add(clean);
      }
    }
  }

  // 3. 目标 cwd 自动匹配 FS 传感器（只有配置了该目录的 FS 传感器才绑定）
  if (context?.cwd && availableSensors) {
    const cwd = String(context.cwd);
    for (const s of availableSensors) {
      if (s.kind === "fs" && s.dirs?.some((d) => cwd === d || cwd.startsWith(d + "/"))) {
        sensorDeps.add(s.id);
      }
    }
  }

  // 4. 生活类任务中明确涉及户外/洗晒的，自动关联气象传感器（室内日常如煎冷面/力量训练绝不关联）
  if (domain === "life" && /晒|户外|露营|洗衣服|晾衣服|洗晒|出门跑步/.test(t.title) && availableSensors) {
    const weatherSensor = availableSensors.find((s) => s.kind === "weather");
    if (weatherSensor) {
      sensorDeps.add(weatherSensor.id);
    }
  }

  return {
    id: t.id,
    title: t.title,
    domain,
    horizon,
    sensorDependencies: sensorDeps.size > 0 ? Array.from(sensorDeps) : undefined,
    timeWindow: {
      start: t.startTime,
      due: t.dueDate,
    },
    sourceRef: {
      type: "mindwtr",
      rawId: t.id,
    },
    context: {
      notes: t.notes,
      tags: t.tags,
      projectId: t.projectId,
      ...context,
    },
  };
}

/**
 * 对生活任务和关联任务统一注入推演处方
 */
export async function enrichTasksWithPrescriptions(
  classified: ClassifiedTasks,
  engine: SpeculationEngine,
  goals: Goal[] = [],
  availableSensors?: SensorMeta[],
): Promise<ClassifiedTasks> {
  const items: SpeculativeItem[] = [];

  // 1. 生活任务转化
  for (const t of classified.lifeTasks) {
    let domain: SpeculativeItem["domain"] = "life";
    if (/羽毛球|健身|跑步|锻炼|力量训练/.test(t.title)) {
      domain = "health";
    } else if (/见朋友|约饭|聚餐|聚会/.test(t.title)) {
      domain = "social";
    }
    items.push(taskToSpeculativeItem(t, domain, "immediate", undefined, availableSensors));
  }

  // 2. 目标支撑任务转化
  const goalMap = new Map<string, Goal>(goals.map((g) => [g.id, g]));
  for (const [goalId, tasks] of Object.entries(classified.linkedTasksByGoal)) {
    const g = goalMap.get(goalId);
    let domain: SpeculativeItem["domain"] = "career";
    if (g?.category === "academic") domain = "skill";
    else if (g?.category === "trading") domain = "finance";
    else if (g?.category === "life") domain = "life";

    for (const t of tasks) {
      items.push(
        taskToSpeculativeItem(t, domain, "weekly", {
          goalId,
          goalTitle: g?.title,
          cwd: g?.cwd,
          goalTags: g?.tags,
          promptTemplate: g?.speculative?.promptTemplate,
        }, availableSensors),
      );
    }
  }

  // 3. 执行推演
  const prescriptions = await engine.speculate(items);

  // 4. 回填 prescription 到 task 对象
  for (const t of classified.lifeTasks) {
    t.prescription = prescriptions.get(t.id);
  }
  for (const tasks of Object.values(classified.linkedTasksByGoal)) {
    for (const t of tasks) {
      t.prescription = prescriptions.get(t.id);
    }
  }

  return classified;
}

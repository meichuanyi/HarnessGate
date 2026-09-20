import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const g = promisify(execFile);

async function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  const { stdout } = await g("git", ["-C", cwd, ...args], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

// ---------- 任务结构 ----------

export type CrewTaskStatus =
  | "pending"    // 可认领（依赖已满足）
  | "blocked"    // 有依赖未完成
  | "working"    // worker 正在干
  | "review"     // 干完，等评审
  | "done"       // 评审通过
  | "failed";    // 重试超限

export type CrewTask = {
  id: string;            // T1..Tn（主持人给的）
  title: string;
  spec: string;          // 给 worker 的完整任务书
  files: string[];       // 允许修改的文件/目录（任务间不得相交）
  deps: string[];        // 依赖的任务 id
  status: CrewTaskStatus;
  assignee?: string;     // sessionId
  attempts: number;      // 已评审次数（打回 +1）
  summary?: string;      // worker 的改动摘要
  diff?: string;         // 评审用的 diff（截断存档）
  review?: {
    reviewer: string;
    verdict: "approve" | "revise";
    comments: string;
    /** rubric 总分（0-10）；阈值之下即使 verdict=approve 也会被打回 */
    score?: number;
    /** 按任务书验收标准逐条判定的清单 */
    rubric?: Array<{ item: string; pass: boolean; note?: string }>;
  };
  error?: string;
};

/** 从主持人回复里稳健地抠出任务 JSON（容忍 markdown 围栏、前后废话） */
export function parseTaskBreakdown(text: string): Array<{
  id: string;
  title: string;
  spec: string;
  files: string[];
  deps: string[];
}> {
  const candidates: string[] = [];
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (const f of fences) candidates.push(f[1] ?? "");
  const first = text.indexOf("[");
  const last = text.lastIndexOf("]");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  for (const c of candidates) {
    try {
      const arr = JSON.parse(c.trim());
      if (!Array.isArray(arr) || !arr.length) continue;
      const tasks = arr
        .filter((t: unknown) => t && typeof t === "object")
        .map((t: Record<string, unknown>, i: number) => {
          const id = String(t.id ?? `T${i + 1}`);
          const spec = String(t.spec ?? t.description ?? t.title ?? "");
          const files = (Array.isArray(t.files) ? t.files : []).map(String);
          const deps = (Array.isArray(t.deps) ? t.deps : []).map(String);
          return {
            id,
            title: String(t.title ?? `任务 ${i + 1}`),
            spec: spec || String(t.title ?? ""),
            files,
            deps: deps.filter((d) => d !== id),
          };
        })
        .filter((t) => t.title && t.spec);
      // id 去重
      const seen = new Set<string>();
      const uniq = tasks.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
      if (uniq.length) return uniq.slice(0, 8);
    } catch {
      /* 尝试下一个候选 */
    }
  }
  return [];
}

/** 从评审回复里抠 {"verdict","comments"} */
export function parseVerdict(text: string): { verdict: "approve" | "revise"; comments: string } | null {
  const candidates: string[] = [];
  for (const f of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(f[1] ?? "");
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const o = JSON.parse(c.trim()) as { verdict?: string; comments?: string };
      if (o.verdict === "approve" || o.verdict === "revise") {
        return { verdict: o.verdict, comments: String(o.comments ?? "") };
      }
    } catch {
      /* 下一个 */
    }
  }
  // 兜底：看关键词
  const lower = text.toLowerCase();
  if (/\bapprove\b|通过|同意|没问题/.test(lower)) return { verdict: "approve", comments: text.slice(0, 400) };
  if (/revise|打回|需要修改|问题/.test(lower)) return { verdict: "revise", comments: text.slice(0, 400) };
  return null;
}

export type ParsedReview = {
  verdict: "approve" | "revise";
  score?: number;
  rubric?: Array<{ item: string; pass: boolean; note?: string }>;
  comments: string;
};

/** rubric 评审解析：比 parseVerdict 多抠 score(0-10) 和 rubric 清单。
 *  verdict 抠不到时退回 parseVerdict 的关键词兜底；score/rubric 抠不到就是 undefined（按老语义处理）。 */
export function parseReview(text: string): ParsedReview | null {
  const candidates: string[] = [];
  for (const f of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(f[1] ?? "");
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const o = JSON.parse(c.trim()) as Record<string, unknown>;
      if (o.verdict !== "approve" && o.verdict !== "revise") continue;
      const score = typeof o.score === "number" && o.score >= 0 && o.score <= 10 ? Math.round(o.score) : undefined;
      const rubric = Array.isArray(o.rubric)
        ? o.rubric
            .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
            .map((r) => ({
              item: String(r.item ?? r.name ?? "未命名验收点"),
              pass: r.pass === true || r.pass === "true",
              note: r.note == null ? undefined : String(r.note).slice(0, 200),
            }))
            .slice(0, 10)
        : undefined;
      return {
        verdict: o.verdict as "approve" | "revise",
        score,
        rubric: rubric?.length ? rubric : undefined,
        comments: String(o.comments ?? ""),
      };
    } catch {
      /* 下一个 */
    }
  }
  const v = parseVerdict(text);
  return v ? { verdict: v.verdict, comments: v.comments } : null;
}

// ---------- git 操作（worktree 侧采集 + 主仓合并） ----------

/**
 * worktree：暂存改动 → 返回完整 diff（评审用，截断）。
 * files 非空时只暂存所有权内的路径——把「文件所有权」从提示词约定变成提交层面的强制；
 * 同时排掉 harness 自己生成的运行时垃圾（.zcode/.claude 等）。
 */
export async function stageAndDiff(dir: string, files: string[], maxChars = 9000): Promise<string> {
  const noise = [":!.zcode", ":!.claude", ":!.openclaw"];
  try {
    if (files.length) {
      try {
        await git(dir, ["add", "-A", "--", ...files, ...noise]);
      } catch {
        // pathspec 没匹配到（要新建的文件还不存在等）→ 退回全量但排垃圾
        await git(dir, ["add", "-A", "--", ...noise]);
      }
    } else {
      await git(dir, ["add", "-A", "--", ...noise]);
    }
    const diff = await git(dir, ["diff", "--cached"]);
    return diff.length > maxChars ? diff.slice(0, maxChars) + "\n…（diff 已截断）" : diff;
  } catch (err) {
    return `（取 diff 失败：${err instanceof Error ? err.message : String(err)}）`;
  }
}

/** worktree：提交全部改动；没有改动返回 null */
export async function commitAll(dir: string, message: string): Promise<string | null> {
  try {
    // 只提交 stageAndDiff 按所有权暂存的内容，不再 add -A
    const status = await git(dir, ["status", "--porcelain"]);
    if (!status) return null;
    const out = await git(dir, ["commit", "-m", message]);
    const m = /\[[\w/.-]+ ([0-9a-f]+)\]/.exec(out);
    return m?.[1] ?? "committed";
  } catch (err) {
    throw new Error(`提交改动失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 主仓：是否可以安全 merge。
 * 只看「已跟踪文件的改动」；未跟踪文件（如 harness 运行时目录 .zcode/）不影响合并。
 */
export async function isClean(dir: string): Promise<boolean> {
  try {
    const status = await git(dir, ["status", "--porcelain", "--untracked-files=no"]);
    return !status;
  } catch {
    return false;
  }
}

export type MergeResult = { ok: boolean; conflict: boolean; output: string };

/** 主仓：顺序 merge 一个 worker 分支；冲突时 abort 并返回 conflict=true */
export async function mergeBranch(mainDir: string, branch: string): Promise<MergeResult> {
  try {
    const out = await git(mainDir, ["merge", "--no-ff", "--no-edit", branch]);
    return { ok: true, conflict: false, output: out.split("\n")[0] ?? "merged" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim() || (e.message ?? "merge failed");
    try {
      await g("git", ["-C", mainDir, "merge", "--abort"]);
    } catch {
      /* 没 merge 成也不必 abort */
    }
    const conflict = /CONFLICT|conflict/i.test(output);
    return { ok: false, conflict, output: output.slice(0, 600) };
  }
}

// ---------- 提示词 ----------

/** 评审通过分数线（0-10）：verdict=approve 但总分低于它仍被打回。rubric 打分的意义在「分数有后果」。 */
export const CREW_APPROVE_SCORE = Number(process.env.HG_CREW_APPROVE_SCORE ?? 8);

export function crewBreakdownPrompt(goal: string, members: string[], hostLabel: string): string {
  return [
    `【工作队·任务拆解】目标：${goal}`,
    "",
    `你是工头「${hostLabel}」。队员：${members.join("、")}（每个队员都会在独立的 git worktree 里并行干活）。`,
    "",
    "请把这个目标拆成 2-6 个可独立完成的任务。要求：",
    "1. 每个任务：id（T1、T2…）、title、spec（给队员的完整任务书：做什么、在哪个文件、验收标准是什么）、files（该任务允许创建/修改的文件或目录列表）、deps（依赖的前置任务 id 数组，无依赖为空数组）",
    "2. 任务之间的 files 必须互不相交（不同队员并行改不同文件，相交必冲突）；确实需要先后改同一文件的，用 deps 串成先后",
    "3. 任务要具体到队员不需要再问你就能做完；每个任务预期 5 分钟内可完成",
    "",
    "只输出 JSON 数组，不要输出任何其他文字：",
    `[{"id":"T1","title":"…","spec":"…","files":["…"],"deps":[]}]`,
  ].join("\n");
}

export function crewWorkerPrompt(opts: {
  goal: string;
  task: CrewTask;
  worktreeDir: string;
  reviseComments?: string;
}): string {
  const { goal, task, worktreeDir, reviseComments } = opts;
  const lines = [
    `【工作队·任务】${task.id}：${task.title}`,
    `总目标：${goal}`,
    "",
    "任务书：",
    task.spec,
    "",
    `只允许创建/修改这些文件或目录（其余一律只读）：${task.files.length ? task.files.join("、") : "（未限定，但不要碰无关文件）"}`,
    `你的工作目录（独立 worktree，放开改）：${worktreeDir}`,
    "",
  ];
  if (reviseComments) {
    lines.push("【上一轮评审没有通过，评审意见如下，请针对性修改】", reviseComments, "");
  }
  lines.push(
    "要求：",
    "- 直接动手完成，不要修改任务书之外的文件",
    "- 不要修改或弱化测试来迁就实现；不要用 mock 规避真实实现",
    "- 完成后输出一段不超过 200 字的改动摘要：改了哪些文件、实现了什么、怎么验证的。不要贴大段代码",
  );
  return lines.join("\n");
}

export function crewReviewPrompt(opts: {
  goal: string;
  task: CrewTask;
  reviewerLabel: string;
  coderLabel: string;
}): string {
  const { goal, task, reviewerLabel, coderLabel } = opts;
  return [
    `【工作队·代码评审（rubric 打分制）】总目标：${goal}`,
    "",
    `你是独立评审「${reviewerLabel}」。你没有参与实现，也看不到实现者的讨论过程——只根据下面的任务书和 diff 判断。`,
    `实现者：${coderLabel}。任务 ${task.id}：${task.title}`,
    "",
    "任务书：",
    task.spec,
    "",
    `允许修改的文件：${task.files.length ? task.files.join("、") : "（未限定）"}`,
    "",
    "改动 diff（可能截断）：",
    task.diff || "（无改动）",
    "",
    "评审方法（先建 rubric 再逐条判定）：",
    "1. 从任务书里抽出验收标准（任务书写了就用它的；没写就自己按任务书拆 2-4 个可验证的验收点）",
    "2. 每个验收点评 pass/fail 并给一句依据（对着 diff 说，不说空话）",
    "3. 固定三条防线也要进 rubric：改了任务书范围之外的文件吗 / 修改、删除或弱化了测试吗（含用 mock、占位实现规避真实工作）/ 有明显 bug 吗（逻辑错误、会抛异常的路径、安全问题）",
    `4. 总分 0-10：全部验收点通过且防线干净 = 9-10；小瑕疵 = 7-8；有验收点不过 = 4-6；根本没完成任务 = 0-3。${CREW_APPROVE_SCORE} 分及以上才能通过`,
    "",
    "严格只输出 JSON，不要输出其他文字：",
    '{"verdict":"approve|revise","score":8,"rubric":[{"item":"验收点","pass":true,"note":"依据"}],"comments":"revise 时写具体要改什么"}',
  ].join("\n");
}

export function crewFinalPrompt(opts: {
  goal: string;
  hostLabel: string;
  tasks: CrewTask[];
  mergeLines: string[];
}): string {
  const { goal, hostLabel, tasks, mergeLines } = opts;
  const taskLines = tasks.map((t) => {
    const st = t.status === "done" ? "完成" : t.status === "failed" ? "失败" : t.status;
    return `- [${st}] ${t.id} ${t.title}（${t.assignee ? "队员 " + t.assignee : "未派"}）：${(t.summary ?? t.error ?? "").slice(0, 150)}`;
  });
  return [
    `【工作队·收尾报告】目标：${goal}`,
    "",
    `你是工头「${hostLabel}」。全部任务已结束，任务清单：`,
    ...taskLines,
    "",
    "合并结果：",
    ...mergeLines,
    "",
    "请写收尾报告：① 完成了什么（对照目标）② 哪些没完成/失败及原因 ③ 合并了哪些分支、有没有冲突 ④ 建议的后续动作。控制在 400 字以内。",
  ].join("\n");
}

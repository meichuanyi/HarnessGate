import { exec, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import type { HarnessSpec, WorktreeInfo } from "./types.ts";
import { HarnessSession } from "./session.ts";
import type { SessionHooks } from "./session.ts";
import type { AuditLog } from "./audit.ts";
import type { SessionStore } from "./store.ts";
import type { WorkspaceHub } from "./workspace.ts";
import { createWorktree, removeWorktree, worktreeDiffStat } from "./worktree.ts";
import type { UtilityAskOptions, UtilityAskResult } from "./utility-session.ts";

/**
 * 自主推测执行引擎（Speculative Pipeline）：自主自驱推演核心。
 *
 * 「目标差分推测执行」= 对一个候选行动假设，廉价地实际跑一遍，用产物验证假设：
 *   1. 快速动脑（judgeIntent）：LiteLLM 裸 API 判定任务值不值得投入沙箱执行；
 *   2. 脏活执行（runSpeculativeTask 中段）：起一次性 utility harness 会话，在独立
 *      git worktree 沙箱里跑编译/回测/单测/挖洞——静默不进前端列表，失败即弃；
 *   3. 成果沉淀（收尾）：成功输出简洁报告 + patch，worktree 与分支保留待收编合并。
 *
 * 底座完全复用 utility-session（静默临时会话）与 worktree（隔离/弃置/diff）：
 * - 会话带 utility 标记：不进列表、不广播、不落盘，用完即删；
 * - worktree 分支 hg/spec-*：成功保留（后续按 goalId 收编），失败连分支一起删；
 * - 快速动脑通道优先 apiConfig（OpenAI 兼容裸 API，与 settings 的 utilityMode=api
 *   同一套配置），没配则回退 UtilitySessions.ask，都没有则判定/评审整体跳过。
 */

export type SpeculativePhase = "judge" | "session" | "execute" | "verify";

/** 成果校验器：全过才算推演成功（intent.artifactCheck 支持单个或数组） */
export type SpeculativeArtifactCheck =
  | { kind: "command"; cmd: string; timeoutMs?: number }
  | { kind: "git-dirty" }
  | { kind: "llm-judge"; criteria: string; timeoutMs?: number };

export type SpeculativeIntent = {
  /** 所属目标（目标树 id），结果与保留的分支都按它归档 */
  goalId: string;
  /** 用途标记：审计/日志/worktree 命名（如 "test-typecheck"、"explore-auth-bypass"） */
  purpose: string;
  /** 执行工作区；是 git 仓库时 worktree 从它切出，否则原目录直跑 */
  cwd: string;
  /** 是否切独立 worktree 隔离执行（推荐 true：失败即弃，成功留分支待合并） */
  useWorktree: boolean;
  /** 给执行 harness 的完整指令（想要结构化报告，就在 prompt 里约定输出格式） */
  prompt: string;
  /** 执行 harness id；空 = deps.resolveHarness 自动选 */
  harnessId?: string;
  /** 指定模型（该 harness 模型配置的 value）；空 = harness 自动选首选模型 */
  model?: string;
  /** 快速动脑：执行前判一次值不值得跑。true=直接判；字符串=附加判定上下文（目标树/进度摘要） */
  judge?: boolean | string;
  /** 成果校验（可多个，全过才算成功）；缺省 = 有非空报告即算 */
  artifactCheck?: SpeculativeArtifactCheck | SpeculativeArtifactCheck[];
  /** 执行静默看门狗：agent 这么久没任何事件就判死（毫秒）。默认 15 分钟 */
  silenceTimeoutMs?: number;
  /** 会话就绪等待上限（毫秒）。默认 60 秒 */
  readyTimeoutMs?: number;
  /** 报告截断长度（字符）。默认 8000 */
  maxReportChars?: number;
};

export type SpeculativeJudgement = { proceed: boolean; reason: string; revisedPrompt?: string };

export type SpeculativeSuccess = {
  ok: true;
  goalId: string;
  purpose: string;
  /** 执行会话 id（会话本身已销毁，痕迹只在审计台账） */
  sessionId: string;
  harnessId: string;
  /** 执行 harness 的结论报告 */
  report: string;
  /** worktree 模式的完整 git patch（未跟踪文件经 add -N 纳入）；纯调研任务无改动则为空 */
  patch?: string;
  /** 改动摘要（diff --stat + 未跟踪清单） */
  diffStat?: string;
  /** worktree 分支名（成功即保留，供后续按 goalId 收编合并） */
  branch?: string;
  worktree?: WorktreeInfo;
  judgement?: SpeculativeJudgement;
  elapsedMs: number;
};

export type SpeculativeFailure = {
  ok: false;
  goalId: string;
  purpose: string;
  /** 失败环节 */
  phase: SpeculativePhase;
  error: string;
  /** 执行 agent 已产出的部分文本（超时/校验失败时供复盘） */
  partial?: string;
  judgement?: SpeculativeJudgement;
  elapsedMs: number;
};

export type SpeculativeResult = SpeculativeSuccess | SpeculativeFailure;

/** 快速动脑通道（判定/评审共用）：LiteLLM 裸 API 优先，UtilitySessions.ask 兜底 */
type ThinkChannel = Pick<SpeculativeDeps, "apiConfig" | "ask">;

export type SpeculativeDeps = {
  store: SessionStore;
  audit: AuditLog;
  hub: WorkspaceHub;
  makeHooks: () => SessionHooks;
  /** harness 解析：显式指定 → 设置偏好 → 自动选探活可用（与 UtilitySessions 同款约定） */
  resolveHarness: (explicit?: string) => HarnessSpec | undefined;
  /** harness → 模型配置 configId（intent.model 经 chosen 下发用） */
  modelConfigIdOf: (harnessId: string) => string | undefined;
  /** 快速动脑首选：LiteLLM 裸 API（OpenAI 兼容，settings 里 utilityMode=api 同一套配置）。
   *  非空时判定/评审直接 HTTP，不起 harness 进程 */
  apiConfig?: () => { baseUrl: string; apiKey: string; model: string } | null;
  /** 快速动脑兜底：没配 apiConfig 时走 UtilitySessions.ask（utilityMode=harness 的临时会话） */
  ask?: (opts: UtilityAskOptions) => Promise<UtilityAskResult>;
};

const runBin = promisify(execFile);
const runShell = promisify(exec);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function gitIn(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await runBin("git", ["-C", cwd, ...args], { timeout: 30_000 });
  return stdout.trim();
}

/** 输出尾部截断（错误定位看尾部比看头部有用） */
function tail(s: string, max = 400): string {
  const t = s.trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}

/** 全局并发闸：推测执行会起真 harness 进程，同时最多 N 个（FIFO 排队），
 *  防止夜间批量目标瞬间打满机器。HG_SPEC_CONCURRENCY 覆盖，默认 2。 */
let inflight = 0;
const gateWaiters: Array<() => void> = [];
function gateMax(): number {
  const n = Number(process.env.HG_SPEC_CONCURRENCY ?? 2);
  return Number.isFinite(n) && n > 0 ? n : 2;
}
async function acquireGate(): Promise<void> {
  if (inflight < gateMax()) {
    inflight++;
    return;
  }
  await new Promise<void>((resolve) => gateWaiters.push(resolve));
  inflight++;
}
function releaseGate(): void {
  inflight--;
  const next = gateWaiters.shift();
  if (next) next();
}

/** 从模型回复里抠出第一个 JSON 对象（容忍前后废话/代码围栏） */
function extractJson<T>(text: string): T | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return undefined;
  }
}

/** 快速动脑通道调用：优先 LiteLLM 裸 API，没配回退 UtilitySessions.ask。
 *  返回 undefined = 没有任何通道（或调用失败）——动脑层是锦上添花，失败不拦执行。 */
async function think(
  ch: ThinkChannel,
  purpose: string,
  prompt: string,
  timeoutMs: number,
  maxChars = 2000,
): Promise<string | undefined> {
  const api = ch.apiConfig?.();
  if (api) {
    try {
      const res = await fetch(`${api.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${api.apiKey}` },
        body: JSON.stringify({
          model: api.model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 800,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
      }
      const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = (j.choices?.[0]?.message?.content ?? "").slice(0, maxChars);
      return text.trim() || undefined;
    } catch {
      return undefined;
    }
  }
  if (ch.ask) {
    const r = await ch.ask({ purpose, prompt, timeoutMs, maxReplyChars: maxChars });
    return r.ok ? r.text : undefined;
  }
  return undefined;
}

const JUDGE_HEADER =
  "你是「推测执行引擎」的意图判定器。下面的任务若放行，会起一个一次性 harness 沙箱会话实际执行它" +
  "（推测执行：廉价试错，成功留产物，失败整体丢弃）。" +
  "判断它是否值得现在投入执行：目标是否明确可验证、与既定目标是否相关、预期收益是否大于一次沙箱会话的成本。\n" +
  '只输出一个 JSON 对象，不要任何其他文字：{"proceed": true, "reason": "一句话理由", "revisedPrompt": "可选：改写后更明确的执行指令，无必要则省略此字段"}';

/** 快速动脑层：判断这个推测任务值不值得投入沙箱执行。
 *  返回 undefined = 没有可用动脑通道（调用方自行决定是否放行）。 */
export async function judgeIntent(
  prompt: string,
  deps: SpeculativeDeps,
  opts?: { extra?: string; timeoutMs?: number },
): Promise<SpeculativeJudgement | undefined> {
  const text = await think(
    deps,
    "speculative-judge",
    `${JUDGE_HEADER}\n\n${opts?.extra ? `【判定上下文】\n${opts.extra.slice(0, 3000)}\n\n` : ""}【待判定任务】\n${prompt.slice(0, 4000)}`,
    opts?.timeoutMs ?? 30_000,
  );
  if (!text) return undefined;
  const j = extractJson<Partial<SpeculativeJudgement>>(text);
  if (!j || typeof j.proceed !== "boolean" || !j.reason) {
    return { proceed: true, reason: "判定输出无法解析，放行执行" };
  }
  return {
    proceed: j.proceed,
    reason: String(j.reason),
    revisedPrompt:
      typeof j.revisedPrompt === "string" && j.revisedPrompt.trim() ? j.revisedPrompt.trim() : undefined,
  };
}

/** 成果校验：全部通过才算推演成功。
 *  - command：在沙箱目录跑一条命令，退出码 0 = 过（如 npm run typecheck）；
 *  - git-dirty：沙箱里有实际改动（diff --stat + 未跟踪文件）才算数；
 *  - llm-judge：快速动脑通道按 criteria 评审执行报告。 */
export async function verifyArtifact(
  check: SpeculativeArtifactCheck,
  dir: string,
  ctx: { worktree?: WorktreeInfo; report?: string; deps?: ThinkChannel },
): Promise<{ ok: boolean; note: string }> {
  if (check.kind === "git-dirty") {
    // worktreeDiffStat 只用到 dir；非 worktree 沙箱也能用（对 HEAD 的改动 + 未跟踪清单）
    const stat = await worktreeDiffStat(ctx.worktree ?? { dir, branch: "", repo: dir });
    return stat ? { ok: true, note: stat } : { ok: false, note: "沙箱没有任何实际改动" };
  }
  if (check.kind === "command") {
    try {
      const { stdout, stderr } = await runShell(check.cmd, {
        cwd: dir,
        timeout: check.timeoutMs ?? 120_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return { ok: true, note: tail(`${stdout}\n${stderr}`) };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
      const out = tail(`${e.stdout ?? ""}\n${e.stderr ?? ""}`, 600) || e.message || "命令失败";
      return {
        ok: false,
        note: e.killed ? `校验命令超时（${check.timeoutMs ?? 120_000}ms）：${out}` : out,
      };
    }
  }
  // llm-judge：无动脑通道时放行（评审是增益项，不能因通道缺失把成功推演判死）
  const report = (ctx.report ?? "").slice(0, 6000);
  const text = await think(
    ctx.deps ?? {},
    "speculative-verify",
    "你是「推测执行引擎」的成果评审员。只依据验收标准与执行产出判断，不确定就判不通过。\n" +
      '只输出一个 JSON 对象：{"pass": true, "note": "一句话依据"}\n\n' +
      `【验收标准】\n${check.criteria}\n\n【执行报告】\n${report}`,
    check.timeoutMs ?? 45_000,
  );
  if (!text) return { ok: true, note: "无动脑通道，跳过评审放行" };
  const j = extractJson<{ pass?: boolean; note?: string }>(text);
  if (!j || typeof j.pass !== "boolean") return { ok: true, note: `评审输出无法解析，放行（原文：${tail(text, 120)}）` };
  return { ok: j.pass, note: String(j.note ?? "") };
}

/** worktree 完整 patch：git add -N 让未跟踪文件也进 diff（只登记意图不暂存内容），再 diff HEAD */
async function patchOf(dir: string): Promise<string> {
  try {
    await gitIn(dir, ["add", "-N", "."]);
  } catch {
    /* 尽力而为：纯 tracked 改动也能出 patch */
  }
  try {
    const out = await gitIn(dir, ["diff", "HEAD"]);
    const MAX = 120_000;
    return out.length > MAX ? `${out.slice(0, MAX)}\n…（patch 过长已截断，完整内容见 worktree 分支）` : out;
  } catch {
    return "";
  }
}

/** 弃置失败的推测沙箱：worktree 连同分支一起删（成功路径才保留分支待收编） */
export async function discardWorktree(info: WorktreeInfo): Promise<void> {
  await removeWorktree(info);
  try {
    await gitIn(info.repo, ["branch", "-D", info.branch]);
  } catch {
    /* 尽力而为 */
  }
}

/** 分支/目录名片段：purpose 里只留安全字符，中文等替换为 - */
function slugOf(s: string, max: number): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max) || "task";
}

/**
 * 核心调度：一次完整的「意图判定 → 沙箱执行 → 成果校验 → 报告/patch 沉淀」。
 *
 * 失败语义（与 utility-session 同款哲学）：绝不抛出——任何环节失败都返回 ok=false；
 * worktree 沙箱失败即整体弃置（连分支），成功则保留分支供后续按 goalId 收编。
 */
export async function runSpeculativeTask(
  intent: SpeculativeIntent,
  deps: SpeculativeDeps,
): Promise<SpeculativeResult> {
  const t0 = Date.now();
  const audit = (op: string, extra: Record<string, unknown> = {}): void =>
    deps.audit.append({ op, goalId: intent.goalId, purpose: intent.purpose, cwd: intent.cwd, ...extra });

  let judgement: SpeculativeJudgement | undefined;
  let wt: WorktreeInfo | undefined;
  let sess: HarnessSession | undefined;
  let sessionId: string | undefined;
  /** 收尾统一弃置沙箱；成功路径先把 wt 置空（沙箱保留待收编）再返回 */
  const fail = (phase: SpeculativePhase, error: string, partial?: string): SpeculativeFailure => {
    audit("speculative.failed", { phase, error: error.slice(0, 300) });
    return {
      ok: false,
      goalId: intent.goalId,
      purpose: intent.purpose,
      phase,
      error,
      ...(partial ? { partial } : {}),
      ...(judgement ? { judgement } : {}),
      elapsedMs: Date.now() - t0,
    };
  };

  await acquireGate();
  try {
    audit("speculative.start", { worktree: intent.useWorktree });

    // ── 1) 快速动脑：意图判定 ────────────────────────────────────────────
    let prompt = intent.prompt;
    if (intent.judge) {
      const j = await judgeIntent(prompt, deps, {
        extra: typeof intent.judge === "string" ? intent.judge : undefined,
      });
      // 无通道/输出不可解析都放行（judgeIntent 内已兜底）；明确不放行才拦
      judgement = j ?? { proceed: true, reason: "无快速动脑通道，跳过判定直接执行" };
      audit("speculative.judge", { proceed: judgement.proceed, reason: judgement.reason.slice(0, 300) });
      if (!judgement.proceed) {
        return fail("judge", `意图判定不放行：${judgement.reason}`);
      }
      if (judgement.revisedPrompt) prompt = judgement.revisedPrompt;
    }

    // ── 2) worktree 沙箱：切不出来不拦任务，降级原目录直跑（与 index.ts create 同款）──
    if (intent.useWorktree) {
      const sandboxId = `spec-${slugOf(intent.purpose, 24)}-${randomUUID().slice(0, 6)}`;
      try {
        wt = (await createWorktree(intent.cwd, sandboxId)) ?? undefined;
      } catch (err) {
        audit("speculative.worktree.failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      audit("speculative.worktree", wt ? { branch: wt.branch, dir: wt.dir } : { skipped: true });
    }
    const sandbox = wt?.dir ?? intent.cwd;

    // ── 3) 起一次性 utility harness 会话执行脏活 ────────────────────────
    const spec = deps.resolveHarness(intent.harnessId);
    if (!spec) return fail("session", "没有可用 harness");
    const record = HarnessSession.newRecord(spec, sandbox);
    record.utility = true;
    record.title = `推演 ${intent.goalId}: ${intent.purpose}`;
    if (intent.model) {
      const mcid = deps.modelConfigIdOf(spec.id);
      if (mcid) record.chosen = { [mcid]: intent.model };
    }
    // 工具会话全静默：不进列表/不广播/不落盘（推测过程无保留价值，结果在本函数返回值里）
    const quietHooks: SessionHooks = {
      ...deps.makeHooks(),
      onStatus: () => {},
      onUpdate: () => {},
      onTurnEnd: () => {},
      onPermission: () => {},
      onLog: () => {},
      onPersist: () => {},
      onStopped: () => {},
    };
    sess = new HarnessSession(spec, record, deps.audit, quietHooks, deps.hub);
    sessionId = record.id;
    // 沙箱里跑编译/测试必然要工具授权：permissiveMode 就绪后切最宽 mode（从源头少授权），
    // autoApprove=all 兜底没有 modes 的 harness——推测任务没人点按钮，挂死即失败
    sess.permissiveMode = true;
    sess.autoApprove = "all";
    sess.intentTag = `speculative:${intent.goalId} ${intent.purpose}`;
    void sess.start("new");

    const readyMs = intent.readyTimeoutMs ?? 60_000;
    const readyDeadline = Date.now() + readyMs;
    let ready = false;
    while (Date.now() < readyDeadline) {
      const st = sess.info().status;
      if (st === "ready" || st === "awaiting") {
        ready = true;
        break;
      }
      if (st === "error") break;
      await sleep(400);
    }
    if (!ready) {
      return fail("session", `执行会话未就绪（${sess?.info().status ?? "unknown"}）`);
    }

    // ── 4) 执行：静默看门狗只看「多久没动静」，不看总时长（长任务合法）────
    const silenceMs = intent.silenceTimeoutMs ?? 900_000;
    const done = await sess.promptAndWait(prompt, silenceMs);
    const report = (done.text || "").trim().slice(0, intent.maxReportChars ?? 8000);
    if (done.stopReason === "idle-timeout") {
      return fail("execute", `执行静默超过 ${Math.round(silenceMs / 60_000)} 分钟，按无进展判死`, report);
    }
    if (done.stopReason === "refusal") return fail("execute", "执行方拒绝该任务", report);
    if (done.stopReason === "error" || !report) {
      return fail("execute", `执行无有效产出（stopReason=${done.stopReason}）`, report);
    }
    audit("speculative.executed", { stopReason: done.stopReason, chars: report.length });

    // ── 5) 成果校验：全过才算成功；不过 = 推测证伪，沙箱整体弃置 ──────────
    const checks =
      intent.artifactCheck === undefined
        ? []
        : Array.isArray(intent.artifactCheck)
          ? intent.artifactCheck
          : [intent.artifactCheck];
    for (const check of checks) {
      const v = await verifyArtifact(check, sandbox, { worktree: wt, report, deps });
      if (!v.ok) {
        audit("speculative.verify.failed", { kind: check.kind, note: v.note.slice(0, 500) });
        return fail("verify", `成果校验未通过（${check.kind}）：${v.note}`, report);
      }
    }

    // ── 6) 成果沉淀：报告 + patch，worktree/分支保留待收编 ───────────────
    let patch: string | undefined;
    let diffStat: string | undefined;
    if (wt) {
      patch = (await patchOf(wt.dir)) || undefined;
      diffStat = (await worktreeDiffStat(wt)) || undefined;
    }
    audit("speculative.done", {
      sessionId: record.id,
      harnessId: spec.id,
      branch: wt?.branch,
      patchBytes: patch?.length ?? 0,
      elapsedMs: Date.now() - t0,
    });
    const result: SpeculativeSuccess = {
      ok: true,
      goalId: intent.goalId,
      purpose: intent.purpose,
      sessionId: record.id,
      harnessId: spec.id,
      report,
      ...(patch ? { patch } : {}),
      ...(diffStat ? { diffStat } : {}),
      ...(wt ? { branch: wt.branch, worktree: wt } : {}),
      ...(judgement ? { judgement } : {}),
      elapsedMs: Date.now() - t0,
    };
    wt = undefined;   // 成功：沙箱保留（分支待收编），收尾不再弃置
    return result;
  } catch (err) {
    return fail("execute", err instanceof Error ? err.message : String(err));
  } finally {
    try {
      await sess?.stop();
    } catch {
      /* 尽力而为 */
    }
    if (sessionId) deps.store.remove(sessionId);
    // 走到这里 wt 还有值 = 中途失败/异常（推测证伪）：沙箱连同分支整体弃置
    if (wt) await discardWorktree(wt).catch(() => {});
    releaseGate();
  }
}

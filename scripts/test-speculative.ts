#!/usr/bin/env node
/**
 * 推测执行引擎（server/speculative.ts）自测：
 *
 *   npm run test:speculative                 # 离线部分：worktree 沙箱 + 成果校验器（不起 harness）
 *   npm run test:speculative -- --live       # 追加端到端：真起 zcode 在沙箱里干一件小事
 *   npm run test:speculative -- --live --harness codex
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { AuditLog } from "../server/audit.ts";
import type { SessionHooks } from "../server/session.ts";
import { SessionStore } from "../server/store.ts";
import type { HarnessSpec } from "../server/types.ts";
import { WorkspaceHub } from "../server/workspace.ts";
import { createWorktree, ensureCrewRepo } from "../server/worktree.ts";
import {
  discardWorktree,
  judgeIntent,
  runSpeculativeTask,
  verifyArtifact,
  type SpeculativeDeps,
  type SpeculativeIntent,
} from "../server/speculative.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function makeRepo(dir: string, file: string): Promise<void> {
  return (async () => {
    mkdirSync(dir, { recursive: true });
    await ensureCrewRepo(dir);
    writeFileSync(join(dir, file), "base\n");
    execFileSync("git", ["-C", dir, "add", "."]);
    execFileSync("git", ["-C", dir, "-c", "user.email=t@local", "-c", "user.name=t", "commit", "-m", "base"]);
  })();
}

const makeHooks = (): SessionHooks => ({
  onStatus: () => {},
  onUpdate: () => {},
  onTurnEnd: () => {},
  onPermission: () => {},
  onLog: () => {},
  onPersist: () => {},
  onStopped: () => {},
});

const tmp = join(tmpdir(), `hg-spec-test-${Date.now()}`);
mkdirSync(tmp, { recursive: true });

// ── 离线部分：沙箱生命周期 + 成果校验器（不依赖任何 harness） ─────────────
console.log("离线：worktree 沙箱与成果校验器");
const repo = join(tmp, "repo");
await makeRepo(repo, "base.txt");
const wt = await createWorktree(repo, "spec-selftest");
check("worktree 创建", Boolean(wt) && existsSync(wt!.dir));
if (wt) {
  const clean = await verifyArtifact({ kind: "git-dirty" }, wt.dir, { worktree: wt });
  check("git-dirty：无改动判不过", !clean.ok);
  writeFileSync(join(wt.dir, "hello.txt"), "speculative-ok\n");
  const dirty = await verifyArtifact({ kind: "git-dirty" }, wt.dir, { worktree: wt });
  check("git-dirty：有改动判过", dirty.ok);
  const hit = await verifyArtifact({ kind: "command", cmd: "grep -q speculative-ok hello.txt" }, wt.dir, {});
  check("command：grep 命中判过", hit.ok, hit.note);
  const miss = await verifyArtifact({ kind: "command", cmd: "grep -q no-such hello.txt" }, wt.dir, {});
  check("command：grep 不中判不过", !miss.ok, miss.note);
  const skip = await verifyArtifact({ kind: "llm-judge", criteria: "报告提到成功" }, wt.dir, {
    report: "一切正常",
    deps: {},
  });
  check("llm-judge：无动脑通道放行", skip.ok);
  await discardWorktree(wt);
  check("discardWorktree：目录已删", !existsSync(wt.dir));
  let branchGone = false;
  try {
    execFileSync("git", ["-C", repo, "rev-parse", "--verify", wt.branch], { stdio: "ignore" });
  } catch {
    branchGone = true;
  }
  check("discardWorktree：分支已删", branchGone);
}
const noChannel = await judgeIntent("随便什么任务", {} as unknown as SpeculativeDeps);
check("judgeIntent：无动脑通道返回 undefined（由调用方放行）", noChannel === undefined);

// ── 端到端（--live）：真起 harness 在沙箱里干一件小事 ────────────────────
if (flag("--live")) {
  console.log("端到端：起 harness 实跑（--live）");
  const harnessJson = JSON.parse(
    readFileSync(fileURLToPath(new URL("../harness.json", import.meta.url)), "utf8"),
  ) as { harnesses: HarnessSpec[] };
  const spec = harnessJson.harnesses.find((h) => h.id === (value("--harness") ?? "zcode"));
  if (!spec) {
    console.error(`  ✗ harness.json 里找不到 ${value("--harness") ?? "zcode"}`);
    process.exitCode = 1;
  } else {
    const audit = new AuditLog(join(tmp, "audit.jsonl"));
    const deps: SpeculativeDeps = {
      store: new SessionStore(join(tmp, "sessions.json")),
      audit,
      hub: new WorkspaceHub(audit),
      makeHooks,
      resolveHarness: () => spec,
      modelConfigIdOf: () => undefined,
    };
    const repo2 = join(tmp, "repo2");
    await makeRepo(repo2, "keep.txt");
    const intent: SpeculativeIntent = {
      goalId: "selftest",
      purpose: "selftest-hello",
      cwd: repo2,
      useWorktree: true,
      prompt: "在当前目录创建文件 hello-spec.txt，内容恰好一行：speculative-ok。只做这一件事，做完回复：DONE",
      artifactCheck: [{ kind: "git-dirty" }, { kind: "command", cmd: "grep -q speculative-ok hello-spec.txt" }],
      readyTimeoutMs: 90_000,
      silenceTimeoutMs: 300_000,
    };
    const r = await runSpeculativeTask(intent, deps);
    check("live：推演成功", r.ok, r.ok ? "" : `phase=${r.phase} ${r.error}`);
    if (r.ok) {
      check("live：patch 含新文件", Boolean(r.patch?.includes("hello-spec.txt")));
      check("live：分支保留待收编", Boolean(r.branch));
      console.log(`  · 报告：${r.report.replace(/\s+/g, " ").slice(0, 160)}`);
      if (r.worktree) {
        await discardWorktree(r.worktree);
        check("live：手动收编后清理沙箱", !existsSync(r.worktree.dir));
      }
    }
    // 反例：成果校验不过 = 推测证伪，沙箱与分支整体弃置，会话记录无残留
    const bad = await runSpeculativeTask(
      { ...intent, purpose: "selftest-bad", artifactCheck: [{ kind: "command", cmd: "test -f never-exists.txt" }] },
      deps,
    );
    check("live：校验不过判失败（phase=verify）", !bad.ok && bad.phase === "verify", bad.ok ? "竟然成功了" : bad.error.slice(0, 120));
    check("live：失败后会话记录无残留", deps.store.all().length === 0, `剩 ${deps.store.all().length} 条`);
    const wtRoot = join(process.env.HOME ?? "/root", ".harnessgate", "worktrees");
    const leftover = existsSync(wtRoot)
      ? readdirSync(wtRoot).filter((d) => d.startsWith("spec-selftest-"))
      : [];
    check("live：失败后无残留 spec 沙箱", leftover.length === 0, leftover.join(", "));
  }
}

rmSync(tmp, { recursive: true, force: true });
if (failed) {
  console.error(`\n${failed} 项未通过`);
  process.exitCode = 1;
} else {
  console.log("\n全部通过");
}

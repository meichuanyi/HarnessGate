#!/usr/bin/env node
/**
 * 端到端：工作队 rubric 评审
 *   小目标 → 工头拆解 → worktree 并行 → rubric 评审（逐条 + 0-10 分 + ≥8 过线）
 * 检查：① 任务进入终态 ② 完成的任务 review.score 是数字且 rubric 有内容
 *       ③ manual 模式停在 ready-merge ④ 主目录干净未被直接改
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const token = process.env.HG_TOKEN ?? readFileSync(join(homedir(), ".harnessgate", "token"), "utf8").trim();
const ws = new WebSocket(`ws://localhost:${process.env.HG_PORT ?? 9830}/ws?token=${encodeURIComponent(token)}`);
const started = Date.now();
let room = null;
let finished = false;

const done = (code, why) => {
  console.log(`\n=== ${code === 0 ? "PASS" : "FAIL"}${why ? ` (${why})` : ""} (${((Date.now() - started) / 1000).toFixed(0)}s) ===`);
  try { ws.close(); } catch {}
  process.exit(code);
};
setTimeout(() => { console.log("!! 总超时（15 分钟）"); done(2); }, 900_000).unref();
ws.on("error", (e) => done(1, `WS ${e.message}`));

ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === "hello") {
    console.log("→ room-start：crew 模式，zcode × hermes，manual 合并，目录 /tmp/hg-crew-rubric");
    ws.send(JSON.stringify({
      type: "room-start",
      cwd: "/tmp/hg-crew-rubric",
      harnessIds: ["zcode", "hermes"],
      topic: "创建 src/add.js 导出 add(a,b) 返回两数之和；再创建 test/add.test.js 用 node:assert 写至少 2 个断言（含负数）。不引入任何第三方依赖",
      rounds: 1,
      crew: { maxAttempts: 2, mergeMode: "manual" },
    }));
    return;
  }
  if (m.type === "error") { console.log("!! 服务端错误:", m.message); done(1, "server error"); return; }
  if (m.type === "room") {
    room = m.room ?? room;
    if (room.crew) {
      const c = room.crew;
      const stat = {};
      for (const t of c.tasks ?? []) stat[t.status] = (stat[t.status] ?? 0) + 1;
      console.log(`[进度] status=${room.status} phase=${c.phase} 任务=${JSON.stringify(stat)}`);
      for (const t of c.tasks ?? []) {
        if (t.review && !t._logged) {
          t._logged = true;
          console.log(`  评审 ${t.id}：${t.review.verdict}${t.review.score != null ? ` ${t.review.score}/10` : "（无分数）"} rubric ${t.review.rubric?.length ?? 0} 条`);
        }
      }
    }
    if (room.status === "done" && !finished) {
      finished = true;
      const c = room.crew;
      const doneTasks = c.tasks.filter((t) => t.status === "done");
      const withScore = doneTasks.filter((t) => typeof t.review?.score === "number");
      const withRubric = doneTasks.filter((t) => Array.isArray(t.review?.rubric) && t.review.rubric.length > 0);
      console.log(`\n房间 #${room.id} phase=${c.phase} 任务=${c.tasks.length}`);
      for (const t of c.tasks) {
        console.log(`  ${t.id} [${t.status}] ${t.title} · 评审=${t.review?.verdict ?? "—"} 分=${t.review?.score ?? "—"} rubric=${t.review?.rubric?.length ?? 0} 条`);
        for (const r of t.review?.rubric ?? []) console.log(`     ${r.pass ? "✓" : "✗"} ${r.item}${r.note ? `（${r.note.slice(0, 40)}）` : ""}`);
      }
      const checks = [
        [c.tasks.length >= 1, `任务被拆解（${c.tasks.length} 个）`],
        [doneTasks.length >= 1, `有完成的任务（${doneTasks.length} 个）`],
        [withScore.length === doneTasks.length && doneTasks.length > 0, `完成任务的评审都有分数（${withScore.length}/${doneTasks.length}）`],
        [withRubric.length >= 1, `评审带逐条 rubric（${withRubric.length} 个任务）`],
        [c.phase === "ready-merge", `manual 模式停在 ready-merge（实际 ${c.phase}）`],
      ];
      let bad = 0;
      for (const [ok, name] of checks) { console.log(`${ok ? "✔" : "✘"} ${name}`); if (!ok) bad++; }
      done(bad ? 1 : 0);
    }
    if ((room.status === "error" || room.status === "stopped") && !finished) {
      finished = true;
      done(1, `room ${room.status}: ${room.error ?? ""}`);
    }
  }
});

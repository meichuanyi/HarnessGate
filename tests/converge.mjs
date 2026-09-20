#!/usr/bin/env node
/**
 * 端到端验证：无上限轮数 + 共识即停
 *   npx tsx 不需要；纯 WS 客户端。期望：
 *   1. rounds=0 的 room-start 被接受
 *   2. 第 2 轮（MIN_CONVERGE_ROUNDS）小结后主持人判定收敛 → 提前结束
 *   3. room.status=done、topic.convergedRound=2、rounds 保持 0
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
setTimeout(() => { console.log("!! 总超时"); done(2); }, 540_000).unref();

ws.on("error", (e) => done(1, `WS ${e.message}`));

ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === "hello") {
    console.log("→ room-start：rounds=0（无上限）+ converge=true，成员 zcode + hermes，主持=zcode 兼任");
    ws.send(JSON.stringify({
      type: "room-start",
      cwd: "/tmp/hg-converge-test",
      harnessIds: ["zcode", "hermes"],
      topic: "1+1 等于几？请各自给出答案；如果所有人答案一致且没有异议，这就是一场已收敛的讨论",
      rounds: 0,
      converge: true,
      mode: "parallel",
      writeAllowed: false,
      host: { harnessId: "zcode", opening: true, roundSummary: true, finalSummary: true, style: "convergent" },
    }));
    return;
  }
  if (m.type === "error") { console.log("!! 服务端错误:", m.message); done(1, "server error"); return; }
  if (m.type === "room") {
    room = m.room ?? room;
    const last = room.topics?.[room.topics.length - 1] ?? room;
    const round = last.currentRound;
    if (round != null) console.log(`[进度] 状态=${room.status} 当前轮=${round} 发言=${room.turns.length}`);
    if (room.status === "done" && !finished) {
      finished = true;
      const t = room.topics?.[room.topics.length - 1] ?? {};
      console.log(`\n房间 #${room.id} status=${room.status} rounds=${room.rounds} converge=${room.converge} convergedRound=${t.convergedRound ?? "无"} 发言=${room.turns.length}`);
      for (const x of room.turns) {
        console.log(`  [第${x.round}轮] ${x.hostRole ?? x.kind}/${x.harnessLabel} (${x.reply.length} 字): ${x.reply.replace(/\s+/g, " ").slice(0, 70)}…`);
      }
      const checks = [
        [room.rounds === 0, `rounds 保持 0（实际 ${room.rounds}）`],
        [t.convergedRound === 2, `在第 2 轮收敛（实际 ${t.convergedRound ?? "无"}）`],
        [room.turns.some((x) => x.hostRole === "round-summary" && x.round === 2 && /已收敛/.test(x.reply)), "第 2 轮小结里有收敛判定"],
        [room.turns.some((x) => x.hostRole === "final"), "最终汇总执行了"],
        [!room.turns.some((x) => x.round >= 3), "没有跑进第 3 轮（确实提前结束）"],
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

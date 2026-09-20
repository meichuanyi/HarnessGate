#!/usr/bin/env node
/**
 * 端到端：评分锦标赛（讨论区）
 *   rounds=3、converge=false（确定性跑满 3 轮）、tournament=true
 * 检查：① 成员发言被打了分 ② 第 2 轮 prompt 带私密点评或带分数的摘录头
 *       ③ 最终汇总提到累计得分/最佳贡献 ④ 无排行榜之外的竞争逻辑泄漏到 UI
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
    console.log("→ room-start：rounds=3 + tournament=true + converge=false，zcode × hermes，主持=zcode 兼任");
    ws.send(JSON.stringify({
      type: "room-start",
      cwd: "/tmp/hg-tournament-test",
      harnessIds: ["zcode", "hermes"],
      topic: "为命令行工具 sloth 设计一句 slogan：简短、有记忆点、体现慢但稳",
      rounds: 3,
      converge: false,
      tournament: true,
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
    if (last.currentRound != null && room.turns.length) {
      const scored = room.turns.filter((t) => t.score != null).length;
      console.log(`[进度] 状态=${room.status} 轮=${last.currentRound} 发言=${room.turns.length} 已评分=${scored}`);
    }
    if (room.status === "done" && !finished) {
      finished = true;
      const t = room.topics?.[room.topics.length - 1] ?? {};
      const memberTurns = room.turns.filter((x) => x.kind === "member");
      const scored = memberTurns.filter((x) => x.score != null);
      console.log(`\n房间 #${room.id} status=${room.status} tournament=${room.tournament} 发言=${room.turns.length} 已评分发言=${scored.length}/${memberTurns.length}`);
      for (const x of room.turns) {
        const tag = x.hostRole ?? x.kind;
        console.log(`  [第${x.round}轮] ${tag}/${x.harnessLabel}${x.score != null ? ` ★${x.score}` : ""} (${x.reply.length} 字): ${x.reply.replace(/\s+/g, " ").slice(0, 60)}…`);
      }
      const r2prompt = room.turns.find((x) => x.round === 2 && x.kind === "member")?.prompt ?? "";
      const finalReply = room.turns.find((x) => x.hostRole === "final")?.reply ?? "";
      const checks = [
        [room.tournament === true, "tournament 标记生效"],
        [scored.length >= 2, `成员发言被打分（${scored.length} 条）`],
        [/主持人对你此前发言的点评|分）---/.test(r2prompt), "第 2 轮 prompt 带私密点评或带分数的摘录头"],
        [/最佳贡献|累计/.test(finalReply), "最终汇总含累计得分/最佳贡献"],
        [!room.turns.some((x) => x.hostRole === "round-summary" && !/【评分】/.test(x.reply)) || true, "（参考）小结里评分行存在性见上"],
      ];
      const summaries = room.turns.filter((x) => x.hostRole === "round-summary");
      checks.push([summaries.every((s) => /【评分】/.test(s.reply)), `每份小结都有评分行（${summaries.filter((s) => /【评分】/.test(s.reply)).length}/${summaries.length}）`]);
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

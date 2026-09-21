#!/usr/bin/env node
/**
 * 断点续跑 e2e（讨论区）：
 *   ① 开 2 轮圆桌（converge=off，确定性跑满）
 *   ② 第 1 轮完成、第 2 轮进行中 → room-stop
 *   ③ room-run 继续运行 → 应从第 2 轮继续（不重说第 1 轮），最终 done 且总轮数正确
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const token = readFileSync(join(homedir(), ".harnessgate", "token"), "utf8").trim();
const ws = new WebSocket(`ws://localhost:9830/ws?token=${encodeURIComponent(token)}`);
const started = Date.now();
let room = null, phase = "run1", r1Done = false, stopped = false;
const fails = [];
const check = (n, ok, x = "") => { console.log(`${ok ? "✔" : "✘"} ${n}${x ? "  " + x : ""}`); if (!ok) fails.push(n); };
const done = (c, w) => { console.log(`\n=== ${c ? "PASS" : "FAIL"}${w ? ` (${w})` : ""} (${((Date.now() - started) / 1000).toFixed(0)}s) ===`); try { ws.close(); } catch {}; process.exit(c ? 0 : 1); };
setTimeout(() => done(false, "总超时"), 540_000).unref();
ws.on("error", (e) => done(false, `WS ${e.message}`));

ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === "hello") {
    console.log("① 开圆桌：zcode × hermes，2 轮，无收敛判定");
    ws.send(JSON.stringify({
      type: "room-start", cwd: "/tmp/hg-resume-test",
      harnessIds: ["zcode", "hermes"],
      topic: "用一句话给“断点续跑”下个定义，并说一个工程上最难的部分",
      rounds: 2, converge: false, mode: "parallel", writeAllowed: false,
      host: { harnessId: "zcode", opening: true, roundSummary: true, finalSummary: true, style: "convergent" },
    }));
    return;
  }
  if (m.type === "error") { console.log("!! 服务端:", m.message); done(false); return; }
  if (m.type === "room") {
    room = m.room ?? room;
    const last = room.topics?.[room.topics.length - 1] ?? room;
    const memberTurns = (room.turns || []).filter((t) => t.kind === "member");
    const r1 = memberTurns.filter((t) => t.round === 1).length;
    const r2 = memberTurns.filter((t) => t.round === 2).length;
    if (phase === "run1" && r1 >= 2 && !r1Done) {
      r1Done = true;
      console.log("② 第 1 轮完成，发 room-stop（制造中断）");
      ws.send(JSON.stringify({ type: "room-stop", roomId: room.id }));
      stopped = true;
      return;
    }
    if (stopped && room.status === "stopped" && phase === "run1") {
      phase = "run2";
      console.log(`③ 已停止（第 2 轮已说了 ${r2}/2 条）。轮询发 room-run 继续运行`);
      room._r2AtStop = r2;
      // 老循环完全退场前 room-run 会被防重入吞掉——每 5 秒重试直到状态变 running（等价于用户多点几次）
      const iv = setInterval(() => {
        if (room.status === "running") { clearInterval(iv); return; }
        if (room.status === "stopped" || room.status === "error") {
          ws.send(JSON.stringify({ type: "room-run", roomId: room.id }));
        }
      }, 5000);
      setTimeout(() => clearInterval(iv), 300_000);
      return;
    }
    if (phase === "run2" && room.status === "done") {
      const t = room.topics?.[room.topics.length - 1] ?? {};
      const final = (room.turns || []).filter((x) => x.hostRole === "final");
      const r2after = (room.turns || []).filter((x) => x.kind === "member" && x.round === 2).length;
      const roundsSeen = new Set(memberTurns.map((x) => x.round));
      console.log(`\n终态：status=${room.status} 第1轮=${r1}条 第2轮=${r2after}条 convergedRound=${t.convergedRound ?? "—"}`);
      check("停止后能继续运行并跑完", room.status === "done");
      check("从第 2 轮继续（没有重说第 1 轮）", r1 === 2 && roundsSeen.size === 2, `出现过的轮：${[...roundsSeen].join(",")}`);
      check("最终汇总执行了", final.length === 1);
      check("总发言数符合 2 成员 × 2 轮", memberTurns.length === 4, `${memberTurns.length} 条`);
      done(fails.length === 0);
    }
    if (phase === "run2" && (room.status === "error")) done(false, `room error: ${room.error}`);
  }
});

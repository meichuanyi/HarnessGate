#!/usr/bin/env node
/**
 * 端到端：打断当前回合（interrupt）
 *   ① 发一个会长流输出的请求 → 收到流式 chunk 后发 interrupt
 *   ② turn 应以 cancelled 结束（而不是等到自然结束）
 *   ③ 会话保持可用：紧接着再发一条消息能正常收到回复
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const token = process.env.HG_TOKEN ?? readFileSync(join(homedir(), ".harnessgate", "token"), "utf8").trim();
const ws = new WebSocket(`ws://localhost:${process.env.HG_PORT ?? 9830}/ws?token=${encodeURIComponent(token)}`);
const started = Date.now();
let sid = null;
let phase = "create";
let chunkAt = 0;
let endStopReason = null;
let sawInTurn = false;
const fails = [];
const check = (n, ok, extra = "") => { console.log(`${ok ? "✔" : "✘"} ${n}${extra ? "  " + extra : ""}`); if (!ok) fails.push(n); };
const tail = (ms) => new Promise((r) => setTimeout(r, ms));

ws.on("error", (e) => { console.log("WS 错误", e.message); process.exit(1); });
setTimeout(() => { console.log("!! 总超时"); process.exit(2); }, 240_000).unref();

ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === "hello") {
    ws.send(JSON.stringify({ type: "create", harnessId: "zcode", cwd: "/tmp/hg-interrupt-test" }));
    return;
  }
  if (m.type === "session" && m.session.cwd === "/tmp/hg-interrupt-test") {
    if (m.session.inTurn) sawInTurn = true;
    if (phase === "create" && m.session.status === "ready") {
      sid = m.session.id;
      phase = "gen";
      console.log("① 会话就绪，发一个长任务（数到 30，每个数一行）");
      ws.send(JSON.stringify({ type: "prompt", sessionId: sid, text: "请从 1 数到 30，每个数单独一行，不要省略。只输出数字。" }));
    }
    if (phase === "gen" && m.session.inTurn) {
      // 一看到 inTurn=true 就等第一个 chunk 再打断
    }
    if (phase === "after" && m.session.status === "ready" && !m.session.inTurn) {
      // 第二轮回复结束的信号由 transcript 处理
    }
  }
  if (m.type === "update" && m.sessionId === sid) {
    const u = m.update || {};
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.text && phase === "gen" && !chunkAt) {
      chunkAt = Date.now();
      console.log("② 收到流式输出，立刻 interrupt");
      ws.send(JSON.stringify({ type: "interrupt", sessionId: sid }));
      phase = "wait-cancel";
    }
    if (u.sessionUpdate === "hg_turn_end" || (u.sessionUpdate === "agent_message" && false)) {
      // 有的版本没有 turn_end 通知，用 status 消息判断
    }
  }
  if (m.type === "transcript" && m.sessionId === sid) {
    const last = m.entries?.filter((e) => e.kind === "assistant").pop();
    if (phase === "wait-cancel" && last && /cancel/i.test(last.stopReason ?? "")) {
      endStopReason = last.stopReason;
      check("② turn 以 cancelled 结束", true, `stopReason=${last.stopReason}，打断耗时 ${Date.now() - chunkAt}ms`);
      check("② 前端能收到 inTurn=true（停止按钮的依据）", sawInTurn);
      console.log("③ 会话应仍可用：再发一条短消息");
      phase = "after";
      ws.send(JSON.stringify({ type: "prompt", sessionId: sid, text: "只回复两个字：收到" }));
      const t0 = Date.now();
      const iv = setInterval(() => {
        ws.send(JSON.stringify({ type: "transcript", sessionId: sid }));
      }, 2000);
      setTimeout(() => {
        clearInterval(iv);
        // 由下一次 transcript 消息处理收尾；这里只是触发
      }, 100);
    }
    if (phase === "after" && last && /收到/.test(last.text ?? "")) {
      check("③ 打断后会话仍可用，第二轮正常回复", true);
      console.log(`\n=== ${fails.length ? "FAIL: " + fails.join("；") : "ALL PASS"} (${((Date.now() - started) / 1000).toFixed(0)}s) ===`);
      try { ws.send(JSON.stringify({ type: "delete", sessionId: sid })); } catch {}
      setTimeout(() => process.exit(fails.length ? 1 : 0), 500);
    }
  }
  if (phase === "wait-cancel") {
    // 打断后周期性拉 transcript 判断 stopReason
    if (!ws._polling) {
      ws._polling = true;
      const iv = setInterval(() => {
        if (sid) ws.send(JSON.stringify({ type: "transcript", sessionId: sid }));
      }, 1500);
      setTimeout(() => clearInterval(iv), 120_000);
    }
  }
});

setTimeout(() => {
  if (phase === "wait-cancel" || phase === "gen") {
    check("② turn 以 cancelled 结束", false, `超时：phase=${phase} stopReason=${endStopReason}`);
    process.exit(1);
  }
}, 200_000).unref();

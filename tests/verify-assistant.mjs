#!/usr/bin/env node
/** 助理端到端：assistant-ensure → prompt → 等流式输出/turn_end（模拟 app 行为） */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
const token = readFileSync(join(homedir(), ".harnessgate", "token"), "utf8").trim();
const ws = new WebSocket(`ws://localhost:9830/ws?token=${encodeURIComponent(token)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seen = [];
let sid = null, prompted = false;
const t0 = Date.now();
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  seen.push(m);
  if (m.type === "error") console.log(`  (error): ${m.message}`);
  if (m.type === "session" && m.session.assistant) sid = m.session.id;
  if (m.type === "update" && m.sessionId === sid) {
    const k = m.update?.sessionUpdate;
    if (k === "agent_message_chunk") {
      if (!prompted) { prompted = true; console.log(`  ✔ 开始流式输出（发出后 ${Math.round((Date.now()-t0)/1000)}s）`); }
    }
  }
  if (m.type === "turn_end" && m.sessionId === sid) {
    console.log(`  ✔ turn_end stop=${m.stopReason}`);
    console.log(`=== PASS ===`);
    process.exit(0);
  }
});
setTimeout(() => { console.log(`=== FAIL（${Math.round((Date.now()-t0)/1000)}s 无回合结束）===`); process.exit(1); }, 180_000).unref();
ws.on("open", async () => {
  console.log("发送 assistant-ensure…");
  ws.send(JSON.stringify({ type: "assistant-ensure" }));
  await sleep(8000);
  if (!sid) { console.log("=== FAIL（无助理会话）==="); process.exit(1); }
  console.log(`助理会话 ${sid}，发测试消息…`);
  ws.send(JSON.stringify({ type: "prompt", sessionId: sid, text: "请只回复两个字：收到" }));
});

#!/usr/bin/env node
/**
 * M2 验收脚本：会话落盘 + 恢复。
 *
 *   node tests/m2.mjs create "<prompt>"                 新建 opencode 会话并提问，打印 SESSION=<id>
 *   node tests/m2.mjs resume <sessionId> "<prompt>"     恢复该会话并提问（验证 harness 侧上下文是否接上）
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const [, , mode, a, b] = process.argv;
const sessionId = mode === "resume" ? a : null;
const prompt = mode === "resume" ? b : a;
const harnessId = process.env.HG_HARNESS ?? "opencode";
const token = process.env.HG_TOKEN ?? readFileSync(join(homedir(), ".harnessgate", "token"), "utf8").trim();
const ws = new WebSocket(`ws://localhost:${process.env.HG_PORT ?? 9830}/ws?token=${encodeURIComponent(token)}`);

let current = null;
let assistant = "";
let prompted = false;
const started = Date.now();

const done = (code) => {
  console.log(`\n=== ${code === 0 ? "PASS" : "FAIL"} (${((Date.now() - started) / 1000).toFixed(1)}s) ===`);
  try { ws.close(); } catch {}
  process.exit(code);
};
setTimeout(() => { console.log("!! 超时"); done(2); }, 180_000).unref();

ws.on("open", () => console.log(`[${mode}] 已连接`));
ws.on("error", (e) => { console.log(`WS 错误 ${e.message}`); done(1); });

ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === "hello") {
    if (mode === "create") {
      console.log(`创建 ${harnessId} 会话…`);
      ws.send(JSON.stringify({ type: "create", harnessId, cwd: process.cwd() }));
    } else {
      console.log(`恢复会话 ${sessionId}…`);
      ws.send(JSON.stringify({ type: "resume", sessionId }));
    }
    return;
  }
  if (m.type === "session") {
    if (mode === "create" && m.session.live === false && m.session.status === "error") { console.log(`错误: ${m.session.error}`); done(1); }
    if (m.session.status === "ready") {
      current = m.session.id;
      console.log(`会话 #${current} ready（resumable=${m.session.resumable}）`);
      if (!prompted) {
        prompted = true;
        console.log(`→ ${prompt}`);
        ws.send(JSON.stringify({ type: "prompt", sessionId: current, text: prompt }));
      }
    } else if (m.session.status === "error") {
      console.log(`错误: ${m.session.error}`);
      done(1);
    }
    return;
  }
  if (m.type === "update") {
    const u = m.update || {};
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") { assistant += u.content.text; process.stdout.write(u.content.text); }
    else if (u.sessionUpdate === "tool_call") process.stdout.write(`\n[tool] ${u.title ?? u.kind}\n`);
    else if (u.sessionUpdate === "hg_error") console.log(`\n[错误] ${u.message}`);
    return;
  }
  if (m.type === "turn_end") {
    console.log(`\n[turn_end] ${m.stopReason}`);
    if (mode === "create") console.log(`SESSION=${current}`);
    console.log(`回复: ${JSON.stringify(assistant.slice(0, 200))}`);
    done(assistant.length > 0 ? 0 : 1);
  }
});

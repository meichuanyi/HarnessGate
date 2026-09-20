#!/usr/bin/env node
/**
 * M1 冒烟测试：连接 HarnessGate，新建会话，发一句话，打印流式输出。
 * 用法: node tests/smoke.mjs <harnessId> "<prompt>" [timeoutSec]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const [, , harnessId = "opencode", prompt = "只回复两个字：收到", timeoutSec = "120"] = process.argv;
const token = process.env.HG_TOKEN ?? readFileSync(join(homedir(), ".harnessgate", "token"), "utf8").trim();
const url = `ws://localhost:${process.env.HG_PORT ?? 9830}/ws?token=${encodeURIComponent(token)}`;

const ws = new WebSocket(url);
let sessionId = null;
let assistant = "";
let done = false;
const started = Date.now();

const finish = (code) => {
  if (done) return;
  done = true;
  try { ws.close(); } catch {}
  console.log(`\n=== ${code === 0 ? "PASS" : "FAIL"} (${((Date.now() - started) / 1000).toFixed(1)}s) ===`);
  process.exit(code);
};

setTimeout(() => { console.log("\n!! 超时"); finish(2); }, Number(timeoutSec) * 1000).unref();

ws.on("open", () => console.log(`已连接 ${url.replace(token, "***")}`));
ws.on("error", (e) => { console.log(`WS 错误: ${e.message}`); finish(1); });

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw));
  switch (msg.type) {
    case "hello":
      console.log(`可用 harness: ${msg.harnesses.filter((h) => h.available).map((h) => h.id).join(", ")}`);
      console.log(`→ 新建 ${harnessId} 会话`);
      ws.send(JSON.stringify({ type: "create", harnessId, cwd: process.env.HG_CWD || process.cwd(), isolate: process.env.HG_ISOLATE === "1" }));
      break;
    case "session":
      if (msg.session.harnessId !== harnessId) break;
      console.log(`  会话 #${msg.session.id} 状态=${msg.session.status}${msg.session.error ? " 错误=" + msg.session.error : ""}`);
      if (msg.session.status === "ready" && !sessionId) {
        sessionId = msg.session.id;
        const atts = [];
        if (process.env.HG_ATTACH) {
          for (const f of process.env.HG_ATTACH.split(",")) {
            const mime = f.endsWith(".png") ? "image/png" : f.endsWith(".jpg") ? "image/jpeg" : f.endsWith(".txt") ? "text/plain" : "application/octet-stream";
            atts.push({ name: f.split("/").pop(), mimeType: mime, data: readFileSync(f).toString("base64") });
            console.log(`  附件: ${f} (${mime})`);
          }
        }
        console.log(`→ 发送: ${prompt}`);
        ws.send(JSON.stringify({ type: "prompt", sessionId, text: prompt, attachments: atts }));
      }
      if (msg.session.status === "error" && !sessionId) finish(1);
      break;
    case "update": {
      const u = msg.update || {};
      if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
        assistant += u.content.text;
        process.stdout.write(u.content.text);
      } else if (u.sessionUpdate === "agent_thought_chunk" && u.content?.type === "text") {
        process.stdout.write(`\x1b[2m[thinking] ${String(u.content.text).slice(0, 120)}\x1b[0m\n`);
      } else if (u.sessionUpdate === "tool_call") {
        process.stdout.write(`\n\x1b[33m[tool] ${u.title ?? u.kind} status=${u.status}\x1b[0m\n`);
      } else if (u.sessionUpdate === "tool_call_update") {
        process.stdout.write(`\x1b[33m[tool-update] ${u.toolCallId} status=${u.status}\x1b[0m\n`);
      } else if (u.sessionUpdate === "hg_error") {
        console.log(`\n[错误] ${u.message}`);
      } else {
        console.log(`\n[${u.sessionUpdate}] ${JSON.stringify(u).slice(0, 200)}`);
      }
      break;
    }
    case "permission": {
      const opts = msg.options || [];
      console.log(`\n[授权请求] ${msg.title}`);
      for (const o of opts) console.log(`    option: ${o.optionId} | ${o.name} | kind=${o.kind}`);
      const pick = opts.find((o) => String(o.kind || "").startsWith("allow")) || opts[0];
      console.log(`    -> 自动选择: ${pick?.name}`);
      ws.send(JSON.stringify({ type: "permission", sessionId: msg.sessionId, requestId: msg.requestId, optionId: pick.optionId }));
      break;
    }
    case "turn_end":
      console.log(`\n[turn_end] stopReason=${msg.stopReason}`);
      console.log(`\n最终回复: ${JSON.stringify(assistant.slice(0, 300))}`);
      finish(assistant.length > 0 ? 0 : 1);
      break;
    case "log":
      if (process.env.HG_VERBOSE) console.log(`\n[log] ${msg.line.slice(0, 300)}`);
      break;
    case "error":
      console.log(`\n[服务端错误] ${msg.message}`);
      break;
  }
});

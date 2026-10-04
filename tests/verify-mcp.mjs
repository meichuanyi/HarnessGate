#!/usr/bin/env node
/** 追问版：建会话(带 MCP) → 发一轮明确要求调用 echo_test 的 prompt → 看握手/工具调用 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
const token = readFileSync(join(homedir(), ".harnessgate", "token"), "utf8").trim();
const ws = new WebSocket(`ws://localhost:9830/ws?token=${encodeURIComponent(token)}`);
const CWD = "/tmp/hg-mcp-test2";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seen = [];
let sid = null, testId = null;
async function waitFor(desc, pred, ms = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = pred(); if (v) return v; await sleep(400); }
  throw new Error(`等待超时: ${desc}`);
}
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  seen.push(m);
  if (m.type === "log" && /mcp|MCP/i.test(m.line ?? "")) console.log(`  [log] ${(m.line ?? "").slice(0, 160)}`);
  if (m.type === "update" && m.update?.sessionUpdate === "tool_call") {
    console.log(`  [tool_call] ${m.update.title ?? m.update.name ?? ""}`.slice(0, 140));
  }
});
setTimeout(() => { console.log("总超时"); process.exit(1); }, 300_000).unref();
ws.on("open", async () => {
  try {
    await waitFor("hello", () => seen.find((m) => m.type === "hello"));
    ws.send(JSON.stringify({ type: "mcp-save", server: { name: "hg-test-echo", type: "stdio", command: "/usr/bin/node", args: ["/tmp/test-mcp-server.mjs"], enabled: true } }));
    const lst = await waitFor("mcp 广播", () => seen.find((m) => m.type === "mcp" && (m.servers ?? []).some((s) => s.name === "hg-test-echo")));
    testId = lst.servers.find((s) => s.name === "hg-test-echo").id;
    ws.send(JSON.stringify({ type: "create", harnessId: "zcode", cwd: CWD, mcpServerIds: [testId] }));
    const s = await waitFor("ready", () => seen.find((m) => m.type === "session" && m.session.cwd === CWD && m.session.status === "ready")?.session, 90_000);
    sid = s.id;
    console.log("会话 ready，发 prompt…");
    ws.send(JSON.stringify({ type: "prompt", sessionId: sid, text: "请调用你的 echo_test 工具，参数 text 填 hello-harnessgate，把工具返回原样告诉我。如果没有这个工具，直接回答：没有。" }));
    await waitFor("回合结束", () => seen.find((m) => m.type === "turn_end" && m.sessionId === sid), 180_000);
    const hasMcp = existsSync("/tmp/test-mcp.log") && /initialize/.test(readFileSync("/tmp/test-mcp.log", "utf8"));
    const toolCalled = seen.some((m) => m.type === "update" && JSON.stringify(m.update ?? {}).includes("echo_test"));
    console.log(`${hasMcp ? "✔" : "✘"} MCP 服务器被 spawn 并握手`);
    console.log(`${toolCalled ? "✔" : "✘"} 模型实际调用了 echo_test`);
    ws.send(JSON.stringify({ type: "delete", sessionId: sid }));
    ws.send(JSON.stringify({ type: "mcp-delete", id: testId }));
    await sleep(1500);
    process.exit(0);
  } catch (err) {
    console.log(`FAIL: ${err.message}`);
    try { if (sid) ws.send(JSON.stringify({ type: "delete", sessionId: sid })); if (testId) ws.send(JSON.stringify({ type: "mcp-delete", id: testId })); } catch {}
    setTimeout(() => process.exit(1), 1200);
  }
});

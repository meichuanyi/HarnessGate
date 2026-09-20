#!/usr/bin/env node
/**
 * 权限模式 / 授权链路测试
 *   node tests/perm.mjs <harness> [modeId] [prompt]
 * 不给 modeId 时只打印可用模式并退出（用 modeId=LIST 亦可）。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const [, , harnessId = "opencode", modeId = "LIST", prompt = "用 bash 执行 ls 看一下当前目录，然后只回复文件数量"] = process.argv;
const token = process.env.HG_TOKEN ?? readFileSync(join(homedir(), ".harnessgate", "token"), "utf8").trim();
const ws = new WebSocket(`ws://localhost:${process.env.HG_PORT ?? 9830}/ws?token=${encodeURIComponent(token)}`);

let current = null, assistant = "", asked = false, listed = false, prompted = false;
const started = Date.now();
const done = (c) => { console.log(`\n=== ${c === 0 ? "PASS" : "FAIL"} (${((Date.now() - started) / 1000).toFixed(1)}s) ===`); try { ws.close(); } catch {} process.exit(c); };
setTimeout(() => { console.log("!! 超时"); done(2); }, 180_000).unref();

ws.on("error", (e) => { console.log(`WS 错误 ${e.message}`); done(1); });
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === "hello") { ws.send(JSON.stringify({ type: "create", harnessId, cwd: process.cwd() })); return; }
  if (m.type === "session") {
    if (m.session.status === "ready") {
      current = m.session.id;
      const modes = m.session.modes;
      if (!listed) {
        listed = true;
        console.log(`可用模式: ${(modes?.availableModes ?? []).map((x) => x.id).join(", ") || "(未声明)"} | 当前=${modes?.currentModeId}`);
        const cfgs = m.session.configOptions || [];
        if (cfgs.length) {
          console.log("配置项:");
          for (const c of cfgs) console.log(`  - id=${c.id} name=${c.name} category=${c.category ?? "-"} 当前=${c.currentValue} 可选=${(c.options ?? []).map((o) => o.value).join(" | ").slice(0, 160)}`);
        } else console.log("配置项: (未声明)");
        if (modeId === "LIST") { done(0); return; }
        if (modeId.startsWith("cfg:")) {
          const [id, value] = modeId.slice(4).split("=");
          console.log(`→ 切换配置项 ${id}=${value}`);
          ws.send(JSON.stringify({ type: "config", sessionId: current, configId: id, value }));
          return;
        }
        if (modeId && modeId !== modes?.currentModeId) {
          console.log(`→ 切换模式: ${modeId}`);
          ws.send(JSON.stringify({ type: "mode", sessionId: current, modeId }));
          return; // 等状态更新后再发言
        }
      }
      if (modeId.startsWith("cfg:") && listed && current && !prompted) {
        const [id, want] = modeId.slice(4).split("=");
        const cur = (m.session.configOptions || []).find((c) => c.id === id);
        if (cur?.currentValue === want) { console.log(`✅ 配置项已生效: ${id}=${cur.currentValue}`); done(0); return; }
      }
      if (!prompted) {
        prompted = true;
        console.log(`→ ${prompt}`);
        ws.send(JSON.stringify({ type: "prompt", sessionId: current, text: prompt }));
      }
    } else if (m.session.status === "error") { console.log(`错误: ${m.session.error}`); done(1); }
    return;
  }
  if (m.type === "update") {
    const u = m.update || {};
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") { assistant += u.content.text; process.stdout.write(u.content.text); }
    else if (u.sessionUpdate === "tool_call") process.stdout.write(`\n[tool] ${u.title ?? u.kind} (${u.status})\n`);
    else if (u.sessionUpdate === "hg_error") console.log(`\n[错误] ${u.message}`);
    return;
  }
  if (m.type === "permission") {
    asked = true;
    console.log(`\n[授权请求] ${m.title}`);
    for (const o of m.options) console.log(`    ${o.optionId} | ${o.name} | kind=${o.kind}`);
    const pick = m.options.find((o) => String(o.kind || "").startsWith("allow")) || m.options[0];
    console.log(`    -> 选择: ${pick.name}`);
    ws.send(JSON.stringify({ type: "permission", sessionId: current, requestId: m.requestId, optionId: pick.optionId }));
    return;
  }
  if (m.type === "error") { console.log(`[服务端错误] ${m.message}`); if (modeId.startsWith("cfg:") || modeId !== "LIST") done(1); return; }
  if (m.type === "turn_end") {
    console.log(`\n[turn_end] ${m.stopReason}${asked ? " · 授权链路已触发 ✅" : " · 未触发授权请求"}`);
    console.log(`回复: ${JSON.stringify(assistant.slice(0, 200))}`);
    done(assistant.length > 0 || asked ? 0 : 1);
  }
});

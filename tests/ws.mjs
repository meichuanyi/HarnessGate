#!/usr/bin/env node
/**
 * M5 验收：两个 harness 在同一个目录里先后改同一个文件，
 * 检查工作区报告能否归因到具体会话并标出冲突。
 *
 *   node tests/ws.mjs [dir] [harnessA] [harnessB]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const dir = process.argv[2] || "/tmp/hgw";
const A = process.argv[3] || "opencode";
const B = process.argv[4] || "zcode";
const token = process.env.HG_TOKEN ?? readFileSync(join(homedir(), ".harnessgate", "token"), "utf8").trim();
const ws = new WebSocket(`ws://localhost:${process.env.HG_PORT ?? 9830}/ws?token=${encodeURIComponent(token)}`);

const started = Date.now();
const sessions = {};   // harnessId -> sessionId
let phase = "create";
let report = null;

const done = (code) => {
  console.log(`\n=== ${code === 0 ? "PASS" : "FAIL"} (${((Date.now() - started) / 1000).toFixed(1)}s) ===`);
  try { ws.close(); } catch {}
  process.exit(code);
};
setTimeout(() => { console.log("!! 超时"); done(2); }, 300_000).unref();

const send = (o) => ws.send(JSON.stringify(o));

ws.on("error", (e) => { console.log(`WS 错误 ${e.message}`); done(1); });

function showReport(reports) {
  const r = reports.find((x) => x.cwd === dir) ?? reports[0];
  if (!r) { console.log("没有工作区报告"); return false; }
  report = r;
  console.log(`\n工作区 ${r.cwd} — ${r.note}`);
  console.log(`会话 ${r.sessions.length} 个:`);
  for (const s of r.sessions) console.log(`  - ${s.harnessLabel} #${s.id} mode=${s.mode} inTurn=${s.inTurn}`);
  console.log(`文件 ${r.files.length} 个，冲突 ${r.conflicts}:`);
  for (const f of r.files.slice(0, 10)) {
    const who = [...new Set(f.touches.map((t) => `${t.harnessId}:${t.confidence}`))].join(", ");
    console.log(`  ${f.conflict ? "⚠️ " : "  "}${f.rel}  [${f.touches.length} 次] ${who}`);
  }
  return true;
}

ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === "hello") {
    console.log(`创建两个会话（${A} / ${B}），工作目录 ${dir}`);
    send({ type: "create", harnessId: A, cwd: dir });
    send({ type: "create", harnessId: B, cwd: dir });
    return;
  }
  if (m.type === "session") {
    const s = m.session;
    if (s.cwd !== dir) return;
    if (s.status === "ready" && !sessions[s.harnessId]) {
      sessions[s.harnessId] = s.id;
      console.log(`  ${s.harnessLabel} ready #${s.id}`);
      if (Object.keys(sessions).length === 2 && phase === "create") {
        phase = "a";
        console.log(`→ ${A} 写 shared.txt`);
        send({ type: "prompt", sessionId: sessions[A], text: "在当前目录创建文件 shared.txt，内容写 AAAA，然后只回复 DONE" });
      }
    }
    if (s.status === "error") { console.log(`错误 ${s.harnessLabel}: ${s.error}`); done(1); }
    return;
  }
  if (m.type === "update") {
    const u = m.update || {};
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") process.stdout.write(u.content.text);
    return;
  }
  if (m.type === "permission") {
    const pick = m.options.find((o) => String(o.kind || "").startsWith("allow")) || m.options[0];
    send({ type: "permission", sessionId: m.sessionId, requestId: m.requestId, optionId: pick.optionId });
    return;
  }
  if (m.type === "turn_end") {
    if (phase === "a") {
      phase = "b";
      console.log(`\n→ ${B} 改同一个文件`);
      send({ type: "prompt", sessionId: sessions[B], text: "把当前目录的 shared.txt 内容改成 BBBB（用你的编辑工具），然后只回复 DONE" });
    } else if (phase === "b") {
      phase = "report";
      console.log("\n→ 拉取工作区报告");
      send({ type: "workspace", cwd: dir });
    }
    return;
  }
  if (m.type === "workspace") {
    const ok = showReport(m.reports);
    const file = report?.files.find((f) => f.rel === "shared.txt");
    if (ok && file) {
      const harnesses = new Set(file.touches.map((t) => t.harnessId));
      console.log(`\nshared.txt: ${file.touches.length} 次改动，来自 ${[...harnesses].join(" + ")}，conflict=${file.conflict}`);
      done(file.conflict && harnesses.size >= 2 ? 0 : 1);
    } else {
      console.log("报告里没找到 shared.txt");
      done(1);
    }
  }
});

#!/usr/bin/env node
/**
 * M6 验收：圆桌会议
 *   node tests/room.mjs [dir] [harnessA] [harnessB] [rounds]
 *
 * 检查：① 每个成员每轮都发言 ② 第 2 轮的 prompt 里确实带了对方的发言摘录
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const dir = process.argv[2] || "/tmp/hgroom";
const A = process.argv[3] || "opencode";
const B = process.argv[4] || "zcode";
const ROUNDS = Number(process.argv[5] || 2);
const token = process.env.HG_TOKEN ?? readFileSync(join(homedir(), ".harnessgate", "token"), "utf8").trim();
const ws = new WebSocket(`ws://localhost:${process.env.HG_PORT ?? 9830}/ws?token=${encodeURIComponent(token)}`);

const started = Date.now();
const sids = {};
let room = null;
let startedRoom = false;

const done = (code) => {
  console.log(`\n=== ${code === 0 ? "PASS" : "FAIL"} (${((Date.now() - started) / 1000).toFixed(1)}s) ===`);
  try { ws.close(); } catch {}
  process.exit(code);
};
setTimeout(() => { console.log("!! 超时"); done(2); }, 420_000).unref();
const send = (o) => ws.send(JSON.stringify(o));

ws.on("error", (e) => { console.log(`WS 错误 ${e.message}`); done(1); });

function verify(r) {
  console.log(`\n房间 #${r.id} 状态=${r.status} 轮次=${r.rounds} 发言=${r.turns.length}`);
  for (const t of r.turns) {
    console.log(`  [第${t.round}轮] ${t.harnessLabel} (${t.reply.length} 字): ${t.reply.replace(/\s+/g, " ").slice(0, 90)}…`);
  }
  if (r.status !== "done") { console.log(`房间未正常结束: ${r.error ?? r.status}`); done(1); return; }
  const expected = r.rounds * r.members.length;
  if (r.turns.length !== expected) { console.log(`发言数不对: ${r.turns.length} != ${expected}`); done(1); return; }

  // 第 2 轮的 prompt 必须包含对方第 1 轮的发言片段
  const r1 = r.turns.filter((t) => t.round === 1);
  const r2 = r.turns.filter((t) => t.round === 2);
  let relayed = 0;
  for (const t of r2) {
    const others = r1.filter((x) => x.sessionId !== t.sessionId);
    for (const o of others) {
      const needle = o.reply.replace(/\s+/g, " ").slice(0, 40);
      const hay = t.prompt.replace(/\s+/g, " ");
      if (needle && hay.includes(needle)) { relayed++; break; }
    }
  }
  console.log(`\n第 2 轮 prompt 中包含对方发言摘录的条数: ${relayed}/${r2.length}`);
  done(relayed === r2.length && r2.length > 0 ? 0 : 1);
}

ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === "hello") {
    console.log(`创建两个成员会话（${A} / ${B}），目录 ${dir}`);
    send({ type: "create", harnessId: A, cwd: dir });
    send({ type: "create", harnessId: B, cwd: dir });
    return;
  }
  if (m.type === "session") {
    const s = m.session;
    if (s.cwd !== dir) return;
    if (s.status === "ready") sids[s.harnessId] = s.id;
    if (s.status === "error") { console.log(`会话错误: ${s.error}`); done(1); }
    if (Object.keys(sids).length === 2 && !startedRoom) {
      startedRoom = true;
      console.log(`→ 开圆桌：${ROUNDS} 轮`);
      send({
        type: "room-create",
        topic: "为一个嵌入式设备设计极简键值存储：请给出你的 API 设计与并发/持久化的取舍",
        members: [sids[A], sids[B]],
        rounds: ROUNDS,
        writeAllowed: false,
      });
    }
    return;
  }
  if (m.type === "update") {
    const u = m.update || {};
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
      const who = u.sessionId ?? "";
      process.stdout.write(u.content.text.slice(0, 400));
    }
    return;
  }
  if (m.type === "room") {
    room = m.room;
    if (room.status === "running") {
      console.log(`  · 房间进行中：已完成 ${room.turns.length} 次发言`);
    } else if (["done", "error", "stopped"].includes(room.status)) {
      verify(room);
    }
    return;
  }
  if (m.type === "error") { console.log(`[服务端错误] ${m.message}`); done(1); }
});

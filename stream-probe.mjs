import WebSocket from "ws";
const HARNESS = process.argv[2] || "opencode";
const ws = new WebSocket("ws://localhost:9830/ws");
let sid = null, t0 = 0;
const chunks = [];
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === "hello") { ws.send(JSON.stringify({ type: "create", harnessId: HARNESS, cwd: "/tmp/streamtest" })); return; }
  if (m.type === "session" && m.session.harnessId === HARNESS && m.session.status === "ready" && !sid) {
    sid = m.session.id; t0 = Date.now();
    ws.send(JSON.stringify({ type: "prompt", sessionId: sid, text: "请从 1 数到 30，每个数字单独一行输出，不要做别的事。" }));
    return;
  }
  if (m.type === "session" && m.session.status === "error") { console.log("错误:", m.session.error); process.exit(1); }
  if (m.type === "update" && m.sessionId === sid && m.update?.sessionUpdate === "agent_message_chunk") {
    const txt = m.update.content?.text || "";
    if (txt) chunks.push({ t: Date.now() - t0, len: txt.length, head: txt.slice(0, 14).replace(/\n/g, "⏎") });
  }
  if (m.type === "turn_end" && m.sessionId === sid) {
    const total = chunks.reduce((a, c) => a + c.len, 0);
    console.log(`\n=== ${HARNESS}：收到 ${chunks.length} 个 chunk，共 ${total} 字符 ===`);
    for (const c of chunks.slice(0, 14)) console.log(`  +${String(c.t).padStart(5)}ms  ${String(c.len).padStart(4)} 字符  « ${c.head} »`);
    if (chunks.length > 14) console.log(`  …（还有 ${chunks.length - 14} 个）`);
    const gaps = chunks.slice(1).map((c, i) => c.t - chunks[i].t);
    console.log(`  最大间隔 ${Math.max(...gaps, 0)}ms | 平均间隔 ${gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0}ms`);
    process.exit(0);
  }
});
setTimeout(() => { console.log("超时"); process.exit(1); }, 120000);

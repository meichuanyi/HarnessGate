/** 重启后验证：连接 /ws 量 hello 帧大小（修复前 2.25MB，预期 ~200KB）。用法：tsx scripts/check-hello-size.ts */
import WebSocket from "ws";

const url = process.env.HG_WS_URL || "ws://127.0.0.1:9830/ws";
const ws = new WebSocket(url);
const t0 = Date.now();
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.type !== "hello") return;
  const ms = Date.now() - t0;
  const kb = d.length / 1024;
  const roomsKb = JSON.stringify(m.rooms ?? []).length / 1024;
  const sessKb = JSON.stringify(m.sessions ?? []).length / 1024;
  console.log(`hello ${kb.toFixed(0)}KB · ${ms}ms · rooms ${roomsKb.toFixed(0)}KB · sessions ${sessKb.toFixed(0)}KB · 房间 ${m.rooms?.length ?? 0} 个 · 会话 ${m.sessions?.length ?? 0} 条`);
  console.log(kb < 400 ? "✅ 瘦身生效（<400KB，插件公网可连）" : "❌ 仍然过大，检查 roomSummary/sessionList 是否生效");
  process.exit(kb < 400 ? 0 : 1);
});
ws.on("error", (e) => { console.log("❌ 连接失败:", e.message); process.exit(1); });
setTimeout(() => { console.log("❌ 5s 未收到 hello"); process.exit(1); }, 5000);

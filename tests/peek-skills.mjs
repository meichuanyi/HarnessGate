import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
const token = readFileSync(join(homedir(), ".harnessgate", "token"), "utf8").trim();
const ws = new WebSocket(`ws://localhost:9830/ws?token=${encodeURIComponent(token)}`);
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type !== "skills") return;
  console.log(`主库：${m.library.length} 个技能`);
  for (const s of m.library) console.log(`  [库] ${s.name} ≈${s.tokens}t 挂载:${s.mountedOn.join(",") || "无"}`);
  for (const mo of m.mounts) {
    const native = mo.skills.filter((s) => s.native);
    const mounted = mo.skills.filter((s) => !s.native);
    console.log(`\n${mo.harnessId}：挂载 ${mounted.length} + 原生 ${native.length} = 常驻 ≈${mo.totalTokens} token`);
    const top = [...native].sort((a, b) => b.tokens - a.tokens).slice(0, 6);
    for (const s of top) console.log(`  ${String(s.tokens).padStart(5)}t  ${s.name}`);
  }
  process.exit(0);
});
ws.on("open", () => ws.send(JSON.stringify({ type: "skills" })));
setTimeout(() => process.exit(1), 10_000);

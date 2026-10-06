import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
const token = readFileSync(join(homedir(), ".harnessgate", "token"), "utf8").trim();
const ws = new WebSocket(`ws://localhost:9830/ws?token=${encodeURIComponent(token)}`);
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type !== "hello") return;
  for (const s of m.sessions ?? []) {
    if (["411ceed5", "assistant"].includes(s.id) || s.harnessId === "zcode" && (s.title ?? "").includes("你好")) {
      console.log(`${s.id} ${s.harnessId} live=${s.live} status=${s.status} inTurn=${s.inTurn ?? false} last=${s.lastActiveAt?.slice(11,19)}Z title=${(s.title ?? "").slice(0, 20)}`);
    }
  }
  process.exit(0);
});
setTimeout(() => process.exit(1), 10_000);

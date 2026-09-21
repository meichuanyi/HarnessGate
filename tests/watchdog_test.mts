/**
 * 看门狗回归：假 agent 收到 session/prompt 后永不回复（2026-09-21 论文工作队冻结事故的形态）。
 * 断言：promptAndWait(timeoutMs=6s) 在 ~6-11 秒内以 stopReason=idle-timeout 返回，而不是永远挂住。
 * 运行：npx tsx tests/watchdog_test.mts
 */
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessSession } from "../server/session.ts";
import type { HarnessSpec } from "../server/types.ts";
import { AuditLog } from "../server/audit.ts";
import { WorkspaceHub } from "../server/workspace.ts";

// 假 ACP agent：响应 initialize / session/new，收到 session/prompt 后装死（不回）
const FAKE = `
const lines = require("readline").createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const sendNotif = (m, p) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: m, params: p }) + "\\n");
lines.on("line", (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.method === "initialize") {
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (m.method === "session/new") {
    send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "fake-s1" } });
  } else if (m.method === "session/prompt") {
    // 装死：一个 chunk 都不吐，RPC 永不返回
  } else if (m.id != null) {
    send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
`;
import { writeFileSync } from "node:fs";
const fakePath = join(tmpdir(), `hg-fake-agent-${Date.now()}.cjs`);
writeFileSync(fakePath, FAKE);

const cwd = mkdtempSync(join(tmpdir(), "hg-watchdog-"));
const spec: HarnessSpec = {
  id: "fake", label: "FakeAgent", cmd: process.execPath, args: [fakePath],
} as unknown as HarnessSpec;

const audit = new AuditLog(join(cwd, "audit.jsonl"));
const hub = new WorkspaceHub(audit);
const hooks = {
  onStatus: () => {},
  onUpdate: () => {},
  onTurnEnd: () => {},
  onPermission: () => {},
  onLog: () => {},
  onPersist: () => {},
};

const rec = HarnessSession.newRecord(spec, cwd);
const session = new HarnessSession(spec, rec, audit, hooks, hub);
const t0 = Date.now();
await session.start("new");
// 等 ready
for (let i = 0; i < 60 && session.info().status !== "ready"; i++) await new Promise((r) => setTimeout(r, 500));
if (session.info().status !== "ready") {
  console.log("✘ 假 agent 没就绪"); process.exit(1);
}
console.log("假 agent 就绪，发起 prompt（agent 将装死）…");

const r = await session.promptAndWait("说点什么", 6_000);
const elapsed = Date.now() - t0;
const ok = r.stopReason === "idle-timeout" && elapsed < 20_000;
console.log(`${ok ? "✔" : "✘"} stopReason=${r.stopReason}，耗时 ${(elapsed / 1000).toFixed(1)}s（旧实现会永远挂住）`);
await session.stop();
process.exit(ok ? 0 : 1);

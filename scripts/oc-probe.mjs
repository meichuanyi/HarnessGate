// 手动调试用：直接把某个 ACP harness 拉起来对话，打印原始返回。
//   node scripts/oc-probe.mjs acp --session agent:main:hg-probe [--token <t>] [-v]
// 排查 OpenClaw 时配合网关日志：tail -f /tmp/openclaw/openclaw-$(date +%F).log
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
const args = process.argv.slice(2);
console.log("启动:", "openclaw", args.join(" "));
const child = spawn("openclaw", args, { cwd: process.cwd(), stdio: ["pipe","pipe","pipe"] });
child.stderr.on("data", d => { const s=String(d).trim(); if (s) console.log("  [stderr]", s.slice(0, 300)); });
const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
let chunks = 0;
const t0 = Date.now(); const el = () => `+${((Date.now()-t0)/1000).toFixed(1)}s`;
await acp.client({ name: "probe" })
  .onNotification(acp.methods.client.session.update, (ctx) => {
    const u = ctx.params?.update ?? {};
    if (u.sessionUpdate === "agent_message_chunk") { chunks++; process.stdout.write(`${el()} [回复] ${(u.content?.text||"").slice(0,120)}\n`); }
  })
  .connectWith(stream, async (ctx) => {
    const init = await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
    console.log(`${el()} initialize OK agent=${JSON.stringify(init.agentInfo)}`);
    const s = await ctx.request(acp.methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
    console.log(`${el()} session/new OK: ${s.sessionId}`);
    const p = await Promise.race([
      ctx.request(acp.methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "只回复两个字：收到" }] }),
      new Promise((_, r) => setTimeout(() => r(new Error("60s 超时")), 60000)),
    ]);
    console.log(`${el()} prompt 返回: ${JSON.stringify(p).slice(0,200)} | 收到片段数=${chunks}`);
  });
child.kill(); process.exit(0);

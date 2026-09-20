import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { writeFileSync } from "node:fs";
import * as acp from "@agentclientprotocol/sdk";

// 需要重新认证 Antigravity 时用：node scripts/antigravity-auth.mjs
// 它会打印 Google 授权链接；若浏览器回调打不到服务器（跨机器场景），
// 可以直接把回调 URL 里的 state/code 用 curl 喂给本地回调端口即可完成。
const BIN = "/root/.harnessgate/agents/antigravity-acp/extracted/agy_acp_server.par";
const P = "http://127.0.0.1:7899";
const env = {
  ...process.env,
  HTTPS_PROXY: P, HTTP_PROXY: P, ALL_PROXY: P,
  https_proxy: P, http_proxy: P, all_proxy: P,
  GRPC_PROXY: P, grpc_proxy: P, GRPC_SSL_PROXY: P,
  NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1",
};
const child = spawn(BIN, ["--uid=root"], { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => {
  const s = String(d);
  const m = s.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?\S+/);
  if (m) {
    writeFileSync("/tmp/ag-oauth-url.txt", m[0]);
    console.log(`已写出授权链接（长度 ${m[0].length}）`);
  }
});
const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
const t0 = Date.now();
const el = () => `+${((Date.now() - t0) / 1000).toFixed(0)}s`;

await acp
  .client({ name: "probe" })
  .onNotification(acp.methods.client.session.update, (ctx) => {
    const u = ctx.params?.update ?? {};
    if (u.sessionUpdate === "agent_message_chunk") console.log(`${el()} [回复] ${(u.content?.text || "").slice(0, 400)}`);
  })
  .connectWith(stream, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    console.log(`${el()} initialize OK；开始认证，等你在浏览器完成…`);
    try {
      await Promise.race([
        ctx.request(acp.methods.agent.authenticate, { methodId: "oauth-personal" }),
        new Promise((_, r) => setTimeout(() => r(new Error("40s 未完成")), 40_000)),
      ]);
      console.log(`${el()} ✅ 认证成功`);
    } catch (e) {
      console.log(`${el()} ❌ 认证失败: ${e.message}`);
      return "done";
    }
    const s = await ctx.request(acp.methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
    console.log(`${el()} session/new OK: ${s.sessionId}`);
    const p = await ctx.request(acp.methods.agent.session.prompt, {
      sessionId: s.sessionId,
      prompt: [{ type: "text", text: "只回复两个字：收到" }],
    });
    console.log(`${el()} prompt 返回: ${JSON.stringify(p).slice(0, 150)}`);
    return "done";
  });
child.kill();
process.exit(0);

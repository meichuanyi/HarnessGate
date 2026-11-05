#!/usr/bin/env node
/**
 * 把 mcp.json 的中枢 MCP 条目切到打包产物（npm run build:mcp 的输出），并补挂
 * harnessgate-admin 管理面条目。走主进程 WS 的 mcp-save（单一事实源：校验、热载、
 * 广播都在主进程），不直改 mcp.json。
 *
 *   node scripts/install-mcp-entries.mjs            # 生产（~/.harnessgate/bin）
 *   HG_MCP_BIN=/tmp/x node scripts/install-mcp-entries.mjs   # 自定产物目录
 *   HG_WS_URL=ws://127.0.0.1:19830/ws node ...      # 指定主进程
 */
import WebSocket from "ws";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BIN = process.env.HG_MCP_BIN ?? join(homedir(), ".harnessgate", "bin");
const BASE = process.env.HG_WS_URL ?? "ws://127.0.0.1:9830/ws";
let token = process.env.HG_TOKEN ?? "";
if (!token) {
  try { token = readFileSync(join(homedir(), ".harnessgate", "token"), "utf8").trim(); } catch {}
}
const url = BASE + (token ? `${BASE.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : "");

const ws = new WebSocket(url);
const waiters = [];

function waitFor(pred, label, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${label} 超时`)), timeoutMs);
    waiters.push((msg) => {
      if (msg.type === "error") { clearTimeout(timer); reject(new Error(`后端错误: ${msg.message}`)); return true; }
      if (pred(msg)) { clearTimeout(timer); resolve(msg); return true; }
      return false;
    });
  });
}

ws.on("message", async (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  for (let i = 0; i < waiters.length; i++) {
    if (waiters[i](msg)) { waiters.splice(i, 1); i--; }
  }
  if (msg.type === "hello") await main(msg);
});

ws.on("error", (err) => { console.error(`连接失败: ${err.message}`); process.exit(1); });

async function main(hello) {
  const existing = (hello.mcpServers ?? []).find((s) => s.name === "harnessgate");
  if (!existing) {
    console.error("mcp.json 里没有 harnessgate 条目——先在 UI 里添加或确认数据目录");
    process.exit(1);
  }

  // 1) 核心条目切到打包产物（保留 id/enabled，其余字段重写）
  const core = {
    id: existing.id,
    name: "harnessgate",
    type: "stdio",
    enabled: existing.enabled !== false,
    note: "HarnessGate 核心中枢 MCP：会话管理(sessions_*) + 目标推进(goals_*) + 神经中枢(sentinel_*) + 通知 + 定时任务。产物由 npm run build:mcp 生成",
    command: "node",
    args: [join(BIN, "hg-mcp-core.mjs")],
    env: [],
  };
  const p1 = waitFor((m) => m.type === "mcp" && (m.servers ?? []).some((s) => s.name === "harnessgate" && s.command === "node"), "核心条目更新");
  ws.send(JSON.stringify({ type: "mcp-save", server: core }));
  await p1;
  console.log(`✅ harnessgate → node ${core.args[0]}`);

  // 2) 管理面条目（不存在则新建；enabled=false：按需勾选，不占默认会话的工具 schema token）
  const adminExisting = (hello.mcpServers ?? []).find((s) => s.name === "harnessgate-admin");
  const admin = {
    ...(adminExisting ? { id: adminExisting.id } : {}),
    name: "harnessgate-admin",
    type: "stdio",
    enabled: false,
    note: "HarnessGate 管理面 MCP：受管 MCP 服务器增删(mcp_*) + 技能库管理(skills_*)。按会话勾选携带；改动只对新建会话生效",
    command: "node",
    args: [join(BIN, "hg-mcp-admin.mjs")],
    env: [],
  };
  const p2 = waitFor((m) => m.type === "mcp" && (m.servers ?? []).some((s) => s.name === "harnessgate-admin" && s.command === "node"), "管理面条目");
  ws.send(JSON.stringify({ type: "mcp-save", server: admin }));
  await p2;
  console.log(`✅ harnessgate-admin → node ${admin.args[0]}（enabled=false，按需勾选）`);

  ws.close();
  process.exit(0);
}

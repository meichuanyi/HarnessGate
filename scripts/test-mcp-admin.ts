/**
 * harnessgate-admin MCP 端到端测试（对隔离实例跑，不碰生产）。
 *
 * 前置：隔离实例已起，如
 *   HG_PORT=19830 HG_DATA_DIR=/tmp/hgtest-admin HG_AUTH=off tsx server/index.ts &
 * 用法：
 *   HG_WS_URL=ws://127.0.0.1:19830/ws tsx scripts/test-mcp-admin.ts
 *   # 测打包产物：
 *   HG_WS_URL=... HG_MCP_CMD=node HG_MCP_TARGET=/tmp/hgtest-admin/bin/hg-mcp-admin.mjs tsx scripts/test-mcp-admin.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const WS_URL = process.env.HG_WS_URL ?? "ws://127.0.0.1:19830/ws";
const MCP_CMD = process.env.HG_MCP_CMD ?? "/root/projects/HarnessGate/node_modules/.bin/tsx";
const MCP_TARGET = process.env.HG_MCP_TARGET ?? "/root/projects/HarnessGate/server/mcp-admin.ts";
const CORE_CMD = process.env.HG_CORE_CMD ?? MCP_CMD;
const CORE_TARGET = process.env.HG_CORE_TARGET ?? "/root/projects/HarnessGate/server/mcp-sessions.ts";

const TEST_MCP_NAME = "hg-admin-test";
const TEST_SKILL = "hg-admin-test-skill";

function ok(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`❌ ${msg}`);
}

async function textOf(r: unknown): Promise<string> {
  const res = r as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  const t = res.content?.find((c) => c.type === "text")?.text ?? "";
  return t;
}

async function main() {
  console.log(`=== [1] 连接 admin MCP（${MCP_CMD} ${MCP_TARGET} → ${WS_URL}）===`);
  const transport = new StdioClientTransport({
    command: MCP_CMD,
    args: [MCP_TARGET],
    cwd: "/root/projects/HarnessGate",
    env: { ...process.env, HG_WS_URL: WS_URL } as Record<string, string>,
  });
  const client = new Client({ name: "test-mcp-admin", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  console.log("✅ 连接成功");

  console.log("\n=== [2] tools/list：8 个管理工具 ===");
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  console.log("工具清单:", names.join(", "));
  for (const want of ["mcp_list", "mcp_save", "mcp_delete", "skills_list", "skills_read", "skills_save", "skills_delete", "skills_mount"]) {
    ok(names.includes(want), `缺少工具 ${want}`);
  }
  ok(names.length === 8, `工具数应为 8，实际 ${names.length}`);

  console.log("\n=== [3] mcp_list：基线清单 ===");
  let list = JSON.parse(await textOf(await client.callTool({ name: "mcp_list", arguments: {} })));
  const baseline = list.length;
  console.log(`现有 ${baseline} 个受管 MCP 服务器`);

  console.log("\n=== [4] mcp_save：新增 stdio 服务器 ===");
  let t = await textOf(await client.callTool({
    name: "mcp_save",
    arguments: { name: TEST_MCP_NAME, type: "stdio", command: "/bin/true", note: "端到端测试条目" },
  }));
  console.log(t.split("\n")[0]);
  ok(t.includes("已保存"), "应提示已保存");
  ok(t.includes("生效语义") && t.includes("新建"), "返回文本必须讲清生效语义（新建会话生效）");

  list = JSON.parse(await textOf(await client.callTool({ name: "mcp_list", arguments: {} })));
  const saved = list.find((s: { name: string }) => s.name === TEST_MCP_NAME);
  ok(saved, "保存后 mcp_list 应包含测试条目");
  const savedId = saved.id;
  console.log(`已入库 id=${savedId}, enabled=${saved.enabled}`);

  console.log("\n=== [5] mcp_save：按 name 原地更新（enabled→false，id 不变）===");
  t = await textOf(await client.callTool({
    name: "mcp_save",
    arguments: { name: TEST_MCP_NAME, type: "stdio", enabled: false },
  }));
  ok(t.includes("已更新"), "同名保存应走更新路径");
  list = JSON.parse(await textOf(await client.callTool({ name: "mcp_list", arguments: {} })));
  const updated = list.find((s: { name: string }) => s.name === TEST_MCP_NAME);
  ok(updated.id === savedId, "原地更新不应换 id");
  ok(updated.enabled === false && updated.command === "/bin/true", "未提供的字段应保留原值（command），提供的覆盖（enabled）");
  console.log(`更新后 enabled=${updated.enabled}, command=${updated.command}, id 未变 ✅`);

  console.log("\n=== [6] skills_save：非法名字被服务端拒绝 ===");
  const bad = await client.callTool({ name: "skills_save", arguments: { name: "../evil", description: "x", body: "x" } }) as { isError?: boolean };
  const badText = await textOf(bad);
  ok(bad.isError === true, "非法名字应返回 isError");
  ok(/名称|不合法/.test(badText), `错误信息应点名名称问题，实际: ${badText}`);
  console.log("被拒：", badText);

  console.log("\n=== [7] skills_save + skills_mount + skills_read ===");
  t = await textOf(await client.callTool({
    name: "skills_save",
    arguments: { name: TEST_SKILL, description: "端到端测试技能", body: "# 测试\n正文标记 HG-ADMIN-TEST-BODY" },
  }));
  ok(t.includes("已保存") && t.includes("主库"), "保存成功提示应说明入库");

  t = await textOf(await client.callTool({ name: "skills_mount", arguments: { name: TEST_SKILL, harnessId: "claude", on: true } }));
  ok(t.includes("挂载") && t.includes("生效语义"), "挂载成功且带生效语义");

  const body = await textOf(await client.callTool({ name: "skills_read", arguments: { name: TEST_SKILL } }));
  ok(body.includes("HG-ADMIN-TEST-BODY"), "skills_read 应读到正文");

  const snap = JSON.parse(await textOf(await client.callTool({ name: "skills_list", arguments: {} })));
  const lib = snap.library.find((s: { name: string }) => s.name === TEST_SKILL);
  ok(lib?.mountedOn?.includes("claude"), `skills_list 应显示挂载在 claude，实际 mountedOn=${JSON.stringify(lib?.mountedOn)}`);
  console.log(`技能已挂载: mountedOn=${JSON.stringify(lib.mountedOn)}`);

  console.log("\n=== [8] skills_delete：连带摘挂载 ===");
  t = await textOf(await client.callTool({ name: "skills_delete", arguments: { name: TEST_SKILL } }));
  ok(t.includes("已删除"), "删除应成功");
  const snap2 = JSON.parse(await textOf(await client.callTool({ name: "skills_list", arguments: {} })));
  ok(!snap2.library.some((s: { name: string }) => s.name === TEST_SKILL), "删除后库中不应再有");

  console.log("\n=== [9] mcp_delete：按 name 删 ===");
  t = await textOf(await client.callTool({ name: "mcp_delete", arguments: { name: TEST_MCP_NAME } }));
  ok(t.includes("已删除"), "删除应成功");
  list = JSON.parse(await textOf(await client.callTool({ name: "mcp_list", arguments: {} })));
  ok(!list.some((s: { name: string }) => s.name === TEST_MCP_NAME), "删除后清单不应再有");
  ok(list.length === baseline, `应还原到基线数量（${baseline}），实际 ${list.length}`);

  console.log("\n=== [10] 核心 MCP：sessions_create schema 带出 mcpServerIds ===");
  const coreTransport = new StdioClientTransport({
    command: CORE_CMD,
    args: [CORE_TARGET],
    cwd: "/root/projects/HarnessGate",
    env: { ...process.env, HG_WS_URL: WS_URL } as Record<string, string>,
  });
  const core = new Client({ name: "test-mcp-core-schema", version: "0.0.1" }, { capabilities: {} });
  await core.connect(coreTransport);
  const coreTools = await core.listTools();
  const createTool = coreTools.tools.find((x) => x.name === "sessions_create");
  ok(createTool, "sessions_create 工具应存在");
  const hasParam = Boolean((createTool?.inputSchema as { properties?: Record<string, unknown> })?.properties?.mcpServerIds);
  ok(hasParam, "sessions_create schema 应声明 mcpServerIds 参数");
  console.log("sessions_create.mcpServerIds 已声明 ✅");
  await core.close();

  await client.close();
  console.log("\n🎉 全部 10 组断言通过");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

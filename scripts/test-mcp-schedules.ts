import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** 定时任务 MCP 工具组（schedules_*）端到端测试：
 *  走真实链路 MCP stdio → 主进程 WS → 定时引擎 → harness 会话。
 *  会真实触发一次 agent 运行（小 prompt），结束时清理测试任务。 */

const TEST_ID = `mcp-test-${Math.random().toString(36).slice(2, 8)}`;

function text(res: { content?: Array<{ type: string; text?: string }> }): string {
  return res.content?.map((c) => c.text ?? "").join("") ?? "";
}

/** server 端 CallToolRequestSchema 统一 catch 后返回 isError 结果（不 reject promise），两种都算「报错」 */
async function expectError(label: string, fn: () => Promise<{ isError?: boolean; content?: Array<{ type: string; text?: string }> }>): Promise<void> {
  try {
    const res = await fn();
    if (res.isError) {
      console.log(`✅ ${label}（按预期报错: ${text(res).slice(0, 80)}）`);
      return;
    }
  } catch (err) {
    console.log(`✅ ${label}（按预期报错: ${(err as Error).message.slice(0, 80)}）`);
    return;
  }
  throw new Error(`${label}：应当报错却没有报错`);
}

let client: Client | null = null;
let transport: StdioClientTransport | null = null;

async function main() {
  console.log("=== [1/8] 启动 MCP 客户端（tsx 拉起 mcp-sessions.ts） ===");
  transport = new StdioClientTransport({
    command: "/root/projects/HarnessGate/node_modules/.bin/tsx",
    args: ["/root/projects/HarnessGate/server/mcp-sessions.ts"],
    cwd: "/root/projects/HarnessGate",
  });
  client = new Client({ name: "test-mcp-schedules", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  console.log("✅ 连接成功");

  console.log("\n=== [2/8] tools/list 应含 5 个 schedules_* 工具 ===");
  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const t of ["schedules_list", "schedules_save", "schedules_delete", "schedules_enable", "schedules_run"]) {
    if (!tools.includes(t)) throw new Error(`缺少工具: ${t}`);
  }
  console.log(`✅ 全部在位（当前共 ${tools.length} 个工具）`);

  console.log("\n=== [3/8] 安全闸：exec 模式 / 缺必填字段 应被拒绝 ===");
  await expectError("exec 模式被拒", () =>
    client.callTool({ name: "schedules_save", arguments: { name: "x", harnessId: "zcode", cadence: { type: "daily", at: "03:00" }, execCommand: "echo hi" } }),
  );
  await expectError("缺 promptTemplate 被拒", () =>
    client.callTool({ name: "schedules_save", arguments: { name: "x", harnessId: "zcode", cadence: { type: "daily", at: "03:00" } } }),
  );
  await expectError("坏频率被拒", () =>
    client.callTool({ name: "schedules_save", arguments: { name: "x", harnessId: "zcode", cadence: { type: "daily", at: "25:00" }, promptTemplate: "p" } }),
  );

  console.log("\n=== [4/8] schedules_save 新建（先停用，避免测试期间自然触发） ===");
  const saved = JSON.parse(text(await client.callTool({
    name: "schedules_save",
    arguments: {
      id: TEST_ID,
      name: "MCP 测试任务",
      harnessId: "zcode",
      cadence: { type: "daily", at: "03:00" },
      promptTemplate: "只输出两个字：正常。不要做任何其他事情。",
      enabled: false,
      autoApprove: "all",
    },
  })));
  if (!saved.success || saved.schedule?.id !== TEST_ID) throw new Error(`save 返回异常: ${JSON.stringify(saved)}`);
  console.log("✅ 创建成功:", JSON.stringify(saved.schedule));

  console.log("\n=== [5/8] schedules_list 能看到它 + schedules_enable 启用 ===");
  const listed = JSON.parse(text(await client.callTool({ name: "schedules_list", arguments: {} })));
  const rec = (listed.schedules as Array<Record<string, unknown>>).find((s) => s.id === TEST_ID);
  if (!rec) throw new Error("list 里找不到刚建的任务");
  if (rec.enabled !== false) throw new Error("刚建的任务应是停用态");
  console.log(`✅ list 可见（共 ${listed.count} 条，本条停用态）`);
  const enabled = JSON.parse(text(await client.callTool({ name: "schedules_enable", arguments: { id: TEST_ID, enabled: true } })));
  if (!enabled.success || enabled.schedule?.enabled !== true) throw new Error(`enable 返回异常: ${JSON.stringify(enabled)}`);
  console.log("✅ 已启用");

  console.log("\n=== [6/8] schedules_run 真实触发一次（异步，轮询 lastStatus） ===");
  const run = JSON.parse(text(await client.callTool({ name: "schedules_run", arguments: { id: TEST_ID } })));
  if (!run.success) throw new Error(`run 返回异常: ${JSON.stringify(run)}`);
  console.log("✅ 已触发:", run.message);
  let lastStatus: string | null = null;
  for (let i = 0; i < 36; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const l = JSON.parse(text(await client.callTool({ name: "schedules_list", arguments: {} })));
    const s = (l.schedules as Array<Record<string, unknown>>).find((x) => x.id === TEST_ID);
    lastStatus = (s?.lastStatus as string) ?? null;
    if (lastStatus === "ok" || lastStatus === "error") break;
    if (i % 4 === 3) console.log(`  …运行中（${(i + 1) * 5}s）`);
  }
  if (lastStatus !== "ok") throw new Error(`运行未成功：lastStatus=${lastStatus}`);
  console.log("✅ 真实运行成功（lastStatus=ok，会话由引擎代跑并验收）");

  console.log("\n=== [7/8] 错误路径：enable / run 不存在的任务 ===");
  await expectError("enable 不存在", () => client.callTool({ name: "schedules_enable", arguments: { id: "no-such-id", enabled: true } }));
  await expectError("run 不存在", () => client.callTool({ name: "schedules_run", arguments: { id: "no-such-id" } }));

  console.log("\n=== [8/8] schedules_delete 清理 ===");
  const del = JSON.parse(text(await client.callTool({ name: "schedules_delete", arguments: { id: TEST_ID } })));
  if (!del.success) throw new Error(`delete 返回异常: ${JSON.stringify(del)}`);
  const after = JSON.parse(text(await client.callTool({ name: "schedules_list", arguments: {} })));
  if ((after.schedules as Array<Record<string, unknown>>).some((s) => s.id === TEST_ID)) throw new Error("删除后任务仍在列表中");
  console.log("✅ 已删除且列表确认");

  client.close();
  await transport.close(); // 显式杀掉拉起的 MCP 子进程，不靠 stdin EOF 兜底
  console.log("\n🎉 定时任务 MCP 工具组全链路（含真实运行）通过！");
}

main().then(
  async () => process.exit(0),
  async (err) => {
    console.error(`\n❌ 测试失败: ${(err as Error).message}`);
    // 失败也尽力清理测试任务，不留脏数据
    try {
      await client?.callTool({ name: "schedules_delete", arguments: { id: TEST_ID } });
      console.log("（已清理测试任务）");
    } catch {}
    try {
      await client?.close();
      await transport?.close();
    } catch {}
    process.exit(1);
  },
);

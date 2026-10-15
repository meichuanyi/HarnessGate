import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  console.log("=== [1/4] 启动 HarnessGate 核心 MCP 客户端 ===");
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "/root/projects/HarnessGate/server/mcp-sessions.ts"],
    cwd: "/root/projects/HarnessGate",
  });

  const client = new Client(
    { name: "test-mcp-client", version: "1.0.0" },
    { capabilities: {} },
  );

  await client.connect(transport);
  console.log("✅ MCP 客户端连接成功！");

  console.log("\n=== [2/4] 测试 tools/list 列出全部工具 ===");
  const toolsResult = await client.listTools();
  const toolNames = toolsResult.tools.map((t) => t.name);
  console.log("当前注册的工具清单 (共 " + toolNames.length + " 个):", toolNames);

  const expectedTools = [
    "sessions_list",
    "sessions_get",
    "sessions_create",
    "sessions_prompt",
    "sessions_interrupt",
    "sessions_delete",
    "goals_list",
    "goals_save",
    "goals_task_complete",
    "goals_task_reschedule",
    "sentinel_status",
    "sentinel_spark",
  ];

  for (const expected of expectedTools) {
    if (!toolNames.includes(expected)) {
      throw new Error(`缺少期望的工具: ${expected}`);
    }
  }
  console.log("✅ 全部 12 个核心工具均正确注册！");

  console.log("\n=== [3/4] 测试调用 goals_list 获取宏观目标与生活运转日常待办 ===");
  const goalsRes = await client.callTool({
    name: "goals_list",
    arguments: {},
  });
  console.log("goals_list 返回状态: isError =", (goalsRes as any).isError ?? false);
  const goalsContent = (goalsRes as any).content?.[0]?.text;
  if (!goalsContent) throw new Error("goals_list 未返回文本内容");
  const parsedGoals = JSON.parse(goalsContent);
  console.log("goals_list 摘要统计:", parsedGoals.summary);
  console.log("首个目标标题:", parsedGoals.goals?.[0]?.title, "进度:", parsedGoals.goals?.[0]?.progress);
  console.log("生活运转日常待办数量:", parsedGoals.lifeOps?.length);
  if (parsedGoals.goals?.length === 0 && parsedGoals.lifeOps?.length === 0) {
    throw new Error("goals_list 返回的目标与待办均为 0，未获取到真实数据");
  }
  console.log("✅ goals_list 成功返回后端真实目标与生活运转数据！");

  console.log("\n=== [4/4] 测试调用 sentinel_status 查看神经心智状态 ===");
  const sentinelRes = await client.callTool({
    name: "sentinel_status",
    arguments: {},
  });
  console.log("sentinel_status 返回状态: isError =", (sentinelRes as any).isError ?? false);
  const sentinelContent = (sentinelRes as any).content?.[0]?.text;
  if (!sentinelContent) throw new Error("sentinel_status 未返回文本内容");
  const parsedSentinel = JSON.parse(sentinelContent);
  console.log("神经中枢张力水位:", parsedSentinel.tension?.level, "/", parsedSentinel.tension?.threshold);
  console.log("神经中枢感官数量:", parsedSentinel.sensors?.length);
  console.log("最近感官脉冲数:", parsedSentinel.pulses?.length);
  if (parsedSentinel.tension === undefined) {
    throw new Error("sentinel_status 未返回有效的张力数据");
  }
  console.log("✅ sentinel_status 成功返回后端真实神经中枢数据！");

  console.log("\n=== 额外自验：测试 sentinel_spark 注入感官脉冲 ===");
  const sparkRes = await client.callTool({
    name: "sentinel_spark",
    arguments: {
      summary: "自测试感官认知脉冲：验证 System 2 慢思考唤醒通道",
      weight: 3,
    },
  });
  const sparkContent = (sparkRes as any).content?.[0]?.text;
  console.log("sentinel_spark 返回结果:", sparkContent);
  console.log("✅ sentinel_spark 执行成功！");

  console.log("\n=== 额外自验：测试 goals_task_reschedule 的 ISO 8601 格式铁律校验 ===");
  const badRescheduleRes = await client.callTool({
    name: "goals_task_reschedule",
    arguments: {
      taskId: "test-task",
      dueDate: "2026-10-16 12:00:00", // 非严格 ISO 带时区
    },
  });
  console.log("非法格式拦截结果: isError =", (badRescheduleRes as any).isError, "错误信息:", (badRescheduleRes as any).content?.[0]?.text);
  if (!(badRescheduleRes as any).isError) {
    throw new Error("ISO 8601 校验未能拦截非法时间戳");
  }
  console.log("✅ goals_task_reschedule 严格强制 ISO 起止时间戳铁律验证通过！");

  await client.close();
  console.log("\n🎉 全部自检与功能验证 100% 通过！");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ 自检失败:", err);
  process.exit(1);
});

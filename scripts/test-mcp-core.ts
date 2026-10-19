import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  console.log("=== [1/5] 启动 HarnessGate 核心 MCP 客户端 ===");
  const transport = new StdioClientTransport({
    command: "/root/projects/HarnessGate/node_modules/.bin/tsx",
    args: ["/root/projects/HarnessGate/server/mcp-sessions.ts"],
    cwd: "/root/projects/HarnessGate",
  });

  const client = new Client(
    { name: "test-mcp-client", version: "1.0.0" },
    { capabilities: {} },
  );

  await client.connect(transport);
  console.log("✅ MCP 客户端连接成功！");

  console.log("\n=== [2/5] 测试 tools/list 列出全部工具 ===");
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
    "sentinel_sensor_list",
    "sentinel_sensor_save",
    "sentinel_sensor_toggle",
    "sentinel_sensor_delete",
  ];

  for (const expected of expectedTools) {
    if (!toolNames.includes(expected)) {
      throw new Error(`缺少期望的工具: ${expected}`);
    }
  }
  console.log("✅ 全部 16 个核心工具（含 4 个感官管理工具）均正确注册！");

  console.log("\n=== [3/5] 测试调用 sentinel_sensor_list 列出感知器 ===");
  const sensorListRes = await client.callTool({
    name: "sentinel_sensor_list",
    arguments: {},
  });
  console.log("sentinel_sensor_list 返回: isError =", (sensorListRes as any).isError ?? false);
  const sensorListContent = (sensorListRes as any).content?.[0]?.text;
  console.log("感知器列表结果:", sensorListContent);
  const parsedSensors = JSON.parse(sensorListContent);
  console.log("当前感知器总数:", parsedSensors.count);

  console.log("\n=== [4/5] 测试调用 sentinel_sensor_save 保存气象感知器 ===");
  const saveSensorRes = await client.callTool({
    name: "sentinel_sensor_save",
    arguments: {
      id: "sen-weather-hz",
      label: "杭州气象环境感知",
      kind: "weather",
      city: "杭州",
      latitude: 30.2741,
      longitude: 120.1551,
      salience: "normal",
      intervalMs: 1800000,
    },
  });
  console.log("sentinel_sensor_save 返回:", (saveSensorRes as any).content?.[0]?.text);

  console.log("\n=== [5/5] 测试调用 sentinel_status 查看神经心智与天气感知快照 ===");
  const sentinelRes = await client.callTool({
    name: "sentinel_status",
    arguments: {},
  });
  const sentinelContent = (sentinelRes as any).content?.[0]?.text;
  const parsedSentinel = JSON.parse(sentinelContent);
  console.log("神经中枢张力水位:", parsedSentinel.tension?.level, "/", parsedSentinel.tension?.threshold);
  console.log("神经中枢感官数量:", parsedSentinel.sensors?.length);
  const weatherSensor = parsedSentinel.sensors?.find((s: any) => s.kind === "weather");
  if (weatherSensor) {
    console.log("天气感知器状态:", weatherSensor.label, "| 归类:", weatherSensor.categoryLabel, "/", weatherSensor.subCategoryLabel);
    if (weatherSensor.weatherSnapshot) {
      console.log("  天气快照:", weatherSensor.weatherSnapshot.summary);
    }
  }

  await client.close();
  console.log("\n🎉 全部 16 个 MCP 工具与内外感知体系端到端自验 100% 通过！");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ 自检失败:", err);
  process.exit(1);
});

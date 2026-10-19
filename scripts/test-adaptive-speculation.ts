import { IdleSpeculator, type SessionSnapshot } from "../server/idle-speculator.ts";
import { LifeEvaluator } from "../server/speculation/evaluators/life-evaluator.ts";
import { SpeculationEngine } from "../server/speculation/engine.ts";
import { classifyMindwtrTasks, enrichTasksWithPrescriptions, type GoalView } from "../server/goals.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function run() {
  console.log("=== 启动【自适应休眠 + 传感器张力破线唤醒】双轮驱动推演测试 ===");

  const now = Date.now();
  // 模拟三个不同时间尺度的任务：
  // 1. 紧迫任务：2 小时后开始打羽毛球（16:00），估算应该在活动前 60 分钟（15:00）唤醒
  const targetBadminton = new Date(now + 2 * 3600_000 + 10 * 60_000).toISOString();
  // 2. 远期任务：48 小时后大扫除，应该在开始前 4 小时唤醒
  const targetClean = new Date(now + 48 * 3600_000).toISOString();
  // 3. 无具体时间戳的日常任务，默认长周期休眠

  const mockTasks = [
    {
      id: "t_badminton",
      title: "周五羽毛球局",
      status: "needsAction" as const,
      startTime: targetBadminton,
      dueDate: targetBadminton,
    },
    {
      id: "t_clean",
      title: "周日全屋打扫做清洁",
      status: "needsAction" as const,
      startTime: targetClean,
    },
    {
      id: "t_cold_noodles",
      title: "自制家庭版烤冷面",
      status: "needsAction" as const,
    },
  ];

  const lifeEvaluator = new LifeEvaluator();
  const engine = new SpeculationEngine({ evaluators: [lifeEvaluator] });
  const classified = classifyMindwtrTasks(mockTasks, [], {});
  await enrichTasksWithPrescriptions(classified, engine, []);

  console.log("[1] 验证处方自适应估算「下次推演时间」:");
  for (const t of classified.lifeTasks) {
    console.log(`    - 任务 [${t.title}]:`);
    console.log(`      * 计划时间: ${t.startTime || "无"}`);
    console.log(`      * 下次推演时间: ${t.prescription?.nextSpeculateAt}`);
    console.log(`      * 有效生命周期(TTL): ${Math.round((t.prescription?.ttlMs || 0) / 60000)} 分钟`);
    assert(Boolean(t.prescription?.nextSpeculateAt), "处方必须包含自适应 nextSpeculateAt");
    assert((t.prescription?.ttlMs || 0) > 0, "处方 TTL 必须为正数");
  }

  // 验证羽毛球紧迫任务的唤醒时间比远期大扫除更早
  const tBadminton = classified.lifeTasks.find((x) => x.id === "t_badminton")!;
  const tClean = classified.lifeTasks.find((x) => x.id === "t_clean")!;
  assert(
    new Date(tBadminton.prescription!.nextSpeculateAt!).getTime() <
    new Date(tClean.prescription!.nextSpeculateAt!).getTime(),
    "近距离任务的下次唤醒时间必须早于远期任务",
  );
  console.log("✔ 自适应推演时间估算准确！近距任务智能排在最前唤醒。");

  console.log("\n[2] 验证 IdleSpeculator 调度器接入:");
  let lifeRunCount = 0;
  const speculator = new IdleSpeculator({
    idleThresholdMs: 100, // 测试设为 100ms
    cooldownMs: 5000,
    getSessions: () => [],
    getGoals: () => [],
    runGoalSpeculation: async () => {},
    refreshLifeTrajectory: async () => {
      lifeRunCount++;
    },
    log: () => {},
  });

  // 首次运行应执行一次微闲时生活轨迹推演
  await new Promise((r) => setTimeout(r, 120));
  await speculator.tick();
  assert(lifeRunCount === 1, "首次静默达标后应执行一次推演");

  // 设置调度器下次推演时间为 2 小时后（休眠状态）
  speculator.scheduleNextLifeSpeculate(Date.now() + 2 * 3600_000);

  // 再次 tick，由于未到下次推演时间，必须保持完全休眠，不触发重算
  await speculator.tick();
  assert(lifeRunCount === 1, "自适应定时未到期前，必须完全休眠（0 重复推演）");
  console.log("✔ 自适应休眠验证成功：未到下次推演时间前，系统 0 次空转重跑！");

  console.log("\n[3] 验证传感器张力阶跃（突破阈值）主动唤醒:");
  // 模拟气象骤变 / 传感器报警，调用 wakeBySensor
  speculator.wakeBySensor("sentinel.weather-jump(level=12.5)");
  // 此时休眠应该被立刻打破，并立即触发一次重算
  await new Promise((r) => setTimeout(r, 50));
  assert(lifeRunCount === 2, "传感器张力突破必须立即打破休眠并触发重算！");
  console.log("✔ 传感器张力破线唤醒验证成功：突发事件瞬间打破休眠立即对冲！");

  console.log("\n🎉 双轮驱动推演体系全部测试通过！");
}

run().catch((err) => {
  console.error("❌ 测试失败:", err);
  process.exit(1);
});

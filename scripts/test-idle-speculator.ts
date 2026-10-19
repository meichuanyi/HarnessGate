import { IdleSpeculator, type SessionSnapshot } from "../server/idle-speculator.ts";
import type { GoalView } from "../server/goals.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function runTests() {
  console.log("=== 启动 IdleSpeculator 单元与场景测试 ===");

  const fakeGoals: GoalView[] = [
    {
      id: "goal_01",
      title: "量化策略研发",
      category: "trading",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      progress: 30,
      speculative: {
        enabled: true,
        promptTemplate: "运行策略回测",
        useWorktree: true,
      },
      lastSpeculatedAt: "2026-10-15T10:00:00.000Z",
    },
    {
      id: "goal_02",
      title: "论文复现",
      category: "academic",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      progress: 50,
      speculative: {
        enabled: true,
        promptTemplate: "编译论文 PDF",
        useWorktree: true,
      },
      lastSpeculatedAt: "2026-10-16T02:00:00.000Z", // 比 goal_01 晚，应该排在后面
    },
    {
      id: "goal_03_disabled",
      title: "未开启推演的目标",
      category: "life",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      progress: 20,
      speculative: {
        enabled: false,
      },
    },
  ];

  let lifeRefreshedCount = 0;
  const dispatchedGoals: string[] = [];
  let currentSessions: SessionSnapshot[] = [];

  const speculator = new IdleSpeculator({
    idleThresholdMs: 100, // 测试中设为 100ms
    cooldownMs: 500,     // 冷却 500ms
    lifeRefreshIntervalMs: 200,
    tickIntervalMs: 50,
    getSessions: () => currentSessions,
    getGoals: () => fakeGoals,
    refreshLifeTrajectory: async () => {
      lifeRefreshedCount++;
    },
    runGoalSpeculation: async (goalId, reason) => {
      dispatchedGoals.push(`${goalId}:${reason}`);
    },
    log: () => {}, // 测试静音
  });

  // 测试 1: 初始状态非闲时
  assert(!speculator.getStatus().isIdle, "初始 0ms 时不应处于闲时");

  // 测试 2: 人类操作重置计时
  speculator.touchHuman("test-click");
  assert(speculator.getStatus().idleSeconds === 0, "touchHuman 应该将 idleSeconds 归零");

  // 等待 150ms 进入微闲时
  await new Promise((r) => setTimeout(r, 150));
  assert(speculator.getStatus().isIdle, "150ms 后应该达到闲时阈值");

  // 测试 3: 人类会话处于 inTurn 状态时，应当抑制闲时推演
  currentSessions = [
    { id: "s1", isHuman: true, inTurn: true, status: "running" },
  ];
  await speculator.tick();
  assert(dispatchedGoals.length === 0, "人类会话 inTurn 时绝不应该派发推演");

  // 测试 4: 仅后台系统会话（非人类）处于 inTurn 时，不阻挡闲时推演
  currentSessions = [
    { id: "crew-1", isHuman: false, inTurn: true, status: "running", intentTag: "crew-task" },
  ];
  await speculator.tick();
  assert(lifeRefreshedCount === 1, "微闲时应触发生活轨迹处方刷新");
  assert(dispatchedGoals.length === 1, "应派发最久未推演的目标 (goal_01)");
  assert(dispatchedGoals[0].startsWith("goal_01:"), `应优先派发 goal_01，实际为: ${dispatchedGoals[0]}`);

  // 测试 5: 冷却期内不重入深推演
  await speculator.tick();
  assert(dispatchedGoals.length === 1, "冷却期内不应重复派发深推演");

  // 测试 6: 等待冷却期过去 (550ms)，轮转推演下一个目标 goal_02
  // 更新 goal_01 的 lastSpeculatedAt 为当前时间
  fakeGoals[0].lastSpeculatedAt = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 550));
  await speculator.tick();
  assert(dispatchedGoals.length === 2, "冷却期过后应派发第二轮推演");
  assert(dispatchedGoals[1].startsWith("goal_02:"), `第二轮应公平轮转到 goal_02，实际为: ${dispatchedGoals[1]}`);

  // 测试 7: 存量推演保护（不杀存量，不重入）
  assert(!speculator.getStatus().isSpeculating, "推演完成后 isSpeculating 应该重置为 false");

  console.log("✔ IdleSpeculator 全套 7 个场景断言全部通过！");
}

runTests().catch((err) => {
  console.error("❌ 测试失败:", err);
  process.exit(1);
});

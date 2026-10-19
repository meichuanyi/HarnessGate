import { IdleSpeculator } from "../server/idle-speculator.ts";
import { LifeEvaluator } from "../server/speculation/evaluators/life-evaluator.ts";
import { SpeculationEngine } from "../server/speculation/engine.ts";
import { loadGoals, classifyMindwtrTasks, enrichTasksWithPrescriptions, type GoalView } from "../server/goals.ts";
import { join } from "node:path";
import { homedir } from "node:os";

async function main() {
  console.log("=== 开始端到端真实链路验证 (E2E Idle Speculation Verification) ===");

  const dataDir = process.env.HG_DATA_DIR || join(homedir(), ".harnessgate");
  const goalsFile = join(dataDir, "goals.json");
  console.log(`[1] 加载真实目标配置: ${goalsFile}`);
  const goals = loadGoals(goalsFile);
  console.log(`    已加载 ${goals.length} 个目标`);

  console.log("[2] 初始化 LifeEvaluator 与 SpeculationEngine (带真实天气与约束感知)");
  const lifeEvaluator = new LifeEvaluator();
  const engine = new SpeculationEngine({
    evaluators: [lifeEvaluator],
  });

  console.log("[3] 测试模拟任务列表的微闲时生活轨迹推演 (含天气、精力与约束对冲)");
  const mockTasks = [
    {
      id: "task_badminton",
      title: "周六上午去城北体育馆打羽毛球",
      status: "needsAction" as const,
      projectTitle: "日常健身",
    },
    {
      id: "task_quilt",
      title: "大洗晒被子和四件套",
      status: "needsAction" as const,
      projectTitle: "生活内务",
    },
    {
      id: "task_cold_noodle",
      title: "尝试自制家庭版烤冷面",
      status: "needsAction" as const,
      projectTitle: "烹饪爱好",
    },
    {
      id: "task_travel",
      title: "去安吉露营自驾游",
      status: "needsAction" as const,
      projectTitle: "周末出行",
    },
  ];

  const classified = classifyMindwtrTasks(mockTasks, goals, {});
  await enrichTasksWithPrescriptions(classified, engine, goals);

  console.log("    微闲时处方生成结果:");
  for (const t of classified.lifeTasks) {
    console.log(`    - 任务 [${t.title}]:`);
    if (t.prescription) {
      console.log(`      * 状态: [${t.prescription.status.toUpperCase()}]`);
      console.log(`      * 处方摘要: ${t.prescription.summary}`);
      if (t.prescription.evidence?.perceptions?.length) {
        console.log(`      * 感官与证据:`);
        for (const ev of t.prescription.evidence.perceptions) {
          console.log(`        - ${ev}`);
        }
      }
      if (t.prescription.actions?.length) {
        console.log(`      * 联动动作:`);
        for (const act of t.prescription.actions) {
          console.log(`        - [${act.actionType}] ${act.label}`);
        }
      }
    } else {
      console.log(`      * 警告: 未生成处方`);
    }
  }

  console.log("[4] 初始化 IdleSpeculator 调度器并模拟真实状态流转");
  let simulatedHumanInTurn = false;
  let simulatedSilenceSeconds = 0;
  let speculativeRunFired = false;
  let targetDispatchedTitle = "";

  const speculator = new IdleSpeculator({
    idleThresholdMs: 300,
    cooldownMs: 1000,
    lifeRefreshIntervalMs: 500,
    getSessions: () => [
      {
        id: "human-sess-1",
        isHuman: true,
        inTurn: simulatedHumanInTurn,
        status: simulatedHumanInTurn ? "running" : "ready",
      },
      {
        id: "crew-worker-1",
        isHuman: false,
        inTurn: true, // 后台工兵在忙，不阻拦闲时推演
        status: "running",
      },
    ],
    getGoals: () => goals as GoalView[],
    refreshLifeTrajectory: async () => {
      console.log("    [调度器回调] 微闲时触发：生活轨迹即时对冲刷新完成");
    },
    runGoalSpeculation: async (goalId, reason) => {
      speculativeRunFired = true;
      const g = goals.find((x) => x.id === goalId);
      targetDispatchedTitle = g?.title || goalId;
      console.log(`    [调度器回调] 深闲时触发：独立沙箱推演派发成功！`);
      console.log(`                 目标: [${targetDispatchedTitle}] (ID: ${goalId})`);
      console.log(`                 原因: ${reason}`);
    },
    log: (m) => console.log(`    [IdleSpeculator] ${m}`),
  });

  console.log("    Step 4.1: 人类正在操作，tick 评估应该静默");
  speculator.touchHuman("user-active");
  await speculator.tick();
  if (speculativeRunFired) throw new Error("人类刚操作时不应触发深推演");

  console.log("    Step 4.2: 人类发了 Prompt 且正在等待回合 (inTurn=true)，模拟静默 400ms，tick 应抑制");
  simulatedHumanInTurn = true;
  await new Promise((r) => setTimeout(r, 400));
  await speculator.tick();
  if (speculativeRunFired) throw new Error("人类会话 inTurn 时不应触发推演");

  console.log("    Step 4.3: 回合结束，前台就绪，后台工兵在跑，人类持续静默 400ms");
  simulatedHumanInTurn = false;
  await new Promise((r) => setTimeout(r, 400));
  await speculator.tick();

  if (!speculativeRunFired) {
    throw new Error("人类静默且空闲时未触发深闲时推演！");
  }

  console.log("\n==========================================");
  console.log("🎉 验证成功！整套闲时推演体系完整跑通！");
  console.log("==========================================");
}

main().catch((err) => {
  console.error("❌ 端到端验证失败:", err);
  process.exit(1);
});

import { describe, it } from "node:test";
import assert from "node:assert";
import { SpeculationEngine } from "../server/speculation/engine.ts";
import { LifeEvaluator } from "../server/speculation/evaluators/life-evaluator.ts";
import type { SpeculativeItem } from "../server/speculation/types.ts";
import { classifyMindwtrTasks, enrichTasksWithPrescriptions, type MindwtrTaskView } from "../server/goals.ts";

describe("Speculation Engine & Evaluators", () => {
  it("LifeEvaluator should warn on drying clothes in rainy weather and suggest delay", async () => {
    const evaluator = new LifeEvaluator({
      weather: {
        condition: "rainy",
        summary: "小雨连绵，高湿低温",
        uvIndex: 1,
        humidity: 90,
      },
    });

    const item: SpeculativeItem = {
      id: "task_dry_1",
      title: "晒被子和清洗冬季床单",
      domain: "life",
      horizon: "immediate",
      sourceRef: { type: "mindwtr", rawId: "task_dry_1" },
    };

    const pres = await evaluator.evaluate(item);
    assert.ok(pres, "Prescription should be generated");
    assert.strictEqual(pres.status, "warning");
    assert.ok(pres.summary.includes("不适宜晾晒"));
    assert.ok(pres.actions && pres.actions.length > 0);
    assert.strictEqual(pres.actions[0].actionType, "reschedule_task");
    assert.match(pres.actions[0].payload.dueDate, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
  });

  it("LifeEvaluator should optimize badminton / strength training schedule mismatch", async () => {
    const evaluator = new LifeEvaluator();
    const item: SpeculativeItem = {
      id: "task_badminton",
      title: "约羽毛球 18:00",
      domain: "health",
      horizon: "immediate",
      sourceRef: { type: "mindwtr", rawId: "task_badminton" },
    };

    const pres = await evaluator.evaluate(item);
    assert.ok(pres, "Prescription should be generated");
    // Depending on today's day of week, it produces optimized or ready
    assert.ok(pres.status === "optimized" || pres.status === "ready");
    if (pres.status === "optimized" && pres.actions) {
      assert.strictEqual(pres.actions[0].actionType, "reschedule_task");
      assert.match(pres.actions[0].payload.dueDate, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
    }
  });

  it("LifeEvaluator should warn about evening gathering under fat loss diet", async () => {
    const evaluator = new LifeEvaluator({
      diet: {
        goal: "fat_loss",
        eveningCalorieLimit: 500,
        currentCalorieDeficit: "减脂冲刺期",
      },
    });

    const item: SpeculativeItem = {
      id: "task_dinner",
      title: "周五晚上和朋友约饭聚餐",
      domain: "social",
      horizon: "immediate",
      sourceRef: { type: "mindwtr", rawId: "task_dinner" },
    };

    const pres = await evaluator.evaluate(item);
    assert.ok(pres);
    assert.strictEqual(pres.status, "warning");
    assert.ok(pres.summary.includes("减脂"));
    assert.strictEqual(pres.actions?.[0].actionType, "notify");
  });

  it("SpeculationEngine should coordinate concurrent evaluations and cache results", async () => {
    const engine = new SpeculationEngine();
    const evaluator = new LifeEvaluator();
    engine.registerEvaluator(evaluator);

    const items: SpeculativeItem[] = [
      {
        id: "task_1",
        title: "洗衣服并晾晒",
        domain: "life",
        horizon: "immediate",
        sourceRef: { type: "mindwtr", rawId: "task_1" },
      },
      {
        id: "task_2",
        title: "健身房力量训练",
        domain: "health",
        horizon: "immediate",
        sourceRef: { type: "mindwtr", rawId: "task_2" },
      },
    ];

    const res1 = await engine.speculate(items);
    assert.strictEqual(res1.size, 2);
    assert.ok(res1.has("task_1"));
    assert.ok(res1.has("task_2"));

    // Cache test
    const res2 = await engine.speculate(items);
    assert.strictEqual(res2.get("task_1"), res1.get("task_1"));
  });

  it("enrichTasksWithPrescriptions should fill prescription into tasks", async () => {
    const engine = new SpeculationEngine();
    engine.registerEvaluator(new LifeEvaluator());

    const tasks: MindwtrTaskView[] = [
      { id: "mw_1", title: "洗衣服和被子" },
      { id: "mw_2", title: "常规买菜做饭" },
    ];

    const classified = classifyMindwtrTasks(tasks, []);
    await enrichTasksWithPrescriptions(classified, engine, []);

    const t1 = classified.lifeTasks.find((x) => x.id === "mw_1");
    assert.ok(t1?.prescription);
    assert.strictEqual(t1.prescription.status, "warning");
  });
});

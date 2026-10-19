import { WeatherSensor } from "../server/sentinel/weather-sensor.ts";
import { LifeEvaluator } from "../server/speculation/evaluators/life-evaluator.ts";

async function main() {
  console.log("=== 1. 测试 WeatherSensor 真实抓取 ===");
  const sensor = new WeatherSensor({
    city: "杭州",
    latitude: 30.2741,
    longitude: 120.1551,
    intervalMs: 3600_000,
    log: (m) => console.log("  LOG:", m),
  });

  const snap = await sensor.fetchWeather();
  console.log("杭州气象快照:", JSON.stringify(snap, null, 2));

  if (!snap || snap.city !== "杭州") {
    throw new Error("WeatherSensor 快照异常");
  }

  console.log("\n=== 2. 测试 LifeEvaluator 接入动态天气感知 ===");
  const life = new LifeEvaluator({
    getWeather: () => snap,
  });

  const prescription = await life.evaluate({
    id: "item-wash",
    title: "洗衣服并晾晒到阳台",
    domain: "life",
    horizon: "immediate",
    sourceRef: { type: "mindwtr", rawId: "mw-123" },
  });

  console.log("推演处方结果:", JSON.stringify(prescription, null, 2));
  if (!prescription) {
    throw new Error("LifeEvaluator 未生成处方");
  }

  console.log("\n=== 3. 验证通过！全部感知与推演联动正常 ===");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

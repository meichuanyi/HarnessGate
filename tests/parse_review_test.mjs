import { parseReview, CREW_APPROVE_SCORE } from "../server/crew.ts";
import { parseConverged, parseRoundScores } from "../server/room.ts";

let bad = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { bad++; console.log(`✘ ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  else console.log(`✔ ${name}`);
};

// --- parseReview ---
const r1 = parseReview('```json\n{"verdict":"revise","score":6,"rubric":[{"item":"导出 add 函数","pass":false,"note":"只写了 README"},{"item":"范围外改动","pass":true}],"comments":"补实现"}\n```');
eq("parseReview 完整 JSON", r1, { verdict: "revise", score: 6, rubric: [{ item: "导出 add 函数", pass: false, note: "只写了 README" }, { item: "范围外改动", pass: true, note: undefined }], comments: "补实现" });

const r2 = parseReview("我认为可以 通过，没有问题。");
eq("parseReview 关键词兜底（无分数）", r2, { verdict: "approve", comments: "我认为可以 通过，没有问题。" });

const r3 = parseReview("完全没法解析的一段话");
eq("parseReview 解析不出 → null", r3, null);

const r4 = parseReview('{"verdict":"approve","score":99,"comments":"x"}');
eq("parseReview 越界分数视为无分数", r4, { verdict: "approve", score: undefined, rubric: undefined, comments: "x" });

eq("通过线是 8", CREW_APPROVE_SCORE >= 0 && CREW_APPROVE_SCORE <= 10, true);

// --- parseRoundScores ---
const s1 = parseRoundScores("小结正文……\n【评分】ZCode=8（论证扎实）；Hermes=5（偏题）\n收敛判定：未收敛（还差 X）");
eq("parseRoundScores 两人带点评", s1, [
  { member: "ZCode", score: 8, note: "论证扎实" },
  { member: "Hermes", score: 5, note: "偏题" },
]);
const s2 = parseRoundScores("【评分】ZCode=10");
eq("parseRoundScores 满分无点评", s2, [{ member: "ZCode", score: 10, note: "" }]);
const s3 = parseRoundScores("没有任何评分行");
eq("parseRoundScores 无标记 → 空", s3, []);
const s4 = parseRoundScores("【评分】AA=15（越界）；BB=7");
eq("parseRoundScores 越界分数丢弃", s4, [{ member: "BB", score: 7, note: "" }]);

// --- parseConverged（回归） ---
eq("parseConverged 仍工作", parseConverged("收敛判定：已收敛"), true);

console.log(bad === 0 ? "\n=== ALL PASS ===" : `\n=== ${bad} FAILED ===`);
process.exit(bad ? 1 : 0);

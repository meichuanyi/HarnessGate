/**
 * 通用最优路径推演求值器（Optimal Trajectory & Life Speculator）
 *
 * 【控制论与最优化本质】：
 * 面对长线目标（Goals），在现有的动态约束（Sensors & Constraints）下，
 * 充分利用自身有限资源（Energy, Attention, Time, Equipment），计算并走出最优行动路径。
 *
 * 彻底消除针对单一业务名词的死板 if-else 硬编码穷举！
 * 任何现实任务（无论日常待办还是宏观行动），均映射入统一的最优化评估空间：
 *
 * 1. 约束可行域检验（Constraint & Feasibility Boundary）：
 *    - 实时接入传感器（WeatherSensor 自然微气候、TemporalSensor 时间窗紧迫度、生理与心智疲劳水位）；
 *    - 若当前环境约束使行动落入不可行域（如暴雨洗晒、强紫外线户外、极度疲劳高爆发），前置阻断并给出最小代价的改期顺延处方。
 *
 * 2. 资源博弈与多目标对齐（Resource Budget & Goal Alignment）：
 *    - 评估该行动对有限资源（体能能量、中枢神经、卡路里平衡、时间精力）的损耗；
 *    - 检查与宏观长线目标（减脂体态、学术交付、职业精进、家庭心智）的协同或冲突。
 *
 * 3. 最优执行路径与微焦点锦囊（Optimal Execution & Pro-Tip）：
 *    - 给出前置资源就绪检查（装备、物料、工具）；
 *    - 给出执行过程中的护体与避坑指南（防损耗、防烫伤、防拉伤）；
 *    - 提供 1 个提升达成品质的独家微焦点（带着刻意焦点前进，达成最优状态转移）。
 *
 * 4. 链式因果协同（Ripple & Chained Dependency）：
 *    - 推演该行动对紧随其后的下一阶段任务的涟漪影响，打通因果链。
 */

import type { SpeculativeEvaluator, SpeculativeItem, SpeculativePrescription } from "../types.ts";

/** 辅助：格式化为严格的 YYYY-MM-DDTHH:mm:ss+08:00 时间戳 */

/**
 * 根据行动的时间窗口与紧急度，自适应估算「下次推演时间」
 * 规则：
 * 1. 若有具体开始时间 (startTime)：
 *    - 距离现在 > 24h：提前 4 小时推演一次
 *    - 距离现在 2h ~ 24h：提前 60 分钟推演一次（临界活动备料与提醒）
 *    - 距离现在 <= 2h：提前 15 分钟最后核验一次
 *    - 正在进行或已过去：6 小时后或次日清晨复核
 * 2. 若无开始时间但有截止时间 (dueDate)：截止前 3 小时复核
 * 3. 若均无指定时间（普通积压待办）：默认 24 小时后复核
 */
export function estimateNextSpeculateTime(timeWindow?: { start?: string; due?: string }): { nextSpeculateAt: string; ttlMs: number } {
  const now = Date.now();
  const startStr = timeWindow?.start || timeWindow?.due;
  let nextMs: number;

  if (startStr) {
    const targetMs = new Date(startStr).getTime();
    const diff = targetMs - now;

    if (diff > 24 * 3600_000) {
      // 距离开始 > 24 小时：在开始前 4 小时推演
      nextMs = targetMs - 4 * 3600_000;
    } else if (diff > 2 * 3600_000) {
      // 距离开始 2 ~ 24 小时：在开始前 60 分钟唤醒
      nextMs = targetMs - 60 * 60_000;
    } else if (diff > 0) {
      // 距离开始 <= 2 小时：在开始前 15 分钟最后唤醒
      nextMs = Math.max(now + 5 * 60_000, targetMs - 15 * 60_000);
    } else {
      // 任务时间已过或正在进行：8 小时后复核
      nextMs = now + 8 * 3600_000;
    }
  } else {
    // 无时间戳的积压池：12 小时后复核
    nextMs = now + 12 * 3600_000;
  }

  // 确保至少有 10 分钟 TTL，且不会在过去
  nextMs = Math.max(now + 10 * 60_000, nextMs);
  const ttlMs = nextMs - now;
  return {
    nextSpeculateAt: formatCstIso(new Date(nextMs)),
    ttlMs,
  };
}

export function formatCstIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  const cst = new Date(utc + 8 * 3600000);
  const y = cst.getFullYear();
  const m = pad(cst.getMonth() + 1);
  const d = pad(cst.getDate());
  const h = pad(cst.getHours());
  const mi = pad(cst.getMinutes());
  const s = pad(cst.getSeconds());
  return `${y}-${m}-${d}T${h}:${mi}:${s}+08:00`;
}

/** 动态环境感知约束输入 */
export type EnvironmentConstraints = {
  weather?: {
    condition: "sunny" | "cloudy" | "rainy" | "humid";
    summary: string;
    temperature?: number;
    humidity: number; // 0-100%
    uvIndex: number; // 0-12
    precipitationProbability?: number;
  };
  diet?: {
    goal: "fat_loss" | "muscle_gain" | "normal";
    eveningCalorieLimit: number;
    currentCalorieDeficit?: string;
  };
};

export type LifeEvaluatorOptions = {
  env?: EnvironmentConstraints;
  getWeather?: () => Promise<EnvironmentConstraints["weather"] | null | undefined> | EnvironmentConstraints["weather"] | null | undefined;
  apiConfig?: () => { baseUrl: string; apiKey: string; model: string } | null;
  getGoalsContext?: () => string;
};

export class LifeEvaluator implements SpeculativeEvaluator {
  readonly name = "life-evaluator";

  private env: EnvironmentConstraints;
  private getWeather?: LifeEvaluatorOptions["getWeather"];
  private apiConfig?: LifeEvaluatorOptions["apiConfig"];
  private getGoalsContext?: LifeEvaluatorOptions["getGoalsContext"];

  // 内存推演缓存（相同任务 ID + 约束参数，30 分钟内复用，避免每次重复推理）
  private cache = new Map<string, { pres: SpeculativePrescription; expiresAt: number }>();

  constructor(options?: LifeEvaluatorOptions | EnvironmentConstraints) {
    if (options && ("getWeather" in options || "apiConfig" in options || "getGoalsContext" in options)) {
      const opts = options as LifeEvaluatorOptions;
      this.getWeather = opts.getWeather;
      this.apiConfig = opts.apiConfig;
      this.getGoalsContext = opts.getGoalsContext;
      this.env = opts.env ?? {
        diet: {
          goal: "fat_loss",
          eveningCalorieLimit: 500,
          currentCalorieDeficit: "减脂冲刺期（目标日缺口 400kcal）",
        },
      };
    } else {
      this.env = (options as EnvironmentConstraints) ?? {
        diet: {
          goal: "fat_loss",
          eveningCalorieLimit: 500,
          currentCalorieDeficit: "减脂冲刺期（目标日缺口 400kcal）",
        },
      };
    }
  }

  setPerception(env: Partial<EnvironmentConstraints>): void {
    this.env = { ...this.env, ...env };
  }

  canEvaluate(item: SpeculativeItem): boolean {
    return item.domain === "life" || item.domain === "health" || item.domain === "social";
  }

  /**
   * 核心推演 = 确定性硬规则（洗晒类任务的天气可行域，可验证、保留）+ 本地小模型生成贴题内容。
   * 小模型不可用/超时/输出空洞 → 返回 null：宁可没有处方，不要模板废话。
   */
  async evaluate(item: SpeculativeItem): Promise<SpeculativePrescription | null> {
    const now = Date.now();
    const cacheKey = `${item.id}:${item.title}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.pres;
    }

    // 1. 采集环境实测（动态感知器）
    const liveWeather = this.getWeather ? await this.getWeather() : null;
    const weather = liveWeather || this.env.weather || {
      condition: "sunny",
      summary: "室外微气象就绪",
      temperature: 24,
      humidity: 50,
      uvIndex: 5,
    };

    // 2. 天气硬规则：洗晒/户外类任务的客观可行域判定（湿度/日照阈值，保留确定性）
    const isClimateDependent = /洗|晒|户外|露营|保洁|大扫除|远行|骑行/.test(item.title);
    if (isClimateDependent) {
      const isBadForMoisture = weather.condition === "rainy" || weather.humidity > 68 || weather.uvIndex < 4;
      if (isBadForMoisture) {
        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() + 2);
        targetDate.setHours(10, 0, 0, 0);
        const pres: SpeculativePrescription = {
          itemId: item.id,
          status: "warning",
          summary: `外部约束未就绪（${weather.summary}），该行动超出可行域，推演建议避开约束阻力。`,
          evidence: {
            perceptions: [
              `传感器实测约束：${weather.summary}`,
              `湿度与水分蒸发：当前湿度 ${weather.humidity}%，无法达成理想干燥杀菌阈值`,
              "最优状态建议：前置阻断当前无效损耗，平移至高日照低湿度窗口",
            ],
            memories: ["约束可行性法则：当环境阻力显著大于执行收益时，顺延时间窗即是帕累托最优"],
          },
          actions: [
            {
              label: "避开天气劣势约束：一键顺延2天至最佳日照窗 (10:00)",
              actionType: "reschedule_task",
              payload: {
                taskId: item.sourceRef.rawId,
                dueDate: formatCstIso(targetDate),
                startTime: formatCstIso(targetDate),
                delayDays: 2,
              },
            },
          ],
        };
        const schedule = estimateNextSpeculateTime(item.timeWindow);
        pres.nextSpeculateAt = schedule.nextSpeculateAt;
        pres.ttlMs = schedule.ttlMs;
        this.cache.set(cacheKey, { pres, expiresAt: now + schedule.ttlMs });
        return pres;
      }
    }

    // 3. 内容生成本地小模型（qwen2.5-1.5b，llama-server OpenAI 兼容口）
    const goalsContext = this.getGoalsContext ? this.getGoalsContext() : "";
    const diet = this.env.diet ?? {
      goal: "fat_loss" as const,
      eveningCalorieLimit: 500,
      currentCalorieDeficit: "减脂冲刺期",
    };
    const pres = await this.llmPrescription(item, weather, goalsContext, diet);
    if (!pres) return null;
    const schedule = estimateNextSpeculateTime(item.timeWindow);
    pres.nextSpeculateAt = schedule.nextSpeculateAt;
    pres.ttlMs = schedule.ttlMs;
    this.cache.set(cacheKey, { pres, expiresAt: now + schedule.ttlMs });
    return pres;
  }

  /** 本地小模型生成贴题处方：带真实时间/天气/目标上下文；失败或空洞 → null */
  private async llmPrescription(
    item: SpeculativeItem,
    weather: NonNullable<EnvironmentConstraints["weather"]>,
    goalsContext: string,
    diet: NonNullable<EnvironmentConstraints["diet"]>,
  ): Promise<SpeculativePrescription | null> {
    const api = this.apiConfig?.();
    if (!api?.baseUrl || !api.model) return null;
    const start = item.timeWindow?.start || item.timeWindow?.due || "";
    let weekday = "";
    try {
      if (start) weekday = new Date(start).toLocaleDateString("zh-CN", { weekday: "long", timeZone: "Asia/Shanghai" });
    } catch {}
    const sys = [
      "你是生活行动规划助手。基于【给定事实】为行动生成推演处方，只输出一个 JSON 对象：",
      '{"summary":"一句话总评(≤40字)","perceptions":["要点1","要点2","要点3","要点4"],"memories":["一条原则(≤18字)"]}',
      "硬性要求：perceptions 共 3-4 条、每条 ≤26 字，必须紧扣行动本身与给定事实（时间/天气/目标）；禁止通用套话；除 JSON 外不输出任何内容。",
    ].join("\n");
    const user = [
      `行动：${item.title}`,
      `时间：${start || "未定"}${weekday ? `（${weekday}）` : ""}`,
      `天气实测：${weather.condition} ${weather.temperature ?? "?"}°C 湿度${weather.humidity}%（${weather.summary}）`,
      `体重/饮食约束：${diet.goal === "fat_loss" ? `减脂期，晚餐上限 ${diet.eveningCalorieLimit} kcal，${diet.currentCalorieDeficit}` : diet.goal}`,
      goalsContext ? `长期目标上下文：${goalsContext.slice(0, 150)}` : "",
    ].filter(Boolean).join("\n");
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25_000);
      const res = await fetch(`${api.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(api.apiKey ? { authorization: `Bearer ${api.apiKey}` } : {}) },
        body: JSON.stringify({
          model: api.model,
          messages: [
            { role: "system", content: sys },
            { role: "user", content: user },
          ],
          temperature: 0.5,
          max_tokens: 300,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const raw = String(data.choices?.[0]?.message?.content ?? "").replace(/```json|```/g, "").trim();
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const j = JSON.parse(m[0]) as { summary?: unknown; perceptions?: unknown; memories?: unknown };
      const summary = String(j.summary ?? "").trim();
      const perceptions = Array.isArray(j.perceptions)
        ? j.perceptions.map((x) => String(x).trim()).filter(Boolean).slice(0, 4)
        : [];
      const memories = Array.isArray(j.memories) ? j.memories.map((x) => String(x).trim()).filter(Boolean).slice(0, 1) : [];
      if (summary.length < 6 || perceptions.length < 2) return null;   // 空洞防御
      return {
        itemId: item.id,
        status: "ready",
        summary: `行动【${item.title}】${summary}`,
        evidence: { perceptions, memories },
        actions: [],
      };
    } catch {
      return null;   // 模型不可用/超时/输出不合法：宁可没有处方
    }
  }
}

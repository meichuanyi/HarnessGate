/**
 * 生活领域求值器（Life Evaluator）
 *
 * 覆盖规则：
 * 1. 晾晒类（晒被子/洗衣服）：感知天气与紫外线（如遇阴雨/高湿度产生 warning，并生成一键顺延 action，如顺延2天到晴天）；
 * 2. 运动健身（打羽毛球/力量训练）：校验主人作息（周一/三 17:30力量训练，周二/五 18:00羽毛球）；
 * 3. 社交聚餐（见朋友/约饭）：校验饮食偏好与晚间减肥状态。
 */

import type { SpeculativeEvaluator, SpeculativeItem, SpeculativePrescription } from "../types.ts";

/** 辅助：格式化为严格的 YYYY-MM-DDTHH:mm:ss+08:00 时间戳 */
export function formatCstIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  // 转换为 +08:00 时区的时间
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

/** 模拟/感知外部环境状态（可由外部 Sensor/缓存注入，缺省为默认感知） */
export type LifeEnvironmentPerception = {
  weather?: {
    condition: "sunny" | "cloudy" | "rainy" | "humid";
    summary: string;
    uvIndex: number; // 0-10
    humidity: number; // 0-100%
  };
  diet?: {
    goal: "fat_loss" | "muscle_gain" | "normal";
    eveningCalorieLimit: number;
    currentCalorieDeficit?: string;
  };
};

export class LifeEvaluator implements SpeculativeEvaluator {
  readonly name = "life-evaluator";

  private env: LifeEnvironmentPerception;

  constructor(env?: LifeEnvironmentPerception) {
    this.env = env ?? {
      weather: {
        condition: "rainy",
        summary: "小雨转阴，空气湿度 85%，紫外线弱",
        uvIndex: 2,
        humidity: 85,
      },
      diet: {
        goal: "fat_loss",
        eveningCalorieLimit: 500,
        currentCalorieDeficit: "减脂冲刺期（目标日缺口 400kcal）",
      },
    };
  }

  setPerception(env: Partial<LifeEnvironmentPerception>): void {
    this.env = { ...this.env, ...env };
  }

  canEvaluate(item: SpeculativeItem): boolean {
    return item.domain === "life" || item.domain === "health" || item.domain === "social";
  }

  async evaluate(item: SpeculativeItem): Promise<SpeculativePrescription | null> {
    const title = item.title.toLowerCase();

    // ── 1. 晾晒类（晒被子/洗衣服/晒衣服/洗床单） ──
    if (/晒|晾|洗衣|衣服|床单|被子/.test(title)) {
      const weather = this.env.weather ?? {
        condition: "rainy",
        summary: "连续阴雨高湿",
        uvIndex: 2,
        humidity: 85,
      };

      const isBadForDrying = weather.condition === "rainy" || weather.humidity > 70 || weather.uvIndex < 4;
      if (isBadForDrying) {
        // 计算顺延 2 天后的晴天时间（严格时间戳格式）
        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() + 2);
        targetDate.setHours(10, 0, 0, 0); // 建议晴天上午 10:00 晾晒
        const newDueIso = formatCstIso(targetDate);
        const newStartIso = formatCstIso(targetDate);

        return {
          itemId: item.id,
          status: "warning",
          summary: `当前天气气象不适宜晾晒（${weather.summary}），建议顺延 2 天至晴好时段。`,
          evidence: {
            perceptions: [
              `天气感知：${weather.summary}`,
              `环境湿度：${weather.humidity}%（晾晒门槛 ≤65%）`,
              `紫外线指数：${weather.uvIndex}（晒被杀菌门槛 ≥5）`,
            ],
            memories: [
              "生活习惯：晾晒需要至少连续 4 小时阳光直射与良好通风",
              "历史偏好：遇阴雨自动后延至最近周末或晴天上午",
            ],
          },
          actions: [
            {
              label: "一键顺延2天到晴天 (10:00)",
              actionType: "reschedule_task",
              payload: {
                taskId: item.sourceRef.rawId,
                dueDate: newDueIso,
                startTime: newStartIso,
                delayDays: 2,
              },
            },
          ],
        };
      }

      return {
        itemId: item.id,
        status: "ready",
        summary: "当前光照充沛、湿度适宜，可正常执行晾晒。",
        evidence: {
          perceptions: [`天气感知：${weather.summary}`, `湿度：${weather.humidity}%`],
          memories: ["适宜晾晒标准符合"],
        },
      };
    }

    // ── 2. 运动健身（打羽毛球/力量训练/健身/跑步） ──
    if (/羽毛球|力量训练|健身|跑步|锻炼/.test(title)) {
      // 校验作息习惯：周一/三 17:30力量训练，周二/五 18:00羽毛球
      const now = new Date();
      const currentDay = now.getDay(); // 0(周日) - 6(周六)
      const dayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

      const isBadminton = /羽毛球/.test(title);
      const isStrength = /力量训练|健身/.test(title);

      let expectedTimeDesc = "";
      let isMismatch = false;
      let targetScheduleHour = 18;
      let targetScheduleMinute = 0;
      let targetNextDayOffset = 0;

      if (isStrength) {
        expectedTimeDesc = "周一 / 周三 17:30 力量训练";
        // 周一(1) 或 周三(3)
        if (currentDay !== 1 && currentDay !== 3) {
          isMismatch = true;
          // 寻找最近的周一或周三
          const daysToMon = (1 - currentDay + 7) % 7 || 7;
          const daysToWed = (3 - currentDay + 7) % 7 || 7;
          targetNextDayOffset = Math.min(daysToMon, daysToWed);
          targetScheduleHour = 17;
          targetScheduleMinute = 30;
        }
      } else if (isBadminton) {
        expectedTimeDesc = "周二 / 周五 18:00 羽毛球";
        // 周二(2) 或 周五(5)
        if (currentDay !== 2 && currentDay !== 5) {
          isMismatch = true;
          const daysToTue = (2 - currentDay + 7) % 7 || 7;
          const daysToFri = (5 - currentDay + 7) % 7 || 7;
          targetNextDayOffset = Math.min(daysToTue, daysToFri);
          targetScheduleHour = 18;
          targetScheduleMinute = 0;
        }
      }

      if (isMismatch) {
        const nextTargetDate = new Date();
        nextTargetDate.setDate(nextTargetDate.getDate() + targetNextDayOffset);
        nextTargetDate.setHours(targetScheduleHour, targetScheduleMinute, 0, 0);
        const newStartIso = formatCstIso(nextTargetDate);
        const newDueIso = formatCstIso(new Date(nextTargetDate.getTime() + 2 * 3600000));

        const targetDayName = dayNames[nextTargetDate.getDay()];

        return {
          itemId: item.id,
          status: "optimized",
          summary: `当前为${dayNames[currentDay]}，与主人既定作息惯例（${expectedTimeDesc}）不同步。`,
          evidence: {
            perceptions: [
              `今日为：${dayNames[currentDay]}`,
              `作息匹配度：非推荐健身日（避免肌群超负荷）`,
            ],
            memories: [
              "体能作息律：周一/三 17:30 力量训练，周二/五 18:00 羽毛球",
              "恢复周期：力量与高爆发羽毛球交替安排，留足 48h 肌肉恢复窗口",
            ],
          },
          actions: [
            {
              label: `校准至最近作息时段 (${targetDayName} ${String(targetScheduleHour).padStart(2, "0")}:${String(targetScheduleMinute).padStart(2, "0")})`,
              actionType: "reschedule_task",
              payload: {
                taskId: item.sourceRef.rawId,
                dueDate: newDueIso,
                startTime: newStartIso,
                delayDays: targetNextDayOffset,
              },
            },
          ],
        };
      }

      return {
        itemId: item.id,
        status: "ready",
        summary: `符合日常训练作息节奏（${expectedTimeDesc}），建议按时执行。`,
        evidence: {
          perceptions: [`今日为：${dayNames[currentDay]}`],
          memories: [`常规训练日程：${expectedTimeDesc}`],
        },
      };
    }

    // ── 3. 社交聚餐（见朋友/约饭/聚餐/聚会） ──
    if (/见朋友|约饭|聚餐|吃饭|聚会|大餐/.test(title)) {
      const diet = this.env.diet ?? {
        goal: "fat_loss",
        eveningCalorieLimit: 500,
        currentCalorieDeficit: "减脂冲刺期",
      };

      if (diet.goal === "fat_loss") {
        return {
          itemId: item.id,
          status: "warning",
          summary: `主人正处于${diet.currentCalorieDeficit}，晚间社交聚餐有热量超标风险。`,
          evidence: {
            perceptions: [
              `饮食目标：${diet.goal}（晚间摄入安全阈值 ≤${diet.eveningCalorieLimit} kcal）`,
              `状态感知：${diet.currentCalorieDeficit}`,
            ],
            memories: [
              "健康与减脂准则：外食社交聚餐平均超标 600-1000 kcal",
              "饮食偏好策略：优选日料/火锅清汤/潮汕牛肉锅，避开高油重盐及酒精",
            ],
          },
          actions: [
            {
              label: "标记轻食/低脂餐厅备选与限酒提示",
              actionType: "notify",
              payload: {
                taskId: item.sourceRef.rawId,
                note: "健康处方：建议选择日料刺身或清汤潮汕牛肉，聚餐前先饮 500ml 饮用水，主食碳水减半。",
              },
            },
          ],
        };
      }
    }

    return null;
  }
}

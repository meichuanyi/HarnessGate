/**
 * 定时任务：存储 + 时间求值。
 * 时间机制 = 标准 cron 表达式（croner 求值）+ 运行窗口过滤（跨午夜/星期几）。
 * UI 的"频率+窗口"两层模型在网页端编译成 cron；引擎只负责边界正确的求值。
 * 持久化：DATA_DIR/schedules.json（原子写，与 rooms/sessions 同款）。
 */
import { Cron } from "croner";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Cadence =
  | { type: "daily"; at: string }                       // "HH:MM"
  | { type: "interval"; everyMinutes: number }
  | { type: "weekly"; days: number[]; at: string }      // days: 0-6（0=周日）
  | { type: "cron"; expr: string };                     // 高级逃生舱：原生 5 段表达式

export type ScheduleWindow = { from?: string; to?: string; weekdays?: number[] };

export type ScheduleContract = { requires?: string[]; outputFile?: string };

export type ScheduleState = {
  running?: boolean;
  nextFireAt?: string;
  lastRunAt?: string;
  lastStatus?: "ok" | "error" | "contract-fail" | "timeout" | "skipped-running" | "missing-files";
  lastSessionId?: string;
  consecutiveFailures?: number;
  lastError?: string;
};

export type Schedule = {
  id: string;
  name: string;
  enabled: boolean;
  harnessId: string;
  /** 空 = 使用自动工作区 DATA_DIR/schedules/<id>/（自动建 + git init） */
  cwd?: string;
  autoApprove?: "off" | "readonly" | "all";
  cadence: Cadence;
  window?: ScheduleWindow;
  overlap: "skip";
  sessionMode: "fresh" | "dedicated";
  promptTemplate: string;
  contract?: ScheduleContract;
  createdAt: string;
  state: ScheduleState;
};

export const WD_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function newScheduleId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** 频率 → cron 表达式（窗口不编译进来，作为运行时过滤，支持跨午夜与顺延） */
export function compileCron(c: Cadence): string {
  const hm = (at: string): [number, number] => {
    const parts = at.split(":").map((x) => Number(x));
    const H = parts[0] ?? 0, M = parts[1] ?? 0;
    if (Number.isNaN(H) || Number.isNaN(M)) throw new Error(`时间格式应为 HH:MM：${at}`);
    return [H, M];
  };
  if (c.type === "daily") {
    const [H, M] = hm(c.at);
    return `${M} ${H} * * *`;
  }
  if (c.type === "weekly") {
    const [H, M] = hm(c.at);
    if (!c.days?.length) throw new Error("每周频率需要至少选择一天");
    return `${M} ${H} * * ${c.days.join(",")}`;
  }
  if (c.type === "interval") {
    const n = Number(c.everyMinutes);
    if (!n || n < 1) throw new Error("间隔应为正整数分钟");
    if (n < 60) return `*/${n} * * * *`;
    const h = Math.max(1, Math.round(n / 60));
    return `0 */${h} * * *`;
  }
  return c.expr.trim();
}

/** 某时刻是否落在运行窗口内（窗口 from > to 视为跨午夜） */
export function inWindow(d: Date, w?: ScheduleWindow): boolean {
  if (!w) return true;
  if (w.weekdays?.length && !w.weekdays.includes(d.getDay())) return false;
  if (!w.from && !w.to) return true;
  const m = d.getHours() * 60 + d.getMinutes();
  const p = (s: string): number => {
    const [H, M] = String(s ?? "").split(":").map((x) => Number(x));
    return (H || 0) * 60 + (M || 0);
  };
  const from = w.from ? p(w.from) : null;
  const to = w.to ? p(w.to) : null;
  if (from !== null && to !== null) {
    return from <= to ? m >= from && m <= to : m >= from || m <= to;
  }
  if (from !== null) return m >= from;
  if (to !== null) return m <= to;
  return true;
}

/** 下一次触发时刻：cron 求值 + 窗口过滤（窗口外顺延，最多迭代 400 次防死循环） */
export function nextFire(c: Cadence, window: ScheduleWindow | undefined, from = new Date()): Date | undefined {
  const cron = new Cron(compileCron(c), { timezone: "Asia/Shanghai" });
  let d: Date | undefined = from;
  for (let i = 0; i < 400; i++) {
    d = cron.nextRun(d ?? undefined) as unknown as Date | undefined;
    if (!d) return undefined;
    if (inWindow(d, window)) return d;
  }
  return undefined;
}

/** 人类可读的频率描述（列表展示用） */
export function cadenceDesc(c: Cadence): string {
  if (c.type === "daily") return `每天 ${c.at}`;
  if (c.type === "interval") return `每 ${c.everyMinutes} 分钟`;
  if (c.type === "weekly") return `每周 ${c.days.map((d) => WD_CN[d] ?? d).join("/")} ${c.at}`;
  return c.expr;
}

export type SchedulesFile = { version: 1; schedules: Schedule[] };

export function loadSchedules(file: string): Schedule[] {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as SchedulesFile;
    return raw.schedules ?? [];
  } catch {
    return [];
  }
}

export function saveSchedules(file: string, schedules: Schedule[]): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, schedules } satisfies SchedulesFile, null, 1));
  renameSync(tmp, file);
}

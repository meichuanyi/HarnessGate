/**
 * [vendored] 复制自独立验证项目 /root/projects/sentinel-hub（Sentinel 伴生感知框架）。
 * 本目录是 HarnessGate 内嵌副本，仅调整了相对导入路径；与上游的功能性差异以 [hg-diff] 标注。
 */
import { makeEvent, type Salience, type Sensor, type SensoryEvent } from "./types.ts";

/**
 * 时间感官：把「时间本身」变成事件流。
 *
 * - 脉冲（temporal.pulse）：固定间隔的心跳，显著性默认 whisper——单个脉冲几乎不产生
 *   张力，但它是「慢性压力」的载体：一件事被搁置得越久，脉冲攒得越多，水位终会漫过
 *   阈值把事情顶到认知层。这正是张力模型对「到期未办」的自然表达；
 * - 闹钟（temporal.alarm）：定点（HH:MM）或周期（everyMinutes）提醒，显著性默认
 *   loud——约定好的时间点是明确意图，不该靠攒。
 */

export type TemporalAlarm = {
  /** 定点触发（本地时区 HH:MM，分钟粒度） */
  at?: string;
  /** 周期触发（每 N 分钟；1 = 每分钟） */
  everyMinutes?: number;
  salience?: Salience;
  summary: string;
};

export type TemporalSensorOptions = {
  /** 脉冲间隔 ms（默认 60_000） */
  intervalMs?: number;
  /** 脉冲显著性（默认 whisper） */
  pulseSalience?: Salience;
  /** 闹钟列表（可选） */
  alarms?: TemporalAlarm[];
  log?: (line: string) => void;
};

export class TemporalSensor implements Sensor {
  readonly name = "temporal";
  onEvent?: (evt: SensoryEvent) => void;
  private timer?: NodeJS.Timeout;
  /** 已触发的闹钟槽位（`${index}:${minuteBucket}`），防同一分钟重复触发 */
  private readonly fired = new Set<string>();
  private pulses = 0;

  constructor(private readonly opts: TemporalSensorOptions) {}

  start(): void {
    if (this.timer) return;
    this.tick();   // 启动即刻给一拍：宿主马上有脉冲可消费
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs ?? 60_000);
  }

  private tick(): void {
    const now = new Date();
    this.onEvent?.(
      makeEvent({
        modality: "temporal",
        kind: "temporal.pulse",
        subject: "clock",
        summary: `时间脉冲 #${++this.pulses} ${now.toISOString()}`,
        salience: this.opts.pulseSalience ?? "whisper",
      }),
    );
    const minuteBucket = Math.floor(now.getTime() / 60_000);
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    (this.opts.alarms ?? []).forEach((alarm, i) => {
      const due =
        alarm.at != null
          ? hhmm === alarm.at
          : alarm.everyMinutes != null
            ? minuteBucket % Math.max(1, alarm.everyMinutes) === 0
            : false;
      const slot = `${i}:${alarm.at ?? `m${minuteBucket}`}`;
      if (!due || this.fired.has(slot)) return;
      this.fired.add(slot);
      if (this.fired.size > 256) {
        // 槽位簿防膨胀：只留最近的
        const oldest = this.fired.values().next().value;
        if (oldest) this.fired.delete(oldest);
      }
      this.onEvent?.(
        makeEvent({
          modality: "temporal",
          kind: "temporal.alarm",
          subject: alarm.at ?? `every-${alarm.everyMinutes}m`,
          summary: alarm.summary,
          salience: alarm.salience ?? "loud",
        }),
      );
      this.opts.log?.(`[temporal] 闹钟触发: ${alarm.summary}`);
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

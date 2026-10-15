/**
 * [vendored] 复制自独立验证项目 /root/projects/sentinel-hub（Sentinel 伴生感知框架）。
 * 本目录是 HarnessGate 内嵌副本，仅调整了相对导入路径；与上游的功能性差异以 [hg-diff] 标注。
 */
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

import { makeEvent, type Salience, type Sensor, type SensoryEvent } from "./types.ts";

/**
 * FS 感官：递归监听目录，把文件变动摊平成 SensoryEvent。
 *
 * 两层降噪（文件系统的原始回调太毛糙，一次保存常触发 3~5 个回调）：
 * - 传感器层：同一文件在 quietMs 内的连续变动合并为一条事件（本层只做「同路径合并」，
 *   跨路径的意图聚类归 System 1）；
 * - 黑名单：node_modules/.git/日志/锁文件这类机械噪音，根本不产生事件。
 *
 * 显著性先验：配置/计划类文件（json/yaml/toml/env）的变动被视为 loud——
 * 改配置的人心里都带着意图。
 */

export type FsSensorOptions = {
  /** 监听的目录列表（递归） */
  paths: string[];
  /** 白名单过滤（绝对路径入参）；不设 = 全收 */
  match?: (absPath: string) => boolean;
  /** 黑名单（对路径做正则测试）；不设 = 内置默认 */
  ignore?: RegExp[];
  /** 同路径合并窗口 ms（默认 300） */
  quietMs?: number;
  /** 显著性先验（默认：配置类 loud，其余 normal） */
  salienceOf?: (kind: string, absPath: string) => Salience;
  log?: (line: string) => void;
};

const DEFAULT_IGNORE = [
  /(^|\/)(node_modules|\.git|\.hg|\.svn|\.harnessgate|\.zcode|dist|build|out|coverage|__pycache__)(\/|$)/,
  /(^|\/)~|(\.log|\.tmp|\.swp|\.lock|\.pid|~)$/i,
];

function isConfigLike(p: string): boolean {
  return /\.(json|ya?ml|toml|ini|conf|env)$/i.test(p);
}

export class FsSensor implements Sensor {
  readonly name: string;
  /** 事件出口（由宿主接到 DualSystem.ingest） */
  onEvent?: (evt: SensoryEvent) => void;
  private readonly watchers: FSWatcher[] = [];
  /** path → 待发射事件（quietMs 合并窗口） */
  private readonly pending = new Map<string, { evt: SensoryEvent; timer: NodeJS.Timeout }>();
  private stopped = false;

  constructor(private readonly opts: FsSensorOptions) {
    this.name = `fs(${opts.paths.map((p) => p.split("/").pop() || p).join(",")})`;
  }

  start(): void {
    for (const dir of this.opts.paths) {
      try {
        const w = watch(dir, { recursive: true }, (_eventType, filename) => {
          this.handle(dir, filename ? String(filename) : "");
        });
        this.watchers.push(w);
      } catch (err) {
        this.opts.log?.(`[fs-sensor] 无法监听 ${dir}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private handle(baseDir: string, filename: string): void {
    if (this.stopped) return;
    const abs = join(baseDir, filename);
    const ignore = this.opts.ignore ?? DEFAULT_IGNORE;
    if (!filename || ignore.some((re) => re.test(abs))) return;
    if (this.opts.match && !this.opts.match(abs)) return;

    const kind = "fs.change";   // fs.watch 的 eventType 在各平台语义不一，统一按「变动」上报
    const existing = this.pending.get(abs);
    if (existing) {
      existing.evt.ts = Date.now();   // 窗口内重复变动：只刷新时间，不叠加事件
      return;
    }
    const salience = this.opts.salienceOf
      ? this.opts.salienceOf(kind, abs)
      : isConfigLike(abs)
        ? "loud"
        : "normal";
    const evt = makeEvent({
      modality: "fs",
      kind,
      subject: abs,
      summary: `文件变动 ${abs}`,
      salience,
      payload: { baseDir },
    });
    const timer = setTimeout(() => {
      this.pending.delete(abs);
      this.onEvent?.(evt);
    }, this.opts.quietMs ?? 300);
    timer.unref?.();
    this.pending.set(abs, { evt, timer });
  }

  stop(): void {
    this.stopped = true;
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* 尽力而为 */
      }
    }
    this.watchers.length = 0;
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}

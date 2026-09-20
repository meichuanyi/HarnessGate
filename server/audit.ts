import { appendFileSync, mkdirSync, watch, type FSWatcher } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * 审计台账：一行一条 JSONL。既用于安全审计，也是后续
 * "共同工作区/圆桌" 的改动归因基础。
 */
export class AuditLog {
  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }

  append(entry: Record<string, unknown>): void {
    try {
      appendFileSync(this.file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
    } catch {
      /* 台账失败不能影响主流程 */
    }
  }
}

/** 判断 p 是否在 root 之内（含相等）。 */
export function isInside(root: string, p: string): boolean {
  const rel = relative(resolve(root), resolve(p));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** 监听工作区文件变化（不依赖 agent 是否委托 fs），返回 watcher 或 null。 */
export function startWorkspaceWatcher(
  root: string,
  onEvent: (eventType: string, file: string) => void,
): FSWatcher | null {
  try {
    return watch(root, { recursive: true }, (eventType, file) => {
      onEvent(eventType, file ? String(file) : "");
    });
  } catch {
    return null;
  }
}

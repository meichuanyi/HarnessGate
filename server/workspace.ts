import { watch, type FSWatcher } from "node:fs";
import { relative, resolve } from "node:path";
import type { AuditLog } from "./audit.ts";
import { worktreeDiffStat, worktreeStatus, type WorktreeInfo } from "./worktree.ts";

// 噪音：版本库/依赖/缓存，以及 .log/.db/log 这类被持续写入的文件
// （实测 trading-system 的 backend.log 与 sqlite 的 -wal 能刷出 1 万多条事件）
const IGNORE = [
  /(^|\/)\.git(\/|$)/, /(^|\/)node_modules(\/|$)/, /(^|\/)\.harnessgate(\/|$)/,
  /(^|\/)\.zcode(\/|$)/, /(^|\/)__pycache__(\/|$)/, /(^|\/)\.pytest_cache(\/|$)/,
  /\.(log|db|db-wal|db-shm|sqlite|sqlite3|pyc|pyo|lock|tmp|swp|sock|pid)$/i,
];
/** 同一路径在这个窗口内的重复事件只记一条 */
const THROTTLE_MS = 2000;

export type Touch = {
  sessionId: string;
  harnessId: string;
  ts: string;
  event: string;
  confidence: "exact" | "ambiguous" | "idle";
};

export type WorkspaceFile = {
  path: string;
  rel: string;
  touches: Touch[];
  /** 被两个及以上会话碰过 → 冲突嫌疑 */
  conflict: boolean;
  firstTs: string;
  lastTs: string;
};

export type WorkspaceSession = {
  id: string;
  harnessId: string;
  harnessLabel: string;
  live: boolean;
  inTurn: boolean;
  mode: "shared" | "worktree";
  cwd: string;
  branch?: string;
  changedFiles?: string[];
  diffStat?: string;
};

export type WorkspaceReport = {
  cwd: string;
  sessions: WorkspaceSession[];
  files: WorkspaceFile[];
  conflicts: number;
  note: string;
};

type Member = {
  sessionId: string;
  harnessId: string;
  harnessLabel: string;
  inTurn: boolean;
  live: boolean;
  worktree?: WorktreeInfo;
};

type Space = {
  cwd: string;
  watcher: FSWatcher;
  members: Map<string, Member>;
  files: Map<string, WorkspaceFile>;
};

/** 每个工作区一个 watcher；按"谁正在跑 turn"把改动归因到具体会话。 */
export class WorkspaceHub {
  private spaces = new Map<string, Space>();

  constructor(private readonly audit: AuditLog, private readonly maxFiles = 3000) {}

  register(member: Member & { cwd: string }): void {
    // 归一化 key：/a/b 和 /a/b/（前端目录补全会自动补尾斜杠）必须落到同一个工作区，
    // 否则同一棵树会被 watch 两遍——大目录下每份递归 watcher 都是几万到十几万个 inotify watch
    const cwd = resolve(member.cwd);
    let space = this.spaces.get(cwd);
    if (!space) {
      const watcher = watch(cwd, { recursive: true }, (eventType, file) => {
        this.onFsEvent(cwd, eventType, file ? String(file) : "");
      });
      watcher.on("error", (err) => {
        this.audit.append({ op: "workspace.watch.error", cwd, error: String(err) });
      });
      space = { cwd, watcher, members: new Map(), files: new Map() };
      this.spaces.set(cwd, space);
      this.audit.append({ op: "workspace.watch.start", cwd });
    }
    space.members.set(member.sessionId, {
      sessionId: member.sessionId,
      harnessId: member.harnessId,
      harnessLabel: member.harnessLabel,
      inTurn: member.inTurn,
      live: member.live,
      worktree: member.worktree,
    });
  }

  unregister(sessionId: string): void {
    for (const [cwd, space] of this.spaces) {
      if (!space.members.delete(sessionId)) continue;
      if (space.members.size === 0) {
        space.watcher.close();
        this.spaces.delete(cwd);
        this.audit.append({ op: "workspace.watch.stop", cwd });
      }
    }
  }

  setInTurn(sessionId: string, inTurn: boolean): void {
    for (const space of this.spaces.values()) {
      const m = space.members.get(sessionId);
      if (m) m.inTurn = inTurn;
    }
  }

  setLive(sessionId: string, live: boolean): void {
    for (const space of this.spaces.values()) {
      const m = space.members.get(sessionId);
      if (m) m.live = live;
    }
  }

  private lastHit = new Map<string, number>();

  private onFsEvent(cwd: string, eventType: string, file: string): void {
    if (!file || IGNORE.some((re) => re.test(file))) return;
    const nowMs = Date.now();
    const key = `${cwd}/${file}`;
    const prev = this.lastHit.get(key) ?? 0;
    if (nowMs - prev < THROTTLE_MS) return;      // 同一文件短时间内反复写入，只记一次
    if (this.lastHit.size > 5000) this.lastHit.clear();
    this.lastHit.set(key, nowMs);
    const space = this.spaces.get(cwd);
    if (!space) return;
    const active = [...space.members.values()].filter((m) => m.inTurn);
    const confidence: Touch["confidence"] = active.length === 0 ? "idle" : active.length === 1 ? "exact" : "ambiguous";
    const targets = active.length ? active : [...space.members.values()];
    const ts = new Date().toISOString();
    const path = `${cwd}/${file}`;
    const rel = relative(cwd, path);

    for (const m of targets) {
      this.audit.append({
        session: m.sessionId,
        harness: m.harnessId,
        op: "fs.change",
        event: eventType,
        path,
        confidence,
      });
    }

    let entry = space.files.get(path);
    if (!entry) {
      entry = { path, rel, touches: [], conflict: false, firstTs: ts, lastTs: ts };
      space.files.set(path, entry);
      if (space.files.size > this.maxFiles) {
        const oldest = [...space.files.entries()].sort((a, b) => a[1].lastTs.localeCompare(b[1].lastTs))[0]?.[0];
        if (oldest) space.files.delete(oldest);
      }
    }
    entry.lastTs = ts;
    for (const m of targets) {
      entry.touches.push({ sessionId: m.sessionId, harnessId: m.harnessId, ts, event: eventType, confidence });
    }
    if (entry.touches.length > 200) entry.touches = entry.touches.slice(-200);
    const distinct = new Set(entry.touches.map((t) => t.sessionId));
    entry.conflict = distinct.size >= 2 && entry.touches.some((t) => t.confidence !== "idle");
  }

  /** 生成某个工作区（或全局）的报告 */
  async report(cwd?: string): Promise<WorkspaceReport[]> {
    const spaces = [...this.spaces.values()].filter((s) => !cwd || s.cwd === resolve(cwd));
    return Promise.all(
      spaces.map(async (space): Promise<WorkspaceReport> => {
        const sessions: WorkspaceSession[] = [];
        for (const m of space.members.values()) {
          const s: WorkspaceSession = {
            id: m.sessionId,
            harnessId: m.harnessId,
            harnessLabel: m.harnessLabel,
            live: m.live,
            inTurn: m.inTurn,
            mode: m.worktree ? "worktree" : "shared",
            cwd: m.worktree?.dir ?? space.cwd,
            branch: m.worktree?.branch,
          };
          if (m.worktree) {
            const status = await worktreeStatus(m.worktree);
            s.changedFiles = status ? status.split("\n").filter(Boolean) : [];
            s.diffStat = await worktreeDiffStat(m.worktree);
          }
          sessions.push(s);
        }
        const files = [...space.files.values()].sort((a, b) => b.lastTs.localeCompare(a.lastTs));
        const conflicts = files.filter((f) => f.conflict).length;
        return {
          cwd: space.cwd,
          sessions,
          files,
          conflicts,
          note:
            sessions.length > 1 && conflicts === 0
              ? "多个会话共用这个目录，暂无冲突"
              : conflicts
                ? `${conflicts} 个文件被多个会话碰过`
                : "工作区暂无改动",
        };
      }),
    );
  }
}

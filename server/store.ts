import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionStatus, TranscriptEntry, WorktreeInfo } from "./types.ts";

export type PersistedSession = {
  id: string;
  harnessId: string;
  cwd: string;
  createdAt: string;
  lastActiveAt: string;
  status: SessionStatus;
  acpSessionId?: string;
  resumable: boolean;
  title?: string;
  /** new = 本工具创建；imported = 从 agent 历史导入（老会话，ACP 侧往往需要 fork 才能继续） */
  origin?: "new" | "imported";
  /** 由哪个圆桌创建（删圆桌时可连带删除；比 origin 可靠——历史导入会把 origin 改成 imported） */
  roomId?: string;
  worktree?: WorktreeInfo;
  /** 用户手动选过的配置（模型等），进/恢复会话时显示并自动重放 */
  chosen?: Record<string, string>;
  /** 自动决策档位（off/readonly/all）；房间会话恒 all */
  autoApprove?: string;
  transcript: TranscriptEntry[];
};

type StoreFile = { version: 1; sessions: PersistedSession[] };

/**
 * 会话落盘：JSON 文件 + 原子写 + 去抖。重启服务后会话以 saved 状态回来，
 * transcript 仍在，可对支持 loadSession 的 harness 调用 session/load 恢复。
 */
export class SessionStore {
  private sessions = new Map<string, PersistedSession>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string, private readonly maxTranscript = 800) {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      try {
        // 开机先留一份备份：万一之后被误清（比如人为覆盖），还能救回来
        copyFileSync(file, `${file}.bak`);
        const data = JSON.parse(readFileSync(file, "utf8")) as StoreFile;
        for (const s of data.sessions ?? []) this.sessions.set(s.id, s);
      } catch (err) {
        console.error(`[store] 读取 ${file} 失败，忽略:`, err instanceof Error ? err.message : err);
      }
    }
    // 进程重启后，原先在跑的会话不可能还活着
    for (const s of this.sessions.values()) {
      if (s.status !== "saved") s.status = "saved";
    }
  }

  all(): PersistedSession[] {
    return [...this.sessions.values()].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  get(id: string): PersistedSession | undefined {
    return this.sessions.get(id);
  }

  upsert(session: PersistedSession): void {
    if (session.transcript.length > this.maxTranscript) {
      session.transcript = session.transcript.slice(-this.maxTranscript);
    }
    this.sessions.set(session.id, session);
    this.schedule();
  }

  remove(id: string): void {
    this.sessions.delete(id);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 400);
    this.timer.unref?.();
  }

  flush(): void {
    const payload: StoreFile = { version: 1, sessions: this.all() };
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(payload, null, 1));
      renameSync(tmp, this.file);
    } catch (err) {
      console.error(`[store] 写入失败:`, err instanceof Error ? err.message : err);
    }
  }
}

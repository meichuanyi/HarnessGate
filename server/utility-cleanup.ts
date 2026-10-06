import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** 清理 harness 本地存储里的「工具会话」（自动打标/蒸馏等 utility 临时对话）。
 *
 *  背景：打标走真实 harness，其本地存储（如 zcode 的 SQLite）里会留下真实对话记录；
 *  ACP 协议的 session/delete zcode 未实现（实测方法面只有 fork/resume），
 *  但它的库自带完整 ON DELETE CASCADE（session→message→part/todo/permission），
 *  删 session 一行即由数据库引擎级联清干净——这是走它自己的数据完整性设计，不是手撸删库。
 *
 *  识别规则（只删工具对话，用户真实历史不动）：
 *  ① session.path 在 HG 的工具工作区下（~/.harnessgate/utility|tagger|assistant 的从属会话除外——
 *     assistant 是常驻助理本体，绝不删）；
 *  ② 或首条用户消息带 [HG-UTILITY: 标记（v0.6.28 起统一约定）。
 *  注意：~/.harnessgate/assistant 会被 zcode 记为助理对话的 cwd，但它同时匹配 ① 的前缀——
 *  所以判定必须精确到工具目录，assistant 目录排除。 */

const TOOL_DIRS = [join(homedir(), ".harnessgate", "utility"), join(homedir(), ".harnessgate", "tagger")];

export type CleanupCandidate = {
  sessionId: string;
  title: string;
  path: string;
  createdAt: string;
  reason: "tool-dir" | "utility-mark";
};

export type CleanupReport = {
  ok: boolean;
  found: number;
  deleted: number;
  candidates?: CleanupCandidate[];
  error?: string;
};

/** 扫描（预览）：列出将被删除的工具会话 */
export function scanUtilitySessions(dbFile: string): CleanupReport {
  if (!existsSync(dbFile)) return { ok: false, found: 0, deleted: 0, error: "db 不存在" };
  try {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    const rows = db.prepare("SELECT id, title, path, time_created FROM session").all() as Array<{
      id: string; title: string | null; path: string | null; time_created: number | string;
    }>;
    const candidates: CleanupCandidate[] = [];
    for (const r of rows) {
      const path = r.path ?? "";
      const inToolDir = TOOL_DIRS.some((d) => path === d || path.startsWith(d + "/"));
      let marked = false;
      if (!inToolDir) {
        // 首条用户消息带 [HG-UTILITY: 标记（message 表按 session 关联，取最早一条的 part 文本判断）
        try {
          const first = db
            .prepare(
              `SELECT p.text FROM message m JOIN part p ON p.message_id = m.id
               WHERE m.session_id = ? ORDER BY m.time_created ASC, p.sequence ASC LIMIT 1`,
            )
            .all(r.id) as Array<{ text: string | null }>;
          marked = Boolean(first[0]?.text?.startsWith("[HG-UTILITY:"));
        } catch {
          /* part 结构差异则跳过标记判定 */
        }
      }
      if (inToolDir || marked) {
        candidates.push({
          sessionId: r.id,
          title: (r.title ?? "").slice(0, 60),
          path,
          createdAt: new Date(r.time_created).toISOString(),
          reason: inToolDir ? "tool-dir" : "utility-mark",
        });
      }
    }
    db.close();
    return { ok: true, found: candidates.length, deleted: 0, candidates };
  } catch (err) {
    return { ok: false, found: 0, deleted: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 执行清理：事务内逐条 DELETE FROM session（级联清 message/part/todo/…） */
export function deleteUtilitySessions(dbFile: string, sessionIds: string[]): CleanupReport {
  if (!existsSync(dbFile)) return { ok: false, found: 0, deleted: 0, error: "db 不存在" };
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbFile);
    db.exec("BEGIN");
    let deleted = 0;
    const del = db.prepare("DELETE FROM session WHERE id = ?");
    for (const id of sessionIds) {
      const r = del.run(id);
      deleted += Number(r.changes);
    }
    db.exec("COMMIT");
    return { ok: true, found: sessionIds.length, deleted };
  } catch (err) {
    try { db?.exec("ROLLBACK"); } catch { /* 已回滚 */ }
    return { ok: false, found: sessionIds.length, deleted: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try { db?.close(); } catch { /* */ }
  }
}

/** 内置的清理源（与 history.ts 的 sqliteProvider 对齐；目前主要是 zcode） */
export function utilityCleanupSources(): Array<{ id: string; label: string; db: string }> {
  return [
    { id: "zcode", label: "ZCode", db: join(homedir(), ".zcode", "cli", "db", "db.sqlite") },
    { id: "opencode", label: "OpenCode", db: join(homedir(), ".local/share/opencode/opencode.db") },
  ];
}

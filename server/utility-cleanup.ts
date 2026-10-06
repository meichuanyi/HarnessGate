import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** 清理 harness 本地存储里的「工具会话」（自动打标/蒸馏等 utility 临时对话）。
 *
 *  背景：打标走真实 harness，其本地存储里会留下真实对话记录；历史同步已跳过它们
 *  （[HG-UTILITY: 标记，v0.6.28），但 harness 存储本体还需要定期清理。各家存储形态
 *  不同，按源适配：
 *  - zcode / OpenCode（SQLite，session 表同构）：删 session 行，message/part 由
 *    ON DELETE CASCADE 级联清；
 *  - Claude Code / Codex / Hermes（文件型，对话即 JSONL/JSON 文件）：识别到标记删文件。
 *
 *  识别规则（只删工具对话，用户真实历史不动）：
 *  ① 会话工作目录在 HG 工具区下（~/.harnessgate/utility|tagger）；
 *  ② 或对话首条用户消息带 [HG-UTILITY: 标记。 */

const MARKER = "[HG-UTILITY";
const TOOL_DIRS = [join(homedir(), ".harnessgate", "utility"), join(homedir(), ".harnessgate", "tagger")];

export type CleanupCandidate = {
  /** 全局唯一删除键（源前缀:源内键） */
  key: string;
  sessionId: string;
  title: string;
  path: string;
  reason: "tool-dir" | "utility-mark";
};

export type CleanupSource = {
  id: string;
  label: string;
  scan: () => CleanupCandidate[];
  del: (keys: string[]) => number;
};


type CleanupReport = {
  ok: boolean;
  found: number;
  deleted: number;
  candidates?: CleanupCandidate[];
  error?: string;
};

/* ---------- SQLite 源（zcode / opencode：session 表同构） ---------- */

function scanSqlite(dbFile: string, sourceId: string): CleanupCandidate[] {
  if (!existsSync(dbFile)) return [];
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const rows = db.prepare("SELECT id, title, directory, path, time_created FROM session").all() as Array<{
      id: string; title: string | null; directory: string | null; path: string | null; time_created: number | string;
    }>;
    const out: CleanupCandidate[] = [];
    for (const r of rows) {
      const dir = r.directory || r.path || "";
      const inToolDir = TOOL_DIRS.some((d) => dir === d || dir.startsWith(d + "/"));
      let marked = false;
      if (!inToolDir) {
        try {
          // 首条消息文本（zcode 在 part.text；opencode 在 part.data JSON）
          const rowsP = db
            .prepare(
              `SELECT p.text AS text, p.data AS data FROM message m JOIN part p ON p.message_id = m.id
               WHERE m.session_id = ? ORDER BY m.sequence ASC LIMIT 1`,
            )
            .all(r.id) as Array<{ text: string | null; data: string | null }>;
          const raw = rowsP[0]?.text ?? rowsP[0]?.data ?? "";
          marked = raw.includes(MARKER);
        } catch {
          /* 结构差异则跳过标记判定 */
        }
      }
      if (inToolDir || marked) {
        out.push({
          key: sourceId + ":" + r.id,
          sessionId: r.id,
          title: (r.title ?? "").slice(0, 60),
          path: dir,
          reason: inToolDir ? "tool-dir" : "utility-mark",
        });
      }
    }
    return out;
  } finally {
    db.close();
  }
}

function deleteSqlite(dbFile: string, sourceId: string, keys: string[]): number {
  if (!existsSync(dbFile)) return 0;
  const db = new DatabaseSync(dbFile);
  try {
    db.exec("BEGIN");
    const del = db.prepare("DELETE FROM session WHERE id = ?");
    let n = 0;
    for (const key of keys) {
      const id = key.startsWith(sourceId + ":") ? key.slice(sourceId.length + 1) : key;
      n += Number(del.run(id).changes);
    }
    db.exec("COMMIT");
    return n;
  } catch {
    try { db.exec("ROLLBACK"); } catch { /* */ }
    return 0;
  } finally {
    db.close();
  }
}

function sqliteSource(id: string, label: string, dbFile: string): CleanupSource {
  return {
    id,
    label,
    scan: () => scanSqlite(dbFile, id),
    del: (keys) => deleteSqlite(dbFile, id, keys),
  };
}

/* ---------- 文件源（claude / codex / hermes：对话即文件，删文件即删会话） ---------- */

function walkFiles(root: string, ext: string, out: string[] = []): string[] {
  if (!existsSync(root)) return out;
  try {
    for (const name of readdirSync(root)) {
      const full = join(root, name);
      const st = statSync(full);
      if (st.isDirectory()) walkFiles(full, ext, out);
      else if (name.endsWith(ext)) out.push(full);
    }
  } catch { /* 无权限跳过 */ }
  return out;
}

function scanFileSource(root: string, sourceId: string, fileFilter?: (name: string) => boolean): CleanupCandidate[] {
  const out: CleanupCandidate[] = [];
  for (const file of walkFiles(root, ".jsonl")) {
    const name = file.split("/").pop() ?? "";
    if (fileFilter && !fileFilter(name)) continue;
    let head = "";
    try {
      head = readFileSync(file, "utf8").slice(0, 65536);
    } catch {
      continue;
    }
    if (head.includes(MARKER)) {
      const base = name.replace(/\.[^.]+$/, "");
      out.push({
        key: sourceId + ":" + file,
        sessionId: base,
        title: base,
        path: file,
        reason: "utility-mark",
      });
    }
  }
  return out;
}

function fileSource(id: string, label: string, root: string, fileFilter?: (name: string) => boolean): CleanupSource {
  return {
    id,
    label,
    scan: () => scanFileSource(root, id, fileFilter),
    del: (keys) => {
      const scanned = scanFileSource(root, id, fileFilter);
      const set = new Set(keys);
      let n = 0;
      for (const c of scanned) {
        if (!set.has(c.key)) continue;
        try {
          if (existsSync(c.path)) {
            unlinkSync(c.path);
            n += 1;
          }
        } catch { /* 单文件失败不中断 */ }
      }
      return n;
    },
  };
}

/* ---------- 源注册 ---------- */

export function cleanupSources(): CleanupSource[] {
  return [
    sqliteSource("zcode", "ZCode", join(homedir(), ".zcode", "cli", "db", "db.sqlite")),
    sqliteSource("opencode", "OpenCode", join(homedir(), ".local/share/opencode/opencode.db")),
    fileSource("claude", "Claude Code", join(homedir(), ".claude", "projects")),
    fileSource("codex", "Codex", join(homedir(), ".codex", "sessions")),
    fileSource("hermes", "Hermes", join(homedir(), ".hermes", "sessions"), (n) => n.startsWith("session_")),
  ];
}

/* ---------- 对外主流程 ---------- */

export function scanAllUtilitySessions(): Array<{ source: CleanupSource; report: CleanupReport }> {
  const out: Array<{ source: CleanupSource; report: CleanupReport }> = [];
  for (const src of cleanupSources()) {
    try {
      const candidates = src.scan();
      out.push({ source: src, report: { ok: true, found: candidates.length, deleted: 0, candidates } });
    } catch (err) {
      out.push({ source: src, report: { ok: false, found: 0, deleted: 0, error: err instanceof Error ? err.message : String(err) } });
    }
  }
  return out;
}

export function deleteAllUtilitySessions(keys: string[]): number {
  let n = 0;
  for (const src of cleanupSources()) {
    const mine = keys.filter((k) => k.startsWith(src.id + ":"));
    if (mine.length) n += src.del(mine);
  }
  return n;
}

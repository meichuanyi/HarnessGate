import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PersistedSession, SessionStore } from "./store.ts";
import type { TranscriptEntry } from "./types.ts";

/**
 * 历史同步：把各 harness 自己存的历史会话（发现 + 增量）导入 HarnessGate。
 *
 * 设计要点：每个 harness 一个 provider，只负责两件事——"有哪些会话"和"某条会话的内容"。
 * 增量靠 fingerprint（文件大小+mtime / 数据库消息计数），没变的跳过；已有会话用完整
 * 内容覆盖台账。新装的机器上启动即自动跑一遍，所以不需要任何人手工导。
 */

const BRIDGE_BLOCKS = /<(bridge_context|bridge_instructions)>[\s\S]*?<\/\1>\s*/g;
const USER_INPUT = /<user_input>\s*([\s\S]*?)\s*<\/user_input>/;

/** 剥掉飞书桥接层塞进来的信封，只留用户真正说的话 */
export function cleanUserText(text: string): string {
  let t = String(text ?? "").replace(BRIDGE_BLOCKS, "");
  const m = t.match(USER_INPUT);
  if (m && m[1]) {
    let body = m[1].trim();
    try {
      const obj = JSON.parse(body);
      if (obj && typeof obj === "object" && typeof obj.text === "string") body = obj.text;
    } catch {
      /* 不是 JSON 就用原文 */
    }
    t = body;
  }
  return t.trim();
}

export type DiscoveredSession = {
  harnessId: string;
  externalId: string;
  cwd: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  fingerprint: string;
  load: () => TranscriptEntry[];
};

export type HistoryProvider = {
  id: string;
  label: string;
  /** 这台机器上有没有该 harness 的历史存储 */
  available(): boolean;
  discover(): DiscoveredSession[];
};

const iso = (ms: number | string): string => {
  const v = Number(ms);
  if (!Number.isFinite(v) || v <= 0) return new Date().toISOString();
  return new Date(v > 1e12 ? v : v * 1000).toISOString();
};

/** 去掉消息信封痕迹（[message_id: …]、"用户123: " 之类），让标题可读 */
const prettyTitle = (s: string): string =>
  s
    .replace(/^\s*\[[^\]]{0,60}\]\s*/, "")
    .replace(/^\s*用户\d+[:：]\s*/, "")
    .replace(/^\s*(@\S+\s+)+/, "")
    .trim();

const titleFrom = (transcript: TranscriptEntry[], dbTitle?: string): string | undefined => {
  const t = cleanUserText(dbTitle ?? "");
  if (t && !t.startsWith("<") && !/^New session/i.test(t)) return prettyTitle(t).slice(0, 40) || t.slice(0, 40);
  for (const kind of ["user", "assistant"] as const) {
    for (const e of transcript) {
      if (e.kind === kind && "text" in e && typeof e.text === "string" && e.text) {
        const cleaned = prettyTitle(e.text.split("\n")[0]!);
        if (cleaned) return cleaned.slice(0, 40);
      }
    }
  }
  return (dbTitle ?? "").slice(0, 40) || undefined;
};

const mergeAdjacent = (out: TranscriptEntry[]): TranscriptEntry[] => {
  const merged: TranscriptEntry[] = [];
  for (const e of out) {
    const last = merged[merged.length - 1];
    if (
      last &&
      (e.kind === "assistant" || e.kind === "thought") &&
      last.kind === e.kind &&
      "text" in last &&
      "text" in e
    ) {
      (last as { text: string }).text += (e as { text: string }).text;
    } else {
      merged.push(e);
    }
  }
  return merged;
};

function makeToolHistoryEntry(opts: {
  ts: string;
  toolCallId?: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  status?: string;
}): TranscriptEntry {
  let title = opts.name ? String(opts.name) : "tool";
  let detail: string | undefined;
  if (opts.input != null) {
    if (typeof opts.input === "string") {
      detail = opts.input.trim();
    } else if (typeof opts.input === "object") {
      try {
        detail = JSON.stringify(opts.input, null, 2);
      } catch {
        detail = String(opts.input);
      }
      const obj = opts.input as Record<string, unknown>;
      const cmd = obj.command ?? obj.cmd ?? obj.script;
      const file = obj.path ?? obj.file_path ?? obj.filePath ?? obj.file ?? obj.target_file;
      const query = obj.query ?? obj.pattern ?? obj.regex;
      const url = obj.url ?? obj.uri;
      if (typeof cmd === "string" && cmd.trim()) {
        const short = cmd.trim().split("\n")[0]?.slice(0, 60);
        title = `${title}: ${short}`;
      } else if (typeof file === "string" && file.trim()) {
        title = `${title}: ${file}`;
      } else if (typeof query === "string" && query.trim()) {
        title = `${title}: "${query.slice(0, 40)}"`;
      } else if (typeof url === "string" && url.trim()) {
        title = `${title}: ${url.slice(0, 50)}`;
      }
    }
  }
  let output: string | undefined;
  if (opts.output != null) {
    output = typeof opts.output === "string" ? opts.output : JSON.stringify(opts.output, null, 2);
  }
  return {
    kind: "tool",
    ts: opts.ts,
    toolCallId: String(opts.toolCallId ?? "").slice(0, 40),
    title,
    status: opts.status ?? "completed",
    detail: detail ? (detail.length > 4000 ? `…${detail.slice(-4000)}` : detail) : undefined,
    output: output ? (output.length > 4000 ? `…${output.slice(-4000)}` : output) : undefined,
  };
}

/** SQLite 型 harness（OpenCode / ZCode 的表结构一致：session / message / part，消息体是 JSON） */
function sqliteProvider(opts: {
  id: string;
  label: string;
  db: string;
  /** 这些前缀的会话是任务派生的内部会话，不是人机对话 */
  skipIdPrefix?: string[];
}): HistoryProvider {
  return {
    id: opts.id,
    label: opts.label,
    available: () => existsSync(opts.db),
    discover() {
      let con: DatabaseSync;
      try {
        con = new DatabaseSync(opts.db, { readOnly: true });
      } catch {
        return [];
      }
      try {
        const rows = con
          .prepare("SELECT id, directory, title, time_created, time_updated FROM session ORDER BY time_created DESC")
          .all() as Array<Record<string, unknown>>;
        const out: DiscoveredSession[] = [];
        for (const r of rows) {
          const sid = String(r.id);
          if (opts.skipIdPrefix?.some((p) => sid.startsWith(p))) continue;
          const messageCount = (
            con.prepare("SELECT COUNT(*) AS n FROM message WHERE session_id = ?").get(sid) as { n: number } | undefined
          )?.n ?? 0;
          out.push({
            harnessId: opts.id,
            externalId: sid,
            cwd: String(r.directory ?? ""),
            title: r.title ? String(r.title) : undefined,
            createdAt: iso(String(r.time_created ?? 0)),
            updatedAt: iso(String(r.time_updated ?? 0)),
            fingerprint: `${messageCount}:${r.time_updated ?? ""}`,
            load: () => loadSqliteTranscript(opts.db, sid),
          });
        }
        return out;
      } finally {
        con.close();
      }
    },
  };
}

function loadSqliteTranscript(db: string, sessionId: string): TranscriptEntry[] {
  const con = new DatabaseSync(db, { readOnly: true });
  try {
    const messages = con
      .prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY sequence, time_created")
      .all(sessionId) as Array<{ id: string; data: string }>;
    const partStmt = con.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY sequence, time_created");
    const out: TranscriptEntry[] = [];
    for (const m of messages) {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(m.data);
      } catch {
        continue;
      }
      const role = String(msg.role ?? "");
      if (role !== "user" && role !== "assistant") continue;
      const sem = (msg.semantics ?? {}) as Record<string, unknown>;
      if (sem.uiVisibility && sem.uiVisibility !== "visible") continue;
      if (sem.transcriptVisibility && sem.transcriptVisibility !== "visible") continue;
      const ts = iso(Number((msg.time as { created?: number } | undefined)?.created ?? 0));
      for (const p of partStmt.all(m.id) as Array<{ data: string }>) {
        let part: Record<string, unknown>;
        try {
          part = JSON.parse(p.data);
        } catch {
          continue;
        }
        const type = String(part.type ?? "");
        if (type === "text" && typeof part.text === "string" && part.text.trim()) {
          const text = role === "user" ? cleanUserText(part.text) : part.text;
          if (text) out.push({ kind: role as "user" | "assistant", ts, text });
        } else if (type === "reasoning" || type === "thinking") {
          const text = (part.text ?? part.reasoning) as string | undefined;
          if (text) out.push({ kind: "thought", ts, text });
        } else if (type === "tool") {
          const st = (part.state ?? {}) as Record<string, unknown>;
          out.push(
            makeToolHistoryEntry({
              ts,
              toolCallId: String(part.callID ?? part.id ?? ""),
              name: String(part.tool ?? "tool"),
              input: st.input ?? part.input,
              output: st.output ?? part.output,
              status: String(st.status ?? "completed"),
            }),
          );
        }
      }
    }
    return mergeAdjacent(out);
  } finally {
    con.close();
  }
}

/** JSONL 型 harness（Claude Code / Codex）：一行一条记录 */
function jsonlProvider(opts: {
  id: string;
  label: string;
  root: string;
  files: (root: string) => string[];
  /** 只读文件头部若干行，拿到 cwd / 会话 id / 起始时间（便宜） */
  head: (path: string) => { cwd: string; externalId: string; createdAt: string; skip?: boolean; title?: string } | null;
  /** 完整解析（只在内容有变化时调用） */
  parse: (path: string) => TranscriptEntry[];
  /** 只取最近修改的 N 个文件（历史文件成千上万时的保护） */
  maxFiles?: number;
}): HistoryProvider {
  return {
    id: opts.id,
    label: opts.label,
    available: () => existsSync(opts.root),
    discover() {
      const out: DiscoveredSession[] = [];
      let files = opts.files(opts.root);
      if (opts.maxFiles && files.length > opts.maxFiles) {
        files = files
          .map((f) => ({ f, m: statSync(f).mtimeMs }))
          .sort((a, b) => b.m - a.m)
          .slice(0, opts.maxFiles)
          .map((x) => x.f);
      }
      for (const f of files) {
        try {
          const st = statSync(f);
          if (!st.isFile() || st.size === 0) continue;
          const h = opts.head(f);
          if (!h || h.skip) continue;
          const fingerprint = `${st.size}:${Math.round(st.mtimeMs)}`;
          out.push({
            harnessId: opts.id,
            externalId: h.externalId,
            cwd: h.cwd,
            title: h.title,
            createdAt: h.createdAt,
            updatedAt: new Date(st.mtimeMs).toISOString(),
            fingerprint,
            load: () => opts.parse(f),
          });
        } catch {
          /* 跳过读不了的文件 */
        }
      }
      return out;
    },
  };
}

function readHeadLines(path: string, maxLines = 200, maxBytes = 256 * 1024): string[] {
  const buf = readFileSync(path, { encoding: "utf8", flag: "r" });
  const slice = buf.slice(0, maxBytes);
  const lines = slice.split("\n");
  return lines.slice(0, maxLines);
}

function walkFiles(root: string, match: (name: string, dir: string) => boolean): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(p);
      else if (match(name, dir)) out.push(p);
    }
  }
  return out;
}

function claudeProvider(): HistoryProvider {
  return jsonlProvider({
    id: "claude",
    label: "Claude Code",
    root: join(homedir(), ".claude", "projects"),
    files: (root) => walkFiles(root, (name) => name.endsWith(".jsonl")),
    head: (path) => {
      let cwd = "";
      let createdAt = "";
      for (const line of readHeadLines(path, 80)) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line) as Record<string, unknown>;
          if (o.cwd && !cwd) cwd = String(o.cwd);
          if (!createdAt && o.timestamp) createdAt = String(o.timestamp);
          if (cwd && createdAt) break;
        } catch {
          continue;
        }
      }
      if (!cwd) return null;
      return { cwd, externalId: path.split("/").pop()!.replace(/\.jsonl$/, ""), createdAt };
    },
    parse: (path) => {
      const out: TranscriptEntry[] = [];
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let o: Record<string, unknown>;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        const ts = String(o.timestamp ?? "");
        if (o.type !== "user" && o.type !== "assistant") continue;
        if (o.isSidechain) continue;
        const msg = (o.message ?? {}) as Record<string, unknown>;
        const role = String(msg.role ?? o.type);
        const content = msg.content;
        const push = (text: string) => {
          if (role === "user") {
            const cleaned = cleanUserText(text);
            if (cleaned) out.push({ kind: "user", ts, text: cleaned });
          } else if (text.trim()) {
            out.push({ kind: "assistant", ts, text });
          }
        };
        if (typeof content === "string") push(content);
        else if (Array.isArray(content)) {
          for (const b of content as Array<Record<string, unknown>>) {
            if (b.type === "text" && typeof b.text === "string") push(b.text);
            else if (b.type === "thinking" && typeof b.thinking === "string") out.push({ kind: "thought", ts, text: b.thinking });
            else if (b.type === "tool_use") {
              out.push(
                makeToolHistoryEntry({
                  ts,
                  toolCallId: String(b.id ?? ""),
                  name: String(b.name ?? "tool"),
                  input: b.input,
                  status: "completed",
                }),
              );
            }
          }
        }
      }
      return mergeAdjacent(out);
    },
  });
}

function codexProvider(): HistoryProvider {
  return jsonlProvider({
    id: "codex",
    label: "Codex",
    root: join(homedir(), ".codex", "sessions"),
    files: (root) => walkFiles(root, (name) => name.startsWith("rollout-") && name.endsWith(".jsonl")),
    head: (path) => {
      for (const line of readHeadLines(path, 5)) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line) as Record<string, unknown>;
          if (o.type !== "session_meta") continue;
          const p = (o.payload ?? {}) as Record<string, unknown>;
          const cwd = String(p.cwd ?? "");
          const sid = String(p.session_id ?? p.id ?? "");
          if (!cwd || !sid) return null;
          return { cwd, externalId: sid, createdAt: String(o.timestamp ?? new Date().toISOString()) };
        } catch {
          continue;
        }
      }
      return null;
    },
    parse: (path) => {
      const out: TranscriptEntry[] = [];
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let o: Record<string, unknown>;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        const ts = String(o.timestamp ?? "");
        const p = (o.payload ?? {}) as Record<string, unknown>;
        if (o.type === "event_msg") {
          if (p.type === "user_message" && typeof p.message === "string") {
            const cleaned = cleanUserText(p.message);
            if (cleaned) out.push({ kind: "user", ts, text: cleaned });
          } else if (p.type === "agent_message" && typeof p.message === "string" && p.message.trim()) {
            out.push({ kind: "assistant", ts, text: p.message });
          }
          continue;
        }
        if (o.type === "response_item" && p.type === "function_call") {
          out.push(
            makeToolHistoryEntry({
              ts,
              toolCallId: String(p.call_id ?? p.id ?? ""),
              name: String(p.name ?? "tool"),
              input: p.arguments,
              status: "completed",
            }),
          );
        }
      }
      return mergeAdjacent(out);
    },
  });
}

/** Hermes：state.db 的 sessions/messages 表（结构与其他家都不同） */
function hermesProvider(): HistoryProvider {
  const db = join(homedir(), ".hermes", "state.db");
  return {
    id: "hermes",
    label: "Hermes",
    available: () => existsSync(db),
    discover() {
      let con: DatabaseSync;
      try {
        con = new DatabaseSync(db, { readOnly: true });
      } catch {
        return [];
      }
      try {
        const rows = con
          .prepare(
            `SELECT id, title, started_at, last_activity_at, model_config, message_count
             FROM sessions WHERE COALESCE(hidden,0)=0 ORDER BY COALESCE(last_activity_at, started_at) DESC`,
          )
          .all() as Array<Record<string, unknown>>;
        const out: DiscoveredSession[] = [];
        for (const r of rows) {
          let cwd = "";
          try {
            const cfg = JSON.parse(String(r.model_config ?? "{}")) as { cwd?: string };
            cwd = cfg.cwd ?? "";
          } catch {
            /* 没 cwd 就跳过 */
          }
          if (!cwd) cwd = homedir();
          const sid = String(r.id);
          out.push({
            harnessId: "hermes",
            externalId: sid,
            cwd,
            title: r.title ? String(r.title) : undefined,
            createdAt: iso(Number(r.started_at ?? 0) * 1000),
            updatedAt: iso(Number(r.last_activity_at ?? r.started_at ?? 0) * 1000),
            fingerprint: `${r.message_count ?? 0}:${r.last_activity_at ?? ""}`,
            load: () => {
              const c2 = new DatabaseSync(db, { readOnly: true });
              try {
                const msgs = c2
                  .prepare(
                    `SELECT role, content, tool_name, tool_calls, reasoning_content, timestamp
                     FROM messages WHERE session_id=? AND COALESCE(active,1)=1 ORDER BY timestamp, rowid`,
                  )
                  .all(sid) as Array<Record<string, unknown>>;
                const tr: TranscriptEntry[] = [];
                for (const m of msgs) {
                  const ts = iso(Number(m.timestamp ?? 0) * 1000);
                  const role = String(m.role ?? "");
                  const content = typeof m.content === "string" ? m.content : "";
                  if (role === "user") {
                    const cleaned = cleanUserText(content);
                    if (cleaned) tr.push({ kind: "user", ts, text: cleaned });
                  } else if (role === "assistant") {
                    if (content.trim()) tr.push({ kind: "assistant", ts, text: content });
                    const reasoning = typeof m.reasoning_content === "string" ? m.reasoning_content : "";
                    if (reasoning.trim()) tr.push({ kind: "thought", ts, text: reasoning });
                    if (typeof m.tool_calls === "string" && m.tool_calls.trim()) {
                      try {
                        for (const tc of JSON.parse(m.tool_calls) as Array<Record<string, unknown>>) {
                          const fn = (tc.function ?? {}) as Record<string, unknown>;
                          tr.push(
                            makeToolHistoryEntry({
                              ts,
                              toolCallId: String(tc.id ?? ""),
                              name: String(fn.name ?? tc.name ?? "tool"),
                              input: fn.arguments ?? tc.arguments ?? tc.input,
                              status: "completed",
                            }),
                          );
                        }
                      } catch {
                        /* 工具调用解析失败就跳过 */
                      }
                    } else if (typeof m.tool_name === "string" && m.tool_name) {
                      tr.push(
                        makeToolHistoryEntry({
                          ts,
                          toolCallId: "",
                          name: m.tool_name,
                          status: "completed",
                        }),
                      );
                    }
                  }
                }
                return mergeAdjacent(tr);
              } finally {
                c2.close();
              }
            },
          });
        }
        return out;
      } finally {
        con.close();
      }
    },
  };
}

/** OpenClaw：agents/<name>/sessions/<uuid>.jsonl（文件极大，默认只看最近的） */
function openclawProvider(maxFiles = 600): HistoryProvider {
  const root = join(homedir(), ".openclaw", "agents");
  const isPlainSession = (name: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/.test(name);
  return jsonlProvider({
    id: "openclaw",
    label: "OpenClaw",
    root,
    maxFiles,
    files: (r) => walkFiles(r, (name, dir) => dir.endsWith("/sessions") && isPlainSession(name)),
    head: (path) => {
      let cwd = "";
      let id = "";
      let createdAt = "";
      let skip = false;
      for (const line of readHeadLines(path, 40)) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line) as Record<string, unknown>;
          if (o.type === "session") {
            cwd = String(o.cwd ?? "");
            id = String(o.id ?? "");
            createdAt = String(o.timestamp ?? new Date().toISOString());
            continue;
          }
          if (o.type !== "message") continue;
          const msg = (o.message ?? {}) as Record<string, unknown>;
          if (msg.role !== "user") continue;
          const c = msg.content;
          const text = typeof c === "string" ? c : Array.isArray(c) ? String((c[0] as Record<string, unknown>)?.text ?? "") : "";
          if (/^\s*\[(cron|heartbeat|automation)/i.test(text)) {
            skip = true;
            break;
          }
          break;
        } catch {
          continue;
        }
      }
      if (!cwd || !id) return null;
      return { cwd, externalId: id, createdAt, skip };
    },
    parse: (path) => {
      const out: TranscriptEntry[] = [];
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let o: Record<string, unknown>;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (o.type !== "message") continue;
        const msg = (o.message ?? {}) as Record<string, unknown>;
        const role = String(msg.role ?? "");
        const ts = String(o.timestamp ?? "");
        const content = msg.content;
        if (typeof content === "string") {
          if (role === "user") {
            const cleaned = cleanUserText(content);
            if (cleaned) out.push({ kind: "user", ts, text: cleaned });
          } else if (role === "assistant" && content.trim()) {
            out.push({ kind: "assistant", ts, text: content });
          }
          continue;
        }
        if (!Array.isArray(content)) continue;
        for (const b of content as Array<Record<string, unknown>>) {
          if (b.type === "text" && typeof b.text === "string") {
            if (role === "user") {
              const cleaned = cleanUserText(b.text);
              if (cleaned) out.push({ kind: "user", ts, text: cleaned });
            } else if (b.text.trim()) {
              out.push({ kind: "assistant", ts, text: b.text });
            }
          } else if (b.type === "toolCall") {
            out.push(
              makeToolHistoryEntry({
                ts,
                toolCallId: String(b.id ?? ""),
                name: String(b.name ?? "tool"),
                input: b.parameters ?? b.args ?? b.input,
                status: "completed",
              }),
            );
          }
        }
      }
      return mergeAdjacent(out);
    },
  });
}

function codebuddyProvider(): HistoryProvider {
  return jsonlProvider({
    id: "codebuddy-code",
    label: "Codebuddy Code",
    root: join(homedir(), ".codebuddy", "projects"),
    files: (root) => walkFiles(root, (name, dir) => name.endsWith(".jsonl") && !dir.endsWith("/subagents")),
    head: (path) => {
      let cwd = "";
      let id = "";
      let createdAt = "";
      let title: string | undefined;
      for (const line of readHeadLines(path, 120)) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line) as Record<string, unknown>;
          if (o.type === "session-meta") {
            if (!id && o.sessionId) id = String(o.sessionId);
            if (!createdAt && o.timestamp) createdAt = iso(String(o.timestamp));
            continue;
          }
          if (o.type === "ai-title" && typeof o.aiTitle === "string") title = o.aiTitle;
          if (o.type !== "message") continue;
          if (!cwd && o.cwd) cwd = String(o.cwd);
          if (!id && o.sessionId) id = String(o.sessionId);
          if (!createdAt && o.timestamp) createdAt = iso(String(o.timestamp));
        } catch {
          continue;
        }
      }
      if (!cwd || !id) return null;
      return { cwd, externalId: id, createdAt, title };
    },
    parse: (path) => {
      const out: TranscriptEntry[] = [];
      const toolIdx = new Map<string, number>();
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let o: Record<string, unknown>;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        const ts = iso(String(o.timestamp ?? 0));
        if (o.type === "message") {
          const role = String(o.role ?? "");
          if (!Array.isArray(o.content)) continue;
          for (const b of o.content as Array<Record<string, unknown>>) {
            const text = typeof b.text === "string" ? b.text : "";
            if (!text.trim()) continue;
            if (role === "user") {
              const cleaned = cleanUserText(text);
              if (cleaned) out.push({ kind: "user", ts, text: cleaned });
            } else if (role === "assistant") {
              out.push({ kind: "assistant", ts, text: text });
            }
          }
          continue;
        }
        if (o.type === "reasoning") {
          const raw = Array.isArray(o.rawContent) ? o.rawContent : [];
          for (const b of raw as Array<Record<string, unknown>>) {
            const t = typeof b.text === "string" ? b.text : "";
            if (t.trim()) out.push({ kind: "thought", ts, text: t });
          }
          continue;
        }
        if (o.type === "function_call") {
          const callId = String(o.callId ?? o.id ?? "");
          const args = typeof o.arguments === "string" ? o.arguments : "";
          toolIdx.set(callId, out.length);
          out.push(
            makeToolHistoryEntry({
              ts,
              toolCallId: callId,
              name: String(o.name ?? "tool"),
              input: args,
              status: "completed",
            }),
          );
          continue;
        }
        if (o.type === "function_call_result") {
          const i = toolIdx.get(String(o.callId ?? ""));
          const outObj = o.output as { text?: unknown } | undefined | null;
          const text = typeof outObj?.text === "string" ? outObj.text : "";
          const e = i === undefined ? undefined : out[i];
          if (e?.kind === "tool" && text) e.output = text.length > 4000 ? `…${text.slice(-4000)}` : text;
        }
      }
      return mergeAdjacent(out);
    },
  });
}

export function defaultProviders(): HistoryProvider[] {
  return [
    sqliteProvider({ id: "opencode", label: "OpenCode", db: join(homedir(), ".local/share/opencode/opencode.db") }),
    sqliteProvider({
      id: "zcode",
      label: "ZCode",
      db: join(homedir(), ".zcode/cli/db/db.sqlite"),
      skipIdPrefix: ["sess_subagent"],
    }),
    claudeProvider(),
    codexProvider(),
    hermesProvider(),
    openclawProvider(),
    codebuddyProvider(),
  ];
}

export type SyncOptions = {
  harnessId?: string;
  force?: boolean;
  includeTmp?: boolean;
  minEntries?: number;
  excludeDirs?: string[];
  limit?: number;
};

export type ProviderSummary = { provider: string; label: string; available: boolean; found: number; imported: number; updated: number; skipped: number };

type IndexFile = { version: 1; entries: Record<string, { fingerprint: string; sessionId: string; at: string }> };

export class HistorySync {
  private index: IndexFile = { version: 1, entries: {} };
  private running = false;

  constructor(
    private readonly store: SessionStore,
    private readonly indexFile: string,
    private readonly providers: HistoryProvider[] = defaultProviders(),
    private readonly log: (line: string) => void = () => {},
  ) {
    try {
      if (existsSync(indexFile)) this.index = JSON.parse(readFileSync(indexFile, "utf8"));
    } catch {
      /* 索引损坏就当空的 */
    }
  }

  private saveIndex(): void {
    try {
      writeFileSync(this.indexFile, JSON.stringify(this.index, null, 1));
    } catch {
      /* 尽力而为 */
    }
  }

  availableProviders(): Array<{ id: string; label: string }> {
    return this.providers.filter((p) => p.available()).map((p) => ({ id: p.id, label: p.label }));
  }

  run(opts: SyncOptions = {}): ProviderSummary[] {
    if (this.running) {
      this.log("已有同步在进行，跳过本次");
      return [];
    }
    this.running = true;
    try {
      return this.runOnce(opts);
    } finally {
      this.running = false;
    }
  }

  private runOnce(opts: SyncOptions = {}): ProviderSummary[] {
    const min = opts.minEntries ?? 3;
    const summaries: ProviderSummary[] = [];
    const taken = new Set(this.store.all().map((s) => s.id));
    const byAcp = new Map<string, PersistedSession>();
    for (const s of this.store.all()) if (s.acpSessionId) byAcp.set(`${s.harnessId}:${s.acpSessionId}`, s);

    for (const provider of this.providers) {
      const summary: ProviderSummary = { provider: provider.id, label: provider.label, available: provider.available(), found: 0, imported: 0, updated: 0, skipped: 0 };
      if (!summary.available) {
        summaries.push(summary);
        continue;
      }
      if (opts.harnessId && opts.harnessId !== provider.id) continue;
      let candidates: DiscoveredSession[];
      try {
        candidates = provider.discover();
      } catch (err) {
        this.log(`扫描 ${provider.label} 历史失败: ${err instanceof Error ? err.message : String(err)}`);
        summaries.push(summary);
        continue;
      }
      summary.found = candidates.length;
      let n = 0;
      for (const c of candidates) {
        if (opts.limit && n >= opts.limit) {
          summary.skipped += candidates.length - n;
          break;
        }
        const noise =
          !opts.includeTmp &&
          (c.cwd.startsWith("/tmp") ||
            c.cwd.includes("worktrees") ||
            (opts.excludeDirs ?? []).some((d) => d && c.cwd.startsWith(d)));
        const key = `${c.harnessId}:${c.externalId}`;
        const existing = byAcp.get(key);
        if (noise && !existing) {
          summary.skipped += 1;
          continue;
        }
        const idx = this.index.entries[key];
        if (!opts.force && existing && idx?.fingerprint === c.fingerprint) {
          summary.skipped += 1;
          continue;
        }
        let transcript: TranscriptEntry[];
        try {
          transcript = c.load();
        } catch {
          summary.skipped += 1;
          continue;
        }
        if (transcript.length < min) {
          summary.skipped += 1;
          continue;
        }
        const kept = transcript.length > 800
          ? ([{ kind: "log", ts: c.createdAt, text: `（更早的 ${transcript.length - 800} 条已省略；本工具每个会话保留最近 800 条）` }] as TranscriptEntry[]).concat(transcript.slice(-800))
          : transcript;
        const rec: PersistedSession = existing ?? {
          id: this.newId(taken),
          harnessId: c.harnessId,
          cwd: c.cwd,
          createdAt: c.createdAt,
          lastActiveAt: c.updatedAt,
          status: "saved",
          resumable: true,
          origin: "imported",
          transcript: [],
        };
        rec.cwd = c.cwd;
        rec.createdAt = c.createdAt;
        rec.lastActiveAt = c.updatedAt;
        rec.acpSessionId = c.externalId;
        rec.resumable = true;
        rec.origin = "imported";
        rec.title = titleFrom(kept, c.title);
        rec.transcript = kept;
        this.store.upsert(rec);
        byAcp.set(key, rec);
        this.index.entries[key] = { fingerprint: c.fingerprint, sessionId: rec.id, at: new Date().toISOString() };
        if (existing) summary.updated += 1;
        else summary.imported += 1;
        n += 1;
      }
      summaries.push(summary);
    }
    this.saveIndex();
    this.store.flush();
    return summaries.filter((s) => s.available);
  }

  private newId(taken: Set<string>): string {
    for (;;) {
      const id = Math.floor(Math.random() * 16 ** 8).toString(16).padStart(8, "0");
      if (!taken.has(id)) {
        taken.add(id);
        return id;
      }
    }
  }
}

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { loadRegistry, availability, loadTrust, loadProbe } from "./registry.ts";
import { listDirs } from "./dirs.ts";
import { AuditLog } from "./audit.ts";
import { HarnessSession, deriveTitle } from "./session.ts";
import { SessionStore, type PersistedSession } from "./store.ts";
import { createWorktree, ensureCrewRepo, repoRoot } from "./worktree.ts";
import { WorkspaceHub } from "./workspace.ts";
import { RoomManager, type HostConfig, type RoomMember, type CrewState } from "./room.ts";
import { headOf, branchCommits, changedFiles, currentBranch, mergeBaseWith } from "./crew.ts";
import { isInside } from "./audit.ts";
import { randomUUID } from "node:crypto";
import { HistorySync } from "./history.ts";
import type { ClientMsg, HarnessSpec, ServerMsg, SessionInfo } from "./types.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.HG_PORT ?? 9830);
const HOST = process.env.HG_HOST ?? "0.0.0.0";
const DATA_DIR = process.env.HG_DATA_DIR ?? join(homedir(), ".harnessgate");
const TOKEN_FILE = join(DATA_DIR, "token");

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(TOKEN_FILE)) {
  writeFileSync(TOKEN_FILE, randomBytes(24).toString("hex"), { mode: 0o600 });
}
const TOKEN = process.env.HG_TOKEN ?? readFileSync(TOKEN_FILE, "utf8").trim();
/** HG_AUTH=off 时不做任何认证（单人自用场景）。默认开启。 */
const AUTH_OFF = ["off", "none", "0", "false", "no"].includes((process.env.HG_AUTH ?? "").toLowerCase());

const registry = loadRegistry(join(ROOT, "harness.json"));
const trust = loadTrust(join(ROOT, "harness.trust.json"));
const probeFile = join(DATA_DIR, "probe.json");
let probe = loadProbe(probeFile);
let probeMtime = mtimeOf(probeFile);

/** doctor 跑完会改写 probe.json；服务常驻时按 mtime 热加载，否则 UI 一直显示探活前的旧状态 */
function currentProbe() {
  const m = mtimeOf(probeFile);
  if (m !== probeMtime) {
    try {
      probe = loadProbe(probeFile);
      probeMtime = m;
    } catch {
      /* 文件正在写入，下次请求再试 */
    }
  }
  return probe;
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}
const audit = new AuditLog(join(DATA_DIR, "fs-audit.log"));
const store = new SessionStore(join(DATA_DIR, "sessions.json"));
const hub = new WorkspaceHub(audit);
const history = new HistorySync(store, join(DATA_DIR, "history-index.json"), undefined, (line) => console.log(`[history] ${line}`));
hub.onTouch = (sid, path) => live.get(sid)?.recordChange(path);
const rooms = new RoomManager(join(DATA_DIR, "rooms.json"), audit, {
  onRoom: (room) => broadcast({ type: "room", room }),
  getSession: (id) => live.get(id),
  reviveSession: (id) => reviveSession(id),
});
const defaultCwd = process.env.HG_DEFAULT_CWD ?? registry.defaults?.cwd ?? homedir();
/** 只有"活着"的会话在这里；落盘的会话在 store 里 */
const live = new Map<string, HarnessSession>();
const sockets = new Set<WebSocket>();

function specOf(id: string): HarnessSpec | undefined {
  return registry.harnesses.find((h) => h.id === id);
}

/**
 * 把一个归档会话重新拉起来（服务重启过、或上次跑完被 stop 的会话）。
 * WS 的 resume 分支和圆桌的 waitReady 都走这里，避免两套逻辑。
 */
function reviveSession(id: string): boolean {
  if (live.has(id)) return true;
  const rec = store.get(id);
  if (!rec) return false;
  const spec = specOf(rec.harnessId);
  if (!spec) return false;
  rec.status = "starting";
  const session = new HarnessSession(spec, rec, audit, makeHooks(), hub);
  // 圆桌/工作队的会话重启后必须恢复自动批准：圆桌界面没有审批按钮，
  // 丢了这标志的 worker 碰到授权请求会永久挂起（房间看起来"卡死"）
  if (rec.roomId) {
    session.autoApprove = "all";
    if (rec.worktree) session.permissiveMode = true;   // crew worker：worktree 隔离 + git 兜底，直接放宽 mode
  }
  live.set(session.id, session);
  broadcast({ type: "session", session: session.info() });
  audit.append({ session: id, harness: rec.harnessId, op: "session.revive", autoApprove: Boolean(rec.roomId) });
  void session.start("resume");
  return true;
}

/** 圆桌自动建会话：自动批准权限（圆桌界面没有审批按钮，否则会永久挂起） */
function spawnRoomSession(
  spec: HarnessSpec,
  cwd: string,
  via: string,
  configs?: Array<{ configId: string; value: string }>,
  vars?: Record<string, string>,
): HarnessSession {
  const record = HarnessSession.newRecord(spec, cwd);
  const session = new HarnessSession(spec, record, audit, makeHooks(), hub);
  session.autoApprove = "all";
  if (vars) session.vars = vars;
  if (configs?.length) session.pendingConfigs = configs;
  live.set(session.id, session);
  store.upsert(session.record());
  audit.append({ session: session.id, harness: spec.id, op: "session.create", cwd, via });
  broadcast({ type: "session", session: session.info() });
  void session.start("new");
  return session;
}

/** 把一批会话标记为「属于某个圆桌」（删圆桌时可连带删除，比 origin 可靠） */
function tagRoomSessions(roomId: string, sessionIds: string[]): void {
  for (const sid of sessionIds) {
    const session = live.get(sid);
    if (session) {
      session.roomId = roomId;
      store.upsert(session.record());
    } else {
      const rec = store.get(sid);
      if (rec) store.upsert({ ...rec, roomId });
    }
  }
}

function savedInfo(rec: PersistedSession): SessionInfo {
  const spec = specOf(rec.harnessId);
  return {
    id: rec.id,
    harnessId: rec.harnessId,
    harnessLabel: spec?.label ?? rec.harnessId,
    cwd: rec.cwd,
    status: "saved",
    createdAt: rec.createdAt,
    lastActiveAt: rec.lastActiveAt,
    live: false,
    resumable: rec.resumable,
    acpSessionId: rec.acpSessionId,
    title: rec.title ?? deriveTitle(rec.transcript),
  };
}

function sessionList(): SessionInfo[] {
  const list: SessionInfo[] = [...live.values()].map((s) => s.info());
  const liveIds = new Set(list.map((s) => s.id));
  for (const rec of store.all()) {
    if (!liveIds.has(rec.id)) list.push(savedInfo(rec));
  }
  return list.sort((a, b) => (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? ""));
}

function transcriptOf(id: string) {
  const l = live.get(id);
  if (l) return l.transcriptEntries();
  return store.get(id)?.transcript ?? [];
}

function broadcast(msg: ServerMsg): void {
  const payload = JSON.stringify(msg);
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

function makeHooks() {
  return {
    onStatus: (info: SessionInfo) => broadcast({ type: "session", session: info }),
    onUpdate: (sessionId: string, update: unknown) =>
      broadcast({ type: "update", sessionId, update }),
    onTurnEnd: (sessionId: string, stopReason: string) =>
      broadcast({ type: "turn_end", sessionId, stopReason }),
    onPermission: (
      sessionId: string,
      requestId: string,
      title: string,
      options: { optionId: string; name: string; kind?: string }[],
    ) => broadcast({ type: "permission", sessionId, requestId, title, options }),
    onLog: (sessionId: string, line: string) => {
      audit.append({
        session: sessionId,
        harness: live.get(sessionId)?.harnessId ?? store.get(sessionId)?.harnessId,
        op: "agent.log",
        line: line.slice(0, 2000),
      });
      broadcast({ type: "log", sessionId, line });
    },
    onPersist: (record: PersistedSession) => store.upsert(record),
  };
}

// ---------- HTTP ----------
function getPageContent(): string {
  try {
    return readFileSync(join(ROOT, "web", "index.html"), "utf8");
  } catch {
    return "<h1>500 - Failed to read web/index.html</h1>";
  }
}
const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        {
          ok: true,
          version: "0.2.0",
          harnesses: registry.harnesses.map((h) => availability(h, trust, currentProbe())),
          sessions: sessionList().map((s) => ({
            id: s.id,
            harnessId: s.harnessId,
            status: s.status,
            live: s.live,
          })),
          dataDir: DATA_DIR,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (url.pathname === "/sync-history" && req.method === "POST") {
    // 让 CLI 与外部工具通过服务同步，避免直接改文件被服务内存覆盖
    const summaries = history.run({
      harnessId: url.searchParams.get("harnessId") ?? undefined,
      force: url.searchParams.get("force") === "1",
      includeTmp: url.searchParams.get("includeTmp") === "1",
      // includeSelf=1：连「本工具自己目录下」的会话一起导（默认当调试噪音跳过）
      excludeDirs: url.searchParams.get("includeSelf") === "1" ? [] : [ROOT],
    });
    console.log(`[history] HTTP 触发同步: ${summaries.map((s) => `${s.label} +${s.imported}/~${s.updated}`).join(", ") || "无"}`);
    broadcast({ type: "history", providers: history.availableProviders(), summaries });
    broadcast(helloPayload());
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, summaries, providers: history.availableProviders() }, null, 1));
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache, no-store, must-revalidate",
      pragma: "no-cache",
      expires: "0",
    });
    res.end(getPageContent());
    return;
  }
  // 交付件下载：/download?room=<id>&task=<id>&path=<相对路径>（单文件）
  //           /download?room=<id>&task=<id>&all=1（任务全部产物打包 tar.gz）
  if (url.pathname === "/download") {
    if (!authorized(req)) {
      res.writeHead(4401, { "content-type": "text/plain; charset=utf-8" });
      res.end("unauthorized");
      return;
    }
    // 单会话模式：/download?session=<id>&path=<相对/绝对路径>（相对 cwd 校验越权）
    const sidDl = url.searchParams.get("session");
    if (sidDl) {
      const sess = live.get(sidDl) ?? store.get(sidDl);
      if (!sess) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("session not found"); return; }
      // path 支持相对/绝对；绝对路径交给 resolve 直接用，isInside 仍限定在工作区内
      const rel2 = url.searchParams.get("path") ?? "";
      const full2 = resolve(sess.cwd, rel2);
      if (!isInside(sess.cwd, full2) || !existsSync(full2) || !statSync(full2).isFile()) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("file not found");
        return;
      }
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${encodeURIComponent(rel2.split("/").pop() ?? "file")}"`,
      });
      res.end(readFileSync(full2));
      return;
    }
    const roomId = url.searchParams.get("room") ?? "";
    const taskId = url.searchParams.get("task") ?? "";
    const room = rooms.get(roomId);
    const task = room?.crew?.tasks.find((t) => t.id === taskId);
    const worker = room?.crew?.workers.find((w) => w.sessionId === task?.assignee) ?? room?.crew?.workers.find((w) => w.dir && task);
    if (!room?.crew || !task || !worker) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("task not found");
      return;
    }
    try {
      if (url.searchParams.get("all")) {
        if (!worker.base) {
          const mb = await currentBranch(room.cwd ?? ".");
          worker.base = (mb ? await mergeBaseWith(worker.dir, mb) : null) ?? (await headOf(worker.dir)) ?? undefined;
        }
        const files = await changedFiles(worker.dir, worker.base);
        if (!files.length) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("no artifacts");
          return;
        }
        const { execFile } = await import("node:child_process");
        const tar = await new Promise<Buffer>((resolve, reject) => {
          execFile("tar", ["-czf", "-", "-C", worker.dir, "--", ...files], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (err: Error | null, stdout: Buffer) => (err ? reject(err) : resolve(stdout)));
        });
        res.writeHead(200, {
          "content-type": "application/gzip",
          "content-disposition": `attachment; filename="crew-${roomId}-${taskId}.tar.gz"`,
        });
        res.end(tar);
        return;
      }
      const rel = (url.searchParams.get("path") ?? "").replace(/^\/+/, "");
      const full = resolve(worker.dir, rel);
      if (!isInside(worker.dir, full) || !existsSync(full) || !statSync(full).isFile()) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("file not found");
        return;
      }
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${encodeURIComponent(rel.split("/").pop() ?? "artifact")}"`,
      });
      res.end(readFileSync(full));
      return;
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(err instanceof Error ? err.message : String(err));
      return;
    }
  }
  // 静态资源（/static/... → web/ 目录，白名单扩展名；KaTeX 等自托管依赖）
  if (url.pathname.startsWith("/static/")) {
    const rel = url.pathname.slice("/static/".length);
    const safe = rel.replace(/\.\./g, "");   // 防目录穿越
    const file = join(ROOT, "web", safe);
    const MIME: Record<string, string> = {
      ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
      ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
      ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json",
    };
    const ext = file.slice(file.lastIndexOf("."));
    if (existsSync(file) && statSync(file).isFile() && MIME[ext]) {
      res.writeHead(200, { "content-type": MIME[ext], "cache-control": "public, max-age=86400" });
      res.end(readFileSync(file));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server: http, path: "/ws" });

function authorized(req: {
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}): boolean {
  if (AUTH_OFF) return true;
  const url = new URL(req.url ?? "/", "http://localhost");
  const qp = url.searchParams.get("token");
  if (qp && qp === TOKEN) return true;
  const auth = req.headers["authorization"];
  return typeof auth === "string" && auth === `Bearer ${TOKEN}`;
}

function helloPayload(): ServerMsg {
  return {
    type: "hello",
    providers: history.availableProviders(),
    harnesses: registry.harnesses.map((h) => availability(h, trust, currentProbe())),
    sessions: sessionList(),
    defaultCwd,
    rooms: rooms.list(),
  };
}

wss.on("connection", (ws, req) => {
  if (!authorized(req as never)) {
    ws.close(4401, "unauthorized");
    return;
  }
  sockets.add(ws);
  ws.send(JSON.stringify(helloPayload()));

  ws.on("message", async (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw)) as ClientMsg;
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "无法解析的消息" } satisfies ServerMsg));
      return;
    }
    try {
      switch (msg.type) {
        case "list":
          ws.send(JSON.stringify(helloPayload()));
          break;

        case "create": {
          const spec = specOf(msg.harnessId);
          void msg.vars;
          if (!spec) {
            ws.send(
              JSON.stringify({
                type: "error",
                message: `未知 harness: ${msg.harnessId}`,
              } satisfies ServerMsg),
            );
            return;
          }
          const baseCwd = msg.cwd?.trim() || defaultCwd;
          const record = HarnessSession.newRecord(spec, baseCwd);
          if (msg.isolate) {
            try {
              const wt = await createWorktree(baseCwd, record.id);
              if (wt) {
                record.worktree = wt;
                record.cwd = wt.dir;
                audit.append({ session: record.id, harness: spec.id, op: "worktree.create", ...wt, baseCwd });
              } else {
                audit.append({ session: record.id, harness: spec.id, op: "worktree.skipped", baseCwd, reason: "不是 git 仓库或仓库无提交" });
                ws.send(JSON.stringify({ type: "error", message: "该工作区无法隔离（需要是有提交的 git 仓库），已直接在原目录运行" } satisfies ServerMsg));
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              audit.append({ session: record.id, op: "worktree.failed", baseCwd, error: message });
              ws.send(JSON.stringify({ type: "error", message: `创建 worktree 失败，已退回原目录: ${message}` } satisfies ServerMsg));
            }
          }
          const session = new HarnessSession(spec, record, audit, makeHooks(), hub);
          if (msg.vars) session.vars = msg.vars;
          live.set(session.id, session);
          store.upsert(session.record());
          audit.append({ session: session.id, harness: spec.id, op: "session.create", cwd: session.cwd, isolated: Boolean(record.worktree) });
          broadcast({ type: "session", session: session.info() });
          void session.start("new");
          break;
        }

        case "resume": {
          if (live.has(msg.sessionId)) {
            ws.send(
              JSON.stringify({
                type: "error",
                sessionId: msg.sessionId,
                message: "该会话已在运行",
              } satisfies ServerMsg),
            );
            return;
          }
          const rec = store.get(msg.sessionId);
          if (!rec) {
            ws.send(
              JSON.stringify({
                type: "error",
                sessionId: msg.sessionId,
                message: "找不到该会话",
              } satisfies ServerMsg),
            );
            return;
          }
          const spec = specOf(rec.harnessId);
          if (!spec) {
            ws.send(
              JSON.stringify({
                type: "error",
                sessionId: msg.sessionId,
                message: `注册表里没有 harness: ${rec.harnessId}`,
              } satisfies ServerMsg),
            );
            return;
          }
          reviveSession(msg.sessionId);
          break;
        }

        case "prompt": {
          const session = live.get(msg.sessionId);
          if (!session) {
            ws.send(
              JSON.stringify({
                type: "error",
                sessionId: msg.sessionId,
                message: "会话未在运行，先「恢复」它",
              } satisfies ServerMsg),
            );
            return;
          }
          void session.prompt(msg.text, msg.attachments ?? []);
          break;
        }

        case "permission": {
          const session = live.get(msg.sessionId);
          const ok = session?.answerPermission(msg.requestId, msg.optionId) ?? false;
          if (!ok) {
            ws.send(
              JSON.stringify({
                type: "error",
                sessionId: msg.sessionId,
                message: `授权请求已失效: ${msg.requestId}`,
              } satisfies ServerMsg),
            );
          }
          break;
        }

        case "mode": {
          const session = live.get(msg.sessionId);
          if (!session) {
            ws.send(JSON.stringify({ type: "error", sessionId: msg.sessionId, message: "会话未在运行" } satisfies ServerMsg));
            return;
          }
          void session.setMode(msg.modeId).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            ws.send(JSON.stringify({ type: "error", sessionId: msg.sessionId, message: `切换模式失败: ${message}` } satisfies ServerMsg));
          });
          break;
        }

        case "config": {
          const session = live.get(msg.sessionId);
          if (!session) {
            ws.send(JSON.stringify({ type: "error", sessionId: msg.sessionId, message: "会话未在运行" } satisfies ServerMsg));
            return;
          }
          void session.setConfigOption(msg.configId, msg.value).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            ws.send(JSON.stringify({ type: "error", sessionId: msg.sessionId, message: `切换配置失败: ${message}` } satisfies ServerMsg));
          });
          break;
        }

        case "room-create": {
          const room = rooms.create({
            topic: msg.topic,
            members: msg.members,
            rounds: msg.rounds,
            writeAllowed: msg.writeAllowed,
          });
          ws.send(JSON.stringify({ type: "rooms", rooms: rooms.list() } satisfies ServerMsg));
          void rooms.run(room.id);
          break;
        }

        case "crew-detail": {
          const room = rooms.get(msg.roomId);
          if (!room?.crew) {
            ws.send(JSON.stringify({ type: "error", message: "圆桌不存在或不是工作队" } satisfies ServerMsg));
            break;
          }
          const crew = room.crew;
          const sids = new Set<string>([
            ...(room.members ?? []),
            ...crew.workers.map((w) => w.sessionId),
            ...(room.host ? [room.host.sessionId] : []),
          ]);
          // 决策记录：台账里的权限请求（含自动决策的理由），新→旧
          const decisions = audit
            .recent(600)
            .filter((e) => e.op === "permission.request" && typeof e.session === "string" && sids.has(e.session as string))
            .slice(0, 150)
            .map((e) => ({
              ts: String(e.ts ?? ""),
              harness: String(e.harness ?? ""),
              title: String(e.title ?? ""),
              chosen: (e.chosenName as string) ?? (typeof e.chosen === "string" ? (e.chosen as string) : undefined),
              reason: (e.reason as string) ?? undefined,
              task: (e.task as string) ?? undefined,
              intent: (e.intent as string) ?? undefined,
              permKind: (e.permKind as string) ?? undefined,
              locations: Array.isArray(e.locations) ? (e.locations as string[]) : undefined,
              input: (e.input as string) ?? undefined,
              raw: (e.raw as string) ?? undefined,
              danger: e.danger === true,
              held: e.held === true,
            }));
          // 交付件：任务产物 + 分支提交 + 评审结论 + diff
          const deliverables = [];
          for (const t of crew.tasks) {
            const w = crew.workers.find((x) => x.sessionId === t.assignee);
            const commits = w ? await branchCommits(w.dir, 10) : [];
            const artifacts: Array<{ path: string; size: number }> = [];
            if (w) {
              if (!w.base) {
                const mb = await currentBranch(room.cwd ?? ".");
                w.base = (mb ? await mergeBaseWith(w.dir, mb) : null) ?? (await headOf(w.dir)) ?? undefined;
              }
              for (const p of await changedFiles(w.dir, w.base)) {
                try {
                  const st = statSync(join(w.dir, p));
                  if (st.isFile()) artifacts.push({ path: p, size: st.size });
                } catch { /* 文件被删等 */ }
              }
            }
            deliverables.push({
              taskId: t.id,
              title: t.title,
              status: t.status,
              assignee: w?.harnessLabel ?? (t.assignee ? (live.get(t.assignee)?.harnessLabel ?? t.assignee) : undefined),
              files: t.files ?? [],
              summary: t.summary,
              review: t.review
                ? {
                    reviewer: t.review.reviewer,
                    verdict: t.review.verdict,
                    score: t.review.score,
                    comments: t.review.comments.slice(0, 400),
                  }
                : undefined,
              commits,
              artifacts,
              diff: t.diff,
            });
          }
          ws.send(JSON.stringify({ type: "crew-detail", roomId: msg.roomId, decisions, deliverables } satisfies ServerMsg));
          break;
        }

        case "room-run":
          void rooms.run(msg.roomId);
          break;

        case "room-start": {
          // 独立圆桌界面：选目录 + 选 harness → 自动给每个 harness 建会话 → 立刻开第一个议题
          const cwd = msg.cwd?.trim() || defaultCwd;
          const ids = [...new Set(msg.harnessIds ?? [])];
          if (ids.length < 2) {
            ws.send(JSON.stringify({ type: "error", message: "至少选两个 harness 才能开圆桌" } satisfies ServerMsg));
            return;
          }
          const specs = ids.map((id) => specOf(id));
          const missing = ids.filter((_, i) => !specs[i]);
          if (missing.length) {
            ws.send(JSON.stringify({ type: "error", message: `未知 harness: ${missing.join(", ")}` } satisfies ServerMsg));
            return;
          }
          try {
            if (!existsSync(cwd)) await mkdir(cwd, { recursive: true });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            ws.send(JSON.stringify({ type: "error", message: `工作目录不可用: ${cwd}（${message}）` } satisfies ServerMsg));
            return;
          }
          const members: string[] = [];
          const memberInfo: RoomMember[] = [];
          const crewWorkers: Array<{ sessionId: string; harnessId: string; harnessLabel: string; dir: string; branch: string; base?: string }> = [];

          // 主持人/工头是两种模式下都必要的指挥角色，必选（前端默认选中，这里兜底）
          if (!msg.host?.harnessId && !msg.host?.sessionId) {
            ws.send(JSON.stringify({ type: "error", message: "请指定主持人/工头——两种模式下它都是必要的指挥角色" } satisfies ServerMsg));
            return;
          }

          // 工作队模式：每个成员一个独立 git worktree（并行干活不冲突），会话 cwd 就在 worktree 里
          const isCrew = Boolean(msg.crew);
          if (isCrew) {
            // 目录没准备好就代劳：不是 git 仓库 → 自动 git init + 首次提交（拆 worktree/算 diff 都需要 HEAD）
            try {
              await ensureCrewRepo(cwd);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              ws.send(JSON.stringify({ type: "error", message: `git 仓库自动初始化失败（${cwd}）: ${message}` } satisfies ServerMsg));
              return;
            }
          }

          for (const spec of specs) {
            let session;
            if (isCrew) {
              const sid = randomUUID().slice(0, 8);
              const wt = await createWorktree(cwd, sid);
              if (!wt) {
                ws.send(JSON.stringify({ type: "error", message: `创建 worktree 失败（${spec!.label}）` } satisfies ServerMsg));
                return;
              }
              const record = HarnessSession.newRecord(spec!, wt.dir, sid);
              record.worktree = wt;
              session = new HarnessSession(spec!, record, audit, makeHooks(), hub);
              session.autoApprove = "all";
              session.permissiveMode = true;   // worker 在 git 隔离的 worktree 里：就绪后自动切最宽 mode，从源头减少授权
              const mcfg = msg.memberConfigs?.[spec!.id];
              if (mcfg?.length) session.pendingConfigs = mcfg;
              live.set(session.id, session);
              store.upsert(session.record());
              const base = await headOf(wt.dir) ?? undefined;
              audit.append({ session: session.id, harness: spec!.id, op: "session.create", cwd: wt.dir, via: "crew-worker", branch: wt.branch, base });
              broadcast({ type: "session", session: session.info() });
              void session.start("new");
              crewWorkers.push({ sessionId: session.id, harnessId: spec!.id, harnessLabel: spec!.label, dir: wt.dir, branch: wt.branch, base });
            } else {
              session = spawnRoomSession(spec!, cwd, "room-member", msg.memberConfigs?.[spec!.id]);
            }
            members.push(session.id);
            memberInfo.push({ sessionId: session.id, harnessId: spec!.id, harnessLabel: spec!.label });
          }

          // 主持人：可以是成员之一（既发言又主持），也可以是额外拉进来的 harness
          let host: HostConfig | undefined;
          const h = msg.crew
            ? (msg.host ?? { harnessId: ids[0], opening: true, roundSummary: false, finalSummary: true, style: "convergent" as const })
            : msg.host;
          if (h && (h.harnessId || h.sessionId)) {
            let hostSession: HarnessSession | undefined;
            if (h.sessionId) hostSession = live.get(h.sessionId);
            if (!hostSession && h.harnessId && !isCrew) {
              // 主持人同时是成员时复用那个成员会话（既发言又主持）；crew 模式工头必须在主目录，不能复用 worktree 里的 worker
              const asMember = memberInfo.find((m) => m.harnessId === h.harnessId);
              if (asMember) hostSession = live.get(asMember.sessionId);
            }
            if (!hostSession && h.harnessId) {
              const spec = specOf(h.harnessId);
              if (!spec) {
                ws.send(JSON.stringify({ type: "error", message: `未知主持人 harness: ${h.harnessId}` } satisfies ServerMsg));
                return;
              }
              hostSession = spawnRoomSession(spec, cwd, "room-host", h.configs);
            }
            if (!hostSession) {
              ws.send(JSON.stringify({ type: "error", message: "主持人会话不可用" } satisfies ServerMsg));
              return;
            }
            host = {
              sessionId: hostSession.id,
              harnessLabel: hostSession.harnessLabel,
              opening: h.opening ?? true,
              roundSummary: h.roundSummary ?? true,
              finalSummary: h.finalSummary ?? true,
              style: h.style ?? "divergent",
            };
          }

          const crew: CrewState | undefined = msg.crew
            ? {
                goal: msg.topic,
                maxAttempts: Math.min(Math.max(msg.crew.maxAttempts ?? 2, 1), 3),
                mergeMode: msg.crew.mergeMode ?? "manual",
                phase: "working",
                tasks: [],
                workers: crewWorkers,
                mergeLines: [],
                conflicts: [],
                integrated: false,
              }
            : undefined;
          const room = rooms.create({
            topic: msg.topic,
            members,
            memberInfo,
            host,
            crew,
            cwd,
            rounds: msg.rounds,
            mode: msg.mode,
            converge: msg.crew ? false : msg.converge,
            tournament: msg.crew ? false : msg.tournament,
            writeAllowed: msg.writeAllowed,
          });
          tagRoomSessions(room.id, [
            ...members,
            ...(host && !members.includes(host.sessionId) ? [host.sessionId] : []),
          ]);
          broadcast({ type: "rooms", rooms: rooms.list() });
          void rooms.run(room.id);
          break;
        }

        case "room-topic": {
          try {
            const t = rooms.addTopic(msg.roomId, {
              topic: msg.topic,
              rounds: msg.rounds,
              mode: msg.mode,
              converge: msg.converge,
              tournament: msg.tournament,
              writeAllowed: msg.writeAllowed,
            });
            if (!t) {
              ws.send(JSON.stringify({ type: "error", message: "圆桌不存在" } satisfies ServerMsg));
              return;
            }
            broadcast({ type: "rooms", rooms: rooms.list() });
            void rooms.run(msg.roomId);
          } catch (err) {
            ws.send(
              JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) } satisfies ServerMsg),
            );
          }
          break;
        }

        case "room-mode": {
          const room = rooms.setMode(msg.roomId, msg.mode);
          if (!room) {
            ws.send(JSON.stringify({ type: "error", message: "圆桌不存在" } satisfies ServerMsg));
            return;
          }
          break;
        }

        case "room-stop":
          rooms.stop(msg.roomId);
          ws.send(JSON.stringify({ type: "rooms", rooms: rooms.list() } satisfies ServerMsg));
          break;

        case "crew-merge": {
          try {
            const room = await rooms.mergeCrew(msg.roomId);
            if (!room) {
              ws.send(JSON.stringify({ type: "error", message: "圆桌不存在" } satisfies ServerMsg));
              return;
            }
            broadcast({ type: "rooms", rooms: rooms.list() });
            broadcast({ type: "room", room });
          } catch (err) {
            ws.send(
              JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) } satisfies ServerMsg),
            );
          }
          break;
        }

        case "room-delete": {
          const room = rooms.get(msg.roomId);
          rooms.delete(msg.roomId);
          // 可选：连带删掉这个圆桌自动建的成员/主持人会话（手动挂进来的会话不删）
          if (msg.deleteSessions && room) {
            const ids = new Set<string>([
              ...(room.members ?? []),
              ...(room.host ? [room.host.sessionId] : []),
            ]);
            for (const sid of ids) {
              const rec = store.get(sid);
              // 只删这个圆桌自己建的（按 roomId 判断：origin 会被历史导入改成 imported，不可靠）
              if (rec?.roomId !== msg.roomId) continue;
              const session = live.get(sid);
              if (session) {
                await session.stop();
                live.delete(sid);
              }
              store.remove(sid);
              audit.append({ session: sid, op: "session.delete", via: "room-delete", room: msg.roomId });
              broadcast({ type: "deleted", sessionId: sid } as unknown as ServerMsg);
            }
          }
          broadcast({ type: "rooms", rooms: rooms.list() });
          ws.send(JSON.stringify(helloPayload()));
          break;
        }

        case "workspace": {
          ws.send(JSON.stringify({ type: "workspace", reports: await hub.report(msg.cwd) } satisfies ServerMsg));
          break;
        }

        case "dirs": {
          // 工作目录补全：纯查询，不建任何东西
          ws.send(
            JSON.stringify({
              type: "dirs",
              reqId: msg.reqId,
              ...listDirs(msg.input ?? "", msg.base?.trim() || defaultCwd),
            } satisfies ServerMsg),
          );
          break;
        }

        case "transcript": {
          ws.send(
            JSON.stringify({
              type: "transcript",
              sessionId: msg.sessionId,
              entries: transcriptOf(msg.sessionId),
            } satisfies ServerMsg),
          );
          break;
        }

        case "sync-history": {
          const summaries = history.run({ harnessId: msg.harnessId, force: msg.force, excludeDirs: [ROOT] });
          console.log(`[history] 手动同步: ${summaries.map((s) => `${s.label} 导入${s.imported}/更新${s.updated}`).join(", ") || "无可用 harness"}`);
          ws.send(JSON.stringify({ type: "history", providers: history.availableProviders(), summaries } satisfies ServerMsg));
          ws.send(JSON.stringify(helloPayload()));
          break;
        }

        case "handoff": {
          // 老会话（CLI 建的）能在 HarnessGate 里查看，但 ACP 侧跑不了它们的 turn。
          // 接续 = 新建一个会话，把老对话的最近记录作为背景注入，然后继续聊。
          const src = store.get(msg.sessionId);
          if (!src) {
            ws.send(JSON.stringify({ type: "error", message: "找不到源会话" } satisfies ServerMsg));
            return;
          }
          const spec = specOf(src.harnessId);
          if (!spec) {
            ws.send(JSON.stringify({ type: "error", message: `注册表里没有 harness: ${src.harnessId}` } satisfies ServerMsg));
            return;
          }
          const keep = Math.min(Math.max(msg.keep ?? 20, 2), 60);
          const tail = src.transcript.slice(-keep);
          const lines: string[] = [];
          let budget = 6000;
          for (const e of tail) {
            const who = e.kind === "user" ? "用户" : e.kind === "assistant" ? "助手" : e.kind === "thought" ? "思考" : e.kind === "tool" ? "工具" : "其他";
            const asAny = e as unknown as Record<string, unknown>;
            const body = (e.kind === "tool"
              ? `[${asAny.title ?? "tool"} ${asAny.status ?? ""}]`
              : String(asAny.text ?? asAny.message ?? "")
            ).trim();
            if (!body) continue;
            const cut = body.length > 1200 ? body.slice(0, 1200) + "…（截断）" : body;
            if (budget - cut.length < 0) { lines.push("…（更早的内容已省略）"); break; }
            budget -= cut.length;
            lines.push(`【${who}】${cut}`);
          }
          const record = HarnessSession.newRecord(spec, src.cwd);
          record.title = `接续：${src.title ?? src.id}`.slice(0, 40);
          const session = new HarnessSession(spec, record, audit, makeHooks(), hub);
          live.set(session.id, session);
          store.upsert(session.record());
          audit.append({ session: session.id, harness: spec.id, op: "session.handoff", from: src.id, cwd: src.cwd });
          broadcast({ type: "session", session: session.info() });
          ws.send(JSON.stringify({ type: "handoff_done", from: src.id, to: session.id } satisfies ServerMsg));
          void session.start("new").then(async () => {
            const deadline = Date.now() + 90_000;
            while (Date.now() < deadline && session.info().status !== "ready") {
              if (session.info().status === "error") return;
              await new Promise((r) => setTimeout(r, 300));
            }
            if (session.info().status !== "ready") return;
            const intro = [
              `【接续会话】下面是之前一段会话（#${src.id}，标题「${src.title ?? "无"}」，目录 ${src.cwd}）的最近记录，请先通读建立上下文。`,
              "读完后用一句话确认你已了解背景，然后等我的下一个指令——不要在这一轮就动手改任何文件。",
              "",
              "——— 历史记录开始 ———",
              ...lines,
              "——— 历史记录结束 ———",
            ].join("\n");
            await session.prompt(intro);
          });
          break;
        }

        case "delete": {
          const session = live.get(msg.sessionId);
          if (session) {
            await session.stop();
            live.delete(msg.sessionId);
          }
          store.remove(msg.sessionId);
          audit.append({ session: msg.sessionId, op: "session.delete" });
          broadcast({
            type: "deleted",
            sessionId: msg.sessionId,
          } as unknown as ServerMsg);
          ws.send(JSON.stringify(helloPayload()));
          break;
        }

        case "close": {
          const session = live.get(msg.sessionId);
          if (session) {
            await session.stop();
            live.delete(msg.sessionId);
            const rec = store.get(msg.sessionId);
            if (rec) broadcast({ type: "session", session: savedInfo(rec) });
          }
          break;
        }

        case "interrupt": {
          const session = live.get(msg.sessionId);
          if (session) void session.cancelTurn();
          break;
        }

        case "set-auto-approve": {
          const session = live.get(msg.sessionId);
          if (session) session.setAutoApprove(msg.level);
          break;
        }

        case "session-detail": {
          const sess = live.get(msg.sessionId);
          const rec = sess ? sess.record() : store.get(msg.sessionId);
          if (!rec) {
            ws.send(JSON.stringify({ type: "error", message: "会话不存在" } satisfies ServerMsg));
            break;
          }
          const cwd = rec.cwd;
          // 决策记录：优先取会话台账（transcript 里的 permission 条目，持久化、不随审计窗口滚动），
          // 台账尾部只做补充（极老会话的早期条目）
          const decisions: Array<{ ts: string; title: string; chosen?: string; reason?: string; level?: string; auto: boolean; held: boolean; danger: boolean; task?: string; intent?: string; permKind?: string; input?: string }> = (rec.transcript || [])
            .filter((e) => e.kind === "permission")
            .slice(-150)
            .reverse()
            .map((e) => ({
              ts: String(e.ts ?? ""),
              title: String(e.title ?? ""),
              chosen: (e as { answered?: string }).answered,
              reason: undefined,
              level: undefined,
              auto: Boolean((e as { auto?: boolean }).auto),
              held: false,
              danger: Boolean((e as { danger?: boolean }).danger),
              task: (e as { task?: string }).task,
              intent: (e as { context?: string }).context,
              permKind: (e as { permKind?: string }).permKind,
              input: (e as { input?: string }).input,
            }));
          if (!decisions.length) {
            for (const e of audit.recent(600)) {
              if (e.op !== "permission.request" || e.session !== msg.sessionId) continue;
              decisions.push({
                ts: String(e.ts ?? ""), title: String(e.title ?? ""),
                chosen: (e.chosenName as string) ?? (typeof e.chosen === "string" ? (e.chosen as string) : undefined),
                reason: (e.reason as string) ?? undefined, level: (e.level as string) ?? undefined,
                auto: e.auto === true, held: e.held === true, danger: e.danger === true,
                task: (e.task as string) ?? undefined, intent: (e.intent as string) ?? undefined,
                permKind: (e.permKind as string) ?? undefined, input: (e.input as string) ?? undefined,
              });
            }
          }
          // 改动：git diff vs HEAD ∪ fs.change 台账（提交过的活不会凭空消失；来源标注）
          let gitRepo = false;
          const changes: Array<{ path: string; size: number; source: "git" | "audit" }> = [];
          const seen = new Set<string>();
          try {
            const top = await repoRoot(cwd);
            if (top) {
              gitRepo = true;
              const out = await new Promise<string>((resolve2, reject2) => {
                import("node:child_process").then(({ execFile }) =>
                  execFile("git", ["-C", cwd, "diff", "--name-only", "HEAD"], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (err: Error | null, stdout: string) => (err ? reject2(err) : resolve2(stdout))),
                );
              }).catch(() => "");
              const changed = out ? out.split("\n").filter(Boolean) : [];
              for (const p of changed) {
                seen.add(p);
                try {
                  const st = statSync(join(cwd, p));
                  if (st.isFile()) changes.push({ path: p, size: st.size, source: "git" });
                } catch { /* 已删除的文件跳过 */ }
              }
            }
          } catch { /* 非 git */ }
          for (const e of audit.recent(1200)) {
            if (e.op !== "fs.change" || e.session !== msg.sessionId) continue;
            const p2 = String(e.path ?? "");
            if (!p2 || seen.has(p2)) continue;
            seen.add(p2);
            try {
              const st = statSync(p2);
              if (st.isFile()) changes.push({ path: p2, size: st.size, source: "audit" });
            } catch { /* 文件已不在 */ }
          }
          changes.sort((a, b2) => b2.path.localeCompare(a.path));
          ws.send(JSON.stringify({ type: "session-detail", sessionId: msg.sessionId, decisions, changes, git: gitRepo } satisfies ServerMsg));
          break;
        }

        default:
          ws.send(JSON.stringify({ type: "error", message: "未知消息类型" } satisfies ServerMsg));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ws.send(JSON.stringify({ type: "error", message } satisfies ServerMsg));
    }
  });

  ws.on("close", () => sockets.delete(ws));
});

function lanAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return "localhost";
}

http.listen(PORT, HOST, () => {
  const avail = registry.harnesses.map((h) => availability(h, trust, currentProbe()));
  const saved = store.all().length;
  console.log(`HarnessGate 0.2.0`);
  console.log(`  UI/API : http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  if (AUTH_OFF) {
    console.log(`  直接打开: http://${lanAddress()}:${PORT}/`);
    if (HOST !== "127.0.0.1" && HOST !== "localhost") {
      console.log(`  ${"!".repeat(3)} 认证已关闭（HG_AUTH=off）：本机 ${HOST} 上任何能访问 ${PORT} 端口的人，`);
      console.log(`      都可以在你的服务器上以 root 驱动 agent 执行任意命令。仅限可信网络使用。`);
      console.log(`      重新开启：删掉 systemd 单元里的 HG_AUTH=off，或设 HG_AUTH=on`);
    }
  } else {
    console.log(`  直接打开: http://${lanAddress()}:${PORT}/?token=${TOKEN}   ← 点开即登录，可收藏`);
  }
  console.log(`  数据   : ${DATA_DIR}（历史会话 ${saved} 个）`);
  console.log(`  token  : ${TOKEN}`);
  console.log(`  harness: ${avail.map((h) => `${h.id}${h.available ? "" : "(缺失)"}`).join(", ")}`);
});

// 启动后台同步一次：新装的机器上，各 harness 的历史会自动出现
setTimeout(() => {
  try {
    const summaries = history.run({ excludeDirs: [ROOT] });
    const line = summaries.map((s) => `${s.label}: 新增 ${s.imported} / 更新 ${s.updated} / 跳过 ${s.skipped}`).join(" | ");
    if (summaries.length) console.log(`[history] 启动同步完成 → ${line}`);
    broadcast({ type: "history", providers: history.availableProviders(), summaries });
  } catch (err) {
    console.error("[history] 启动同步失败:", err instanceof Error ? err.message : err);
  }
}, 1500).unref();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void (async () => {
      for (const s of live.values()) await s.stop();
      store.flush();
      process.exit(0);
    })();
  });
}

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, createReadStream, renameSync, unlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { loadRegistry, availability, loadTrust, loadProbe, loadOverrides, applyOverrides, saveOverrides } from "./registry.ts";
import { loadSchedules, saveSchedules, nextFire, cadenceDesc, newScheduleId, compileCron, type Schedule } from "./schedules.ts";
import { listDirs } from "./dirs.ts";
import { AuditLog } from "./audit.ts";
import { HarnessSession, deriveTitle, applyChosen, registerConfigFallback, registerMcpResolver } from "./session.ts";
import { McpStore } from "./mcp.ts";
import { SkillsStore } from "./skills.ts";
import { SessionStore, type PersistedSession } from "./store.ts";
import { SettingsStore, settingsFileOf, type AppSettings } from "./settings.ts";
import { AutoTagger, projectTagOf } from "./auto-tagger.ts";
import { UtilitySessions } from "./utility-session.ts";
import { scanAllUtilitySessions, deleteAllUtilitySessions } from "./utility-cleanup.ts";
import { createWorktree, ensureCrewRepo, repoRoot } from "./worktree.ts";
import { WorkspaceHub } from "./workspace.ts";
import { RoomManager, type HostConfig, type RoomMember, type CrewState } from "./room.ts";
import { headOf, branchCommits, changedFiles, currentBranch, mergeBaseWith } from "./crew.ts";
import { isInside } from "./audit.ts";
import { randomUUID } from "node:crypto";
import { HistorySync } from "./history.ts";
import * as voice from "./voice.ts";
import { VoiceLive } from "./voice-live.ts";
import type { ClientMsg, HarnessSpec, ServerMsg, SessionInfo } from "./types.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.HG_PORT ?? 9830);
const HOST = process.env.HG_HOST ?? "0.0.0.0";
const DATA_DIR = process.env.HG_DATA_DIR ?? join(homedir(), ".harnessgate");
const SCHEDULES_FILE = join(DATA_DIR, "schedules.json");
const AUTO_WORKSPACE_ROOT = join(DATA_DIR, "schedules");
const TOKEN_FILE = join(DATA_DIR, "token");

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(TOKEN_FILE)) {
  writeFileSync(TOKEN_FILE, randomBytes(24).toString("hex"), { mode: 0o600 });
}
const TOKEN = process.env.HG_TOKEN ?? readFileSync(TOKEN_FILE, "utf8").trim();
/** HG_AUTH=off 时不做任何认证（单人自用场景）。默认开启。 */
const AUTH_OFF = ["off", "none", "0", "false", "no"].includes((process.env.HG_AUTH ?? "").toLowerCase());

const registry = loadRegistry(join(ROOT, "harness.json"));
/* 版本单一来源：package.json 的 version（打 tag 发布时同步升它），git 短 commit 用于更新比较与展示 */
const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version?: string }).version ?? "dev";
  } catch {
    return "dev";
  }
})();
function gitOf(args: string[]): { ok: boolean; out: string } {
  try {
    const r = spawnSync("git", args, { cwd: ROOT, timeout: 20_000, encoding: "utf8" });
    return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
  } catch {
    return { ok: false, out: "" };
  }
}
const GIT_COMMIT = gitOf(["rev-parse", "--short", "HEAD"]).out || "unknown";
/** 运行时的 git 操作走异步（fetch 可能几秒到几十秒，不能阻塞服务事件循环） */
function gitAsync(args: string[], timeoutMs = 30_000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd: ROOT });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, out: "", err: e.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, out: out.trim(), err: err.trim() }); });
  });
}
type UpdateCheckMsg = Extract<ServerMsg, { type: "update-check" }>;

/* ---------- APP 更新中转：手机直连 GitHub 慢，服务器（gh 有网络）下载一次并缓存 ----------
   GET /release-apk[?tag=vX.Y.Z]（默认 latest）→ 找 Release 里的 *-android.apk */
const APK_CACHE_DIR = join(DATA_DIR, "apk-cache");
mkdirSync(APK_CACHE_DIR, { recursive: true });
const apkDlLocks = new Map<string, Promise<boolean>>();

/** gh release view → { tag, apkName, apkSize }；找不到 APK 产物返回 null */
function ghReleaseApk(tag: string): Promise<{ tag: string; apkName: string; apkSize: number } | null> {
  return new Promise((resolve) => {
    const child = spawn("gh", ["release", "view", ...(tag ? [tag] : []), "--json", "tagName,assets"], { cwd: ROOT });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.log(`[release-apk] gh release view 失败: ${err.slice(0, 300)}`);
        resolve(null);
        return;
      }
      try {
        const j = JSON.parse(out) as { tagName: string; assets: Array<{ name: string; size: number }> };
        const apk = j.assets?.find((a) => a.name.endsWith("-android.apk"));
        resolve(apk ? { tag: j.tagName, apkName: apk.name, apkSize: apk.size } : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/** 后台预取 latest APK 到缓存：新版本发布后用户点「更新」大概率直接命中缓存，
 *  不用现场等服务器从 GitHub 拉（首次可能很慢）。启动后错峰预取 + check-update 发现有更新时预取。 */
function prefetchLatestApk(): void {
  void (async () => {
    const info = await ghReleaseApk("");
    if (!info) return;
    const file = join(APK_CACHE_DIR, info.apkName);
    if (existsSync(file) && statSync(file).size === info.apkSize) return; // 已缓存
    console.log(`[release-apk] 预取 ${info.apkName}（后台下载进缓存）`);
    const job = apkDlLocks.get(info.tag) ?? ghDownloadApk(info.tag, info.apkName);
    apkDlLocks.set(info.tag, job);
    const ok = await job;
    apkDlLocks.delete(info.tag);
    console.log(`[release-apk] 预取${ok ? "完成" : "失败"}: ${info.apkName}`);
  })();
}
setTimeout(() => prefetchLatestApk(), 60_000).unref?.();
/** curl -C - 断点续传下载：服务重启/预取被杀后，下次从 .tmp 半截继续，不再从零爬
 *  （gh release download 不支持续传——一天连发多版时缓存永远追不上，实测踩坑）。
 *  续传失败（文件损坏/服务端不支持 Range）自动删 .tmp 从头再来一次。 */
function ghDownloadApk(tag: string, name: string): Promise<boolean> {
  const dest = join(APK_CACHE_DIR, name);
  const tmp = `${dest}.tmp`;
  const url = `https://github.com/meichuanyi/HarnessGate/releases/download/${tag}/${name}`;
  const run = (resume: boolean): Promise<boolean> =>
    new Promise((resolve) => {
      const args = ["-sL", "-m", "3600", "-o", tmp, url];
      if (resume) args.unshift("-C", "-");
      const child = spawn("curl", args);
      let err = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 3_600_000);
      child.stderr.on("data", (c) => { err += c; });
      child.on("error", () => { clearTimeout(timer); resolve(false); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          console.log(`[release-apk] curl 下载失败(resume=${resume}): ${err.slice(0, 200)}`);
          resolve(false);
          return;
        }
        try {
          renameSync(tmp, dest);
          resolve(true);
        } catch {
          resolve(false);
        }
      });
    });
  return run(true).then((ok) => {
    if (ok) return true;
    console.log(`[release-apk] 续传失败，清 .tmp 从头重试: ${name}`);
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {}
    return run(false);
  });
}
// UI 里按 harness 配置的运行时覆盖（代理等）：对手写与导入条目都生效，持久化在 harness.overrides.json
const OVERRIDES_FILE = join(ROOT, "harness.overrides.json");
// 基线代理（harness.json/registry 的原值）：UI 清除覆盖时恢复到它，而不是保留上一次设置的值
const baseProxy = new Map(registry.harnesses.map((h) => [h.id, h.proxy]));
const overrides = loadOverrides(OVERRIDES_FILE);
applyOverrides(registry, overrides);
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

// 会话的兜底配置：harness 没上报 configOptions 时（hermes 从不报；部分 resume/load 也不带），
// 活会话面板也能显示/切换模型——探活结果按 harness 缓存，正好是「这个 harness 有哪些配置」的答案
registerConfigFallback((harnessId) => currentProbe()[harnessId]?.configs);

// 受管 MCP 服务器（~/.harnessgate/mcp.json）：会话启动/恢复时按所选 id 解析成 ACP 线格式
const mcpStore = new McpStore(join(DATA_DIR, "mcp.json"));
registerMcpResolver((ids) => mcpStore.wire(ids));

// 技能管理：主库 + 软链挂载（「装在库里」不占 token，「挂载中」才占）
const skillsStore = new SkillsStore(DATA_DIR);
const skillsSnapshot = () => skillsStore.snapshot(registry.harnesses.map((h) => ({ id: h.id })));
function broadcastSkills(reqId?: string) {
  broadcast({ type: "skills", reqId, ...skillsSnapshot() } satisfies ServerMsg);
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
const settingsStore = new SettingsStore(settingsFileOf(DATA_DIR));
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
/** 每个客户端连接最多一路实时通话（VoiceLive tap 本连接 WS 推音频/字幕） */
const voiceLives = new Map<WebSocket, VoiceLive>();
const sockets = new Set<WebSocket>();

function specOf(id: string): HarnessSpec | undefined {
  return registry.harnesses.find((h) => h.id === id);
}

/**
 * 接续快照：把源会话完整 transcript 物化成工作目录里的一个 Markdown 文件，
 * 新会话的 agent 用现成的 Grep/Read 按需查阅——渐进式披露，不占开场上下文。
 * 写失败不阻断接续：返回 undefined，注入词里就不提快照。
 */
function writeHandoffSnapshot(src: PersistedSession): string | undefined {
  try {
    const dir = join(src.cwd, ".harnessgate");
    const file = join(dir, `history-${src.id}.md`);
    mkdirSync(dir, { recursive: true });
    // 不污染 git status：写进仓库本地的 exclude（不动用户的 .gitignore；worktree 的 .git 是文件，跳过）
    const dotGit = join(src.cwd, ".git");
    if (existsSync(dotGit) && statSync(dotGit).isDirectory()) {
      const exclude = join(dotGit, "info", "exclude");
      let cur = "";
      try {
        cur = readFileSync(exclude, "utf8");
      } catch {
        /* 还没有 exclude 文件，新建 */
      }
      if (!cur.split("\n").some((l) => l.trim() === ".harnessgate/")) {
        mkdirSync(dirname(exclude), { recursive: true });
        writeFileSync(exclude, cur.replace(/\n*$/, "\n") + "# HarnessGate 接续历史快照\n.harnessgate/\n");
      }
    }
    const who = (k: string) =>
      k === "user" ? "用户" : k === "assistant" ? "助手" : k === "thought" ? "思考" : k === "tool" ? "工具"
        : k === "permission" ? "授权" : k === "error" ? "错误" : k === "log" ? "日志" : k;
    const fmt = (ts: string) => {
      const d = new Date(ts);
      return Number.isNaN(d.getTime())
        ? ts
        : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    const out: string[] = [
      `# 会话 #${src.id}${src.title ? `「${src.title}」` : ""}完整历史（接续快照）`,
      `源: #${src.id} · ${src.harnessId} · ${src.cwd} · 快照于 ${new Date().toISOString()} · 共 ${src.transcript.length} 条`,
      `条目按时间正序，每条以 "## [序号] 角色 · 时间" 开头。定位做法：先 Grep "^## \\[" 拿目录，再按行区间 Read 相关条目。`,
      "",
    ];
    src.transcript.forEach((e, i) => {
      out.push(`## [${String(i + 1).padStart(3, "0")}] ${who(e.kind)} · ${fmt(e.ts)}`);
      if (e.kind === "tool") {
        out.push(`状态: ${e.status}`);
        if (e.detail) out.push(`输入: ${e.detail}`);
        if (e.output) out.push(`输出: ${e.output}`);
      } else if (e.kind === "permission") {
        if (e.title) out.push(e.title);
        const opts = e.options?.map((o) => `${o.name ?? o.optionId}${o.kind ? `(${o.kind})` : ""}`).join(" / ");
        if (opts) out.push(`选项: ${opts}`);
        if (e.answered) out.push(`答复: ${e.answered}${e.auto ? "（自动）" : ""}`);
        if (e.input) out.push(`入参: ${e.input}`);
      } else {
        const a = e as unknown as Record<string, unknown>;
        const text = String(a.text ?? a.message ?? "");
        if (text) out.push(String(text));
        if (e.kind === "user" && e.attachments?.length) out.push(`（附件: ${e.attachments.map((x) => x.name).join(", ")}）`);
        if (e.kind === "assistant" && e.stopReason && e.stopReason !== "end_turn") out.push(`（结束原因: ${e.stopReason}）`);
      }
      out.push("");
    });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, out.join("\n"));
    renameSync(tmp, file);
    return file;
  } catch (err) {
    console.error("[handoff] 历史快照写入失败（接续继续，只是没有快照文件）:", err instanceof Error ? err.message : err);
    return undefined;
  }
}

/**
 * 把一个归档会话重新拉起来（服务重启过、或上次跑完被 stop 的会话）。
 * WS 的 resume 分支和圆桌的 waitReady 都走这里，避免两套逻辑。
 */
function reviveSession(id: string): boolean {
  const cur = live.get(id);
  if (cur?.info().live) return true;
  if (cur) live.delete(id);   // 残留死实例（进程已停但从未摘除）：挡在这里只会让恢复静默失败，清掉
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
    // 与 session.ts 的新语义对齐：有 ACP 会话 id 就可恢复（resume/fork 总可以试），
    // 兼容旧记录里只认 loadSession 能力时写下的 false
    resumable: rec.resumable || Boolean(rec.acpSessionId),
    acpSessionId: rec.acpSessionId,
    title: rec.title ?? deriveTitle(rec.transcript),
    autoApprove: rec.autoApprove,
    starred: rec.starred,
    tags: rec.tags,
    configOptions: applyChosen(currentProbe()[rec.harnessId]?.configs, rec.chosen),
  };
}

function sessionList(): SessionInfo[] {
  const list: SessionInfo[] = [...live.values()].filter((s) => !s.utility).map((s) => s.info());
  const liveIds = new Set(list.map((s) => s.id));
  for (const rec of store.all()) {
    if (!liveIds.has(rec.id)) list.push(savedInfo(rec));
  }
  // 收藏的会话置顶，其余按最近活动倒序
  return list.sort((a, b) =>
    Number(b.starred ?? false) - Number(a.starred ?? false) ||
    (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? ""));
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

/** 自动打标器（registry/availability 就绪后初始化，见下方赋值） */
let autoTagger: AutoTagger | null = null;

function makeHooks() {
  return {
    onStatus: (info: SessionInfo) => {
      if (info.utility) return; // 打标器临时会话不进任何客户端视野
      broadcast({ type: "session", session: info });
    },
    onUpdate: (sessionId: string, update: unknown) => {
      broadcast({ type: "update", sessionId, update });
      for (const vl of voiceLives.values()) {
        if (vl.sessionId === sessionId) vl.onUpdate(update as { sessionUpdate?: string; content?: { type?: string; text?: string } });
      }
    },
    onTurnEnd: (sessionId: string, stopReason: string) => {
      void autoTagger?.maybeEnqueue(sessionId); // 首轮结束后异步语义打标（内部自判条件）
      broadcast({ type: "turn_end", sessionId, stopReason });
      for (const vl of voiceLives.values()) {
        if (vl.sessionId === sessionId) vl.onTurnEnd();
      }
    },
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
    // 任何路径的 stop()（含空闲自动停止）都从这里统一摘除 live 实例，
    // 防止死实例残留把后续 resume 挡成"该会话已在运行"
    onStopped: (sessionId: string) => {
      live.delete(sessionId);
    },
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
          version: VERSION,
          commit: GIT_COMMIT,
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
  if (url.pathname === "/release-apk") {
    if (!authorized(req)) {
      res.writeHead(4401, { "content-type": "text/plain; charset=utf-8" });
      res.end("unauthorized");
      return;
    }
    void (async () => {
      const tag = url.searchParams.get("tag") ?? "";
      const info = await ghReleaseApk(tag);
      if (!info) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end(tag ? `release ${tag} 没有找到 Android APK` : "latest release 没有找到 Android APK");
        return;
      }
      const file = join(APK_CACHE_DIR, info.apkName);
      let size = existsSync(file) ? statSync(file).size : 0;
      if (size !== info.apkSize) {
        // 缓存缺失/大小不符：经服务器下载（并发请求共用一次下载）
        const job = apkDlLocks.get(info.tag) ?? ghDownloadApk(info.tag, info.apkName);
        apkDlLocks.set(info.tag, job);
        const okDl = await job;
        apkDlLocks.delete(info.tag);
        if (!okDl || !existsSync(file)) {
          res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
          res.end("APK 下载失败（服务器无法访问 GitHub？稍后再试）");
          return;
        }
        size = statSync(file).size;
      }
      res.writeHead(200, {
        "content-type": "application/vnd.android.package-archive",
        "content-length": size,
        "content-disposition": `attachment; filename="${info.apkName}"`,
      });
      createReadStream(file).pipe(res);
    })();
    return;
  }

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
  if (url.pathname === "/sw.js") {
    // Service Worker 必须在根作用域才能覆盖全站（加 Service-Worker-Allowed 头）
    res.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "service-worker-allowed": "/",
      "cache-control": "no-cache",
    });
    res.end(readFileSync(join(ROOT, "web", "sw.js")));
    return;
  }
  if (url.pathname === "/manifest.webmanifest") {
    res.writeHead(200, { "content-type": "application/manifest+json", "cache-control": "public, max-age=3600" });
    res.end(readFileSync(join(ROOT, "web", "static", "manifest.webmanifest")));
    return;
  }
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

const utilitySessions = new UtilitySessions({
    store,
    audit,
    hub,
    makeHooks,
    resolveHarness: (explicit?: string) => {
      const wanted = explicit || settingsStore.get().taggerHarnessId;
      if (wanted) {
        const w = specOf(wanted);
        if (w) return w;
      }
      const s = registry.harnesses.find((h) => availability(h, trust, currentProbe()).available);
      return s ? specOf(s.id) : undefined;
    },
    modelConfigIdOf: (harnessId: string) => {
      const h = registry.harnesses.find((x) => x.id === harnessId);
      if (!h) return undefined;
      const cfgs = availability(h, trust, currentProbe()).configs ?? [];
      return (cfgs.find((c) => c.category === "model") ?? cfgs.find((c) => /model/i.test(c.id) || /model/i.test(c.name ?? "")))?.id;
    },
    dataDir: DATA_DIR,
});
const utility = utilitySessions;

autoTagger = new AutoTagger(
  store,
  utility,
  () => settingsStore.get(),
  (sid: string, tags: string[]) => {
    // live 实例同步（否则实例下次 persist 会用旧 tags 盖掉 store）；存档会话直接广播
    const liveSess = live.get(sid);
    if (liveSess) {
      liveSess.setTags(tags, { semantic: true });
    } else {
      const rec = store.get(sid);
      if (rec) broadcast({ type: "session", session: savedInfo(rec) });
    }
  },
);

/** 助理会话 id：live 里找，退到 store（同一时刻只有一个 assistant 会话） */
function findAssistantSessionId(): string | null {
  for (const s of live.values()) if (s.assistant) return s.id;
  const rec = store.all().find((r) => r.assistant);
  return rec?.id ?? null;
}

function helloPayload(): ServerMsg {
  return {
    type: "hello",
    settings: settingsStore.get() as Record<string, unknown>,
    assistantSessionId: findAssistantSessionId(),
    providers: history.availableProviders(),
    version: VERSION,
    commit: GIT_COMMIT,
    harnesses: registry.harnesses.map((h) => availability(h, trust, currentProbe())),
    mcpServers: mcpStore.list(),
    skills: skillsSnapshot(),
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

        case "mcp-list":
          ws.send(JSON.stringify({ type: "mcp", servers: mcpStore.list() } satisfies ServerMsg));
          break;

        case "mcp-save": {
          const r = mcpStore.upsert(msg.server as Record<string, unknown>);
          if ("error" in r) {
            ws.send(JSON.stringify({ type: "error", message: `MCP 保存失败: ${r.error}` } satisfies ServerMsg));
            break;
          }
          broadcast({ type: "mcp", servers: mcpStore.list() } satisfies ServerMsg);
          break;
        }

        case "mcp-delete": {
          // 已存档会话记录里可能还留着它的 id：wire() 会静默跳过，不阻塞恢复，无需清理
          if (!mcpStore.remove(String(msg.id))) {
            ws.send(JSON.stringify({ type: "error", message: "MCP 服务器不存在" } satisfies ServerMsg));
            break;
          }
          broadcast({ type: "mcp", servers: mcpStore.list() } satisfies ServerMsg);
          break;
        }

        case "skills": {
          ws.send(JSON.stringify({ type: "skills", reqId: msg.reqId, ...skillsSnapshot() } satisfies ServerMsg));
          break;
        }
        case "skills-save": {
          const r = skillsStore.save(msg.skill);
          if ("error" in r) {
            ws.send(JSON.stringify({ type: "error", message: `skill 保存失败: ${r.error}` } satisfies ServerMsg));
            break;
          }
          broadcastSkills(msg.reqId);
          break;
        }
        case "skills-delete": {
          const r = skillsStore.remove(String(msg.name));
          if ("error" in r) {
            ws.send(JSON.stringify({ type: "error", message: `skill 删除失败: ${r.error}` } satisfies ServerMsg));
            break;
          }
          broadcastSkills(msg.reqId);
          break;
        }
        case "skills-mount": {
          const r = skillsStore.setMount(String(msg.name), String(msg.harnessId), msg.on !== false);
          if ("error" in r) {
            ws.send(JSON.stringify({ type: "error", message: `挂载操作失败: ${r.error}` } satisfies ServerMsg));
            break;
          }
          broadcastSkills(msg.reqId);
          break;
        }
        case "skills-read": {
          const r = skillsStore.read(String(msg.name), { nativeHarness: msg.nativeHarness ? String(msg.nativeHarness) : undefined });
          if (typeof r !== "string") {
            ws.send(JSON.stringify({ type: "error", message: r.error } satisfies ServerMsg));
            break;
          }
          ws.send(JSON.stringify({ type: "skills-content", reqId: msg.reqId, name: String(msg.name), content: r } satisfies ServerMsg));
          break;
        }

        case "branch": {
          // 会话树分叉：优先真 fork（ACP session/fork，agent 侧上下文复制，零损耗）；
          // fork 不可用或源会话非本工具创建时，退化为接续式注入（蒸馏最近历史开新会话）
          const src = store.get(msg.sessionId);
          if (!src) {
            ws.send(JSON.stringify({ type: "error", message: "找不到源会话" } satisfies ServerMsg));
            return;
          }
          const hid = msg.harnessId ?? src.harnessId;
          const spec = specOf(hid);
          if (!spec) {
            ws.send(JSON.stringify({ type: "error", message: `注册表里没有 harness: ${hid}` } satisfies ServerMsg));
            return;
          }
          const record = HarnessSession.newRecord(spec, src.cwd);
          record.parentId = src.id;
          record.branchName = (msg.branchName ?? "").trim().slice(0, 20) || `分支`;
          record.title = `${src.title ?? src.id} · ${record.branchName}`.slice(0, 44);
          record.tags = [...new Set([...(src.tags ?? []), "分支"])].slice(0, 20);
          if (msg.model) {
            const mc = currentProbe()[spec.id]?.configs?.find((c) => c.category === "model" && c.options.some((o) => o.value === msg.model));
            if (mc) record.chosen = { ...(record.chosen ?? {}), [mc.id]: msg.model };
          }
          const session = new HarnessSession(spec, record, audit, makeHooks(), hub);
          live.set(session.id, session);
          store.upsert(session.record());
          audit.append({ session: session.id, harness: spec.id, op: "session.branch", from: src.id, branch: record.branchName });
          broadcast({ type: "session", session: session.info() });
          ws.send(JSON.stringify({ type: "branch-created", from: src.id, to: session.id } satisfies ServerMsg));
          void session.start("new").then(async () => {
            const deadline = Date.now() + 90_000;
            while (Date.now() < deadline && session.info().status !== "ready") {
              if (session.info().status === "error") return;
              await new Promise((r) => setTimeout(r, 300));
            }
            if (session.info().status !== "ready") return;
            // fork 优先：同 harness 且源有 acpSessionId 时，等 start 完成后试 fork 注入上下文
            // （进程内 fork 在 connectWith resume/new 之后做——这里简化为注入式兜底，fork 路径
            //  走源会话 acpSessionId 的 clone，见 startFork）
            const forked = await session.tryForkFrom(src.acpSessionId);
            if (!forked) {
              // 兜底：接续式注入（蒸馏源会话最近历史）
              const tail = src.transcript.slice(-16);
              const lines: string[] = [];
              let budget = 5000;
              for (const e of tail) {
                const a = e as unknown as Record<string, unknown>;
                const who = e.kind === "user" ? "用户" : e.kind === "assistant" ? "助手" : e.kind === "thought" ? "思考" : e.kind === "tool" ? "工具" : "其他";
                const body = (e.kind === "tool" ? `[${a.title ?? "tool"} ${a.status ?? ""}]` : String(a.text ?? a.message ?? "")).trim();
                if (!body) continue;
                const cut = body.length > 1000 ? body.slice(0, 1000) + "…" : body;
                if (budget - cut.length < 0) { lines.push("…（更早省略）"); break; }
                budget -= cut.length;
                lines.push(`【${who}】${cut}`);
              }
              await session.prompt([
                `【分支会话】你是从会话 #${src.id}（标题「${src.title ?? "无"}」）分叉出的分支「${record.branchName}」，下面是源会话的最近记录，通读建立上下文。`,
                "主线想探索多个想法，你负责其中一个分支。一句话确认背景后等指令，不要动手改文件。",
                "", "——— 源会话记录 ———", ...lines, "—————————————",
              ].join("\n"));
            }
          });
          break;
        }

        case "adopt-branch": {
          // 收编分支：蒸馏其关键结论 → 注入主线（新回合）；分支标记已收编
          const branch = store.get(msg.branchId);
          const main = store.get(msg.mainId);
          if (!branch || !main) {
            ws.send(JSON.stringify({ type: "error", message: "分支或主线不存在" } satisfies ServerMsg));
            return;
          }
          if (branch.parentId !== main.id) {
            ws.send(JSON.stringify({ type: "error", message: "该会话不是这个主线的分支" } satisfies ServerMsg));
            return;
          }
          void (async () => {
            // 分支台账蒸馏（用户/助手的结论为主，工具行只留标题）
            const lines: string[] = [];
            for (const e of branch.transcript) {
              const a = e as unknown as Record<string, unknown>;
              if (e.kind === "user") lines.push(`用户: ${String(a.text ?? "").slice(0, 500)}`);
              else if (e.kind === "assistant") lines.push(`助手: ${String(a.text ?? "").slice(0, 800)}`);
              else if (e.kind === "tool") lines.push(`[工具 ${a.title ?? ""} ${a.status ?? ""}]`);
            }
            const r = await utility.ask({
              purpose: "adopt-branch",
              prompt: [
                "你是会话合并助手。下面是一个「主会话」分出去的「分支会话」的完整记录（分支带着主线上下文探索了一个方向）。",
                "提炼这个分支的关键结论：做了什么尝试、得到什么结果/结论、改了哪些文件（如有）、下一步建议。控制在 300 字内，直接输出要点，不要客套。",
                "", "——— 分支记录 ———", ...lines.slice(-120), "—————————————",
              ].join("\n"),
              timeoutMs: 90_000,
            });
            const summary = r.ok ? r.text.slice(0, 1200) : `（蒸馏失败：${r.error}；原始记录见分支会话 #${branch.id}）`;
            // 注入主线（拉活主线会话并 prompt）
            reviveSession(main.id);
            const mainSess = live.get(main.id);
            if (!mainSess) {
              ws.send(JSON.stringify({ type: "error", message: "主线会话无法拉活" } satisfies ServerMsg));
              return;
            }
            const deadline = Date.now() + 60_000;
            while (Date.now() < deadline && mainSess.info().status !== "ready") {
              if (mainSess.info().status === "error") break;
              await new Promise((r2) => setTimeout(r2, 300));
            }
            await mainSess.prompt([
              `【分支收编】之前从本会话分出去的分支「${branch.branchName ?? branch.id}」（会话 #${branch.id}）已经探索完毕，以下是它的关键结论摘要：`,
              "", summary, "",
              "请把这些结论纳入你的上下文（视为已确认的事实/进展），一句话确认后等我的下一步指令。",
            ].join("\n"));
            // 分支标记已收编（标题加 ✓，广播）
            const updated = { ...branch, branchName: `${branch.branchName ?? "分支"}✓已收编`, tags: [...new Set([...(branch.tags ?? []), "已收编"])].slice(0, 20) };
            store.upsert(updated);
            const liveB = live.get(branch.id);
            if (liveB) {
              liveB.branchName = updated.branchName;   // 实例同步（否则下次 persist 用旧名盖掉 store）
              liveB.setTags(updated.tags ?? [], { manual: true });
            } else {
              broadcast({ type: "session", session: savedInfo(updated) });
            }
            audit.append({ session: branch.id, op: "branch.adopted", main: main.id });
            broadcast({ type: "branch-adopted", branchId: branch.id, mainId: main.id, summary } satisfies ServerMsg);
          })();
          break;
        }

        case "assistant-ensure": {
          // 幂等：已有助理会话（未指定 harness 或 harness 相同）则只拉活
          const asid = findAssistantSessionId();
          const wantHid = typeof msg.harnessId === "string" ? msg.harnessId.trim() : "";
          const curRec = asid ? store.get(asid) : undefined;
          const needRebuild = Boolean(asid && wantHid && curRec && curRec.harnessId !== wantHid);
          if (asid && !needRebuild) {
            reviveSession(asid);
            ws.send(JSON.stringify({ type: "session", session: (live.get(asid) ?? live.values().next().value as HarnessSession).info() } satisfies ServerMsg));
            break;
          }
          if (needRebuild) {
            // 换芯重建：停旧删旧，台账搬进新会话；cwd 记忆目录不变 → 长期记忆跨 harness 保留
            const old = live.get(asid!);
            if (old) {
              await old.stop();
              live.delete(asid!);
            }
            store.remove(asid!);
            audit.append({ session: asid!, op: "assistant.recreate", from: curRec!.harnessId, to: wantHid });
            broadcast({ type: "deleted", sessionId: asid } as unknown as ServerMsg);
          }
          const hid = wantHid || settingsStore.get().taggerHarnessId || registry.harnesses.find((h) => availability(h, trust, currentProbe()).available)?.id;
          const spec = hid ? specOf(hid) : undefined;
          if (!spec) {
            ws.send(JSON.stringify({ type: "error", message: "没有可用 harness，无法创建助理会话" } satisfies ServerMsg));
            break;
          }
          const record = HarnessSession.newRecord(spec, join(DATA_DIR, "assistant"));
          record.assistant = true;
          record.title = "助理";
          record.tags = ["助理"];
          if (needRebuild) record.transcript = curRec!.transcript;   // 聊天记录跟过去
          const session = new HarnessSession(spec, record, audit, makeHooks(), hub);
          live.set(session.id, session);
          store.upsert(session.record());
          audit.append({ session: session.id, harness: spec.id, op: "assistant.create" });
          broadcast({ type: "session", session: session.info() });
          ws.send(JSON.stringify(helloPayload()));   // assistantSessionId 变了，让发起端立刻拿到新 id
          void session.start("new");
          break;
        }

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
          if (msg.assistant) record.assistant = true;
          autoTagger?.applyProjectTags(record);   // 必须在构造实例前改 record（实例构造时快照 tags）
          const session = new HarnessSession(spec, record, audit, makeHooks(), hub);
          if (msg.vars) session.vars = msg.vars;
          // MCP 注入：显式给了列表就用列表（未知 id 剔除），没给则默认全部 enabled 的
          const knownIds = new Set(mcpStore.list().map((s) => s.id));
          session.mcpServerIds = msg.mcpServerIds
            ? msg.mcpServerIds.map(String).filter((id) => knownIds.has(id))
            : mcpStore.enabledIds();
          if (msg.mcpServerIds && session.mcpServerIds.length !== msg.mcpServerIds.length) {
            ws.send(JSON.stringify({ type: "error", message: "部分所选 MCP 服务器已不存在，已忽略" } satisfies ServerMsg));
          }
          live.set(session.id, session);
          store.upsert(session.record());
          audit.append({ session: session.id, harness: spec.id, op: "session.create", cwd: session.cwd, isolated: Boolean(record.worktree) });
          broadcast({ type: "session", session: session.info() });
          void session.start("new");
          break;
        }

        case "resume": {
          // 只有「真活着」的会话才拒绝重复恢复；进程已停但实例残留（空闲自动停止的历史遗留）直接放行
          if (live.get(msg.sessionId)?.info().live) {
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
          if (session) {
            void session.setConfigOption(msg.configId, msg.value).catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              ws.send(JSON.stringify({ type: "error", sessionId: msg.sessionId, message: `切换配置失败: ${message}` } satisfies ServerMsg));
            });
            break;
          }
          // 存档会话：记进 chosen 即可——恢复时构造函数会转成 pendingConfigs 自动重放，
          // 面板立即显示新选择（之前直接报「会话未在运行」，冷会话的模型选项成了摆设）
          const rec = store.get(msg.sessionId);
          if (!rec) {
            ws.send(JSON.stringify({ type: "error", sessionId: msg.sessionId, message: "会话不存在" } satisfies ServerMsg));
            break;
          }
          rec.chosen = { ...rec.chosen, [msg.configId]: msg.value };
          store.upsert(rec);
          broadcast({ type: "session", session: savedInfo(rec) });
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
          const all = transcriptOf(msg.sessionId);
          const limit = typeof msg.limit === "number" && msg.limit > 0 ? Math.floor(msg.limit) : 0;
          if (!limit) {
            // 不给窗口：整份（web 端沿用旧行为）
            ws.send(
              JSON.stringify({ type: "transcript", sessionId: msg.sessionId, entries: all, total: all.length, start: 0 } satisfies ServerMsg),
            );
            break;
          }
          const end = typeof msg.before === "number" ? Math.max(0, Math.min(all.length, Math.floor(msg.before))) : all.length;
          const start = Math.max(0, end - limit);
          ws.send(
            JSON.stringify({
              type: "transcript",
              sessionId: msg.sessionId,
              entries: all.slice(start, end),
              total: all.length,
              start,
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
          // 接续 = 新建一个会话（可换 harness/模型），把老对话的最近记录作为背景注入；
          // 完整历史物化成快照文件放在工作目录，agent 需要更早背景时自己 Grep/Read（渐进式披露）。
          const src = store.get(msg.sessionId);
          if (!src) {
            ws.send(JSON.stringify({ type: "error", message: "找不到源会话" } satisfies ServerMsg));
            return;
          }
          const spec = specOf(msg.targetHarnessId ?? src.harnessId);
          if (!spec) {
            ws.send(JSON.stringify({ type: "error", message: `注册表里没有 harness: ${msg.targetHarnessId ?? src.harnessId}` } satisfies ServerMsg));
            return;
          }
          // 模型：只认目标 harness 探活配置里真实存在的值，写进 chosen → 启动时经 pendingConfigs 自动重放
          let modelCfg: { id: string } | undefined;
          if (msg.model) {
            modelCfg = currentProbe()[spec.id]?.configs?.find(
              (c) => c.category === "model" && c.options.some((o) => o.value === msg.model),
            );
            if (!modelCfg) {
              ws.send(JSON.stringify({ type: "error", message: `模型 ${msg.model} 不在 ${spec.label} 的探活配置里，本次接续先用默认模型，进会话后可在顶栏再切` } satisfies ServerMsg));
            }
          }
          const tail = src.transcript.slice(-20);
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
          const snapshotPath = writeHandoffSnapshot(src);
          const record = HarnessSession.newRecord(spec, src.cwd);
          record.title = `接续：${src.title ?? src.id}`.slice(0, 40);
          record.handoffFrom = src.id;
          if (msg.model && modelCfg) record.chosen = { ...(record.chosen ?? {}), [modelCfg.id]: msg.model };
          const session = new HarnessSession(spec, record, audit, makeHooks(), hub);
          live.set(session.id, session);
          store.upsert(session.record());
          audit.append({ session: session.id, harness: spec.id, op: "session.handoff", from: src.id, cwd: src.cwd, target: spec.id, model: msg.model });
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
            ];
            if (snapshotPath) {
              intro.push(
                "",
                `【更早的历史】该会话的完整历史（共 ${src.transcript.length} 条，含未截断的工具输入输出）已保存为文件：${snapshotPath}`,
                "需要更早背景（早前的决定、讨论原文等）时再用工具查阅，现在不要读：先 Grep `^## \\[` 拿到条目目录，定位后按行区间 Read 相关几段即可，不要整文件通读。",
              );
            }
            await session.prompt(intro.join("\n"));
          });
          break;
        }

        case "voice-stt": {
          // 本地 STT：模型没下过就开始后台下载并告知；就绪则整段 WAV → 文本
          if (!voice.sttModelReady()) {
            void voice.ensureModel().catch((err) => {
              console.error("[voice] 模型下载失败:", err instanceof Error ? err.message : err);
            });
            ws.send(JSON.stringify({
              type: "voice-stt-result", reqId: msg.reqId, downloading: true,
              error: "本地识别模型首次使用需下载（约 350MB 一次性），已开始后台下载，完成后重试即可",
            } satisfies ServerMsg));
            return;
          }
          try {
            await voice.ensureModel();   // 就绪路径上这是空操作
            const wav = Buffer.from(msg.audio, "base64");
            const text = await voice.transcribeWav(wav);
            ws.send(JSON.stringify({ type: "voice-stt-result", reqId: msg.reqId, text } satisfies ServerMsg));
          } catch (err) {
            ws.send(JSON.stringify({ type: "voice-stt-result", reqId: msg.reqId, error: err instanceof Error ? err.message : String(err) } satisfies ServerMsg));
          }
          break;
        }

        case "voice-tts": {
          try {
            const r = await voice.tts(msg.provider).synthesize(msg.text, { voice: msg.voice });
            ws.send(JSON.stringify({
              type: "voice-tts-result", reqId: msg.reqId,
              audio: r.audio.toString("base64"), mime: r.mime, provider: r.provider,
            } satisfies ServerMsg));
          } catch (err) {
            ws.send(JSON.stringify({ type: "voice-tts-result", reqId: msg.reqId, error: err instanceof Error ? err.message : String(err) } satisfies ServerMsg));
          }
          break;
        }

        case "voice-live-start": {
          const session = live.get(msg.sessionId);
          if (!session) {
            ws.send(JSON.stringify({ type: "voice-live-phase", phase: "error", note: "会话不在运行，先进会话（必要时恢复）再打语音电话" } satisfies ServerMsg));
            return;
          }
          if (!voice.sttModelReady()) {
            void voice.ensureModel().catch((err) => console.error("[voice] 模型下载失败:", err instanceof Error ? err.message : err));
            ws.send(JSON.stringify({ type: "voice-live-phase", phase: "error", note: "本地识别模型还没就绪（首次需下载），稍后再拨" } satisfies ServerMsg));
            return;
          }
          const wantAudio = msg.mode === "audio";
          const mode: "stt" | "audio" = wantAudio && session.canPromptAudio() ? "audio" : "stt";
          if (wantAudio && !session.canPromptAudio()) {
            ws.send(JSON.stringify({ type: "voice-live-phase", phase: "listening", note: "该 harness 不支持直传音频，已改用本地识别" } satisfies ServerMsg));
          }
          const prev = voiceLives.get(ws);
          if (prev) void prev.stop();   // 同连接重拨：先挂旧电话
          const vl = new VoiceLive(
            session,
            {
              partial: (text) => ws.send(JSON.stringify({ type: "voice-live-partial", text } satisfies ServerMsg)),
              user: (text) => ws.send(JSON.stringify({ type: "voice-live-user", text } satisfies ServerMsg)),
              audio: (seq, audio, mime) => {
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "voice-live-agent-audio", seq, audio, mime } satisfies ServerMsg));
              },
              phase: (phase, note) => {
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "voice-live-phase", phase, note } satisfies ServerMsg));
              },
            },
            { model: msg.model, cancelOnBarge: msg.cancelOnBarge, mode, transcribe: msg.transcribe },
          );
          voiceLives.set(ws, vl);
          try {
            await vl.start();
          } catch (err) {
            voiceLives.delete(ws);
            ws.send(JSON.stringify({ type: "voice-live-phase", phase: "error", note: err instanceof Error ? err.message : String(err) } satisfies ServerMsg));
          }
          break;
        }

        case "voice-live-chunk": {
          voiceLives.get(ws)?.feedChunk(Buffer.from(msg.pcm, "base64"));
          break;
        }

        case "voice-live-barge": {
          voiceLives.get(ws)?.barge();
          break;
        }

        case "voice-live-stop": {
          const vl = voiceLives.get(ws);
          voiceLives.delete(ws);
          if (vl) await vl.stop();
          ws.send(JSON.stringify({ type: "voice-live-ended" } satisfies ServerMsg));
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

        case "utility-cleanup": {
          if (msg.ids) {
            const deleted = deleteAllUtilitySessions(msg.ids);
            audit.append({ op: "utility-cleanup.delete", count: deleted });
            ws.send(JSON.stringify({ type: "utility-cleanup-report", reports: [{ id: "cleanup", label: "", ok: true, found: 0, deleted }] } satisfies ServerMsg));
          } else {
            const reports = scanAllUtilitySessions().map(({ source, report }) => ({
              id: source.id,
              label: source.label,
              ok: report.ok,
              found: report.found,
              deleted: 0,
              candidates: report.candidates,
              error: report.error,
            }));
            ws.send(JSON.stringify({ type: "utility-cleanup-report", reports } satisfies ServerMsg));
          }
          break;
        }

        case "ping": {
          ws.send(JSON.stringify({ type: "pong" } satisfies ServerMsg));
          break;
        }

        case "settings-get": {
          ws.send(JSON.stringify({ type: "settings", settings: settingsStore.get() } satisfies ServerMsg));
          break;
        }

        case "settings-set": {
          const next = settingsStore.update(msg.patch as Partial<AppSettings>);
          broadcast({ type: "settings", settings: next } satisfies ServerMsg);
          break;
        }

        case "set-tags": {
          // 标签整体替换：live 会话走实例（落盘+广播）；仅存档的记录直接改 store 后广播
          const session = live.get(msg.sessionId);
          if (session) {
            session.setTags(Array.isArray(msg.tags) ? msg.tags : [], { manual: true });
          } else {
            const rec = store.get(msg.sessionId);
            if (rec) {
              const updated = { ...rec, tags: (Array.isArray(msg.tags) ? msg.tags : []).map(String).map((t) => t.trim()).filter(Boolean).slice(0, 20) };
              store.upsert(updated);
              broadcast({ type: "session", session: savedInfo(updated) });
            }
          }
          break;
        }

        case "star": {
          // 收藏切换：live 会话走实例（落盘+广播）；仅存档的记录直接改 store 后广播
          const session = live.get(msg.sessionId);
          if (session) {
            session.setStarred(msg.starred);
          } else {
            const rec = store.get(msg.sessionId);
            if (rec) {
              const updated = { ...rec, starred: msg.starred };
              store.upsert(updated);
              broadcast({ type: "session", session: savedInfo(updated) });
            }
          }
          break;
        }

        case "check-update": {
          void (async () => {
            const reply = (extra: Partial<UpdateCheckMsg>) =>
              ws.send(
                JSON.stringify({
                  type: "update-check",
                  current: VERSION,
                  commit: GIT_COMMIT,
                  branch: "",
                  behind: 0,
                  ahead: 0,
                  dirty: false,
                  commits: [],
                  updateAvailable: false,
                  ...extra,
                } satisfies UpdateCheckMsg),
              );
            const branchR = await gitAsync(["rev-parse", "--abbrev-ref", "HEAD"]);
            const branch = branchR.out || "HEAD";
            const statusR = await gitAsync(["status", "--porcelain"]);
            const dirty = statusR.ok ? statusR.out.length > 0 : false;
            if (!branchR.ok || !statusR.ok) {
              await reply({ branch, error: "git 不可用（部署目录不是 git 仓库？无法自动更新）" });
              return;
            }
            const fetchR = await gitAsync(["fetch", "--quiet", "origin"], 45_000);
            if (!fetchR.ok) {
              await reply({ branch, dirty, error: `git fetch 失败：${fetchR.err || "未知错误"}（服务器无法访问 GitHub？）` });
              return;
            }
            // 上游分支：跟踪分支优先，退回 origin/main
            const upR = await gitAsync(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
            const upstream = upR.ok && upR.out ? upR.out : "origin/main";
            const behindR = await gitAsync(["rev-list", "--count", `HEAD..${upstream}`]);
            const aheadR = await gitAsync(["rev-list", "--count", `${upstream}..HEAD`]);
            const logR = await gitAsync(["log", "--oneline", "--no-decorate", "-n", "10", `HEAD..${upstream}`]);
            const behind = behindR.ok ? Number(behindR.out) || 0 : 0;
            if (behind > 0) prefetchLatestApk();   // 有新版：后台先把 APK 拉进缓存，用户点更新时直接命中
            await reply({
              branch,
              dirty,
              behind,
              ahead: aheadR.ok ? Number(aheadR.out) || 0 : 0,
              commits: logR.ok ? logR.out.split("\n").filter(Boolean) : [],
              updateAvailable: behind > 0,
            });
          })();
          break;
        }

        case "apply-update": {
          void (async () => {
            const statusR = await gitAsync(["status", "--porcelain"]);
            if (!statusR.ok) {
              ws.send(JSON.stringify({ type: "error", message: "git 不可用（部署目录不是 git 仓库？）" } satisfies ServerMsg));
              return;
            }
            if (statusR.out.length > 0) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: "部署目录有未提交的本地修改，拒绝自动更新（防止覆盖你的改动）。请先在服务器上提交或 stash。",
                } satisfies ServerMsg),
              );
              return;
            }
            const pullR = await gitAsync(["pull", "--ff-only", "--quiet"], 60_000);
            if (!pullR.ok) {
              ws.send(JSON.stringify({ type: "error", message: `git pull 失败：${pullR.err || "未知错误"}` } satisfies ServerMsg));
              return;
            }
            audit.append({ op: "selfupdate.apply", from: GIT_COMMIT });
            // 广播给所有客户端（含触发者），前端提示重启并自动重连
            broadcast({ type: "update-applied", version: VERSION, message: "更新已拉取，服务重启中…页面会自动重连" } satisfies ServerMsg);
            // 优雅收尾运行中的会话（落盘 + 停 harness 子进程），再退出交给 systemd 拉起新代码
            await Promise.allSettled([...live.values()].map((s) => s.stop()));
            store.flush();
            setTimeout(() => process.exit(0), 800);
          })();
          break;
        }

        case "harness-proxy": {
          // UI 里按 harness 配置代理：立即更新内存 spec（对之后新建的会话生效）并持久化覆盖文件
          const spec = registry.harnesses.find((h) => h.id === msg.id);
          if (!spec) {
            ws.send(JSON.stringify({ type: "error", message: `未知 harness: ${msg.id}` } satisfies ServerMsg));
            break;
          }
          const proxy = String(msg.proxy ?? "").trim();
          if (proxy && !/^(https?|socks5):\/\//.test(proxy)) {
            ws.send(JSON.stringify({ type: "error", message: "代理地址需以 http:// / https:// / socks5:// 开头" } satisfies ServerMsg));
            break;
          }
          const ov: { proxy?: string } = { ...(overrides[msg.id] ?? {}) };
          if (proxy) ov.proxy = proxy; else delete ov.proxy;
          overrides[msg.id] = ov;
          // 直接设 spec：设置 → 覆盖值；清除 → 恢复基线（harness.json 原值）
          spec.proxy = ov.proxy ?? baseProxy.get(msg.id) ?? undefined;
          try {
            saveOverrides(OVERRIDES_FILE, overrides);
          } catch (err) {
            ws.send(JSON.stringify({ type: "error", message: `覆盖文件写入失败: ${err instanceof Error ? err.message : String(err)}` } satisfies ServerMsg));
            break;
          }
          audit.append({ op: "harness.proxy.set", harness: msg.id, proxy: proxy || "(直连)" });
          console.log(`[harness] ${msg.id} 代理 → ${proxy || "(直连)"}（对之后新建的会话生效）`);
          broadcast(helloPayload());
          break;
        }

        case "schedules-list": {
          ws.send(JSON.stringify({ type: "schedules", schedules } satisfies ServerMsg));
          break;
        }

        case "schedule-save": {
          const incoming = (msg as unknown as { schedule: Partial<Schedule> }).schedule;
          if (!incoming?.name || !incoming?.harnessId || !incoming?.cadence || !incoming?.promptTemplate) {
            ws.send(JSON.stringify({ type: "error", message: "定时任务缺少必填字段（名称/harness/频率/prompt 模板）" } satisfies ServerMsg));
            break;
          }
          try {
            compileCronCheck(incoming.cadence);
          } catch (err) {
            ws.send(JSON.stringify({ type: "error", message: `频率配置有误: ${err instanceof Error ? err.message : String(err)}` } satisfies ServerMsg));
            break;
          }
          const id = incoming.id || newScheduleId();
          const existing = schedules.find((s) => s.id === id);
          const rec: Schedule = {
            ...(existing ?? { id, createdAt: new Date().toISOString(), state: {} as Schedule["state"] }),
            ...(incoming as Schedule),
            id,
            enabled: incoming.enabled !== false,
            state: {
              ...(existing?.state ?? {}),
              ...(incoming.state ?? {}),   // 从会话整理时带 lastSessionId 进来（专属会话模式续用原会话）
              nextFireAt: incoming.enabled !== false ? nextFire(incoming.cadence, incoming.window)?.toISOString() : undefined,
            },
          };
          const idx = schedules.findIndex((s) => s.id === id);
          if (idx >= 0) schedules[idx] = rec; else schedules.push(rec);
          audit.append({ op: "schedule.save", schedule: id, name: rec.name });
          saveAndBroadcastSchedules();
          break;
        }

        case "schedule-delete": {
          const before = schedules.length;
          schedules = schedules.filter((s) => s.id !== msg.id);
          if (schedules.length !== before) {
            audit.append({ op: "schedule.delete", schedule: String(msg.id) });
            saveAndBroadcastSchedules();
          }
          break;
        }

        case "schedule-segmented-get": {
          // AI 精切结果缓存查询：结果广播是瞬时的，面板晚开也能取
          const cached = segmentationCache.get(String(msg.sessionId ?? ""));
          ws.send(JSON.stringify({ type: "schedule-segmented", sessionId: String(msg.sessionId ?? ""), segments: cached?.segments ?? [] } satisfies ServerMsg));
          break;
        }

        case "schedule-segment": {
          // AI 精切：把压缩后的用户消息序列交给当前会话的模型，输出任务段（本地切分的复核/兜底）
          const session = live.get(msg.sessionId);
          if (!session || session.info().status !== "ready") {
            ws.send(JSON.stringify({ type: "error", sessionId: msg.sessionId, message: "AI 精切需要会话在运行（先恢复会话）" } satisfies ServerMsg));
            break;
          }
          const users = session.transcriptEntries()
            .map((e, i) => ({ e, i }))
            .filter(({ e }) => e.kind === "user" && (e as { text?: string }).text?.trim())
            .map(({ e, i }) => {
              const u = e as { text: string; ts: string };
              const t = new Date(u.ts);
              const stamp = `${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
              return `#${i} ${stamp} ${u.text.trim().slice(0, 120)}`;
            });
          if (!users.length) {
            ws.send(JSON.stringify({ type: "error", sessionId: session.id, message: "会话里没有用户消息" } satisfies ServerMsg));
            break;
          }
          const ASK = `【任务段切分】下面是一次会话里我的全部发言（#编号 时间 内容）。请把它们切成若干"任务段"：同一个任务的推进（包括"继续/好的"这类短回复）归同一段，不同任务分开。只输出一个 JSON 对象（可放 \`\`\`json 围栏），不要解释：
{"segments":[{"from":起始消息的#编号,"to":结束消息的#编号,"name":"任务名(10字内)","schedulable":该任务是否适合定时重复执行(true/false，一次性修复/纯问答=false),"score":1-3的推荐度}]}
按时间顺序，最多 5 段，最值得定时化的排前面。

${users.join("\n")}`;
          void (async () => {
            const r = await session.promptAndWait(ASK, 120_000);
            let parsed = parseDistilled(r.text);
            if (!parsed || !Array.isArray(parsed.segments)) {
              const r2 = await session.promptAndWait("上一条没有给出合法的 segments JSON。请立即只输出那个 JSON 对象。", 60_000);
              parsed = parseDistilled(r2.text);
            }
            const ents = session.transcriptEntries();
            const all = ents.map((e, i) => ({ e, i })).filter(({ e }) => e.kind === "user");
            const segsOut: Array<{ head: string; fromTs: string; toTs: string; turns: number; score: number }> = [];
            if (parsed && Array.isArray(parsed.segments)) {
              for (const g of parsed.segments as Array<Record<string, unknown>>) {
                const from = Number(g.from), to = Number(g.to);
                if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) continue;
                if (g.schedulable === false) continue;
                const inRange = all.filter(({ i }) => i >= from && i <= to);
                if (!inRange.length) continue;
                segsOut.push({
                  head: String(g.name ?? (("text" in inRange[0]!.e ? inRange[0]!.e.text : "") || "任务段")).slice(0, 60),
                  fromTs: (inRange[0]!.e as { ts: string }).ts,
                  toTs: (inRange[inRange.length - 1]!.e as { ts: string }).ts,
                  turns: inRange.length,
                  score: Math.max(1, Math.min(3, Number(g.score) || 2)),
                });
              }
            }
            audit.append({ op: "schedule.segment", session: session.id, found: segsOut.length });
            segmentationCache.set(session.id, { segments: segsOut.slice(0, 5), at: new Date().toISOString() });
            ws.send(JSON.stringify({ type: "schedule-segmented", sessionId: session.id, segments: segsOut.slice(0, 5) } satisfies ServerMsg));
          })();
          break;
        }

        case "schedule-distill": {
          // 从会话蒸馏定时任务：在原会话上跑提炼 prompt（上下文免费），只针对选定时间范围
          const session = live.get(msg.sessionId);
          if (!session || session.info().status !== "ready") {
            ws.send(JSON.stringify({ type: "error", sessionId: msg.sessionId, message: "会话未在运行或未就绪（先恢复会话）" } satisfies ServerMsg));
            break;
          }
          const from = msg.fromTs ? new Date(msg.fromTs).toLocaleString("zh-CN") : "会话开始";
          const to = msg.toTs ? new Date(msg.toTs).toLocaleString("zh-CN") : "最近";
          const ASK = `【任务提炼】请只基于 ${from} 到 ${to} 之间的对话，提炼一个可定时重复执行的任务。只输出一个 JSON 对象（可放在 \`\`\`json 围栏里），不要多余解释：
{
  "name": "任务名（12 字内）",
  "prompt": "自包含的任务指令：脱离本对话也能独立执行。包含必要背景与步骤；引用文件用相对路径；需要日期的地方写 {{date}} 占位符（运行时自动替换为当天）；规定固定输出格式",
  "outputFile": "每次运行的产物文件路径（含 {{date}} 占位符；没有固定产物填 null）",
  "cadence": {"type": "daily", "at": "HH:MM"} 或 {"type": "weekly", "days": [1,2,3,4,5], "at": "HH:MM"} 或 {"type": "interval", "everyMinutes": 数字},
  "reason": "建议该频率的一句理由"
}`;
          void (async () => {
            const r = await session.promptAndWait(ASK, 180_000);
            let parsed = parseDistilled(r.text);
            if (!parsed) {
              audit.append({ op: "schedule.distill.reask", session: session.id });
              const r2 = await session.promptAndWait("上一条没有给出合法 JSON。请立即只输出那个 JSON 对象，不要任何其他文字。", 60_000);
              parsed = parseDistilled(r2.text);
            }
            if (!parsed) {
              ws.send(JSON.stringify({ type: "error", sessionId: session.id, message: "蒸馏失败：模型未能给出结构化结果（表单将以会话信息兜底填充）" } satisfies ServerMsg));
              ws.send(JSON.stringify({ type: "schedule-distilled", sessionId: session.id, spec: {} } satisfies ServerMsg));
              return;
            }
            // 规范化 cadence
            const c = parsed.cadence as Record<string, unknown> | undefined;
            const cadence = c && typeof c.type === "string"
              ? (c.type === "interval"
                  ? { type: "interval" as const, everyMinutes: Number(c.everyMinutes) || 60 }
                  : c.type === "weekly"
                    ? { type: "weekly" as const, days: Array.isArray(c.days) ? c.days.map(Number) : [1, 2, 3, 4, 5], at: String(c.at || "09:00") }
                    : { type: "daily" as const, at: String(c.at || "09:00") })
              : undefined;
            const spec = {
              name: typeof parsed.name === "string" ? parsed.name : undefined,
              prompt: typeof parsed.prompt === "string" ? parsed.prompt : undefined,
              outputFile: typeof parsed.outputFile === "string" && parsed.outputFile !== "null" ? parsed.outputFile : undefined,
              cadence,
              reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
            };
            audit.append({ op: "schedule.distill", session: session.id, name: spec.name ?? "" });
            ws.send(JSON.stringify({ type: "schedule-distilled", sessionId: session.id, spec } satisfies ServerMsg));
          })();
          break;
        }

        case "schedule-run": {
          const s = schedules.find((x) => x.id === msg.id);
          if (!s) {
            ws.send(JSON.stringify({ type: "error", message: "找不到该定时任务" } satisfies ServerMsg));
            break;
          }
          void runSchedule(s);
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

  ws.on("close", () => {
    sockets.delete(ws);
    const vl = voiceLives.get(ws);
    if (vl) {
      voiceLives.delete(ws);
      void vl.stop();   // 客户端消失也要还原模型配置
    }
  });
});

function lanAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return "localhost";
}


/** 从蒸馏回复里抠 JSON 对象（容忍围栏与前后废话） */
function parseDistilled(text: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  for (const f of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(f[1] ?? "");
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const o = JSON.parse(c.trim());
      if (o && typeof o === "object" && !Array.isArray(o)) return o as Record<string, unknown>;
    } catch { /* 下一个 */ }
  }
  return null;
}

/* ---------- 定时任务：状态、执行器与 tick ---------- */

let schedules: Schedule[] = loadSchedules(SCHEDULES_FILE);
const segmentationCache = new Map<string, { segments: Array<{ head: string; fromTs: string; toTs: string; turns: number; score: number }>; at: string }>();
// 恢复时校正 nextFireAt（文件里的时刻可能已过）
for (const s of schedules) if (s.enabled && !s.state.running) s.state.nextFireAt = nextFire(s.cadence, s.window)?.toISOString();

function saveAndBroadcastSchedules(): void {
  saveSchedules(SCHEDULES_FILE, schedules);
  broadcast({ type: "schedules", schedules } as never);
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
function fillTemplate(tpl: string): string {
  const d = new Date();
  const vars: Record<string, string> = {
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
    weekday: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()] ?? "",
  };
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");
}

const compileCronCheck = compileCron;
const SCHEDULE_MAX_SILENCE_MS = Number(process.env.HG_SCHEDULE_TURN_TIMEOUT_MS ?? 30 * 60_000);

async function runSchedule(s: Schedule): Promise<void> {
  if (s.state.running) { s.state.lastStatus = "skipped-running"; return; }
  s.state.running = true;
  saveAndBroadcastSchedules();
  const cwd = s.cwd?.trim() || join(AUTO_WORKSPACE_ROOT, s.id);
  const vars = fillTemplate;
  let session: HarnessSession | undefined;
  try {
    try { mkdirSync(cwd, { recursive: true }); } catch { /* 已存在 */ }
    // 前置预检：契约要求的文件必须存在且非空
    for (const req of s.contract?.requires ?? []) {
      const p = join(cwd, req);
      if (!existsSync(p) || statSync(p).size === 0) throw new Error(`缺少前置文件: ${req}`);
    }
    // 会话：dedicated → 复用/复活；fresh → 新建
    if (s.sessionMode === "dedicated" && s.state.lastSessionId) {
      if (!live.has(s.state.lastSessionId)) reviveSession(s.state.lastSessionId);
      session = live.get(s.state.lastSessionId);
    }
    if (!session) {
      const spec = specOf(s.harnessId);
      if (!spec) throw new Error(`未知 harness: ${s.harnessId}`);
      const record = HarnessSession.newRecord(spec, cwd);
      session = new HarnessSession(spec, record, audit, makeHooks(), hub);
      live.set(session.id, session);
      store.upsert(session.record());
      broadcast({ type: "session", session: session.info() });
      void session.start("new");
    }
    s.state.lastSessionId = session.id;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && session.info().status === "starting") {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (session.info().status !== "ready") throw new Error(`会话未就绪（${session.info().status}）`);
    if (s.autoApprove) session.setAutoApprove(s.autoApprove);

    const r = await session.promptAndWait(vars(s.promptTemplate), SCHEDULE_MAX_SILENCE_MS);
    if (r.stopReason === "timeout") throw new Error("回合静默超时");
    // 产物验收：契约声明的输出文件必须存在且非空
    if (s.contract?.outputFile) {
      const out = vars(s.contract.outputFile);
      const p = join(cwd, out);
      if (!existsSync(p) || statSync(p).size === 0) throw new Error(`契约未满足：产物 ${out} 未生成`);
    }
    s.state.lastStatus = "ok";
    s.state.consecutiveFailures = 0;
    s.state.lastError = undefined;
    audit.append({ op: "schedule.run", schedule: s.id, status: "ok", session: session.id, chars: r.text.length });
    console.log(`[schedule] ${s.name || s.id}: 完成（${r.text.length} 字）`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    s.state.lastStatus = "error";
    s.state.lastError = message;
    s.state.consecutiveFailures = (s.state.consecutiveFailures ?? 0) + 1;
    let extra = "";
    if ((s.state.consecutiveFailures ?? 0) >= 3) {
      s.enabled = false;
      extra = "；连续失败 3 次，已自动暂停（修复后在定时面板重新启用）";
    }
    audit.append({ op: "schedule.run", schedule: s.id, status: "error", error: message });
    console.error(`[schedule] ${s.name || s.id}: ${message}${extra}`);
  } finally {
    s.state.running = false;
    s.state.lastRunAt = new Date().toISOString();
    s.state.nextFireAt = nextFire(s.cadence, s.window)?.toISOString();
    saveAndBroadcastSchedules();
  }
}

// tick：每 30 秒扫描到期的定时任务
setInterval(() => {
  let changed = false;
  for (const s of schedules) {
    if (!s.enabled || s.state.running) continue;
    if (!s.state.nextFireAt) {
      s.state.nextFireAt = nextFire(s.cadence, s.window)?.toISOString();
      changed = true;
      continue;
    }
    if (new Date(s.state.nextFireAt).getTime() <= Date.now()) {
      changed = true;
      void runSchedule(s);
    }
  }
  if (changed) saveAndBroadcastSchedules();
}, 30_000).unref?.();

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

/**
 * dsh-harnessgate — HarnessGate 会话网关的 DeepSeek Harness (dsh) 插件。
 *
 * 两个面：
 *  1. /harnessgate 命令族（dsh-commands）：状态概览 / 会话列表 / 面板入口，
 *     结果只进 UI 不进模型历史（commands 注册表的天生语义）。
 *  2. 面板（dsh-host-webserver 精确路由）：整页 iframe 嵌 HG 自带的 web UI
 *     （静态单页 + WS，?token= 直过认证门；HG 服务端不设 frame 限制）。
 *
 * 连接：全局 WebSocket（Node ≥21）连 HG 的 /ws，收 hello 维护会话快照，
 * 断线 5s 重连。不做代理、不做存储——dsh 侧永远是薄客户端，真相在 HG。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import z from "@deepseek-ai/schemastery";

/** Stable Cordis plugin name. */
export const name = "harnessgate";

/** webServer：面板路由；commands：/harnessgate 命令族。（0.2.1-rc.2 里服务名是 webServer——rc.1 文档写的 httpServer 已改名） */
export const inject = ["webServer", "commands"];

export const Config = z.object({
  url: z.string().default("http://127.0.0.1:9830").description("HarnessGate 服务器地址"),
  token: z.string().default("").description("访问 token（留空则读 tokenFile）"),
  tokenFile: z.string().default("~/.harnessgate/token").description("HG token 文件路径"),
  panelPath: z.string().default("/harnessgate").description("面板挂载路径（dsh webserver 上的路由）"),
  listLimit: z.number().default(15).description("/harnessgate list 最多列出的会话数"),
});

const readTokenFile = (p) => {
  const file = p.replace(/^~/, homedir());
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
};

/** 面板整页：顶栏（标题 + 外链 + 连接点）+ 全幅 iframe。iframe 失联时浏览器自然显示 HG 的离线态。 */
const panelPage = (base, panelPath, token) => `<!doctype html>
<html lang="zh"><head><meta charset="utf-8" />
<title>HarnessGate</title>
<style>
  html, body { margin: 0; height: 100%; }
  body { display: flex; flex-direction: column; font: 13px/1.4 system-ui, sans-serif; }
  .bar { display: flex; align-items: center; gap: 10px; padding: 6px 12px;
    border-bottom: 1px solid #2a2f3a; background: #14171f; color: #cbd2e0; flex: none; }
  .bar b { font-size: 13px; }
  .bar a { color: #7ab0ff; text-decoration: none; margin-left: auto; font-size: 12px; }
  iframe { flex: 1; width: 100%; border: 0; }
</style></head><body>
  <div class="bar"><b>🛡 HarnessGate</b><span>跨 harness 会话网关</span>
    <a href="${base}/?token=${encodeURIComponent(token)}" target="_blank" rel="noopener">在新标签打开 ↗</a></div>
  <iframe src="${base}/?token=${encodeURIComponent(token)}" title="HarnessGate"></iframe>
</body></html>`;

export function apply(ctx, config) {
  const base = config.url.replace(/\/+$/, "");
  const token = config.token || readTokenFile(config.tokenFile);
  const wsUrl = `${base.replace(/^http/, "ws")}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`;

  /* ── HG 连接与会话快照（hello 建底，session/deleted 增量维护） ─────────── */
  const state = { connected: false, harnesses: 0, sessions: [] };
  let ws = null;
  let retry = null;
  let stopped = false;

  const onMessage = (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.type === "hello") {
      state.connected = true;
      state.harnesses = (m.harnesses ?? []).length;
      state.sessions = m.sessions ?? [];
    } else if (m.type === "session") {
      const i = state.sessions.findIndex((s) => s.id === m.session?.id);
      if (i >= 0) state.sessions[i] = m.session;
      else state.sessions.unshift(m.session);
    } else if (m.type === "deleted") {
      state.sessions = state.sessions.filter((s) => s.id !== m.sessionId);
    }
  };

  const connect = () => {
    if (stopped) return;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      scheduleRetry();
      return;
    }
    ws.onopen = () => ws.send(JSON.stringify({ type: "list" }));
    ws.onmessage = (ev) => {
      /* Node 的 undici WebSocket 文本帧是 Blob，浏览器侧是 string——两头都接 */
      if (typeof ev.data === "string") onMessage(ev.data);
      else void ev.data.text().then(onMessage, () => {});
    };
    ws.onclose = () => {
      state.connected = false;
      scheduleRetry();
    };
    ws.onerror = () => {};
  };
  const scheduleRetry = () => {
    if (stopped || retry) return;
    retry = setTimeout(() => {
      retry = null;
      connect();
    }, 5000);
  };
  connect();
  ctx.on("dispose", () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    try {
      ws?.close();
    } catch {}
  });

  /* ── 面板：webserver 精确路由 → 整页 iframe（见 panelPage） ────────────── */
  const page = panelPage(base, config.panelPath, token);
  ctx.webServer.register({
    kind: "exact",
    path: config.panelPath,
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(page);
    },
  });
  const panelUrl = () => `http://127.0.0.1:${String(ctx.webServer.port)}${config.panelPath}`;

  /* ── /harnessgate 命令族：结果只进 UI，不进模型上下文 ─────────────────── */
  ctx.commands.register({
    name: "harnessgate",
    description: "HarnessGate 会话网关：跨 harness 统一管理会话（状态/列表/面板）",
    input: { hint: "[list|panel]（留空 = 状态概览）" },
    handler: ({ rawInput }) => {
      const arg = rawInput.trim().toLowerCase();
      if (arg === "list") {
        if (!state.connected) return { kind: "error", text: `未连接 HarnessGate（${base}）——确认服务在跑且 token 正确` };
        if (!state.sessions.length) return { kind: "success", text: "HarnessGate 里还没有会话" };
        const lines = state.sessions.slice(0, config.listLimit).map((s, i) => {
          const label = s.harnessLabel ?? s.harnessId ?? "?";
          const live = s.live || s.inTurn ? " · 在跑" : "";
          return `${String(i + 1)}. [${label}] ${s.title ?? s.id}${live}`;
        });
        const more = state.sessions.length > config.listLimit ? `\n…共 ${String(state.sessions.length)} 个（面板看全量）` : "";
        return { kind: "success", text: `HarnessGate 会话：\n${lines.join("\n")}${more}` };
      }
      if (arg === "panel" || arg === "open") return { kind: "success", text: panelUrl() };
      const conn = state.connected ? "已连接" : "未连接（5s 自动重试）";
      return {
        kind: "success",
        text: `HarnessGate ${conn} · ${String(state.harnesses)} 个 harness · ${String(state.sessions.length)} 个会话\n面板：${panelUrl()}\n/harnessgate list 看会话，/harnessgate panel 只要链接`,
      };
    },
  });
}

import * as vscode from "vscode";
import { GateClient } from "./client.ts";
import { Store } from "./store.ts";
import { HarnessTreeProvider } from "./tree.ts";
import { ChatPanel } from "./chat.ts";
import { RoomPanel } from "./room-panel.ts";
import { promptCwd } from "./cwd-input.ts";
import type { HarnessAvailability, Room, SessionInfo } from "./protocol.ts";

let output: vscode.OutputChannel;
let client: GateClient;
const store = new Store();

/** 供测试与外部集成使用的公开面（VS Code 会把 activate 的返回值放到 extension.exports） */
export type HarnessGateApi = {
  store: Store;
  client: GateClient;
  state: () => string;
  openChat: (sessionId: string) => void;
  createSession: (harnessId: string, cwd: string) => Promise<SessionInfo | undefined>;
  /** 对话面板的渲染回执（大会话加载回归用）；面板没开过或 webview 还没渲染完则 undefined */
  chatRenderInfo: (sessionId: string) => { count: number; start: number; total: number; ms: number } | undefined;
  /** 圆桌面板的渲染回执 */
  roomsRenderInfo: () => { rooms: number; ms: number } | undefined;
};

export function activate(context: vscode.ExtensionContext): HarnessGateApi {
  output = vscode.window.createOutputChannel("HarnessGate");
  const cfg = () => vscode.workspace.getConfiguration("harnessgate");
  client = new GateClient(
    () => cfg().get<string>("url") ?? "ws://127.0.0.1:9830/ws",
    () => cfg().get<string>("token") ?? "",
    (line) => output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`),
  );

  const tree = new HarnessTreeProvider(store, () => client.getState());
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("harnessgate.harnesses", tree),
    vscode.commands.registerCommand("harnessgate.collapseAll", () => tree.collapseAll()),
    vscode.commands.registerCommand("harnessgate.expandAll", () => tree.expandAll()),
    vscode.commands.registerCommand("harnessgate.connect", () => {
      client.connect();
      output.show(true);
    }),
    vscode.commands.registerCommand("harnessgate.refresh", () => {
      if (!client.send({ type: "list" })) client.connect();
      tree.refresh();
    }),
    vscode.commands.registerCommand("harnessgate.showLog", () => output.show(true)),
    vscode.commands.registerCommand("harnessgate.syncHistory", async () => {
      if (!client.send({ type: "sync-history" })) {
        void vscode.window.showWarningMessage("未连接 HarnessGate 服务");
        return;
      }
      void vscode.window.setStatusBarMessage("HarnessGate: 正在同步历史会话…", 4000);
    }),
    vscode.commands.registerCommand("harnessgate.newSession", () => newSession()),
    vscode.commands.registerCommand("harnessgate.openInBrowser", async () => {
      // 工作区面板等网页版独有功能；圆桌已有原生面板（harnessgate.rooms）
      const cfg = vscode.workspace.getConfiguration("harnessgate");
      const wsUrl = String(cfg.get("url") ?? "ws://127.0.0.1:9830/ws");
      const httpUrl = wsUrl.replace(/^ws(s?):\/\//, "http$1://").replace(/\/ws\/?$/, "").replace(/\/$/, "");
      const withToken = String(cfg.get("token") ?? "");
      void vscode.env.openExternal(vscode.Uri.parse(withToken ? `${httpUrl}/?token=${encodeURIComponent(withToken)}` : httpUrl));
    }),
    vscode.commands.registerCommand("harnessgate.configServer", async () => {
      const cfg = vscode.workspace.getConfiguration("harnessgate");
      const url = await vscode.window.showInputBox({
        title: "HarnessGate 服务地址",
        value: cfg.get<string>("url") ?? "ws://127.0.0.1:9830/ws",
        prompt: "HarnessGate 跑在哪台机器就填哪台：ws://IP:9830/ws。本机转发/局域网/公网（建议 wss 或 Tailscale）都是这个格式",
        placeHolder: "ws://192.168.1.100:9830/ws",
        validateInput: (v) => (/^wss?:\/\/\S+/.test(v.trim()) ? undefined : "需要 ws:// 或 wss:// 开头，例如 ws://192.168.1.100:9830/ws"),
        ignoreFocusOut: true,
      });
      if (url === undefined) return;
      const token = await vscode.window.showInputBox({
        title: "访问 token（可选）",
        value: cfg.get<string>("token") ?? "",
        prompt: "服务端开了认证（HG_AUTH=on）时必填，内容见服务器上的 ~/.harnessgate/token；没开认证直接回车",
        password: true,
        ignoreFocusOut: true,
      });
      if (token === undefined) return;
      await cfg.update("url", url.trim(), vscode.ConfigurationTarget.Global);
      await cfg.update("token", token.trim(), vscode.ConfigurationTarget.Global);
      void vscode.window.setStatusBarMessage(`HarnessGate: 已保存 ${url.trim()}`, 4000);
      // 配置没变化时 onDidChangeConfiguration 不会触发，手动兜底重连
      client.connect();
    }),
    vscode.commands.registerCommand("harnessgate.rooms", () => {
      RoomPanel.show(client, store, (l) => output.appendLine(l));
    }),
    vscode.commands.registerCommand("harnessgate.openChat", (arg?: string | { session?: SessionInfo; id?: string }) => {
      // 树行点击传的是 id 字符串；内联按钮/右键菜单（view/item/context）传的是树节点对象——两种都要接
      const id = typeof arg === "string" ? arg : (arg?.session?.id ?? arg?.id);
      if (id) ChatPanel.show(String(id), client, store, (l) => output.appendLine(l));
      else void vscode.window.showWarningMessage("请从侧栏的会话上打开对话");
    }),
    vscode.commands.registerCommand("harnessgate.resumeSession", (node?: { session?: SessionInfo; id?: string }) => {
      const id = node?.session?.id ?? node?.id;
      if (id) client.send({ type: "resume", sessionId: id });
    }),
    vscode.commands.registerCommand("harnessgate.stopSession", (node?: { session?: SessionInfo; id?: string }) => {
      const id = node?.session?.id ?? node?.id;
      if (id) client.send({ type: "close", sessionId: id });
    }),
    vscode.commands.registerCommand("harnessgate.deleteSession", async (node?: { session?: SessionInfo; id?: string }) => {
      const id = node?.session?.id ?? node?.id;
      if (!id) return;
      const s = store.getSession(id);
      const pick = await vscode.window.showWarningMessage(
        `删除会话「${s?.title || "#" + id}」？（服务器上的会话记录会被删除）`,
        { modal: true },
        "删除",
      );
      if (pick === "删除") client.send({ type: "delete", sessionId: id });
    }),
  );

  let errNotified = false;   // 重试循环里别反复弹窗，一个会话最多提示一次（连上后复位）
  client.on("state", (s: string) => {
    tree.refresh();
    if (s === "error") {
      const err = client.getLastError() ?? "未知错误";
      output.appendLine(`连接失败: ${err}`);
      if (!errNotified) {
        errNotified = true;
        void vscode.window
          .showWarningMessage(`HarnessGate 连不上：${err}`, "配置服务器地址", "重试连接")
          .then((pick) => {
            if (pick === "配置服务器地址") void vscode.commands.executeCommand("harnessgate.configServer");
            else if (pick === "重试连接") client.connect();
          });
      }
    }
    if (s === "connected") errNotified = false;
  });
  client.on("hello", (msg: { harnesses: HarnessAvailability[]; sessions: SessionInfo[]; defaultCwd: string; rooms?: Room[] }) => {
    store.setHello(msg.harnesses ?? [], msg.sessions ?? [], msg.defaultCwd ?? "", msg.rooms);
    output.appendLine(`已同步：${msg.harnesses?.length ?? 0} 个 harness，${msg.sessions?.length ?? 0} 个会话，${msg.rooms?.length ?? 0} 个圆桌`);
  });
  client.on("rooms", (msg: { rooms?: Room[] }) => {
    if (msg.rooms) store.setRooms(msg.rooms);
  });
  client.on("room", (msg: { room?: Room }) => {
    if (msg.room) store.upsertRoom(msg.room);
  });
  client.on("session", (msg: { session: SessionInfo }) => {
    if (msg.session) store.upsertSession(msg.session);
  });
  client.on("deleted", (msg: { sessionId: string }) => {
    if (msg.sessionId) store.removeSession(msg.sessionId);
  });
  client.on("error", (msg: { message?: string }) => {
    if (msg.message) void vscode.window.showErrorMessage(`HarnessGate: ${msg.message}`);
  });

  // 配置变了就重连（换服务器/换 token）
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("harnessgate.url") || e.affectsConfiguration("harnessgate.token")) {
        client.dispose();
        client.connect();
      }
    }),
  );

  client.connect();

  return {
    store,
    client,
    state: () => client.getState(),
    openChat: (sessionId: string) => ChatPanel.show(sessionId, client, store, (l) => output.appendLine(l)),
    chatRenderInfo: (sessionId: string) => ChatPanel.renderInfoOf(sessionId),
    roomsRenderInfo: () => RoomPanel.lastRenderInfo,
    createSession: async (harnessId: string, cwd: string) => {
      if (!client.send({ type: "create", harnessId, cwd })) return undefined;
      return waitForNewSession(harnessId, 30_000);
    },
  };
}

export function deactivate(): void {
  client?.dispose();
}

/** 新建会话：选 harness → 输工作目录（服务器上的路径，带补全提示）→ 创建并打开对话 */
async function newSession(): Promise<void> {
  if (client.getState() !== "connected") {
    void vscode.window.showWarningMessage("未连接 HarnessGate 服务，先执行「HarnessGate: 连接 / 重连服务」");
    return;
  }
  const usable = store.harnesses.filter((h) => h.available && !h.blocked);
  if (!usable.length) {
    void vscode.window.showWarningMessage("没有可用的 harness（在服务器上跑一次 npm run doctor -- --probe --deep）");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    usable.map((h) => ({
      label: h.label,
      description: h.state === "probed-ok" ? "探活通过" : "未探活",
      detail: h.note,
      id: h.id,
    })),
    { title: "选择 harness", placeHolder: "在新会话里用哪个 agent" },
  );
  if (!picked) return;

  const saved = vscode.workspace.getConfiguration("harnessgate").get<string>("defaultCwd") || "";
  const cwd = await promptCwd(client, saved || store.defaultCwd);
  if (cwd === undefined) return;

  if (!client.send({ type: "create", harnessId: picked.id, cwd })) {
    void vscode.window.showErrorMessage("发送失败：连接已断开");
    return;
  }
  // 等新会话出现（服务端建好后会推 session 消息）再打开对话
  const created = await waitForNewSession(picked.id, 30_000);
  if (created) ChatPanel.show(created.id, client, store, (l) => output.appendLine(l));
  else void vscode.window.showWarningMessage("会话创建超时，看看侧栏的会话列表");
}

/** 工作目录输入（带服务端目录补全）在 cwd-input.ts，与圆桌面板共用 */

async function waitForNewSession(harnessId: string, timeoutMs: number): Promise<SessionInfo | undefined> {
  const known = new Set(store.sessionsOf(harnessId).map((s) => s.id));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fresh = store.sessionsOf(harnessId).find((s) => !known.has(s.id));
    if (fresh) return fresh;
    await new Promise((r) => setTimeout(r, 300));
  }
  return undefined;
}

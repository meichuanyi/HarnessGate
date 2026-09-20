import * as vscode from "vscode";
import { GateClient } from "./client.ts";
import { Store } from "./store.ts";
import { HarnessTreeProvider } from "./tree.ts";
import { ChatPanel } from "./chat.ts";
import type { HarnessAvailability, SessionInfo } from "./protocol.ts";

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
      // 圆桌/工作队/工作区面板只在网页版有；把 ws://host:port/ws 换成 http://host:port 直接打开
      const cfg = vscode.workspace.getConfiguration("harnessgate");
      const wsUrl = String(cfg.get("url") ?? "ws://127.0.0.1:9830/ws");
      const httpUrl = wsUrl.replace(/^ws(s?):\/\//, "http$1://").replace(/\/ws\/?$/, "").replace(/\/$/, "");
      const withToken = String(cfg.get("token") ?? "");
      void vscode.env.openExternal(vscode.Uri.parse(withToken ? `${httpUrl}/?token=${encodeURIComponent(withToken)}` : httpUrl));
    }),
    vscode.commands.registerCommand("harnessgate.openChat", (sessionId?: string) => {
      if (sessionId) ChatPanel.show(sessionId, client, store, (l) => output.appendLine(l));
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

  client.on("state", (s: string) => {
    tree.refresh();
    if (s === "error") {
      const err = client.getLastError() ?? "未知错误";
      output.appendLine(`连接失败: ${err}`);
    }
  });
  client.on("hello", (msg: { harnesses: HarnessAvailability[]; sessions: SessionInfo[]; defaultCwd: string }) => {
    store.setHello(msg.harnesses ?? [], msg.sessions ?? [], msg.defaultCwd ?? "");
    output.appendLine(`已同步：${msg.harnesses?.length ?? 0} 个 harness，${msg.sessions?.length ?? 0} 个会话`);
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
  const cwd = await promptCwd(saved || store.defaultCwd);
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

/** 工作目录输入：服务器上的路径，支持边打边列目录（复用服务端的 dirs 补全） */
async function promptCwd(initial: string): Promise<string | undefined> {
  const input = vscode.window.createInputBox();
  input.title = "工作目录（服务器上的路径）";
  input.placeholder = "/path/on/server";
  input.value = initial;
  input.prompt = "输入片段会列出子目录；不存在的目录会在创建时自动建立";
  let reqId = "";
  const req = () => {
    reqId = Math.random().toString(36).slice(2);
    client.send({ type: "dirs", reqId, input: input.value.trim() });
  };
  const onDirs = (msg: { reqId: string; dir: string; exists: boolean; isDir: boolean; entries: Array<{ name: string; path: string; git: boolean }>; error?: string }) => {
    if (msg.reqId !== reqId) return;
    if (msg.error) input.prompt = `读不了这个目录：${msg.error}`;
    else if (!msg.exists) input.prompt = "目录不存在 · 回车将创建";
    else if (!msg.isDir) input.prompt = "这是文件，不是目录";
    else input.prompt = `${msg.entries.length} 个子目录 · 回车在该目录新建会话`;
  };
  client.on("dirs", onDirs);
  input.onDidChangeValue(() => {
    if (input.value.trim().length >= 1) req();
  });
  req();

  const result = await new Promise<string | undefined>((resolve) => {
    input.onDidAccept(() => resolve(input.value.trim()));
    input.onDidHide(() => resolve(undefined));
    input.show();
  });
  client.off("dirs", onDirs);
  input.dispose();
  return result;
}

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

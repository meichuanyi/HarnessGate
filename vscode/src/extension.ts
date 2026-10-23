import * as vscode from "vscode";
import { GateClient } from "./client.ts";
import { Store } from "./store.ts";
import { HarnessTreeProvider } from "./tree.ts";
import { ChatPanel, requestSessionDetail } from "./chat.ts";
import { RoomPanel } from "./room-panel.ts";
import { SchedulesPanel, WorkspacePanel, setSchedulesData, setWorkspaceData } from "./schedules-panel.ts";
import { SkillsPanel } from "./skills-panel.ts";
import { GoalsPanel, setGoalsData } from "./goals-panel.ts";
import { promptCwd } from "./cwd-input.ts";
import type { GoalView, HarnessAvailability, MindwtrTaskView, Room, SessionInfo } from "./protocol.ts";

let output: vscode.OutputChannel;
let client: GateClient;
const store = new Store();

/** 供测试与外部集成使用的公开面（VS Code 会把 activate 的返回值放到 extension.exports） */
export type HarnessGateApi = {
  store: Store;
  client: GateClient;
  state: () => string;
  openChat: (sessionId: string) => void;
  openGoals: () => void;
  createSession: (harnessId: string, cwd: string) => Promise<SessionInfo | undefined>;
  /** 对话面板的渲染回执（大会话加载回归用）；面板没开过或 webview 还没渲染完则 undefined */
  chatRenderInfo: (sessionId: string) => { count: number; start: number; total: number; ms: number } | undefined;
  /** 圆桌面板的渲染回执 */
  roomsRenderInfo: () => { rooms: number; ms: number } | undefined;
};

export function activate(context: vscode.ExtensionContext): HarnessGateApi {
  ChatPanel.extUri = context.extensionUri;   // Mermaid 等本地资源经 asWebviewUri 按需加载
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
    // 助理：ensure（无则创建，有则直达）；可指定 harnessId（换芯重建：记忆保留）
    vscode.commands.registerCommand("harnessgate.assistantEnsure", async (arg?: { harnessId?: string }) => {
      const asid = store.assistantSessionId;
      if (asid && !arg?.harnessId) {
        vscode.commands.executeCommand("harnessgate.openChat", asid);
        return;
      }
      const cur = asid ? store.getSession(asid)?.harnessId : "";
      const avail = store.harnesses.filter((h) => h.available);
      const picks = avail.map((h) => ({
        label: h.label,
        description: h.id === cur ? "当前" : h.id,
        hid: h.id,
      }));
      const picked = await vscode.window.showQuickPick(picks, {
        placeHolder: "选择助理的 harness（换芯重建：长期记忆和台账保留）",
      });
      if (!picked) return;
      client.send({ type: "assistant-ensure", harnessId: picked.hid });
      vscode.window.showInformationMessage(`正在把助理切到 ${picked.label}（记忆保留）…`);
    }),
    // 目标系统与生活运转看板
    vscode.commands.registerCommand("harnessgate.openGoals", () => {
      client.send({ type: "goals-get" });
      GoalsPanel.reveal(client, store);
    }),
    // 会话标签：编辑（逗号分隔）
    vscode.commands.registerCommand("harnessgate.editTags", async (node?: { session?: SessionInfo; id?: string }) => {
      const id = node?.session?.id ?? node?.id;
      if (!id) return;
      const s = store.getSession(id);
      const cur = (s?.tags ?? []).join(", ");
      const input = await vscode.window.showInputBox({
        prompt: "标签（逗号分隔，留空清空）",
        value: cur,
        placeHolder: "如: 重构, anki, 长期任务",
      });
      if (input === undefined) return;
      const tags = input.split(/[,，]/).map((t) => t.trim()).filter(Boolean).slice(0, 20);
      client.send({ type: "set-tags", sessionId: id, tags });
      if (s) {
        store.upsertSession({ ...s, tags });
      }
    }),
    // 收藏切换
    vscode.commands.registerCommand("harnessgate.toggleStar", (node?: { session?: SessionInfo; id?: string }) => {
      const id = node?.session?.id ?? node?.id;
      if (!id) return;
      const s = store.getSession(id);
      const v = !(s?.starred ?? false);
      client.send({ type: "star", sessionId: id, starred: v });
      if (s) store.upsertSession({ ...s, starred: v });
    }),
    // 📚 全量归档检索
    vscode.commands.registerCommand("harnessgate.archive", async (node?: { session?: SessionInfo; id?: string }) => {
      const id = node?.session?.id ?? node?.id;
      if (!id) return;
      const q = await vscode.window.showInputBox({ placeHolder: "关键词（空 = 最近 400 条）", title: "📚 全量归档检索 · 会话 #" + id });
      if (q === undefined) return;
      const lines: string[] = [];
      let total = 0;
      const onArchive = (m: any) => {
        if (m.sessionId !== id) return;
        total = m.total ?? 0;
        lines.length = 0;
        lines.push(...(m.lines ?? []));
      };
      client.on("archive-content", onArchive);
      client.send({ type: "archive", sessionId: id, q });
      // 等回包（最长 15s）
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300));
        if (lines.length || total) break;
      }
      client.off("archive-content", onArchive);
      if (!lines.length) {
        vscode.window.showInformationMessage(`归档无匹配（共 ${total} 条记录）`);
        return;
      }
      const pick = await vscode.window.showQuickPick(
        lines.map((l, i) => ({ label: l.slice(0, 120), detail: `第 ${i + 1} 条 / 共 ${total} 条命中`, line: l })),
        { placeHolder: `📚 归档命中 ${total} 条（选择复制该行）`, matchOnDetail: false },
      );
      if (pick) {
        await vscode.env.clipboard.writeText(pick.line);
        vscode.window.showInformationMessage("已复制该行到剪贴板");
      }
    }),

    // ❓ 侧问
    vscode.commands.registerCommand("harnessgate.sideQuestion", async (node?: { session?: SessionInfo; id?: string }) => {
      const id = node?.session?.id ?? node?.id;
      if (!id) return;
      const text = await vscode.window.showInputBox({
        placeHolder: "问点什么…（fork 当前上下文回答，不打断正在跑的会话）",
        title: "❓ 侧问 · 会话 #" + id,
      });
      if (!text?.trim()) return;
      // 先按源找回在跑的分身：有则直接追问（复用同一个，不另开）；没有才 fork 新的
      const existing = await new Promise<string | null>((resolve) => {
        const onFound = (m: { srcId?: string; sessionId?: string | null }) => {
          if (m.srcId !== id) return;
          cleanup();
          resolve(m.sessionId ?? null);
        };
        const cleanup = () => {
          clearTimeout(timer);
          client.off("side-found", onFound);
        };
        const timer = setTimeout(() => {
          cleanup();
          resolve(null);
        }, 3000);
        client.on("side-found", onFound);
        client.send({ type: "side-find", srcId: id });
      });
      if (existing) {
        client.send({ type: "prompt", sessionId: existing, text: text.trim() });
        vscode.commands.executeCommand("harnessgate.openChat", existing);
        return;
      }
      let sideId: string | null = null;
      const onSide = (m: any) => {
        if (m.srcId === id) {
          sideId = m.sessionId as string;
          client.off("side-created", onSide);
          // 在聊天面板中直接打开分身（完整流式回答）
          vscode.commands.executeCommand("harnessgate.openChat", sideId);
        }
      };
      client.on("side-created", onSide);
      client.send({ type: "side-question", sessionId: id, text: text.trim() });
      setTimeout(() => client.off("side-created", onSide), 120_000);
    }),

    // ⎇ 分支（fork 当前上下文开新会话，建好直接进入）
    vscode.commands.registerCommand("harnessgate.branchSession", async (node?: { session?: SessionInfo; id?: string }) => {
      const id = node?.session?.id ?? node?.id;
      if (!id) return;
      const name = await vscode.window.showInputBox({
        placeHolder: "分支名（可留空）",
        title: `⎇ 分支 · 会话 #${id}`,
        validateInput: (v) => (v.length > 20 ? "最长 20 字" : undefined),
      });
      if (name === undefined) return;
      client.send({ type: "branch", sessionId: id, branchName: name.trim() || undefined });
    }),

    // ⇱ 收编回主线（仅分支会话：结论蒸馏注入主线后分支删除）
    vscode.commands.registerCommand("harnessgate.adoptBranch", async (node?: { session?: SessionInfo; id?: string }) => {
      const id = node?.session?.id ?? node?.id;
      if (!id) return;
      const parentId = node?.session?.parentId ?? store.getSession(id)?.parentId;
      if (!parentId) {
        vscode.window.showInformationMessage("这个会话不是分支（没有父会话），无需收编");
        return;
      }
      const pick = await vscode.window.showWarningMessage(
        "⇱ 收编回主线？",
        { modal: true, detail: "分支的结论会被蒸馏后注入主线，随后本分支删除（完整历史仍在归档）。" },
        "收编",
      );
      if (pick === "收编") client.send({ type: "adopt-branch", branchId: id, mainId: parentId });
    }),

    // ⇄ 接续（带最近历史接到新会话，完整历史落快照文件）
    vscode.commands.registerCommand("harnessgate.handoffSession", async (node?: { session?: SessionInfo; id?: string }) => {
      const id = node?.session?.id ?? node?.id;
      if (!id) return;
      const list = store.harnesses;
      if (!list.length) {
        vscode.window.showWarningMessage("没有可用的 harness");
        return;
      }
      const pick = await vscode.window.showQuickPick(
        list.map((h) => ({ label: h.label, description: h.available ? h.version ?? "" : "（不可用）", id: h.id })),
        { placeHolder: "接续到哪个 harness？最近历史作为背景注入，完整历史落快照文件" },
      );
      if (!pick) return;
      client.send({ type: "handoff", sessionId: id, targetHarnessId: pick.id });
    }),

    // 🧾 决策与改动（授权决策记录 + 改动文件）
    vscode.commands.registerCommand("harnessgate.sessionDetail", (node?: { session?: SessionInfo; id?: string }) => {
      const id = node?.session?.id ?? node?.id;
      if (!id) return;
      requestSessionDetail(client, id);
    }),

    // Harness 版本管理（安装/升级）
    vscode.commands.registerCommand("harnessgate.harnessManage", async (node?: { harness?: { id?: string } }) => {
      const candidates = store.harnesses.filter((h) => h.manageSupported);
      if (!candidates.length) {
        vscode.window.showInformationMessage("没有可管理的 harness（服务端 manage 未声明）");
        return;
      }
      const pick = await vscode.window.showQuickPick(
        candidates.map((h) => ({
          label: `${h.label}  ${h.installedVersion ?? "未安装"}${h.latestVersion ? ` → v${h.latestVersion}` : ""}`,
          harnessId: h.id,
          action: h.installedVersion ? ("update" as const) : ("install" as const),
        })),
        { placeHolder: "选择要安装/升级的 harness（走服务端 manage 白名单）" },
      );
      if (!pick) return;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Harness ${pick.action === "install" ? "安装" : "升级"}中…（可能需要数分钟）` },
        async () => {
          await new Promise<void>((resolve) => {
            const onManaged = (m: any) => {
              if (m.harnessId !== pick.harnessId) return;
              client.off("harness-managed", onManaged);
              resolve();
              if (m.ok) vscode.window.showInformationMessage(`✅ ${m.action === "install" ? "安装" : "升级"}完成${m.to ? `：v${m.to}` : ""}（新会话生效）`);
              else vscode.window.showErrorMessage(`❌ 管理失败：${String(m.output ?? "未知错误").slice(-160)}`);
            };
            client.on("harness-managed", onManaged);
            client.send({ type: "harness-manage", harnessId: pick.harnessId, action: pick.action });
          });
        },
      );
    }),

    // 过滤：选标签或手动输入
    vscode.commands.registerCommand("harnessgate.filterSessions", async () => {
      const counts = [...store.tagCounts().entries()].sort((a, b) => b[1] - a[1]);
      const picks: Array<vscode.QuickPickItem & { tag?: string }> = [
        { label: "（清除过滤）", tag: "", alwaysShow: true },
        ...counts.map(([t, n]) => ({ label: t, description: `${n} 个会话`, tag: t })),
        { label: "$(search) 手动输入…", alwaysShow: true },
      ];
      const picked = await vscode.window.showQuickPick(picks, { placeHolder: `按标签过滤会话（当前：${store.filterText || "无"}）` });
      if (!picked) return;
      if (picked.label.includes("手动输入")) {
        const input = await vscode.window.showInputBox({ prompt: "过滤词（标题/目录/标签）", value: store.filterText });
        if (input === undefined) return;
        store.filterText = input;
      } else {
        store.filterText = picked.tag ?? "";
      }
      tree.refresh();
    }),
    // 定时任务面板
    vscode.commands.registerCommand("harnessgate.schedules", () => {
      client.send({ type: "schedules-list" });
      SchedulesPanel.reveal().attach(client, store);
    }),
    // 工作区归因面板
    vscode.commands.registerCommand("harnessgate.workspace", () => {
      client.send({ type: "workspace" });
      WorkspacePanel.reveal().attach(client, store);
    }),
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
    vscode.commands.registerCommand("harnessgate.skillsMcp", () => {
      SkillsPanel.show(client, store, (l) => output.appendLine(l));
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
  client.on("hello", (msg: {
    harnesses: HarnessAvailability[];
    sessions: SessionInfo[];
    defaultCwd: string;
    rooms?: Room[];
    schedules?: import("./protocol.ts").Schedule[];
    assistantSessionId?: string | null;
    mcpServers?: import("./protocol.ts").McpServerInfo[];
    skills?: import("./protocol.ts").SkillsSnapshotView;
  }) => {
    store.setHello(msg.harnesses ?? [], msg.sessions ?? [], msg.defaultCwd ?? "", msg.rooms, msg.schedules, msg.assistantSessionId, msg.mcpServers, msg.skills);
    if (msg.schedules) setSchedulesData(msg.schedules);
    output.appendLine(
      `已同步：${msg.harnesses?.length ?? 0} 个 harness，${msg.sessions?.length ?? 0} 个会话，${msg.rooms?.length ?? 0} 个圆桌，${msg.schedules?.length ?? 0} 个定时任务`,
    );
  });
  client.on("schedules", (msg: { schedules?: import("./protocol.ts").Schedule[] }) => {
    if (msg.schedules) {
      store.setSchedules(msg.schedules);
      setSchedulesData(msg.schedules);
    }
  });
  client.on("goals", (msg: { goals?: GoalView[]; lifeTasks?: MindwtrTaskView[] }) => {
    if (msg.goals) {
      store.setGoals(msg.goals, msg.lifeTasks);
      setGoalsData(msg.goals, msg.lifeTasks ?? []);
    }
  });
  client.on("workspace", (msg: { reports?: import("./protocol.ts").WorkspaceReport[] }) => {
    if (msg.reports) {
      store.setWorkspaceReports(msg.reports);
      setWorkspaceData(msg.reports);
    }
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
  // 分支建好直接进新分支（只发给请求方）；收编完成提示蒸馏摘要（广播）；接续完成跳新会话（只发给请求方）
  client.on("branch-created", (msg: { from: string; to: string }) => {
    if (msg.to) void vscode.commands.executeCommand("harnessgate.openChat", msg.to);
  });
  client.on("branch-adopted", (msg: { branchId: string; mainId: string; summary?: string }) => {
    void vscode.window.showInformationMessage(`⇱ 已收编回主线：${(msg.summary ?? "").slice(0, 200) || "（无摘要）"}`);
  });
  client.on("handoff_done", (msg: { from: string; to: string }) => {
    if (msg.to) void vscode.commands.executeCommand("harnessgate.openChat", msg.to);
  });
  // MCP/技能全量推送（保存/删除/挂载后服务端广播）：入库并让管理面板即时刷新
  client.on("mcp", (msg: { servers?: import("./protocol.ts").McpServerInfo[] }) => {
    if (msg.servers) store.setMcpServers(msg.servers);
  });
  client.on("skills", (msg: { library?: import("./protocol.ts").SkillMetaView[]; mounts?: import("./protocol.ts").SkillsSnapshotView["mounts"] }) => {
    if (msg.library) store.setSkills({ library: msg.library, mounts: msg.mounts ?? [] });
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
    openGoals: () => GoalsPanel.reveal(client, store),
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

  // MCP 选择（可多选、可跳过）：只列「新建会话默认勾选」的启用项
  const mcpPick = await new Promise<string[] | undefined>((resolve) => {
    const qp = vscode.window.createQuickPick();
    qp.title = "挂载 MCP 服务器（空格勾选 / 回车确认，Esc 跳过）";
    qp.canSelectMany = true;
    qp.matchOnDescription = true;
    qp.items = store.mcpServers
      .filter((x) => x.enabled !== false)
      .map((x) => ({
        label: x.name,
        description: x.type === "stdio" ? [x.command, ...(x.args ?? [])].filter(Boolean).join(" ") : x.url ?? "",
      }));
    let done = false;
    const finish = (ids: string[] | undefined) => {
      if (done) return;
      done = true;
      resolve(ids);
      qp.dispose();
    };
    qp.onDidAccept(() => finish(qp.selectedItems.map((i) => (i as { id?: string }).id ?? i.label)));
    qp.onDidHide(() => finish(undefined));
    qp.show();
  });
  if (mcpPick === undefined) return;   // Esc：放弃新建

  if (!client.send({ type: "create", harnessId: picked.id, cwd, mcpServerIds: mcpPick })) {
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

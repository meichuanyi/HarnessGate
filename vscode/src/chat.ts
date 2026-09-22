import * as vscode from "vscode";
import type { GateClient } from "./client.ts";
import type { Store } from "./store.ts";
import type { PermissionOption, SessionInfo, TranscriptEntry } from "./protocol.ts";
import { mdToHtml, esc } from "./markdown.ts";
import { RENDERER_SOURCE } from "./generated/renderer-source.ts";

const STATUS_LABEL: Record<string, string> = {
  starting: "启动中",
  ready: "运行中",
  awaiting: "待审批",
  saved: "已归档",
  error: "错误",
  stopped: "已停止",
};

type Entry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; title: string; status: string; toolCallId?: string; detail?: string }
  | { kind: "permission"; title: string; answered?: string; requestId?: string; options?: PermissionOption[]; auto?: boolean }
  | { kind: "error"; message: string }
  | { kind: "log"; text: string };

/**
 * 对话面板（Webview）：流式输出、Markdown、工具时间线、授权按钮、模型/模式下拉。
 * 每个会话一个面板；agent 在服务器上跑，这里只是显示与发指令。
 */
export class ChatPanel {
  static readonly viewType = "harnessgate.chat";
  private static panels = new Map<string, ChatPanel>();
  /** 渲染回执（webview 处理完 render 后回报），测试/诊断用：卡在「加载中」时它不会出现 */
  static renderInfoOf(sessionId: string): { count: number; start: number; total: number; ms: number } | undefined {
    return ChatPanel.panels.get(sessionId)?.renderInfo;
  }

  private disposables: vscode.Disposable[] = [];
  private entries: Entry[] = [];
  private transcriptBase = 0;
  private streaming = false;
  private showLog = false;
  private pendingText = "";
  private ready = false;
  /** 大会话（实测 800 条 / 1.2MB）全量塞 webview 会卡死在「加载中」：
      首屏只发窗口内条目，向上翻页加载；流式期间的条目更新走增量 upsert。 */
  private window = 100;
  private renderInfo?: { count: number; start: number; total: number; ms: number };

  private readonly onServerMsg = (msg: Record<string, unknown>): void => this.onServer(msg);
  /** 最近一次 session 广播的快照：header 直接用它，不依赖 store 的更新时序
      （client 先发 message 事件再发 session 事件，走 store 会永远读到上一拍的旧状态——
      表现为「打断」按钮不及时出现/消失、模式下拉显示旧值） */
  private latestSession?: SessionInfo;

  private constructor(
    private readonly sessionId: string,
    private readonly panel: vscode.WebviewPanel,
    private readonly client: GateClient,
    private readonly store: Store,
    private readonly log: (line: string) => void,
  ) {
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m: Record<string, unknown>) => this.onMessage(m), null, this.disposables);
    this.client.on("message", this.onServerMsg);
    const s = store.getSession(sessionId);
    this.log(`面板打开 #${sessionId}（status=${s?.status ?? "?"} live=${s?.live} resumable=${s?.resumable}）`);
  }

  static show(sessionId: string, client: GateClient, store: Store, log: (line: string) => void): ChatPanel | undefined {
    if (typeof sessionId !== "string" || !sessionId) {
      log(`面板打开被拒：sessionId 非法（${String(sessionId)}）`);
      return undefined;
    }
    const key = sessionId;
    const existing = ChatPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Beside);
      return existing;
    }
    const s = store.getSession(sessionId);
    const panel = vscode.window.createWebviewPanel(
      ChatPanel.viewType,
      s?.title ? `${s.title.slice(0, 30)}` : `HarnessGate #${sessionId}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const inst = new ChatPanel(sessionId, panel, client, store, log);
    ChatPanel.panels.set(key, inst);
    // 打开面板时拉一次台账（归档会话也能看到历史）
    client.send({ type: "transcript", sessionId });
    const rec = store.getSession(sessionId);
    if (rec && !rec.live && rec.resumable) client.send({ type: "resume", sessionId });
    return inst;
  }

  private dispose(): void {
    ChatPanel.panels.delete(this.sessionId);
    this.client.off("message", this.onServerMsg);   // 不摘的话旧面板会一直收消息
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private post(msg: Record<string, unknown>): void {
    this.panel.webview.postMessage(msg).then(undefined, (err) => {
      this.log(`postMessage 失败（type=${msg.type}）: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private get session(): SessionInfo | undefined {
    return this.latestSession ?? this.store.getSession(this.sessionId);
  }

  /** 服务端消息 → 面板 */
  private onServer(msg: Record<string, unknown>): void {
    const type = String(msg.type ?? "");
    if (type === "hello") {
      this.latestSession = undefined;   // hello 全量刷新后以 store 为准
      this.pushHeader();
      return;
    }
    if (type === "session") {
      const s = (msg as { session?: SessionInfo }).session;
      if (s && s.id === this.sessionId) this.latestSession = s;
      this.pushHeader();
      return;
    }
    if (type === "transcript" && msg.sessionId === this.sessionId) {
      const snap = (msg.entries ?? []) as TranscriptEntry[];
      // 快照已覆盖本地新增（长度 ≥ 本地起点）→ 整表替换，绝不拼接；
      // 否则（理论上少见）才把本地尚未上报的尾部接在快照后面。
      // 旧实现合并后把 transcriptBase 清零，下一次快照会把整个旧数组再拼一遍 → 内容成倍重复。
      if (snap.length >= this.transcriptBase) {
        this.entries = snap.map(toEntry);
      } else {
        const tail = this.entries.slice(this.transcriptBase);
        this.entries = [...snap.map(toEntry), ...tail];
      }
      this.transcriptBase = this.entries.length;
      this.log(`transcript 到达：${snap.length} 条`);
      this.renderAll();
      return;
    }
    if (type === "update" && msg.sessionId === this.sessionId) {
      this.applyUpdate(msg.update as Record<string, unknown>);
      return;
    }
    if (type === "turn_end" && msg.sessionId === this.sessionId) {
      this.streaming = false;
      this.post({ type: "waiting", on: false });
      this.post({ type: "streamEnd" });
      return;
    }
    if (type === "permission" && msg.sessionId === this.sessionId) {
      const last = [...this.entries].reverse().find((e) => e.kind === "permission" && !e.answered && !e.requestId);
      const perm: Entry = {
        kind: "permission",
        title: String(msg.title ?? "工具调用"),
        requestId: String(msg.requestId),
        options: (msg.options ?? []) as PermissionOption[],
      };
      if (last) {
        Object.assign(last, perm);
        this.upsertEntry(this.entries.indexOf(last));
      }
      this.entries.push(perm);
      this.upsertEntry(this.entries.length - 1);
      return;
    }
    if (type === "log" && msg.sessionId === this.sessionId && this.showLog) {
      this.entries.push({ kind: "log", text: String(msg.line ?? "") });
      this.upsertEntry(this.entries.length - 1);
      return;
    }
    if (type === "deleted" && msg.sessionId === this.sessionId) {
      this.panel.dispose();
      return;
    }
    if (type === "error" && (!msg.sessionId || msg.sessionId === this.sessionId)) {
      this.entries.push({ kind: "error", message: String(msg.message ?? "未知错误") });
      this.upsertEntry(this.entries.length - 1);
    }
  }

  private applyUpdate(u: Record<string, unknown>): void {
    const kind = String(u.sessionUpdate ?? "");
    if (kind === "agent_message_chunk") {
      const c = u.content as { type?: string; text?: string } | undefined;
      if (c?.type === "text" && typeof c.text === "string") this.appendText("assistant", c.text);
      return;
    }
    if (kind === "agent_thought_chunk") {
      const c = u.content as { type?: string; text?: string } | undefined;
      if (c?.type === "text" && typeof c.text === "string") this.appendText("thought", c.text);
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      this.streaming = false;
      this.post({ type: "streamEnd" });   // 让 webview 结束当前流式气泡，下段文字另起一块
      const id = String(u.toolCallId ?? "");
      const title = String(u.title ?? id ?? "工具");
      const status = String(u.status ?? "pending");
      const found = this.entries.find((e) => e.kind === "tool" && e.toolCallId === id) as
        | Extract<Entry, { kind: "tool" }>
        | undefined;
      if (found) {
        found.title = title || found.title;
        found.status = status;
        found.detail = mergeToolDetail(found.detail, kind, u);
        this.upsertEntry(this.entries.indexOf(found));
      } else {
        this.entries.push({ kind: "tool", title, status, toolCallId: id, detail: rawToolDetail(kind, u) });
        this.upsertEntry(this.entries.length - 1);
      }
      return;
    }
    if (this.showLog) {
      this.entries.push({ kind: "log", text: `[${kind}] ${JSON.stringify(u).slice(0, 240)}` });
      this.upsertEntry(this.entries.length - 1);
    }
  }

  private appendText(kind: "assistant" | "thought", text: string): void {
    const last = this.entries[this.entries.length - 1];
    if (last && last.kind === kind && this.streaming) {
      last.text += text;
    } else {
      this.entries.push({ kind, text });
      this.streaming = true;
    }
    // 流式：只更新最后一条，避免整页重绘（带绝对索引，便于 upsert 对位）
    this.post({ type: "append", kind, text, index: this.entries.length - 1 });
  }

  private onMessage(m: Record<string, unknown>): void {
    const cmd = String(m.cmd ?? "");
    if (cmd === "ready") {
      this.ready = true;
      this.log(`webview 就绪，重发渲染（当前 ${this.entries.length} 条）`);
      this.pushHeader();
      this.renderAll();
      return;
    }
    if (cmd === "send") {
      const text = String(m.text ?? "").trim();
      if (!text) return;
      const s = this.session;
      if (!s) return;
      if (!s.live) {
        this.entries.push({ kind: "error", message: "会话未在运行：先点「恢复」" });
        this.renderAll();
        return;
      }
      this.entries.push({ kind: "user", text });
      this.transcriptBase = this.entries.length;
      this.streaming = false;
      this.renderAll();
      this.post({ type: "waiting", on: true });   // 模型慢时给个明确状态，别让人以为挂了
      this.client.send({ type: "prompt", sessionId: this.sessionId, text });
      return;
    }
    if (cmd === "permission") {
      this.client.send({
        type: "permission",
        sessionId: this.sessionId,
        requestId: String(m.requestId ?? ""),
        optionId: String(m.optionId ?? ""),
      });
      return;
    }
    if (cmd === "config") {
      this.client.send({
        type: "config",
        sessionId: this.sessionId,
        configId: String(m.configId ?? ""),
        value: String(m.value ?? ""),
      });
      return;
    }
    if (cmd === "mode") {
      this.client.send({ type: "mode", sessionId: this.sessionId, modeId: String(m.modeId ?? "") });
      return;
    }
    if (cmd === "resume") {
      this.client.send({ type: "resume", sessionId: this.sessionId });
      return;
    }
    if (cmd === "stop") {
      this.client.send({ type: "close", sessionId: this.sessionId });
      return;
    }
    if (cmd === "interrupt") {
      this.client.send({ type: "interrupt", sessionId: this.sessionId });
      return;
    }
    if (cmd === "autoApprove") {
      const level = String(m.level ?? "off");
      if (level === "off" || level === "readonly" || level === "all") {
        this.client.send({ type: "set-auto-approve", sessionId: this.sessionId, level });
      }
      return;
    }
    if (cmd === "toggleLog") {
      this.showLog = !this.showLog;
      this.renderAll();
      return;
    }
    if (cmd === "wvError") {
      this.log(`[chat webview] ${String(m.message ?? "未知错误")}`);
      this.entries.push({ kind: "error", message: `webview: ${String(m.message ?? "")}` });
      this.upsertEntry(this.entries.length - 1);
      return;
    }
    if (cmd === "rendered") {
      this.renderInfo = {
        count: Number(m.count ?? 0),
        start: Number(m.start ?? 0),
        total: Number(m.total ?? 0),
        ms: Number(m.ms ?? 0),
      };
      this.log(`渲染完成：${this.renderInfo.count}/${this.renderInfo.total} 条（${this.renderInfo.ms}ms）`);
      return;
    }
    if (cmd === "loadMore") {
      this.window += 150;
      this.renderAll();
      return;
    }
    if (cmd === "openSettings") {
      void vscode.commands.executeCommand("workbench.action.openSettings", "harnessgate");
    }
  }

  private pushHeader(): void {
    const s = this.session;
    if (!s) return;
    const hasModes = Boolean(s.modes?.availableModes?.length);
    // 与网页版同规则：有专用「模式」下拉时，跳过 configOptions 里 category=mode 的项（claude 会两处都报，不去重就出现两个模式下拉）
    const cfg = (s.configOptions ?? []).filter((o) => o.options?.length && !(hasModes && o.category === "mode"));
    const modes = s.modes?.availableModes ?? [];
    const AAPPROVE: Array<["off" | "readonly" | "all", string]> = [["off", "人工审批"], ["readonly", "只读自动"], ["all", "全自动"]];
    const aaSel = s.roomId
      ? ""
      : `<select data-aa="1" title="权限请求的处理方式：人工审批 / 只读自动 / 全自动（含危险操作，会打 ⚠ 标记便于回溯）">` +
        AAPPROVE.map(([v, name]) => `<option value="${v}" ${(s.autoApprove ?? "off") === v ? "selected" : ""}>自动:${name}</option>`).join("") +
        `</select>`;
    this.post({
      type: "header",
      title: s.title || `(空会话 #${s.id})`,
      harness: s.harnessLabel,
      cwd: s.cwd,
      status: s.status,
      statusLabel: STATUS_LABEL[s.status] ?? s.status,
      pending: s.pendingPermission?.title,
      live: s.live,
      resumable: s.resumable,
      inTurn: s.inTurn,
      error: s.error,
      showLog: this.showLog,
      aaSel,
      configs: cfg.map((o) => ({
        id: o.id,
        name: o.name ?? o.id,
        current: o.currentValue,
        options: (o.options ?? []).map((v) => ({ value: v.value, name: v.name ?? v.value })),
      })),
      modes: modes.length ? { current: s.modes?.currentModeId, options: modes.map((m) => ({ id: m.id, name: m.name ?? m.id })) } : undefined,
    });
  }

  /** 全量渲染（窗口化）：只发最后 window 条，更早的由「载入更早」翻页 */
  private renderAll(): void {
    const total = this.entries.length;
    const start = Math.max(0, total - this.window);
    this.post({
      type: "render",
      start,
      total,
      entries: this.entries.slice(start).map((e) => ({ ...e, html: htmlOf(e) })),
    });
  }

  /** 单条增量更新（窗口内改气泡，新条目追加）——流式期间不重发整页 */
  private upsertEntry(i: number): void {
    if (i < 0 || i >= this.entries.length) return;
    const total = this.entries.length;
    const start = Math.max(0, total - this.window);
    if (i < start && i !== total - 1) return;   // 在窗口外且不是新尾巴：等下次全量渲染
    const e = this.entries[i];
    if (!e) return;
    this.post({ type: "upsert", index: i, start, total, entry: { ...e, html: htmlOf(e) } });
  }

  private html(): string {
    const csp = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';";
    return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  :root { --line: var(--vscode-panel-border); --dim: var(--vscode-descriptionForeground); }
  body { margin:0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-foreground); background: var(--vscode-editor-background); display:flex; flex-direction:column; height:100vh; }
  header { padding:8px 12px; border-bottom:1px solid var(--line); display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  header .ttl { font-weight:600; font-size:13px; }
  header .meta { color:var(--dim); font-size:11.5px; }
  header select { background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground);
    border:1px solid var(--vscode-dropdown-border); border-radius:4px; padding:2px 6px; font-size:11.5px; max-width:220px; }
  header button { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground);
    border:0; border-radius:4px; padding:3px 9px; font-size:11.5px; cursor:pointer; }
  header button:hover { background:var(--vscode-button-secondaryHoverBackground); }
  header button.primary { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
  #stream { flex:1; overflow:auto; padding:14px 16px; }
  .msg { margin:0 0 13px; max-width:min(900px,100%); }
  .msg .who { font-size:11px; color:var(--dim); margin-bottom:3px; cursor:pointer; user-select:none; }
  .msg .who:hover { color:var(--vscode-foreground); }
  .msg .who .chev { display:inline-block; width:11px; transition:transform .12s; }
  .msg.collapsed .who .chev { transform:rotate(-90deg); }
  .msg .sum { display:none; color:var(--dim); font-size:11.5px; line-height:1.4; padding:0 0 2px;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; cursor:pointer; }
  .msg.collapsed { margin:0 0 5px; }
  .msg.collapsed .bubble { display:none; }
  .msg.collapsed .sum { display:block; }
  .msg .bubble { padding:7px 11px; border-radius:6px; line-height:1.6; word-wrap:break-word; }
  .msg.user .bubble { background:var(--vscode-input-background); border:1px solid var(--line); }
  .msg.assistant .bubble { background:transparent; border:1px solid var(--line); }
  .msg.thought .bubble { background:transparent; border:1px dashed var(--line); color:var(--dim); font-size:12.5px; }
  .msg.tool .bubble { background:transparent; border-left:3px solid var(--vscode-charts-yellow); font-size:12px; color:var(--dim); }
  .msg.error .bubble { background:var(--vscode-inputValidation-errorBackground); border:1px solid var(--vscode-inputValidation-errorBorder); }
  .msg.log .bubble { font-family:var(--vscode-editor-font-family); font-size:11.5px; color:var(--dim); white-space:pre-wrap; }
  .msg.permission .bubble { border:1px solid var(--vscode-charts-orange); }
  .msg .bubble > :first-child { margin-top:0; } .msg .bubble > :last-child { margin-bottom:0; }
  .bubble h1,.bubble h2,.bubble h3,.bubble h4 { margin:11px 0 5px; line-height:1.3; }
  .bubble h1{font-size:17px} .bubble h2{font-size:15.5px} .bubble h3{font-size:14px} .bubble h4{font-size:13px}
  .bubble p { margin:6px 0; } .bubble ul,.bubble ol { margin:6px 0; padding-left:22px; }
  .bubble li { margin:2px 0; }
  .bubble code { background:var(--vscode-textCodeBlock-background); padding:1px 5px; border-radius:3px;
    font-family:var(--vscode-editor-font-family); font-size:.92em; }
  .bubble pre { background:var(--vscode-textCodeBlock-background); padding:9px 11px; border-radius:5px; overflow:auto; margin:7px 0; }
  .bubble pre code { background:transparent; padding:0; }
  .bubble blockquote { margin:7px 0; padding-left:10px; border-left:3px solid var(--line); color:var(--dim); }
  .bubble table { border-collapse:collapse; margin:8px 0; font-size:12.5px; }
  .bubble th,.bubble td { border:1px solid var(--line); padding:4px 8px; text-align:left; }
  .bubble th { background:var(--vscode-textCodeBlock-background); font-weight:600; }
  .bubble a { color:var(--vscode-textLink-foreground); }
  .bubble hr { border:0; border-top:1px solid var(--line); margin:10px 0; }
  .permOpts { display:flex; gap:7px; flex-wrap:wrap; margin-top:7px; }
  footer { border-top:1px solid var(--line); padding:9px 12px; display:flex; gap:8px; align-items:flex-end; }
  footer textarea { flex:1; resize:vertical; min-height:38px; max-height:200px; padding:7px 9px;
    background:var(--vscode-input-background); color:var(--vscode-input-foreground);
    border:1px solid var(--vscode-input-border); border-radius:5px; font-family:inherit; font-size:inherit; }
  footer button { background:var(--vscode-button-background); color:var(--vscode-button-foreground);
    border:0; border-radius:5px; padding:7px 15px; cursor:pointer; }
  .empty { color:var(--dim); text-align:center; padding:40px 20px; }
  /* 工具栏：搜索 + 折叠 + 我的发言（与网页版对齐）；wrap 保证窄面板下按钮不丢 */
  .bar { display:flex; gap:5px; align-items:center; padding:5px 10px; border-bottom:1px solid var(--line);
    position:relative; flex-wrap:wrap; }
  .bar input { flex:1; min-width:90px; max-width:260px; background:var(--vscode-input-background); color:var(--vscode-input-foreground);
    border:1px solid var(--vscode-input-border); border-radius:4px; padding:2px 8px; font-size:11.5px; }
  .bar select { max-width:170px; background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground);
    border:1px solid var(--vscode-dropdown-border); border-radius:4px; padding:2px 6px; font-size:11.5px; }
  .bar .cnt { color:var(--dim); font-size:11.5px; min-width:40px; text-align:center; }
  .bar button { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground);
    border:0; border-radius:4px; padding:2px 7px; font-size:11.5px; cursor:pointer; flex:none; }
  body { position:relative; }
  .msg.hit { outline:1px solid var(--vscode-charts-yellow); outline-offset:2px; }
  .msg.cur { outline:2px solid var(--vscode-focusBorder); outline-offset:2px; }
  #toBottom { position:absolute; right:20px; bottom:120px; width:30px; height:30px; border-radius:50%;
    background:var(--vscode-editorWidget-background); color:var(--vscode-editorWidget-foreground);
    border:1px solid var(--line); font-size:15px; cursor:pointer; display:none; align-items:center; justify-content:center; z-index:20; }
  .loadMore { text-align:center; padding:6px 0 12px; }
  .loadMore button { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground);
    border:0; border-radius:4px; padding:4px 14px; font-size:12px; cursor:pointer; }
  .stat { text-align:center; color:var(--dim); font-size:11.5px; padding:4px 0 10px; }
</style></head>
<body>
<header id="head"></header>
<div class="bar">
  <input id="search" placeholder="🔍 搜索对话内容…" />
  <span class="cnt" id="searchCount"></span>
  <button id="searchPrev" title="上一个命中">▲</button>
  <button id="searchNext" title="下一个命中">▼</button>
  <button id="collapseAll" title="折叠全部消息（点任意消息的标题行可单独折叠/展开）" style="letter-spacing:-0.5px">⏷ 折叠</button>
  <button id="expandAll" title="展开全部消息">⏵ 展开</button>
  <span style="flex:1"></span>
  <select id="userJump"><option value="">我的发言…</option></select>
</div>
<div id="stream"><div class="empty">加载中…</div></div>
<button id="toBottom" title="回到底部">↓</button>
<footer>
  <textarea id="input" placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"></textarea>
  <button id="send">发送</button>
</footer>
<script>
  /* 与服务端/插件同一套 Markdown 渲染器（构建时内联；esc/mdToHtml 都来自它，别重复声明） */
  ${RENDERER_SOURCE}
  const vscode = acquireVsCodeApi();
  /* 页面脚本任何未捕获异常都回报扩展主机——「卡在加载中」时能看到真实原因 */
  window.addEventListener('error', (e) => {
    try { vscode.postMessage({ cmd:'wvError', message: e.message + ' @' + (e.filename || '') + ':' + e.lineno }); } catch {}
  });
  window.addEventListener('unhandledrejection', (e) => {
    try { vscode.postMessage({ cmd:'wvError', message: 'unhandled: ' + String((e.reason && e.reason.message) || e.reason) }); } catch {}
  });
  const $ = (id) => document.getElementById(id);
  const stream = $('stream');
  let streamingEl = null, streamingKind = null;

  /* esc 由注入的渲染器提供 */

  const WHO = { user:'你', assistant:'助手', thought:'思考', tool:'工具', permission:'需要授权', error:'错误', log:'日志' };

  function summaryOf(e){
    const t = e.kind === 'error' ? e.message : e.kind === 'tool' || e.kind === 'permission' ? e.title : e.text;
    return (WHO[e.kind] || e.kind) + ' · ' + String(t ?? '').replace(/\\s+/g, ' ').slice(0, 90);
  }

  function msgEl(e, idx){
    const w = document.createElement('div');
    w.className = 'msg ' + e.kind;
    if (idx !== undefined) w.dataset.i = String(idx);
    const who = WHO[e.kind] || e.kind;
    w.innerHTML = '<div class="who"><span class="chev">▾</span>' + esc(who) + '</div>' +
      '<div class="sum" title="点击展开">' + esc(summaryOf(e)) + '</div>' +
      '<div class="bubble md">' + (e.html || '') + '</div>';
    return w;
  }

  function renderHeader(h){
    const cfg = (h.configs || []).map((c) =>
      '<select data-cfg="' + esc(c.id) + '">' + c.options.map((o) =>
        '<option value="' + esc(o.value) + '"' + (o.value === c.current ? ' selected' : '') + '>' +
        esc(c.name + ': ' + o.name) + '</option>').join('') + '</select>').join('');
    const modes = h.modes ? '<select data-mode="1">' + h.modes.options.map((m) =>
      '<option value="' + esc(m.id) + '"' + (m.id === h.modes.current ? ' selected' : '') + '>' + esc('模式: ' + m.name) + '</option>').join('') + '</select>' : '';
    $('head').innerHTML =
      '<span class="ttl">' + esc(h.title) + '</span>' +
      '<span class="meta">' + esc(h.harness) + ' · ' + esc(h.cwd) + '</span>' +
      '<span class="meta">' + esc(h.statusLabel || h.status) + (h.error ? ' · ' + esc(h.error) : '') + '</span>' +
      (h.pending ? '<span class="meta" style="color:var(--vscode-charts-orange)">⏳ 待审批：' + esc(h.pending) + '</span>' : '') +
      '<span style="flex:1"></span>' + cfg + modes + (h.aaSel || '') +
      (h.inTurn ? '<button data-act="interrupt" class="primary">⏹ 打断</button>' : '') +
      (h.live ? '<button data-act="stop">停止</button>' : (h.resumable ? '<button class="primary" data-act="resume">恢复</button>' : '')) +
      '<button data-act="toggleLog">' + (h.showLog ? '隐藏日志' : '日志') + '</button>';
    const aa = $('head').querySelector('select[data-aa]');
    if (aa) aa.onchange = () => vscode.postMessage({ cmd:'autoApprove', level: aa.value });
    $('head').querySelectorAll('select[data-cfg]').forEach((s) => {
      s.onchange = () => vscode.postMessage({ cmd:'config', configId:s.dataset.cfg, value:s.value });
    });
    $('head').querySelectorAll('select[data-mode]').forEach((s) => {
      s.onchange = () => vscode.postMessage({ cmd:'mode', modeId:s.value });
    });
    $('head').querySelectorAll('button[data-act]').forEach((b) => {
      b.onclick = () => vscode.postMessage({ cmd: b.dataset.act });
    });
  }

  let vStart = 0, vTotal = 0, allCollapsed = false;

  function applyCollapsed(){
    if (allCollapsed) stream.querySelectorAll('.msg').forEach((el) => el.classList.add('collapsed'));
  }

  function render(m){
    const t0 = performance.now();
    streamingEl = null; streamingKind = null;
    vStart = m.start || 0; vTotal = m.total || (m.entries ? m.entries.length : 0);
    if (!m.entries || !m.entries.length){
      stream.innerHTML = vTotal === 0
        ? '<div class="empty">服务器上这个会话没有历史记录。<br>可能是空会话或导入失败——发一条消息开始。</div>'
        : '<div class="empty">加载中…</div>';
      vscode.postMessage({ cmd:'rendered', count:0, start:vStart, total:vTotal, ms:Math.round(performance.now() - t0) });
      return;
    }
    const prevH = stream.scrollHeight, prevTop = stream.scrollTop;
    stream.innerHTML = '';
    if (vStart > 0) {
      const more = document.createElement('div');
      more.className = 'loadMore';
      more.innerHTML = '<button id="loadMoreBtn">载入更早 ' + Math.min(150, vStart) + ' 条（还有 ' + vStart + ' 条）</button>';
      more.querySelector('button').onclick = () => vscode.postMessage({ cmd:'loadMore' });
      stream.appendChild(more);
    }
    m.entries.forEach((e, i) => stream.appendChild(msgEl(e, vStart + i)));
    const stat = document.createElement('div');
    stat.className = 'stat'; stat.textContent = '共 ' + vTotal + ' 条' + (vStart > 0 ? ' · 显示最后 ' + m.entries.length + ' 条' : '');
    stream.appendChild(stat);
    applyCollapsed();
    bindPerms();
    refreshUserJump();
    if (vStart > 0 && vTotal > m.entries.length && prevTop > 40) {
      stream.scrollTop = prevTop + (stream.scrollHeight - prevH);   // 载入更早：视口停在原来那批消息上
    } else {
      stream.scrollTop = stream.scrollHeight;
    }
    vscode.postMessage({ cmd:'rendered', count:m.entries.length, start:vStart, total:vTotal, ms:Math.round(performance.now() - t0) });
  }

  /* ---------- 搜索 / 我的发言 / 回底部（与网页版对齐） ---------- */
  let hits = [], pos = -1;
  const nearBottom = () => stream.scrollHeight - stream.scrollTop - stream.clientHeight < 140;

  function refreshUserJump(){
    const sel = $('userJump');
    if (!sel) return;
    const msgs = [...stream.querySelectorAll('.msg.user')];
    sel.innerHTML = '<option value="">我的发言…</option>' +
      msgs.map((m, i) => {
        const t = (m.textContent || '').replace(/^你/, '').replace(/\s+/g, ' ').trim().slice(0, 46);
        return '<option value="' + i + '">#' + (i + 1) + ' ' + esc(t) + '</option>';
      }).join('');
  }

  function scrollToMsg(el){
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function runSearch(q){
    stream.querySelectorAll('.msg.hit, .msg.cur').forEach((el) => el.classList.remove('hit', 'cur'));
    hits = []; pos = -1;
    const cnt = $('searchCount');
    const needle = q.trim().toLowerCase();
    if (!needle) { cnt.textContent = ''; return; }
    stream.querySelectorAll('.msg').forEach((el) => {
      if ((el.textContent || '').toLowerCase().includes(needle)) { el.classList.add('hit'); hits.push(el); }
    });
    if (!hits.length) { cnt.textContent = '无匹配'; return; }
    cnt.textContent = hits.length + ' 处';
  }

  function gotoHit(k){
    if (!hits.length) return;
    pos = ((k % hits.length) + hits.length) % hits.length;
    stream.querySelectorAll('.msg.cur').forEach((el) => el.classList.remove('cur'));
    hits[pos].classList.add('cur');
    scrollToMsg(hits[pos]);
    $('searchCount').textContent = (pos + 1) + '/' + hits.length;
  }

  const searchInput = $('search');
  let searchTimer = null;
  searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(searchInput.value), 200); });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); gotoHit(e.shiftKey ? pos - 1 : pos + 1); }
    if (e.key === 'Escape') { searchInput.value = ''; runSearch(''); }
  });
  $('searchPrev').onclick = () => gotoHit(pos - 1);
  $('searchNext').onclick = () => gotoHit(pos + 1);
  $('userJump').onchange = (e) => {
    const i = Number(e.target.value);
    if (e.target.value === '' || Number.isNaN(i)) return;
    const msgs = stream.querySelectorAll('.msg.user');
    if (msgs[i]) { scrollToMsg(msgs[i]); msgs[i].animate?.([{ filter:'brightness(1.8)' }, { filter:'none' }], 900); }
    e.target.value = '';
  };
  const toBottom = $('toBottom');
  stream.addEventListener('scroll', () => {
    toBottom.style.display = stream.scrollHeight - stream.scrollTop - stream.clientHeight > 240 ? 'flex' : 'none';
  }, { passive: true });
  toBottom.onclick = () => stream.scrollTo({ top: stream.scrollHeight, behavior: 'smooth' });

  /* ---------- 折叠 / 展开 ---------- */
  function toggleMsg(el){
    el.classList.toggle('collapsed');
    if (!el.classList.contains('collapsed')) el.scrollIntoView({ block:'center' });
  }
  stream.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!(t instanceof Element)) return;
    const head = t.closest('.who'), sum = t.closest('.sum');
    const msg = t.closest('.msg');
    if (!msg) return;
    if (head || sum) toggleMsg(msg);
  });
  $('collapseAll').onclick = () => { allCollapsed = true; applyCollapsed(); };
  $('expandAll').onclick = () => {
    allCollapsed = false;
    stream.querySelectorAll('.msg.collapsed').forEach((el) => el.classList.remove('collapsed'));
  };

  function bindPerms(){
    stream.querySelectorAll('button[data-opt]').forEach((b) => {
      b.onclick = () => {
        vscode.postMessage({ cmd:'permission', requestId:b.dataset.req, optionId:b.dataset.opt });
        b.parentElement.innerHTML = '<span class="meta">已选择：' + esc(b.textContent) + '</span>';
      };
    });
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.type === 'header') { renderHeader(m); return; }
    if (m.type === 'render') { render(m); return; }
    if (m.type === 'upsert') {
      vStart = m.start ?? vStart; vTotal = Math.max(vTotal, m.total ?? 0);
      const rel = m.index - vStart;
      const exist = rel >= 0 ? stream.querySelector('.msg[data-i="' + m.index + '"]') : null;
      if (exist) {
        const collapsed = exist.classList.contains('collapsed');
        exist.className = 'msg ' + m.entry.kind + (collapsed ? ' collapsed' : '');
        exist.querySelector('.sum').textContent = summaryOf(m.entry);
        exist.querySelector('.bubble').innerHTML = m.entry.html || '';
        bindPerms();
        return;
      }
      if (rel >= 0) {
        const empty = stream.querySelector('.empty, .stat');
        if (empty && empty.classList.contains('empty')) stream.innerHTML = '';
        const el = msgEl(m.entry, m.index);
        if (allCollapsed) el.classList.remove('collapsed');   // 新消息不折叠，流式可见
        stream.insertBefore(el, stream.querySelector('.stat'));
        bindPerms();
        refreshUserJump();
        if (nearBottom()) stream.scrollTop = stream.scrollHeight;
      }
      return;
    }
    if (m.type === 'append') {
      // 流式：只更新最后一条气泡
      if (!streamingEl || streamingKind !== m.kind) {
        const e = { kind: m.kind, html: '' };
        streamingEl = msgEl(e, m.index);
        if (allCollapsed) streamingEl.classList.remove('collapsed');   // 正在流式输出的不折叠
        if (stream.firstChild && stream.firstChild.classList && stream.firstChild.classList.contains('empty')) stream.innerHTML = '';
        stream.insertBefore(streamingEl, stream.querySelector('.stat'));
        streamingKind = m.kind;
      }
      const w0 = document.getElementById('waiting');
      if (w0 && window.__waitTimer) { clearInterval(window.__waitTimer); w0.remove(); }
      const b = streamingEl.querySelector('.bubble');
      b.dataset.raw = (b.dataset.raw || '') + m.text;
      b.innerHTML = mdToHtml(b.dataset.raw);
      if (nearBottom()) stream.scrollTop = stream.scrollHeight;   // 读历史时不被流式输出拽走
      return;
    }
    if (m.type === 'waiting') {
      let w = document.getElementById('waiting');
      if (m.on) {
        if (!w) { w = document.createElement('div'); w.id = 'waiting';
          w.style.cssText = 'padding:8px 16px;color:var(--dim);font-size:12px';
          stream.parentElement.insertBefore(w, stream.nextSibling); }
        const t0 = Date.now();
        w.textContent = '已发送，等待回复…';
        if (window.__waitTimer) clearInterval(window.__waitTimer);
        window.__waitTimer = setInterval(() => { w.textContent = '已发送，等待回复… ' + Math.round((Date.now()-t0)/1000) + 's'; }, 1000);
      } else if (w) { if (window.__waitTimer) clearInterval(window.__waitTimer); w.remove(); }
      return;
    }
    if (m.type === 'streamEnd') {
      streamingEl = null; streamingKind = null;
      const w = document.getElementById('waiting'); if (w && window.__waitTimer) { clearInterval(window.__waitTimer); w.remove(); }
      return;
    }
  });

  const input = $('input');
  function send(){
    const t = input.value.trim();
    if (!t) return;
    vscode.postMessage({ cmd:'send', text:t });
    input.value = '';
  }
  $('send').onclick = send;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.focus();
  vscode.postMessage({ cmd:'ready' });
</script>
</body></html>`;
  }
}

/** ACP 的 rawInput/content 形态不统一，统一摊成文本 */
function textOfUpdate(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(textOfUpdate).filter(Boolean).join("\n");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (o.content !== undefined) return textOfUpdate(o.content);
    try { return JSON.stringify(v); } catch { return ""; }
  }
  return String(v);
}
/** tool_call 记入参，tool_call_update 记输出 */
function rawToolDetail(kind: string, u: Record<string, unknown>): string | undefined {
  if (kind === "tool_call") {
    const inp = textOfUpdate(u.rawInput);
    return inp ? `▸ ${inp}` : undefined;
  }
  return textOfUpdate(u.content) || undefined;
}
function mergeToolDetail(prev: string | undefined, kind: string, u: Record<string, unknown>): string | undefined {
  const add = rawToolDetail(kind, u);
  if (!add) return prev;
  if (!prev) return add;
  if (prev.endsWith(add)) return prev;   // 上游每次发全量，别重复叠加
  return (prev + "\n" + add).slice(-4000);
}

function toEntry(e: TranscriptEntry): Entry {
  switch (e.kind) {
    case "user": return { kind: "user", text: e.text };
    case "assistant": return { kind: "assistant", text: e.text };
    case "thought": return { kind: "thought", text: e.text };
    case "tool": return { kind: "tool", title: e.title, status: e.status, toolCallId: e.toolCallId };
    case "permission": return { kind: "permission", title: e.title, answered: e.answered, requestId: e.requestId, options: e.options, auto: e.auto };
    case "error": return { kind: "error", message: e.message };
    case "log": return { kind: "log", text: e.text };
  }
}

function htmlOf(e: Entry): string {
  switch (e.kind) {
    case "user": return `<p>${esc(e.text).replace(/\n/g, "<br>")}</p>`;
    case "assistant": return mdToHtml(e.text);
    case "thought": return `<p>${esc(e.text).replace(/\n/g, "<br>")}</p>`;
    case "tool": return `${esc(e.title)} <span style="opacity:.7">[${esc(e.status)}]</span>` +
      (e.detail ? `<details style="margin-top:5px"><summary>看执行细节</summary><pre>${esc(e.detail)}</pre></details>` : "");
    case "permission": {
      if (e.answered) return `${esc(e.title)} → ${esc(e.answered)}${e.auto ? "（自动决策）" : ""}`;
      const opts = (e.options ?? [])
        .map((o) => `<button data-req="${esc(e.requestId ?? "")}" data-opt="${esc(o.optionId)}">${esc(o.name)}</button>`)
        .join("");
      return `${esc(e.title)}<div class="permOpts">${opts}</div>`;
    }
    case "error": return esc(e.message);
    case "log": return esc(e.text);
  }
}

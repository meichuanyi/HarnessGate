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

  private disposables: vscode.Disposable[] = [];
  private entries: Entry[] = [];
  private transcriptBase = 0;
  private streaming = false;
  private showLog = false;
  private pendingText = "";
  private ready = false;

  private readonly onServerMsg = (msg: Record<string, unknown>): void => this.onServer(msg);

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
  }

  static show(sessionId: string, client: GateClient, store: Store, log: (line: string) => void): ChatPanel {
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
    void this.panel.webview.postMessage(msg);
  }

  private get session(): SessionInfo | undefined {
    return this.store.getSession(this.sessionId);
  }

  /** 服务端消息 → 面板 */
  private onServer(msg: Record<string, unknown>): void {
    const type = String(msg.type ?? "");
    if (type === "hello" || type === "session") {
      this.pushHeader();
      return;
    }
    if (type === "transcript" && msg.sessionId === this.sessionId) {
      const snap = (msg.entries ?? []) as TranscriptEntry[];
      const tail = this.entries.slice(this.transcriptBase);
      this.entries = [...snap.map(toEntry), ...tail];
      this.transcriptBase = 0;
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
      if (last) Object.assign(last, perm);
      this.entries.push(perm);
      this.renderAll();
      return;
    }
    if (type === "log" && msg.sessionId === this.sessionId && this.showLog) {
      this.entries.push({ kind: "log", text: String(msg.line ?? "") });
      this.renderAll();
      return;
    }
    if (type === "deleted" && msg.sessionId === this.sessionId) {
      this.panel.dispose();
      return;
    }
    if (type === "error" && (!msg.sessionId || msg.sessionId === this.sessionId)) {
      this.entries.push({ kind: "error", message: String(msg.message ?? "未知错误") });
      this.renderAll();
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
      } else {
        this.entries.push({ kind: "tool", title, status, toolCallId: id, detail: rawToolDetail(kind, u) });
      }
      this.renderAll();
      return;
    }
    if (this.showLog) {
      this.entries.push({ kind: "log", text: `[${kind}] ${JSON.stringify(u).slice(0, 240)}` });
      this.renderAll();
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
    // 流式：只更新最后一条，避免整页重绘
    this.post({ type: "append", kind, text });
  }

  private onMessage(m: Record<string, unknown>): void {
    const cmd = String(m.cmd ?? "");
    if (cmd === "ready") {
      this.ready = true;
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
    if (cmd === "toggleLog") {
      this.showLog = !this.showLog;
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
    const cfg = (s.configOptions ?? []).filter((o) => o.options?.length);
    const modes = s.modes?.availableModes ?? [];
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
      configs: cfg.map((o) => ({
        id: o.id,
        name: o.name ?? o.id,
        current: o.currentValue,
        options: (o.options ?? []).map((v) => ({ value: v.value, name: v.name ?? v.value })),
      })),
      modes: modes.length ? { current: s.modes?.currentModeId, options: modes.map((m) => ({ id: m.id, name: m.name ?? m.id })) } : undefined,
    });
  }

  private renderAll(): void {
    this.post({ type: "render", entries: this.entries.map((e) => ({ ...e, html: htmlOf(e) })) });
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
  .msg .who { font-size:11px; color:var(--dim); margin-bottom:3px; }
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
  /* 工具栏：搜索 + 我的发言（与网页版对齐） */
  .bar { display:flex; gap:6px; align-items:center; padding:5px 12px; border-bottom:1px solid var(--line); position:relative; }
  .bar input { flex:1; min-width:90px; max-width:300px; background:var(--vscode-input-background); color:var(--vscode-input-foreground);
    border:1px solid var(--vscode-input-border); border-radius:4px; padding:2px 8px; font-size:11.5px; }
  .bar select { max-width:170px; background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground);
    border:1px solid var(--vscode-dropdown-border); border-radius:4px; padding:2px 6px; font-size:11.5px; }
  .bar .cnt { color:var(--dim); font-size:11.5px; min-width:40px; text-align:center; }
  .bar button { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground);
    border:0; border-radius:4px; padding:2px 8px; font-size:11.5px; cursor:pointer; }
  body { position:relative; }
  .msg.hit { outline:1px solid var(--vscode-charts-yellow); outline-offset:2px; }
  .msg.cur { outline:2px solid var(--vscode-focusBorder); outline-offset:2px; }
  #toBottom { position:absolute; right:20px; bottom:120px; width:30px; height:30px; border-radius:50%;
    background:var(--vscode-editorWidget-background); color:var(--vscode-editorWidget-foreground);
    border:1px solid var(--line); font-size:15px; cursor:pointer; display:none; align-items:center; justify-content:center; z-index:20; }
</style></head>
<body>
<header id="head"></header>
<div class="bar">
  <input id="search" placeholder="🔍 搜索对话内容…" />
  <span class="cnt" id="searchCount"></span>
  <button id="searchPrev" title="上一个命中">▲</button>
  <button id="searchNext" title="下一个命中">▼</button>
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
  /* 与服务端/插件同一套 Markdown 渲染器（构建时内联） */
  ${RENDERER_SOURCE}
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const stream = $('stream');
  let streamingEl = null, streamingKind = null;

  function esc(s){ return String(s ?? '').replace(/[&<>"']/g, (c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  function msgEl(e){
    const w = document.createElement('div');
    w.className = 'msg ' + e.kind;
    const who = { user:'你', assistant:'助手', thought:'思考', tool:'工具', permission:'需要授权', error:'错误', log:'日志' }[e.kind] || e.kind;
    w.innerHTML = '<div class="who">' + esc(who) + '</div><div class="bubble md">' + (e.html || '') + '</div>';
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
      '<span style="flex:1"></span>' + cfg + modes +
      (h.inTurn ? '<button data-act="interrupt" class="primary">⏹ 打断</button>' : '') +
      (h.live ? '<button data-act="stop">停止</button>' : (h.resumable ? '<button class="primary" data-act="resume">恢复</button>' : '')) +
      '<button data-act="toggleLog">' + (h.showLog ? '隐藏日志' : '日志') + '</button>';
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

  function render(entries){
    streamingEl = null; streamingKind = null;
    if (!entries.length){ stream.innerHTML = '<div class="empty">还没有对话。发一条消息开始。</div>'; return; }
    stream.innerHTML = '';
    for (const e of entries) stream.appendChild(msgEl(e));
    bindPerms();
    refreshUserJump();
    stream.scrollTop = stream.scrollHeight;
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
    if (m.type === 'render') { render(m.entries); return; }
    if (m.type === 'append') {
      // 流式：只更新最后一条气泡
      if (!streamingEl || streamingKind !== m.kind) {
        const e = { kind: m.kind, html: '' };
        streamingEl = msgEl(e);
        if (stream.firstChild && stream.firstChild.classList && stream.firstChild.classList.contains('empty')) stream.innerHTML = '';
        stream.appendChild(streamingEl);
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

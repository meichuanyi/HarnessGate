import * as vscode from "vscode";
import type { GateClient } from "./client.ts";
import type { Store } from "./store.ts";
import type { Room, RoomTopic, RoomTurn } from "./protocol.ts";
import { mdToHtml } from "./markdown.ts";
import { RENDERER_SOURCE } from "./generated/renderer-source.ts";
import { promptCwd } from "./cwd-input.ts";

const STATUS_LABEL: Record<string, string> = {
  idle: "未开始",
  running: "进行中",
  done: "已完成",
  error: "出错",
  stopped: "已停止",
};

/**
 * 圆桌面板（Webview）：多 harness 就一个议题轮流发言。
 * 列表 + 新建向导 + 按轮分栏的讨论视图（主持人发言横跨整行）+ 停止/删除/追加议题。
 * 成员会话的流式 chunk 直接投进当前轮的分栏（与服务端 room 广播的整轮结果互补）。
 */
export class RoomPanel {
  static readonly viewType = "harnessgate.rooms";
  private static inst?: RoomPanel;
  /** 渲染回执（webview 处理完 state 消息后回报），测试/诊断用 */
  static lastRenderInfo: { rooms: number; ms: number } | undefined;

  private disposables: vscode.Disposable[] = [];
  private selected?: string;
  private showForm = false;
  /** 工作队决策/交付件（crew-detail 消息），webview 渲染用 */
  private crewDetail?: { decisions: never[]; deliverables: never[] };
  private crewDetailAt = 0;

  private readonly onServerMsg = (msg: Record<string, unknown>): void => this.onServer(msg);

  private constructor(
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

  static show(client: GateClient, store: Store, log: (line: string) => void): RoomPanel {
    if (RoomPanel.inst) {
      RoomPanel.inst.panel.reveal(vscode.ViewColumn.Beside);
      return RoomPanel.inst;
    }
    const panel = vscode.window.createWebviewPanel(
      RoomPanel.viewType,
      "HarnessGate 圆桌会议",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    RoomPanel.inst = new RoomPanel(panel, client, store, log);
    client.send({ type: "list" });   // hello 里带 rooms；主动再拉一次保险
    return RoomPanel.inst;
  }

  private dispose(): void {
    this.client.off("message", this.onServerMsg);
    while (this.disposables.length) this.disposables.pop()?.dispose();
    if (RoomPanel.inst === this) RoomPanel.inst = undefined;
  }

  private post(msg: Record<string, unknown>): void {
    void this.panel.webview.postMessage(msg);
  }

  private onServer(msg: Record<string, unknown>): void {
    const type = String(msg.type ?? "");
    if (type === "rooms") {
      this.store.setRooms((msg.rooms ?? []) as Room[]);
      this.pushAll();
      return;
    }
    if (type === "room") {
      this.store.upsertRoom(msg.room as Room);
      this.pushAll();
      // 工作队：房间有变化就刷新决策/交付件（3 秒节流，别跟着广播风暴走）
      const room = msg.room as Room;
      if (room?.crew && this.selected === room.id) this.requestCrewDetail(room.id);
      return;
    }
    if (type === "crew-detail") {
      this.crewDetail = { decisions: (msg.decisions ?? []) as never, deliverables: (msg.deliverables ?? []) as never };
      this.post({ type: "crewDetail", roomId: String(msg.roomId ?? ""), decisions: this.crewDetail.decisions, deliverables: this.crewDetail.deliverables });
      return;
    }
    // 成员会话的流式文本 → 当前轮的对应分栏（room 广播是整轮粒度，直播靠这个）
    if (type === "update") {
      const sid = String(msg.sessionId ?? "");
      const room = this.selected ? this.store.getRoom(this.selected) : undefined;
      if (!room || room.status !== "running" || !room.members.includes(sid)) return;
      const u = msg.update as Record<string, unknown>;
      if (String(u.sessionUpdate ?? "") !== "agent_message_chunk") return;
      const c = u.content as { type?: string; text?: string } | undefined;
      if (c?.type === "text" && typeof c.text === "string") {
        this.post({ type: "live", sessionId: sid, text: c.text });
      }
    }
  }

  /** 请求工作队决策/交付件数据（3 秒节流） */
  private requestCrewDetail(roomId: string): void {
    const now = Date.now();
    if (now - this.crewDetailAt < 3000) return;
    this.crewDetailAt = now;
    this.client.send({ type: "crew-detail", roomId });
  }

  private onMessage(m: Record<string, unknown>): void {
    const cmd = String(m.cmd ?? "");
    if (cmd === "ready") {
      this.pushAll();
      return;
    }
    if (cmd === "wvError") {
      this.log(`[rooms webview] ${String(m.message ?? "未知错误")}`);
      return;
    }
    if (cmd === "rendered") {
      RoomPanel.lastRenderInfo = { rooms: Number(m.rooms ?? 0), ms: Number(m.ms ?? 0) };
      return;
    }
    if (cmd === "select") {
      this.selected = String(m.roomId ?? "") || undefined;
      this.pushAll();
      return;
    }
    if (cmd === "refresh") {
      this.client.send({ type: "list" });
      return;
    }
    if (cmd === "toggleForm") {
      this.showForm = !this.showForm;
      this.pushAll();
      return;
    }
    if (cmd === "pickCwd") {
      void (async () => {
        const cur = String(m.current ?? "") || this.store.defaultCwd;
        const picked = await promptCwd(this.client, cur);
        if (picked) this.post({ type: "cwd", value: picked });
      })();
      return;
    }
    if (cmd === "create") {
      const members = (m.members ?? []) as string[];
      const memberConfigs = (m.memberConfigs ?? {}) as Record<string, Array<{ configId: string; value: string }>>;
      const cfg: Record<string, Array<{ configId: string; value: string }>> = {};
      for (const [hid, list] of Object.entries(memberConfigs)) {
        const clean = list.filter((c) => c.value);
        if (clean.length) cfg[hid] = clean;
      }
      const hostId = String(m.hostId ?? "");
      const isCrew = m.kind === "crew";
      const hostCfg = (m.hostCfg ?? {}) as Record<string, string>;
      const hostConfigs = Object.entries(hostCfg).map(([configId, value]) => ({ configId, value }));
      this.client.send({
        type: "room-start",
        cwd: String(m.cwd ?? ""),
        harnessIds: members,
        topic: String(m.topic ?? ""),
        rounds: isCrew ? 0 : Number(m.rounds ?? 1) || 1,
        mode: m.mode === "sequential" ? "sequential" : "parallel",
        writeAllowed: isCrew ? true : m.writeAllowed === true,
        crew: isCrew ? { maxAttempts: 2, mergeMode: m.mergeMode === "auto" ? "auto" : "manual" } : undefined,
        host: hostId
          ? {
              harnessId: hostId,
              opening: !isCrew,
              roundSummary: !isCrew,
              finalSummary: true,
              configs: hostConfigs.length ? hostConfigs : undefined,
            }
          : undefined,
        memberConfigs: Object.keys(cfg).length ? cfg : undefined,
      });
      this.showForm = false;
      this.log(isCrew
        ? `已开工工作队：${String(m.topic ?? "").slice(0, 40)}（工头 + ${members.length} 个队员）`
        : `已发起圆桌：${String(m.topic ?? "").slice(0, 40)}（${members.length} 个成员）`);
      return;
    }
    if (cmd === "crewMerge") {
      this.client.send({ type: "crew-merge", roomId: String(m.roomId ?? "") });
      return;
    }
    if (cmd === "crewDetail") {
      this.requestCrewDetail(String(m.roomId ?? ""));
      return;
    }
    if (cmd === "stop") {
      this.client.send({ type: "room-stop", roomId: String(m.roomId ?? "") });
      return;
    }
    if (cmd === "run") {
      this.client.send({ type: "room-run", roomId: String(m.roomId ?? "") });
      return;
    }
    if (cmd === "delete") {
      void (async () => {
        const roomId = String(m.roomId ?? "");
        const room = this.store.getRoom(roomId);
        const pick = await vscode.window.showWarningMessage(
          `删除圆桌「${room?.topic?.slice(0, 30) || roomId}」？`,
          { modal: true, detail: "同时删除成员会话则连各成员的会话记录一起删；不删则圆桌记录移除，会话保留可单独继续聊。" },
          "仅删圆桌",
          "连成员会话一起删",
        );
        if (pick === "仅删圆桌") this.client.send({ type: "room-delete", roomId });
        else if (pick) this.client.send({ type: "room-delete", roomId, deleteSessions: true });
      })();
      return;
    }
    if (cmd === "addTopic") {
      this.client.send({
        type: "room-topic",
        roomId: String(m.roomId ?? ""),
        topic: String(m.topic ?? ""),
        rounds: Number(m.rounds ?? 1) || 1,
      });
      return;
    }
    if (cmd === "setMode") {
      this.client.send({ type: "room-mode", roomId: String(m.roomId ?? ""), mode: m.mode === "sequential" ? "sequential" : "parallel" });
      return;
    }
  }

  /** 推全部状态：房间列表 + 选中房间详情 + 新建表单要用的 harness 清单 */
  private pushAll(): void {
    const rooms = this.store.roomsList();
    if (this.selected && !rooms.some((r) => r.id === this.selected)) this.selected = undefined;
    if (!this.selected && rooms.length) this.selected = rooms[0]?.id;
    const usable = this.store.harnesses.filter((h) => h.available && !h.blocked);
    const probed = usable.filter((h) => h.state === "probed-ok");
    this.post({
      type: "state",
      rooms: rooms.map((r) => ({
        id: r.id,
        topic: r.topic,
        status: r.status,
        statusLabel: STATUS_LABEL[r.status] ?? r.status,
        crew: Boolean(r.crew),
        members: (r.memberInfo ?? []).map((mi) => mi.harnessLabel),
        host: typeof r.host?.harnessLabel === "string" ? r.host.harnessLabel : undefined,
        updatedAt: r.updatedAt,
      })),
      selected: this.selected,
      showForm: this.showForm,
      defaultCwd: this.store.defaultCwd,
      harnesses: (probed.length ? probed : usable).map((h) => ({
        id: h.id,
        label: h.label,
        probed: h.state === "probed-ok",
        configs: (h.configs ?? [])
          .filter((c) => c.options?.length)
          .map((c) => ({
            id: c.id,
            name: c.name ?? c.id,
            options: (c.options ?? []).map((o) => ({ value: o.value, name: o.name ?? o.value })),
          })),
      })),
    });
    const room = this.selected ? this.store.getRoom(this.selected) : undefined;
    if (room) this.post({ type: "room", room });
    else this.post({ type: "room", room: null });
  }

  private html(): string {
    const csp = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';";
    return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  :root { --line: var(--vscode-panel-border); --dim: var(--vscode-descriptionForeground); }
  body { margin:0; font-family:var(--vscode-font-family); font-size:var(--vscode-font-size);
    color:var(--vscode-foreground); background:var(--vscode-editor-background); }
  header { padding:8px 12px; border-bottom:1px solid var(--line); display:flex; gap:8px; align-items:center; }
  header .ttl { font-weight:600; font-size:13px; }
  header button { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground);
    border:0; border-radius:4px; padding:3px 10px; font-size:12px; cursor:pointer; }
  header button.primary { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
  main { display:flex; height:calc(100vh - 42px); }
  #list { width:250px; min-width:190px; border-right:1px solid var(--line); overflow:auto; }
  .roomItem { padding:8px 10px; border-bottom:1px solid var(--line); cursor:pointer; }
  .roomItem:hover { background:var(--vscode-list-hoverBackground); }
  .roomItem.sel { background:var(--vscode-list-activeSelectionBackground); color:var(--vscode-list-activeSelectionForeground); }
  .roomItem .t { font-size:12px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .roomItem .m { font-size:11px; color:var(--dim); margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .dot { display:inline-block; width:7px; height:7px; border-radius:50%; margin-right:5px; vertical-align:middle; }
  .dot.running { background:var(--vscode-charts-green); } .dot.done { background:var(--vscode-charts-blue); }
  .dot.error { background:var(--vscode-charts-red); } .dot.idle, .dot.stopped { background:var(--dim); }
  #detail { flex:1; overflow:auto; padding:14px 18px 40px; }
  /* 新建向导 */
  #form { border:1px solid var(--line); border-radius:6px; padding:12px 14px; margin-bottom:16px; max-width:760px; }
  #form h3 { margin:0 0 8px; font-size:13px; }
  #form textarea, #form input[type=text] { width:100%; box-sizing:border-box; padding:6px 9px; margin:3px 0 9px;
    background:var(--vscode-input-background); color:var(--vscode-input-foreground);
    border:1px solid var(--vscode-input-border); border-radius:4px; font-family:inherit; font-size:inherit; }
  #form textarea { min-height:52px; resize:vertical; }
  .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin:6px 0; }
  .row label { font-size:12px; color:var(--dim); }
  .row select, #list select { background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground);
    border:1px solid var(--vscode-dropdown-border); border-radius:4px; padding:3px 6px; font-size:12px; }
  .member { display:flex; gap:8px; align-items:center; padding:5px 0; border-bottom:1px dashed var(--line); flex-wrap:wrap; }
  .member .lbl { min-width:150px; font-size:12.5px; }
  .member select { max-width:200px; }
  .btn { background:var(--vscode-button-background); color:var(--vscode-button-foreground);
    border:0; border-radius:4px; padding:5px 14px; font-size:12.5px; cursor:pointer; }
  .btn.sec { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
  .btn.warn { background:var(--vscode-button-secondaryBackground); color:var(--vscode-errorForeground); }
  /* 讨论区 */
  .topic { margin-bottom:22px; }
  .topicHead { font-size:13.5px; font-weight:600; padding:6px 0; border-bottom:1px solid var(--line); margin-bottom:10px; }
  .roundHead { color:var(--dim); font-size:12px; margin:14px 0 6px; }
  .cols { display:flex; gap:10px; align-items:stretch; flex-wrap:wrap; }
  .col { flex:1; min-width:230px; max-width:520px; border:1px solid var(--line); border-radius:6px; padding:8px 11px; }
  .col .h { font-size:11.5px; color:var(--dim); border-bottom:1px dashed var(--line); padding-bottom:4px; margin-bottom:6px; }
  .col .md { font-size:12.5px; line-height:1.55; word-wrap:break-word; }
  .hostBlock { border:1px solid var(--vscode-charts-purple, #a371f7); border-radius:6px;
    padding:8px 12px; margin:10px 0; max-width:100%; }
  .hostBlock .h { font-size:11.5px; color:var(--vscode-charts-purple, #a371f7); margin-bottom:5px; }
  .hostBlock .md { font-size:12.5px; line-height:1.55; }
  .md h1,.md h2,.md h3 { margin:8px 0 4px; line-height:1.3; } .md h1{font-size:15px} .md h2{font-size:14px} .md h3{font-size:13px}
  .md p { margin:5px 0; } .md ul,.md ol { margin:5px 0; padding-left:20px; } .md li { margin:2px 0; }
  .md code { background:var(--vscode-textCodeBlock-background); padding:1px 4px; border-radius:3px;
    font-family:var(--vscode-editor-font-family); font-size:.92em; }
  .md pre { background:var(--vscode-textCodeBlock-background); padding:8px 10px; border-radius:5px; overflow:auto; margin:6px 0; }
  .md pre code { background:transparent; padding:0; }
  .md blockquote { margin:6px 0; padding-left:9px; border-left:3px solid var(--line); color:var(--dim); }
  .md table { border-collapse:collapse; margin:6px 0; font-size:12px; }
  .md th,.md td { border:1px solid var(--line); padding:3px 7px; text-align:left; }
  .md a { color:var(--vscode-textLink-foreground); }
  .empty { color:var(--dim); text-align:center; padding:50px 20px; }
  .metaLine { color:var(--dim); font-size:12px; margin:2px 0 10px; }
  .actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:8px 0 14px; }
  .crewTask { border:1px solid var(--line); border-radius:6px; padding:8px 11px; margin:8px 0; }
  .crewTask .s { font-size:11px; color:var(--dim); }
  .btn.sec.on { outline:2px solid var(--vscode-focusBorder); }
  .board { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:8px; margin:8px 0; }
  .boardCol { background:var(--vscode-editorWidget-background); border:1px solid var(--line); border-radius:6px; padding:6px 8px; min-width:0; }
  .boardCol>.hd { font-size:11.5px; font-weight:600; color:var(--dim); margin-bottom:5px; }
  .boardTask { background:var(--vscode-editor-background); border:1px solid var(--line); border-radius:5px; padding:5px 7px; margin-bottom:5px; font-size:12px; }
  .boardTask .t { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .boardTask .m { font-size:10.5px; color:var(--dim); margin-top:2px; }
  .decision { border-bottom:1px dashed var(--line); padding:4px 0; font-size:11.5px; line-height:1.5; }
  .decision .h { color:var(--dim); font-size:10.5px; }
  .deliverable { border:1px solid var(--line); border-radius:6px; padding:7px 10px; margin:6px 0; font-size:12px; }
  .deliverable .m { font-size:10.5px; color:var(--dim); margin:2px 0; }
</style></head>
<body>
<header>
  <span class="ttl">圆桌会议</span>
  <span style="flex:1"></span>
  <button id="toggleForm" class="primary">＋ 新建圆桌</button>
  <button id="refresh">刷新</button>
</header>
<main>
  <div id="list"></div>
  <div id="detail"><div class="empty">加载中…</div></div>
</main>
<script>
  ${RENDERER_SOURCE}
  const vscode = acquireVsCodeApi();
  /* 页面脚本任何未捕获异常都回报扩展主机 */
  window.addEventListener('error', (e) => {
    try { vscode.postMessage({ cmd:'wvError', message: e.message + ' @' + (e.filename || '') + ':' + e.lineno }); } catch {}
  });
  window.addEventListener('unhandledrejection', (e) => {
    try { vscode.postMessage({ cmd:'wvError', message: 'unhandled: ' + String((e.reason && e.reason.message) || e.reason) }); } catch {}
  });
  const $ = (id) => document.getElementById(id);
  /* esc/mdToHtml 由注入的渲染器提供，别重复声明（重复声明=脚本整体语法错误，页面卡加载中） */

  let state = { rooms: [], selected: undefined, showForm: false, defaultCwd: '', harnesses: [], kind: 'crew', hostCfg: {} };
  let room = null;
  /* 已渲染发言的指纹：room 广播是整对象替换，指纹没变的分栏不重绘（滚动位置/性能都保得住） */
  const nodeCache = new Map();
  /* 实时分栏的流式文本缓冲：存 JS 变量而不是 DOM dataset——
     房间广播频繁重渲染会重建 #liveRow，DOM 存储会被清掉（内容丢失/跳动） */
  const liveBuf = {};

  function fmtTime(ts) {
    try { return new Date(ts).toLocaleString(); } catch { return ''; }
  }

  function renderList() {
    const el = $('list');
    if (!state.rooms.length) { el.innerHTML = '<div class="empty">还没有圆桌</div>'; return; }
    el.innerHTML = '';
    for (const r of state.rooms) {
      const d = document.createElement('div');
      d.className = 'roomItem' + (r.id === state.selected ? ' sel' : '');
      d.innerHTML =
        '<div class="t"><span class="dot ' + esc(r.status) + '"></span>' + esc(r.topic || '(无议题)') + (r.crew ? ' <span style="font-size:10px;color:var(--dim)">工作队</span>' : '') + '</div>' +
        '<div class="m">' + esc(r.members.join(' · ') || '') + '</div>' +
        '<div class="m">' + esc(r.statusLabel) + ' · ' + esc(fmtTime(r.updatedAt)) + (r.host ? ' · 主持 ' + esc(r.host) : '') + '</div>';
      d.onclick = () => vscode.postMessage({ cmd:'select', roomId:r.id });
      el.appendChild(d);
    }
  }

  /* ---------- 新建向导 ---------- */
  function renderForm() {
    const slot = document.getElementById('formSlot');
    if (!slot) return;
    slot.innerHTML = '';
    if (!state.showForm) return;
    const f = document.createElement('div');
    f.id = 'form';
    const memberRows = state.harnesses.map((h) => {
      const cfg = (h.configs || []).map((c) =>
        '<select data-cfg="' + esc(h.id) + ':' + esc(c.id) + '">' +
          '<option value="">' + esc(c.name + '：默认') + '</option>' +
          c.options.map((o) => '<option value="' + esc(o.value) + '">' + esc(c.name + '：' + o.name) + '</option>').join('') +
        '</select>').join('');
      return '<div class="member">' +
        '<label class="lbl"><input type="checkbox" value="' + esc(h.id) + '" ' + (h.probed ? '' : 'disabled') + '> ' + esc(h.label) +
          (h.probed ? ' <span style="color:var(--vscode-charts-green)">✓</span>' : ' <span style="font-size:10px;color:var(--dim)">未探活</span>') + '</label>' +
        cfg + '</div>';
    }).join('');
    const hostOpts = state.harnesses.map((h, i) =>
      '<option value="' + esc(h.id) + '"' + (i === 0 ? " selected" : "") + '>' + esc(h.label) + '</option>').join('');
    f.innerHTML =
      '<h3>新建圆桌 / 工作队</h3>' +
      '<div class="row"><label>工作目录</label><input type="text" id="fCwd" style="flex:1" placeholder="/path/on/server" value="' + esc(state.defaultCwd) + '" /><button class="sec" id="pickCwd">浏览…</button></div>' +
      '<div class="row" style="gap:8px">' +
        '<button class="btn sec pickKind' + (state.kind === "crew" ? " on" : "") + '" data-kind="crew" style="flex:1">🛠 工作队（默认）<div style="font-size:10.5px;opacity:.75;font-weight:400">工头拆任务 → 多 agent 并行干活 → 评审 → 合并</div></button>' +
        '<button class="btn sec pickKind' + (state.kind === "discuss" ? " on" : "") + '" data-kind="discuss" style="flex:1">🎤 圆桌讨论<div style="font-size:10.5px;opacity:.75;font-weight:400">多 harness 就议题轮流发言、互相批注</div></button>' +
      '</div>' +
      '<textarea id="fTopic" placeholder="' + (state.kind === "crew"
        ? "目标：要做成什么事？（工头会把它拆成任务分给队员并行实现，例如「给项目加上导入导出功能」）"
        : "议题：想让大家讨论什么？（具体一点，例如「给 X 项目选测试框架，对比 A/B/C」）") + '"></textarea>' +
      '<div class="row"><label>成员（≥2，勾选参与）</label></div>' +
      '<div id="fMembers">' + memberRows + '</div>' +
      '<div class="row"><label>' + (state.kind === "crew" ? "🛠 工头（必选）：拆解任务 / 分派队员 / 把关评审" : "🎤 主持人（必选）：开场拆题 / 轮间小结 / 最终汇总") + '</label><select id="fHost">' + hostOpts + '</select></div>' +
      '<div class="row" id="fHostCfg"></div>' +
      '<div class="row" id="fCrewCtl"' + (state.kind === "crew" ? "" : ' hidden') + '>' +
        '<label>合并</label><select id="fMerge"><option value="manual">人工确认合并（推荐）</option><option value="auto">自动合并</option></select>' +
      '</div>' +
      '<div class="row" id="fDiscussCtl"' + (state.kind === "discuss" ? "" : ' hidden') + '>' +
        '<label>轮数</label><select id="fRounds">' + [1,2,3,4,5].map((n)=>'<option'+(n===2?' selected':'')+'>'+n+'</option>').join('') + '</select>' +
        '<label>发言方式</label><select id="fMode"><option value="parallel">并行（同轮互不可见）</option><option value="sequential">串行（后发言者能看到前面）</option></select>' +
        '<label><input type="checkbox" id="fConverge" checked> 共识即停</label>' +
        '<label><input type="checkbox" id="fTournament"> 评分锦标赛</label>' +
        '<label><input type="checkbox" id="fWrite"> 允许改文件</label>' +
      '</div>' +
      '<div class="row"><span style="flex:1"></span><button class="btn primary" id="fGo">' + (state.kind === "crew" ? "开工" : "开始圆桌") + '</button></div>';
    slot.appendChild(f);
    const bindHostCfg = () => {
      f.querySelectorAll("select[data-hcfg]").forEach((s) => {
        s.onchange = () => { state.hostCfg[s.dataset.hcfg] = s.value; };
      });
    };
    const renderHostCfg = () => {
      const box = f.querySelector("#fHostCfg");
      if (!box) return;
      const host = state.harnesses.find((h) => h.id === $("fHost").value);
      const cfgs = (host?.configs || []).filter((c) => c.options && c.options.length);
      box.innerHTML = cfgs.length
        ? cfgs.map((c) => {
            const cur = (state.hostCfg || {})[c.id] || c.currentValue || "";
            return '<label>' + esc(c.name || c.id) + '<select data-hcfg="' + esc(c.id) + '">' +
              c.options.map((o) => '<option value="' + esc(o.value) + '"' + (o.value === cur ? " selected" : "") + '>' + esc(o.name || o.value) + '</option>').join("") +
              '</select></label>';
          }).join("")
        : '<span style="font-size:11px;opacity:.7">' + esc(host?.label || "") + ' 未上报可切换配置（模型等用默认值）</span>';
      bindHostCfg();
    };
    $("fHost").onchange = () => { state.hostCfg = {}; renderHostCfg(); };
    renderHostCfg();
    f.querySelectorAll(".pickKind").forEach((b) => {
      b.onclick = () => {
        state.kind = b.dataset.kind;
        const topic = $("fTopic").value;      // 切模式保留已输入内容
        const cwd = $("fCwd").value;
        renderForm();
        $("fTopic").value = topic; $("fCwd").value = cwd;
      };
    });
    $("pickCwd").onclick = () => vscode.postMessage({ cmd:'pickCwd', current: $("fCwd").value });
    $("fGo").onclick = () => {
      const members = [...f.querySelectorAll('#fMembers input[type=checkbox]:checked')].map((c) => c.value);
      const topic = $("fTopic").value.trim();
      if (!topic) { $('fTopic').style.borderColor = 'var(--vscode-errorForeground)'; $('fTopic').focus(); return; }
      if (members.length < 2) { alertLike('至少选 2 个成员'); return; }
      const memberConfigs = {};
      f.querySelectorAll('select[data-cfg]').forEach((s) => {
        if (!s.value) return;
        const [hid, cid] = s.dataset.cfg.split(':');
        (memberConfigs[hid] = memberConfigs[hid] || []).push({ configId: cid, value: s.value });
      });
      const hostCfg = {};
      f.querySelectorAll('select[data-hcfg]').forEach((s) => { hostCfg[s.dataset.hcfg] = s.value; });
      vscode.postMessage({
        cmd:'create', kind: state.kind, cwd: $("fCwd").value.trim(), topic, members,
        rounds: Number(($("fRounds") || {}).value || 1), mode: ($("fMode") || {}).value || "parallel",
        converge: ($("fConverge") || {}).checked !== false,
        tournament: ($("fTournament") || {}).checked === true,
        writeAllowed: ($("fWrite") || {}).checked === true,
        mergeMode: ($("fMerge") || {}).value || "manual",
        hostId: $("fHost").value, memberConfigs, hostCfg,
      });
    };
  }

  function alertLike(msg) {
    const bar = document.createElement('div');
    bar.style.cssText = 'color:var(--vscode-errorForeground);font-size:12px;padding:4px 0';
    bar.textContent = msg;
    const f = document.getElementById('form');
    if (f) f.appendChild(bar);
    setTimeout(() => bar.remove(), 2600);
  }

  /* ---------- 讨论视图 ---------- */
  function turnEl(t) {
    const key = t.ts + ':' + t.round + ':' + t.sessionId + ':' + (t.hostRole || t.kind || '');
    const hash = t.reply.length + '|' + (t.score ?? '') + '|' + t.stopReason;
    const cached = nodeCache.get(key);
    if (cached && cached.hash === hash) return cached.el;   // 断开的节点可直接重新挂回，内容还在
    let el;
    if (t.kind === 'host') {
      el = cached ? cached.el : document.createElement('div');
      el.className = 'hostBlock';
      el.innerHTML = '<div class="h">🎤 主持 · ' + esc(hostRoleLabel(t)) + '</div><div class="md"></div>';
    } else {
      el = cached ? cached.el : document.createElement('div');
      el.className = 'col';
      el.innerHTML = '<div class="h"></div><div class="md"></div>';
      el.querySelector('.h').textContent = t.harnessLabel + (t.score !== undefined ? ' · 评分 ' + t.score : '') +
        (t.stopReason === 'timeout' ? ' · 超时' : '');
    }
    const body = el.querySelector('.md');
    const html = mdToHtml(t.reply || (t.stopReason === 'timeout' ? '（本轮无输出）' : ''));
    if (cached) { if (cached.html !== html) body.innerHTML = html; }
    else body.innerHTML = html;
    nodeCache.set(key, { hash, html, el });
    return el;
  }

  function hostRoleLabel(t) {
    return t.hostRole === 'opening' ? '开场拆题' : t.hostRole === 'final' ? '最终汇总' : t.hostRole === 'round-summary' ? '轮间小结' : (t.harnessLabel || '');
  }

  function renderTopics(r) {
    const topics = (r.topics && r.topics.length) ? r.topics : [{
      id: 'main', topic: r.topic, rounds: r.rounds, mode: r.mode, status: r.status,
      turns: r.turns, currentRound: undefined, createdAt: r.createdAt,
    }];
    const wrap = document.createElement('div');
    for (const tp of topics) {
      const div = document.createElement('div');
      div.className = 'topic';
      div.dataset.topic = tp.id;
      const st = tp.status === 'running' ? ' · 第 ' + (tp.currentRound ?? '?') + ' 轮进行中' : '';
      div.innerHTML = '<div class="topicHead">' + esc(tp.topic) +
        ' <span style="font-weight:400;color:var(--dim);font-size:11.5px">' +
        esc((tp.mode === 'sequential' ? '串行' : '并行') + ' · ' + (tp.rounds || '∞') + ' 轮 · ' + (STATUS[tp.status] || tp.status) + st) +
        (tp.convergedRound ? ' · 第 ' + tp.convergedRound + ' 轮收敛' : '') + '</div>';
      const hostOpening = tp.turns.filter((t) => t.hostRole === 'opening');
      for (const t of hostOpening) div.appendChild(turnEl(t));
      const byRound = new Map();
      for (const t of tp.turns) {
        if (t.kind === 'host' || t.hostRole) continue;
        if (!byRound.has(t.round)) byRound.set(t.round, []);
        byRound.get(t.round).push(t);
      }
      for (const [round, ts] of [...byRound.entries()].sort((a, b) => a[0] - b[0])) {
        const head = document.createElement('div');
        head.className = 'roundHead';
        head.textContent = '第 ' + round + ' 轮';
        div.appendChild(head);
        const row = document.createElement('div');
        row.className = 'cols';
        for (const t of ts) row.appendChild(turnEl(t));
        div.appendChild(row);
        const sum = tp.turns.find((t) => t.hostRole === 'round-summary' && t.round === round);
        if (sum) div.appendChild(turnEl(sum));
      }
      const liveRound = tp.status === 'running' ? tp.currentRound : undefined;
      if (liveRound !== undefined && liveRound > 0) {
        const head = document.createElement('div');
        head.className = 'roundHead';
        head.textContent = '第 ' + liveRound + ' 轮 · 发言中…';
        div.appendChild(head);
        // 本轮已交卷的成员不再渲染实时列（正式卡片已出现，留着就是前后重复）
        const finished = new Set(tp.turns.filter((t) => t.round === liveRound && !t.hostRole).map((t) => t.sessionId));
        const row = document.createElement('div');
        row.className = 'cols'; row.id = 'liveRow';
        for (const sid of r.members) {
          if (finished.has(sid)) continue;
          const info = (r.memberInfo || []).find((mi) => mi.sessionId === sid);
          const col = document.createElement('div');
          col.className = 'col'; col.dataset.sid = sid;
          col.innerHTML = '<div class="h">' + esc(info ? info.harnessLabel : sid.slice(0, 8)) + ' ⋯</div><div class="md"></div>';
          const raw = liveBuf[sid] || '';
          const body = col.querySelector('.md');
          body.dataset.raw = raw;
          if (raw) body.innerHTML = mdToHtml(raw);
          row.appendChild(col);
        }
        if (!row.children.length) { head.textContent = '第 ' + liveRound + ' 轮 · 收口中…'; }
        div.appendChild(row);
      }
      const finals = tp.turns.filter((t) => t.hostRole === 'final');
      for (const t of finals) div.appendChild(turnEl(t));
      wrap.appendChild(div);
    }
    return wrap;
  }

  function renderCrew(r) {
    const wrap = document.createElement('div');
    const crew = r.crew || {};
    const PH = { working:'🔨 干活中', 'ready-merge':'📦 待合并', merged:'✅ 已合并', conflict:'⚠️ 合并冲突' };
    wrap.innerHTML = '<div class="topicHead">工作队 · ' + esc(PH[crew.phase] || crew.phase || '') + '</div>' +
      '<div class="metaLine">目标：' + esc(crew.goal || '') + '</div>' +
      (crew.mergeLines && crew.mergeLines.length
        ? '<div class="metaLine">合并：' + crew.mergeLines.map((l) => esc(l)).join(' ｜ ') + '</div>'
        : '') +
      (crew.phase === 'ready-merge' && r.status !== 'running'
        ? '<div class="actions" style="margin:4px 0 10px"><button class="btn" id="crewMergeBtn">🔗 合并到主目录</button></div>'
        : '');
    const mergeBtn = wrap.querySelector('#crewMergeBtn');
    if (mergeBtn) mergeBtn.onclick = () => vscode.postMessage({ cmd: 'crewMerge', roomId: r.id });

    // 任务板：按状态分列
    const COLS = [['pending','待办'], ['working','进行中'], ['review','待评审'], ['done','完成'], ['failed','失败']];
    const board = document.createElement('div');
    board.className = 'board';
    for (const [st, label] of COLS) {
      const tasks = (crew.tasks || []).filter((t) => t.status === st);
      const col = document.createElement('div');
      col.className = 'boardCol';
      col.innerHTML = '<div class="hd">' + label + '（' + tasks.length + '）</div>';
      for (const t of tasks) {
        const rv = t.review || {};
        const c = document.createElement('div');
        c.className = 'boardTask';
        c.innerHTML = '<div class="t" title="' + esc(t.title) + '">' + esc(t.title) + '</div>' +
          '<div class="m">' + esc(t.assignee || '未分配') + ' · 尝试 ' + (t.attempts ?? 0) + '</div>' +
          (t.files && t.files.length ? '<div class="m">📄 ' + esc(t.files.join(', ')) + '</div>' : '') +
          (rv.comments ? '<div class="m" title="' + esc(String(rv.comments).slice(0, 400)) + '">💬 ' + esc(String(rv.comments).slice(0, 60)) + '</div>' : '');
        col.appendChild(c);
      }
      board.appendChild(col);
    }
    wrap.appendChild(board);

    // 决策记录 + 交付件（crew-detail 数据）
    const cd = crewDetailData && crewDetailData.roomId === r.id ? crewDetailData : null;
    if (cd) {
      if (cd.decisions && cd.decisions.length) {
        const box = document.createElement('div');
        box.innerHTML = '<div class="topicHead">决策记录（' + cd.decisions.length + '）</div>';
        for (const d of cd.decisions.slice(0, 40)) {
          const el = document.createElement('div');
          el.className = 'decision';
          el.innerHTML = '<div class="h">' + esc(d.ts ? d.ts.slice(11, 19) : '') + ' · ' + esc(d.harness) +
            (d.task ? ' · ' + esc(d.task) : '') + (d.auto !== undefined ? '' : '') +
            ' → <b>' + esc(d.chosen || '?') + '</b>' + (d.danger ? ' ⚠️' : '') + '</div>' +
            (d.title ? '<div>' + esc(d.title) + '</div>' : '') +
            (d.reason ? '<div class="h">理由：' + esc(String(d.reason).slice(0, 160)) + '</div>' : '');
          box.appendChild(el);
        }
        wrap.appendChild(box);
      }
      if (cd.deliverables && cd.deliverables.length) {
        const box = document.createElement('div');
        box.innerHTML = '<div class="topicHead">交付件与改动</div>';
        for (const d of cd.deliverables) {
          const el = document.createElement('div');
          el.className = 'deliverable';
          el.innerHTML = '<b>' + esc(d.title) + '</b> <span class="m">[' + esc(d.status) + ']</span>' +
            (d.commits && d.commits.length ? '<div class="m">提交：' + d.commits.slice(0, 3).map((x) => esc(String(x).slice(0, 70))).join('<br>') + '</div>' : '') +
            (d.artifacts && d.artifacts.length ? '<div class="m">产物：' + d.artifacts.map((a) => esc(a.path + ' (' + Math.max(1, Math.round(a.size / 1024)) + 'KB)')).join('、') + '</div>' : '') +
            (d.review ? '<div class="m">评审：' + esc(d.review.verdict) + (d.review.score !== undefined ? ' · ' + d.review.score + ' 分' : '') + ' — ' + esc(String(d.review.comments || '').slice(0, 200)) + '</div>' : '');
          box.appendChild(el);
        }
        wrap.appendChild(box);
      }
    }

    // 队员实时输出分栏（干活中的逐字流式）
    if (r.status === 'running') {
      const head = document.createElement('div');
      head.className = 'topicHead';
      head.textContent = '队员实时输出';
      wrap.appendChild(head);
      const row = document.createElement('div');
      row.className = 'cols'; row.id = 'liveRow';
      for (const sid of r.members) {
        const info = (r.memberInfo || []).find((mi) => mi.sessionId === sid);
        const col = document.createElement('div');
        col.className = 'col'; col.dataset.sid = sid;
        col.innerHTML = '<div class="h">' + esc(info ? info.harnessLabel : sid.slice(0, 8)) + ' ⋯</div><div class="md"></div>';
        const raw = liveBuf[sid] || '';
        if (raw) col.querySelector('.md').innerHTML = mdToHtml(raw);
        row.appendChild(col);
      }
      wrap.appendChild(row);
    }
    return wrap;
  }

  const STATUS = { idle:'未开始', running:'进行中', done:'已完成', error:'出错', stopped:'已停止' };
  let cachedRoomId = '';
  let crewDetailData = null;

  function renderRoom(r) {
    const detail = $('detail');
    if (!r) {
      // 没有房间时也保留 formSlot 结构，新建表单不丢
      const slot = document.getElementById('formSlot');
      const body = document.getElementById('roomBody');
      if (!slot || !body) {
        detail.innerHTML = '<div id="formSlot"></div><div id="roomBody"><div class="empty">' +
          (state.rooms.length ? '选择左侧圆桌查看' : '还没有圆桌。点右上「新建圆桌」开一场。') + '</div></div>';
        renderForm();
      } else {
        body.innerHTML = '<div class="empty">' + (state.rooms.length ? '选择左侧圆桌查看' : '还没有圆桌。点右上「新建圆桌」开一场。') + '</div>';
      }
      return;
    }
    // 换房间才清发言缓存；同房间的 room 广播复用没变的分栏（断开的节点可直接重新挂回）
    if (cachedRoomId !== r.id) { nodeCache.clear(); for (const k of Object.keys(liveBuf)) delete liveBuf[k]; cachedRoomId = r.id; }
    const near = detail.scrollHeight - detail.scrollTop - detail.clientHeight < 160;

    let formSlot = document.getElementById('formSlot');
    let body = document.getElementById('roomBody');
    if (!formSlot || !body) {
      detail.innerHTML = '<div id="formSlot"></div><div id="roomBody"></div>';
      formSlot = document.getElementById('formSlot');
      body = document.getElementById('roomBody');
      renderForm();
    }
    body.innerHTML = '';

    const head = document.createElement('div');
    const hostLbl = r.host && r.host.harnessLabel ? ' · 主持 ' + esc(String(r.host.harnessLabel)) : '';
    head.innerHTML = '<div style="font-size:14.5px;font-weight:600;margin-bottom:3px">' + esc(r.topic || '(无议题)') + '</div>' +
      '<div class="metaLine">' + esc((r.memberInfo || []).map((m) => m.harnessLabel).join(' · ')) + hostLbl +
      (r.cwd ? ' · <code>' + esc(r.cwd) + '</code>' : '') + ' · ' + esc(STATUS[r.status] || r.status) +
      (r.writeAllowed ? ' · <b style="color:var(--vscode-charts-orange)">可改文件</b>' : '') +
      (r.error ? ' · <span style="color:var(--vscode-errorForeground)">' + esc(r.error) + '</span>' : '') + '</div>';
    body.appendChild(head);

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.innerHTML =
      (r.status === 'running'
        ? '<button class="btn warn" data-act="stop">⏹ 停止</button>'
        : '<button class="btn" data-act="run">▶ 继续跑</button>') +
      '<button class="btn sec" data-act="addTopic">＋ 追加议题</button>' +
      '<select data-act="setMode"><option value="parallel"' + (r.mode !== 'sequential' ? ' selected' : '') + '>并行</option><option value="sequential"' + (r.mode === 'sequential' ? ' selected' : '') + '>串行</option></select>' +
      '<button class="btn warn" data-act="delete">删除圆桌</button>';
    body.appendChild(actions);

    const stopBtn = actions.querySelector('[data-act=stop]');
    if (stopBtn) stopBtn.onclick = () => vscode.postMessage({ cmd:'stop', roomId:r.id });
    const runBtn = actions.querySelector('[data-act=run]');
    if (runBtn) runBtn.onclick = () => vscode.postMessage({ cmd:'run', roomId:r.id });
    actions.querySelector('[data-act=delete]').onclick = () => vscode.postMessage({ cmd:'delete', roomId:r.id });
    actions.querySelector('[data-act=setMode]').onchange = (e) => vscode.postMessage({ cmd:'setMode', roomId:r.id, mode:e.target.value });
    actions.querySelector('[data-act=addTopic]').onclick = () => {
      const bar = document.getElementById('addTopicBar');
      if (!bar) return;
      bar.style.display = bar.style.display === 'none' ? 'flex' : 'none';
      if (bar.style.display === 'flex') document.getElementById('atTopic').focus();
    };

    const addTopicBar = document.createElement('div');
    addTopicBar.id = 'addTopicBar';
    addTopicBar.style.cssText = 'display:none;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 12px';
    addTopicBar.innerHTML = '<input type="text" id="atTopic" placeholder="新议题…" style="flex:1;min-width:220px;padding:5px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px" />' +
      '<select id="atRounds">' + [1,2,3,4,5].map((n)=>'<option'+(n===1?' selected':'')+'>'+n+'</option>').join('') + '</select>' +
      '<button class="btn" id="atGo">发起</button>';
    body.appendChild(addTopicBar);
    document.getElementById('atGo').onclick = () => {
      const t = document.getElementById('atTopic').value.trim();
      if (!t) return;
      vscode.postMessage({ cmd:'addTopic', roomId:r.id, topic:t, rounds:Number(document.getElementById('atRounds').value) });
    };

    body.appendChild(r.crew ? renderCrew(r) : renderTopics(r));

    // 工作队：渲染后拉一次决策/交付件（host 侧 3 秒节流）
    if (r.crew) vscode.postMessage({ cmd: 'crewDetail', roomId: r.id });

    if (near) detail.scrollTop = detail.scrollHeight;
  }

  function render() {
    const t0 = performance.now();
    renderList(); renderForm(); renderRoom(room);
    vscode.postMessage({ cmd:'rendered', rooms: state.rooms.length, ms: Math.round(performance.now() - t0) });
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.type === 'state') {
      // kind/hostCfg 是本地面板状态（用户选的模式/工头配置），跨 state 消息保留
      state = { rooms: m.rooms || [], selected: m.selected, showForm: m.showForm, defaultCwd: m.defaultCwd || '', harnesses: m.harnesses || [], kind: state.kind || 'crew', hostCfg: state.hostCfg || {} };
      render();
      return;
    }
    if (m.type === 'room') { room = m.room; renderRoom(room); return; }
    if (m.type === 'cwd') {
      const inp = document.getElementById('fCwd');
      if (inp) inp.value = m.value;
      return;
    }
    if (m.type === 'crewDetail') {
      crewDetailData = { roomId: m.roomId, decisions: m.decisions || [], deliverables: m.deliverables || [] };
      if (room && room.id === m.roomId) renderRoom(room);
      return;
    }
    if (m.type === 'live') {
      // 流式文本进变量缓冲（DOM 会在房间广播时重建，dataset 存储会丢）
      liveBuf[m.sessionId] = (liveBuf[m.sessionId] || '') + m.text;
      const col = document.querySelector('#liveRow .col[data-sid="' + m.sessionId + '"]');
      if (!col) return;
      const body = col.querySelector('.md');
      body.dataset.raw = liveBuf[m.sessionId];
      body.innerHTML = mdToHtml(liveBuf[m.sessionId]);
      const detail = $('detail');
      if (detail.scrollHeight - detail.scrollTop - detail.clientHeight < 160) detail.scrollTop = detail.scrollHeight;
      return;
    }
  });

  $('toggleForm').onclick = () => vscode.postMessage({ cmd:'toggleForm' });
  $('refresh').onclick = () => vscode.postMessage({ cmd:'refresh' });
  vscode.postMessage({ cmd:'ready' });
</script>
</body></html>`;
  }
}

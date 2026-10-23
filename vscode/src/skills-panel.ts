import * as vscode from "vscode";
import type { GateClient } from "./client.ts";
import type { Store } from "./store.ts";
import type { McpServerInfo, SkillsSnapshotView } from "./protocol.ts";

/**
 * 技能与 MCP 管理面板（Webview）：对齐网页版设置抽屉的两块管理面。
 * MCP：受管服务器增删改 + 「新建会话默认勾选」开关（stdio 走 command，http/sse 走 url）。
 * 技能：主库增删改 + 按 harness 挂载/卸载（挂载是 harness 级，同 harness 会话共享）。
 * 数据来自 hello/mcp/skills 推送；表单状态全部留在 webview 内，扩展侧只中转服务端操作。
 */
export class SkillsPanel {
  static readonly viewType = "harnessgate.skillsMcp";
  private static inst?: SkillsPanel;

  private disposables: vscode.Disposable[] = [];
  private readonly onServerMsg = (msg: Record<string, unknown>): void => this.onServer(msg);
  private readSeq = 0;

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

  static show(client: GateClient, store: Store, log: (line: string) => void): SkillsPanel {
    if (SkillsPanel.inst) {
      SkillsPanel.inst.panel.reveal(vscode.ViewColumn.Beside);
      return SkillsPanel.inst;
    }
    const panel = vscode.window.createWebviewPanel(
      SkillsPanel.viewType,
      "HarnessGate 技能与 MCP",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    SkillsPanel.inst = new SkillsPanel(panel, client, store, log);
    client.send({ type: "mcp-list" });   // hello 里带一份；主动再拉保险（回 mcp 推送）
    client.send({ type: "skills" });
    return SkillsPanel.inst;
  }

  private dispose(): void {
    this.client.off("message", this.onServerMsg);
    while (this.disposables.length) this.disposables.pop()?.dispose();
    if (SkillsPanel.inst === this) SkillsPanel.inst = undefined;
  }

  private post(msg: Record<string, unknown>): void {
    void this.panel.webview.postMessage(msg);
  }

  private onServer(msg: Record<string, unknown>): void {
    const type = String(msg.type ?? "");
    if (type === "hello" || type === "mcp" || type === "skills") this.pushAll();
  }

  private pushAll(): void {
    this.post({
      cmd: "state",
      mcps: this.store.mcpServers,
      skills: this.store.skills,
      harnesses: this.store.harnesses.map((h) => ({ id: h.id, label: h.label, available: h.available })),
    });
  }

  private onMessage(m: Record<string, unknown>): void {
    const cmd = String(m.cmd ?? "");
    if (cmd === "ready") {
      this.pushAll();
      return;
    }
    if (cmd === "wvError") {
      this.log(`[skills webview] ${String(m.message ?? "未知错误")}`);
      return;
    }
    if (cmd === "refresh") {
      this.client.send({ type: "mcp-list" });
      this.client.send({ type: "skills" });
      return;
    }
    if (cmd === "saveMcp") {
      this.client.send({ type: "mcp-save", server: m.server as McpServerInfo });
      this.log(`MCP 保存：${String((m.server as { name?: string })?.name ?? "")}`);
      return;
    }
    if (cmd === "deleteMcp") {
      this.client.send({ type: "mcp-delete", id: String(m.id ?? "") });
      return;
    }
    if (cmd === "saveSkill") {
      this.client.send({ type: "skills-save", skill: m.skill as { name: string; description: string; body: string; renameFrom?: string } });
      this.log(`技能保存：${String((m.skill as { name?: string })?.name ?? "")}`);
      return;
    }
    if (cmd === "deleteSkill") {
      this.client.send({ type: "skills-delete", name: String(m.name ?? "") });
      return;
    }
    if (cmd === "mount") {
      this.client.send({ type: "skills-mount", name: String(m.name ?? ""), harnessId: String(m.harnessId ?? ""), on: m.on === true });
      return;
    }
    if (cmd === "readSkill") {
      // 读全文回填编辑表单：单次监听 skills-content（reqId 关联，15s 兜底）
      const name = String(m.name ?? "");
      const reqId = `skillread-${++this.readSeq}`;
      const onContent = (c: Record<string, unknown>) => {
        if (c.reqId !== reqId) return;
        this.client.off("skills-content", onContent);
        this.post({ cmd: "skillContent", name, content: String(c.content ?? "") });
      };
      this.client.on("skills-content", onContent);
      setTimeout(() => this.client.off("skills-content", onContent), 15_000);
      this.client.send({ type: "skills-read", reqId, name });
      return;
    }
  }

  private html(): string {
    const csp = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';";
    return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  :root { --line: var(--vscode-panel-border); --dim: var(--vscode-descriptionForeground); }
  body { margin:0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  #bar { display:flex; gap:8px; align-items:center; padding:10px 14px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  #bar h2 { font-size:13px; margin:0; }
  .tab { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground);
    border:0; border-radius:4px; padding:3px 12px; font-size:12px; cursor:pointer; }
  .tab.on { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
  button.act { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground);
    border:0; border-radius:4px; padding:2px 8px; font-size:11.5px; cursor:pointer; }
  button.act:hover { background:var(--vscode-button-secondaryHoverBackground); }
  #wrap { padding:12px 14px; max-width:980px; }
  .row { border:1px solid var(--line); border-radius:8px; padding:8px 12px; margin-bottom:8px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .row .main { flex:1; min-width:220px; }
  .row b { font-size:13px; }
  .sub { color:var(--dim); font-size:11.5px; margin-top:2px; word-break:break-all; }
  .pill { font-size:10.5px; border:1px solid var(--line); border-radius:999px; padding:1px 8px; color:var(--dim); }
  .pill.on { color:var(--vscode-charts-green); border-color:var(--vscode-charts-green); }
  .pill.warn { color:var(--vscode-charts-yellow); border-color:var(--vscode-charts-yellow); }
  .chips { display:flex; gap:4px; flex-wrap:wrap; margin-top:4px; }
  .chip { font-size:10.5px; border:1px solid var(--line); border-radius:999px; padding:1px 7px; color:var(--dim); }
  .empty { color:var(--dim); padding:18px 4px; font-size:12.5px; }
  form { border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin:10px 0 14px; }
  form h3 { font-size:12.5px; margin:0 0 8px; }
  label { display:block; font-size:11.5px; color:var(--dim); margin:7px 0 2px; }
  input[type=text], textarea, select { width:100%; box-sizing:border-box; background:var(--vscode-input-background);
    color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border); border-radius:4px; padding:4px 8px;
    font-family: var(--vscode-font-family); font-size:12px; }
  textarea { min-height:120px; font-family: var(--vscode-editor-font-family); }
  .frow { display:flex; gap:10px; } .frow > div { flex:1; }
  .btns { display:flex; gap:8px; margin-top:10px; }
  .btns .go { background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:0; border-radius:4px; padding:4px 14px; cursor:pointer; font-size:12px; }
  .hint { color:var(--dim); font-size:11px; margin:6px 0 0; }
</style></head><body>
<div id="bar">
  <h2>🧰 技能与 MCP</h2>
  <button class="tab on" id="tabMcp">🔌 MCP 服务</button>
  <button class="tab" id="tabSkill">🎯 技能库</button>
  <span style="flex:1"></span>
  <button class="act" id="refreshBtn">刷新</button>
</div>
<div id="wrap"></div>
<script>
const vscode = acquireVsCodeApi();
const state = { tab:'mcp', mcps:[], skills:{library:[],mounts:[]}, harnesses:[],
  mcpForm:null, skillForm:null, target:'' };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

window.addEventListener('error', (e) => vscode.postMessage({ cmd:'wvError', message: e.message }));
document.addEventListener('DOMContentLoaded', () => {
  vscode.postMessage({ cmd:'ready' });
  $('tabMcp').onclick = () => { state.tab='mcp'; render(); };
  $('tabSkill').onclick = () => { state.tab='skill'; render(); };
  $('refreshBtn').onclick = () => vscode.postMessage({ cmd:'refresh' });
});
window.addEventListener('message', (e) => {
  const m = e.data || {};
  if (m.cmd === 'state') {
    state.mcps = m.mcps || []; state.skills = m.skills || {library:[],mounts:[]};
    state.harnesses = m.harnesses || [];
    if (!state.target && state.harnesses.length) state.target = state.harnesses[0].id;
    render();
  }
  if (m.cmd === 'skillContent' && state.skillForm) {
    state.skillForm.body = m.content;
    state.skillForm.renameFrom = m.name;
    render();
  }
});

function mountChips(names) {
  return '<div class="chips">' + names.map((n) => '<span class="chip">⎇ ' + esc(n) + '</span>').join('') + '</div>';
}

function renderMcp() {
  let h = '';
  if (state.mcpForm) h += mcpFormHtml();
  h += '<div class="btns"><button class="act" onclick="newMcp()">＋ 新建 MCP 服务</button></div>';
  if (!state.mcps.length) { h += '<div class="empty">还没有 MCP 服务。新建后可在「新建会话」和会话装备里勾选注入。</div>'; return h; }
  for (const s of state.mcps) {
    const sub = s.type === 'stdio' ? [s.command, ...(s.args||[])].filter(Boolean).join(' ') : (s.url || '');
    h += '<div class="row">' +
      '<div class="main"><b>' + esc(s.name) + '</b> <span class="pill">' + esc(s.type) + '</span> ' +
      (s.enabled ? '<span class="pill on">默认勾选</span>' : '') +
      '<div class="sub">' + esc(sub) + (s.note ? ' · ' + esc(s.note) : '') + '</div></div>' +
      '<button class="act" onclick="toggleMcp(\\'' + esc(s.id) + '\\')">' + (s.enabled ? '取消默认' : '设为默认') + '</button>' +
      '<button class="act" onclick="editMcp(\\'' + esc(s.id) + '\\')">编辑</button>' +
      '<button class="act" onclick="delMcp(\\'' + esc(s.id) + '\\')">' + (confirmKey === 'mcp:' + s.id ? '确认删除？' : '删除') + '</button>' +
      '</div>';
  }
  return h;
}

function mcpFormHtml() {
  const f = state.mcpForm;
  const isStdio = f.type === 'stdio';
  return '<form onsubmit="return false"><h3>' + (f.id ? '编辑 MCP' : '新建 MCP') + '</h3>' +
    '<div class="frow"><div><label>名称</label><input type="text" id="fName" value="' + esc(f.name) + '"></div>' +
    '<div><label>类型</label><select id="fType">' + ['stdio','http','sse'].map((t) =>
      '<option value="' + t + '"' + (f.type === t ? ' selected' : '') + '>' + t + '</option>').join('') + '</select></div></div>' +
    (isStdio
      ? '<div class="frow"><div><label>命令</label><input type="text" id="fCmd" value="' + esc(f.command || '') + '"></div>' +
        '<div><label>参数（空格分隔）</label><input type="text" id="fArgs" value="' + esc((f.args || []).join(' ')) + '"></div></div>' +
        '<label>环境变量（每行 KEY=VAL）</label><textarea id="fEnv" style="min-height:60px">' +
        esc(Object.entries(f.env || {}).map(([k, v]) => k + '=' + v).join('\\n')) + '</textarea>'
      : '<div class="frow"><div><label>URL</label><input type="text" id="fUrl" value="' + esc(f.url || '') + '"></div></div>' +
        '<label>headers（每行 KEY: VAL）</label><textarea id="fHeaders" style="min-height:60px">' +
        esc(Object.entries(f.headers || {}).map(([k, v]) => k + ': ' + v).join('\\n')) + '</textarea>') +
    '<div class="frow"><div><label>备注</label><input type="text" id="fNote" value="' + esc(f.note || '') + '"></div>' +
    '<div><label>&nbsp;</label><label style="display:flex;gap:6px;align-items:center;margin-top:8px"><input type="checkbox" id="fEnabled" style="width:auto"' + (f.enabled ? ' checked' : '') + '> 新建会话默认勾选</label></div></div>' +
    '<div class="btns"><button class="go" onclick="submitMcp()">保存</button>' +
    '<button class="act" onclick="closeMcpForm()">取消</button></div></form>';
}

function renderSkill() {
  let h = '';
  if (state.skillForm) h += skillFormHtml();
  const mounts = state.skills.mounts || [];
  if (mounts.length) {
    h += '<div class="row" style="flex-wrap:wrap">' + mounts.map((mm) =>
      '<span class="pill' + (mm.totalTokens > 1500 ? ' warn' : '') + '">' + esc(harnessLabel(mm.harnessId)) + ' ~' + mm.totalTokens + ' tok</span>'
    ).join(' ') + '<span class="sub" style="margin:0">常驻技能超 1500 tok 会稀释上下文，挂载按需取舍</span></div>';
  }
  h += '<div class="row" style="padding:6px 12px"><label style="margin:0">挂载目标 harness：</label>' +
    '<select id="targetSel" style="width:auto" onchange="state.target=this.value">' +
    state.harnesses.map((hh) => '<option value="' + esc(hh.id) + '"' + (state.target === hh.id ? ' selected' : '') + '>' + esc(hh.label) + '</option>').join('') +
    '</select><span style="flex:1"></span><button class="act" onclick="newSkill()">＋ 新建技能</button></div>';
  const lib = state.skills.library || [];
  if (!lib.length) { h += '<div class="empty">技能库是空的（~/.harnessgate/skills）。</div>'; return h; }
  for (const sk of lib) {
    const on = (sk.mountedOn || []).includes(state.target);
    h += '<div class="row">' +
      '<div class="main"><b>' + esc(sk.name) + '</b> <span class="pill">~' + (sk.tokens ?? 0) + ' tok</span>' +
      (sk.description ? '<div class="sub">' + esc(sk.description) + '</div>' : '') +
      ((sk.mountedOn || []).length ? mountChips(sk.mountedOn) : '') + '</div>' +
      '<button class="act" onclick="toggleMount(\\'' + esc(sk.name) + '\\',' + (on ? 'false' : 'true') + ')">' + (on ? '从目标卸载' : '挂载到目标') + '</button>' +
      '<button class="act" onclick="editSkill(\\'' + esc(sk.name) + '\\')">编辑</button>' +
      '<button class="act" onclick="delSkill(\\'' + esc(sk.name) + '\\')">' + (confirmKey === 'skill:' + sk.name ? '确认删除？' : '删除') + '</button>' +
      '</div>';
  }
  return h;
}

function skillFormHtml() {
  const f = state.skillForm;
  return '<form onsubmit="return false"><h3>' + (f.renameFrom ? '编辑技能：' + esc(f.renameFrom) : '新建技能') + '</h3>' +
    '<div class="frow"><div><label>名称（字母/数字/._-，≤64）</label><input type="text" id="sName" value="' + esc(f.name) + '"></div>' +
    '<div><label>描述（进系统提示词，≤600 字）</label><input type="text" id="sDesc" value="' + esc(f.description) + '"></div></div>' +
    '<label>正文（Markdown）</label><textarea id="sBody">' + esc(f.body) + '</textarea>' +
    '<div class="btns"><button class="go" onclick="submitSkill()">保存</button>' +
    '<button class="act" onclick="closeSkillForm()">取消</button></div>' +
    '<p class="hint">重命名：改名称后保存即可（服务端按 renameFrom 迁移）。</p></form>';
}

function harnessLabel(id) {
  const h = state.harnesses.find((x) => x.id === id);
  return h ? h.label : id;
}

function render() {
  $('tabMcp').className = 'tab' + (state.tab === 'mcp' ? ' on' : '');
  $('tabSkill').className = 'tab' + (state.tab === 'skill' ? ' on' : '');
  $('wrap').innerHTML = state.tab === 'mcp' ? renderMcp() : renderSkill();
}

/* 表单动作（挂在 window 上供 onclick 使用） */
window.newMcp = () => { state.mcpForm = { id:'', name:'', type:'stdio', command:'', args:[], env:{}, url:'', headers:{}, note:'', enabled:true }; render(); };
window.editMcp = (id) => { const s = state.mcps.find((x) => x.id === id); if (s) { state.mcpForm = JSON.parse(JSON.stringify(s)); render(); } };
window.closeMcpForm = () => { state.mcpForm = null; render(); };
window.toggleMcp = (id) => {
  const s = state.mcps.find((x) => x.id === id); if (!s) return;
  vscode.postMessage({ cmd:'saveMcp', server: { ...s, enabled: !s.enabled } });
};
/* webview 里 confirm/alert 不可用：删除走两步确认（再点一次执行，4s 后自动解除） */
let confirmKey = null, confirmTimer = null;
function armConfirm(key, fn) {
  if (confirmKey === key) { confirmKey = null; clearTimeout(confirmTimer); fn(); return; }
  confirmKey = key;
  clearTimeout(confirmTimer);
  confirmTimer = setTimeout(() => { confirmKey = null; render(); }, 4000);
  render();
}
window.delMcp = (id) => armConfirm('mcp:' + id, () => vscode.postMessage({ cmd:'deleteMcp', id }));
window.submitMcp = () => {
  const f = state.mcpForm || {};
  const type = $('fType').value;
  const server = {
    id: f.id || undefined, name: $('fName').value.trim(), type,
    note: $('fNote').value.trim() || undefined, enabled: $('fEnabled').checked,
  };
  if (type === 'stdio') {
    server.command = $('fCmd').value.trim();
    server.args = $('fArgs').value.trim() ? $('fArgs').value.trim().split(/\\s+/) : undefined;
    const env = {};
    $('fEnv').value.split('\\n').map((l) => l.trim()).filter(Boolean).forEach((l) => {
      const i = l.indexOf('='); if (i > 0) env[l.slice(0, i)] = l.slice(i + 1);
    });
    server.env = Object.keys(env).length ? env : undefined;
  } else {
    server.url = $('fUrl').value.trim();
    const headers = {};
    $('fHeaders').value.split('\\n').map((l) => l.trim()).filter(Boolean).forEach((l) => {
      const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim()] = l.slice(i + 1).trim();
    });
    server.headers = Object.keys(headers).length ? headers : undefined;
  }
  if (!server.name) return;
  vscode.postMessage({ cmd:'saveMcp', server });
  state.mcpForm = null; render();
};
window.newSkill = () => { state.skillForm = { name:'', description:'', body:'', renameFrom:'' }; render(); };
window.editSkill = (name) => {
  const sk = (state.skills.library || []).find((x) => x.name === name); if (!sk) return;
  state.skillForm = { name: sk.name, description: sk.description || '', body:'', renameFrom: sk.name };
  render();
  vscode.postMessage({ cmd:'readSkill', name });
};
window.closeSkillForm = () => { state.skillForm = null; render(); };
window.submitSkill = () => {
  const f = state.skillForm || {};
  const skill = { name: $('sName').value.trim(), description: $('sDesc').value.trim(), body: $('sBody').value };
  if (f.renameFrom && f.renameFrom !== skill.name) skill.renameFrom = f.renameFrom;
  if (!skill.name) return;
  vscode.postMessage({ cmd:'saveSkill', skill });
  state.skillForm = null; render();
};
window.delSkill = (name) => armConfirm('skill:' + name, () => vscode.postMessage({ cmd:'deleteSkill', name }));
window.toggleMount = (name, on) => {
  if (!state.target) return;
  vscode.postMessage({ cmd:'mount', name, harnessId: state.target, on });
};
</script></body></html>`;
  }
}

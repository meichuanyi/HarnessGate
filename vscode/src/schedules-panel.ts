import * as vscode from "vscode";
import type { Store } from "./store.ts";
import type { GateClient } from "./client.ts";
import type { Schedule, WorkspaceReport } from "./protocol.ts";

/** 定时任务 + 工作区归因：两个轻量 webview 面板（只读为主，操作走命令回发）。
 *  沿用 RoomPanel 的消息直通模式：webview postMessage → client.send。 */

const CSS = `
  body { font-family: var(--vscode-font-family); padding: 12px; color: var(--vscode-foreground); font-size: 13px; }
  h3 { font-size: 12px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .05em; margin: 14px 0 6px; }
  .row { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }
  .row .t1 { font-weight: 600; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 11.5px; margin-top: 2px; }
  .btn { cursor: pointer; color: var(--vscode-textLink-foreground); margin-right: 10px; }
  .warn { color: var(--vscode-editorWarning-foreground); }
  .ok { color: var(--vscode-charts-green); }
  .empty { color: var(--vscode-descriptionForeground); padding: 20px 0; text-align: center; }
`;

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? "");
}

function cadenceDesc(c: Schedule["cadence"]): string {
  if (c.type === "daily") return `每天 ${c.at}`;
  if (c.type === "interval") return `每 ${c.everyMinutes} 分钟`;
  if (c.type === "weekly") return `每周${(c.days ?? []).map((d) => "日一二三四五六"[d] ?? d).join("/")} ${c.at}`;
  return `cron: ${c.expr}`;
}

const LAST_STATUS: Record<string, string> = {
  ok: "✓ 成功",
  error: "✕ 出错",
  "contract-fail": "✕ 契约未满足",
  timeout: "⏱ 超时",
  "skipped-running": "跳过（上次仍在跑）",
  "missing-files": "✕ 缺前置文件",
};

export class SchedulesPanel {
  private static instance?: SchedulesPanel;

  static reveal(): SchedulesPanel {
    this.instance ??= new SchedulesPanel();
    this.instance.panel.reveal();
    this.instance.render();
    return this.instance;
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor() {
    this.panel = vscode.window.createWebviewPanel("hg-schedules", "⏰ 定时任务", vscode.ViewColumn.One, { enableScripts: true });
    this.panel.onDidDispose(() => (SchedulesPanel.instance = undefined));
  }

  attach(client: GateClient, store: Store): void {
    this.panel.webview.onDidReceiveMessage((m: { cmd: string; id?: string }) => {
      if (m.cmd === "run" && m.id) client.send({ type: "schedule-run", id: m.id });
      if (m.cmd === "del" && m.id && store) client.send({ type: "schedule-delete", id: m.id });
      if (m.cmd === "refresh") client.send({ type: "schedules-list" });
    });
    store.onChange(() => this.render());
  }

  render(): void {
    if (!this.panel.visible) return;
    const list = schedulesData ?? [];
    const rows = list
      .map((s) => {
        const st = s.state ?? {};
        const parts = [
          cadenceDesc(s.cadence),
          st.nextFireAt ? `下次 ${st.nextFireAt.replace("T", " ").slice(5, 16)}` : "",
          st.lastRunAt ? `上次 ${LAST_STATUS[st.lastStatus ?? ""] ?? ""}` : "",
          st.consecutiveFailures ? `<span class="warn">⚠ 连续失败 ${st.consecutiveFailures}</span>` : "",
        ].filter(Boolean);
        return `<div class="row">
          <div class="t1">${esc(s.name)}${s.enabled ? "" : ' <span class="meta">（已停用）</span>'}${st.running ? ' <span class="ok">运行中…</span>' : ""}</div>
          <div class="meta">${esc(s.harnessId)} · ${parts.join(" · ")}</div>
          <div style="margin-top:4px">
            <span class="btn" data-cmd="run" data-id="${esc(s.id)}">▶ 立即运行</span>
            <span class="btn" data-cmd="del" data-id="${esc(s.id)}">删除</span>
            <span class="btn" data-cmd="refresh">刷新</span>
          </div>
        </div>`;
      })
      .join("");
    this.panel.webview.html = `<html><head><style>${CSS}</style></head><body>
      <h3>定时任务（${list.length}）· 创建与编辑在网页端</h3>
      ${rows || '<div class="empty">还没有定时任务。在网页端「定时」页创建（含从会话蒸馏）。</div>'}
      <script>
        document.addEventListener("click", (e) => {
          const el = e.target.closest("[data-cmd]");
          if (el) vscode.postMessage({ cmd: el.dataset.cmd, id: el.dataset.id });
        });
        const vscode = acquireVsCodeApi();
      </script>
    </body></html>`;
  }
}

/** schedules 数据由 extension.ts 在 store 变更时同步到这里（避免循环依赖） */
export let schedulesData: Schedule[] | null = null;
export function setSchedulesData(list: Schedule[]): void {
  schedulesData = list;
}

export class WorkspacePanel {
  private static instance?: WorkspacePanel;

  static reveal(): WorkspacePanel {
    this.instance ??= new WorkspacePanel();
    this.instance.panel.reveal();
    this.instance.render();
    return this.instance;
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor() {
    this.panel = vscode.window.createWebviewPanel("hg-workspace", "🗂 工作区归因", vscode.ViewColumn.One, { enableScripts: true });
    this.panel.onDidDispose(() => (WorkspacePanel.instance = undefined));
  }

  attach(client: GateClient, store: Store): void {
    this.panel.webview.onDidReceiveMessage((m: { cmd: string }) => {
      if (m.cmd === "refresh") client.send({ type: "workspace" });
    });
    store.onChange(() => this.render());
  }

  render(): void {
    if (!this.panel.visible) return;
    const reports = workspaceData;
    if (!reports) {
      this.panel.webview.html = `<html><head><style>${CSS}</style></head><body><div class="empty">加载中…（若无响应，服务端可能是旧版本）</div></body></html>`;
      return;
    }
    const blocks = reports
      .map((r: WorkspaceReport) => {
        const sess = r.sessions
          .map(
            (s) =>
              `<div class="meta">${s.inTurn ? "🟢" : s.live ? "🔵" : "⚪"} ${esc(s.harnessLabel)}${s.inTurn ? " 正在干活" : ""} · ${s.mode === "worktree" ? `worktree ${esc(s.branch ?? "")}` : "共享目录"}${(s.changedFiles ?? []).length ? ` · 改动 ${(s.changedFiles ?? []).length} 个文件` : ""}</div>`,
          )
          .join("");
        const files = r.files
          .slice(0, 50)
          .map(
            (f) =>
              `<div class="meta">${f.conflict ? "⚠️ " : ""}${esc(f.rel)} <span style="opacity:.6">${[...new Set(f.touches.map((t) => t.harnessId))].join("+")} · ${f.touches.length} 次</span></div>`,
          )
          .join("");
        return `<h3>${esc(r.cwd)}${r.conflicts ? ` <span class="warn">冲突 ${r.conflicts}</span>` : ""}</h3>${sess}${files ? '<h3>文件改动归因</h3>' + files : ""}`;
      })
      .join("");
    this.panel.webview.html = `<html><head><style>${CSS}</style></head><body>
      ${blocks || '<div class="empty">还没有活跃工作区</div>'}
      <p><span class="btn" data-cmd="refresh">刷新</span></p>
      <script>
        const vscode = acquireVsCodeApi();
        document.addEventListener("click", (e) => {
          const el = e.target.closest("[data-cmd]");
          if (el) vscode.postMessage({ cmd: el.dataset.cmd });
        });
      </script>
    </body></html>`;
  }
}

export let workspaceData: WorkspaceReport[] | null = null;
export function setWorkspaceData(list: WorkspaceReport[]): void {
  workspaceData = list;
}

import * as vscode from "vscode";
import type { GateClient } from "./client.ts";
import type { Store } from "./store.ts";
import type { GoalView, MindwtrTaskView, SpeculativePrescription } from "./protocol.ts";

/**
 * 目标系统（Goals）与生活运转看板 Webview Panel。
 *
 * 核心卡片：
 * 1. ☕ 今日生活与日常运转 (Life Ops)：
 *    - 展示待办标题、时间、标签
 *    - 点击「✓ 完成」发送 goal-task-complete
 *    - 展示前瞻推演处方（若有 reschedule_task 支持一键顺延发送 goal-task-reschedule）
 * 2. 🎯 目标推进与罗盘：
 *    - 展示目标卡片列表（分类、标题、进度条、状态、关联任务打勾推进）
 */

const CSS = `
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-foreground);
    --desc: var(--vscode-descriptionForeground);
    --border: var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
    --card-bg: var(--vscode-sideBar-background, rgba(255, 255, 255, 0.03));
    --subcard-bg: var(--vscode-editorWidget-background, rgba(0, 0, 0, 0.2));
    --blue: var(--vscode-charts-blue, #58a6ff);
    --green: var(--vscode-charts-green, #3fb950);
    --yellow: var(--vscode-charts-yellow, #d29922);
    --red: var(--vscode-charts-red, #f85149);
    --btn-bg: var(--vscode-button-secondaryBackground, #21262d);
    --btn-fg: var(--vscode-button-secondaryForeground, #c9d1d9);
    --btn-hover: var(--vscode-button-secondaryHoverBackground, #30363d);
  }
  body {
    font-family: var(--vscode-font-family);
    background: var(--bg);
    color: var(--fg);
    font-size: 13px;
    padding: 16px 20px 40px;
    margin: 0;
    box-sizing: border-box;
    line-height: 1.5;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 18px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }
  .header h2 {
    font-size: 16px;
    font-weight: 600;
    margin: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .btn-action {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: var(--btn-bg);
    color: var(--btn-fg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
    user-select: none;
    transition: background 0.15s;
  }
  .btn-action:hover {
    background: var(--btn-hover);
  }
  .section-card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 20px;
  }
  .section-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 14px;
  }
  .section-badge {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--subcard-bg);
    border: 1px solid var(--border);
    color: var(--desc);
    font-weight: normal;
  }
  .task-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .task-item {
    border-bottom: 1px solid var(--border);
    padding-bottom: 12px;
  }
  .task-item:last-child {
    border-bottom: none;
    padding-bottom: 0;
  }
  .task-main {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }
  .btn-complete {
    flex-shrink: 0;
    margin-top: 1px;
    background: rgba(63, 185, 80, 0.12);
    color: var(--green);
    border: 1px solid rgba(63, 185, 80, 0.35);
    border-radius: 4px;
    padding: 3px 8px;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
    user-select: none;
  }
  .btn-complete:hover {
    background: rgba(63, 185, 80, 0.25);
  }
  .btn-complete:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .task-content {
    flex: 1;
    min-width: 0;
  }
  .task-title {
    font-weight: 500;
    color: var(--fg);
    word-break: break-word;
  }
  .task-notes {
    font-size: 12px;
    color: var(--desc);
    margin-top: 3px;
    line-height: 1.4;
    word-break: break-word;
  }
  .task-meta {
    flex-shrink: 0;
    text-align: right;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
  }
  .task-time {
    font-size: 11px;
    color: var(--desc);
    display: flex;
    align-items: center;
    gap: 3px;
  }
  .task-tags {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .task-tag {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--subcard-bg);
    border: 1px solid var(--border);
    color: var(--desc);
  }
  .prescription-box {
    margin-top: 8px;
    background: var(--subcard-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 12px;
    font-size: 12px;
  }
  .prescription-box.warning {
    border-color: rgba(210, 153, 34, 0.45);
    background: rgba(210, 153, 34, 0.05);
  }
  .prescription-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .prescription-badge {
    font-size: 10.5px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 3px;
  }
  .prescription-badge.ready {
    background: rgba(63, 185, 80, 0.15);
    color: var(--green);
    border: 1px solid rgba(63, 185, 80, 0.4);
  }
  .prescription-badge.warning {
    background: rgba(210, 153, 34, 0.15);
    color: var(--yellow);
    border: 1px solid rgba(210, 153, 34, 0.4);
  }
  .prescription-badge.optimized {
    background: rgba(88, 166, 255, 0.15);
    color: var(--blue);
    border: 1px solid rgba(88, 166, 255, 0.4);
  }
  .prescription-summary {
    font-weight: 500;
    color: var(--fg);
    flex: 1;
  }
  .evidence-list {
    margin: 6px 0 0;
    padding-left: 0;
    list-style: none;
    font-size: 11px;
    color: var(--desc);
  }
  .evidence-list li {
    margin-bottom: 2px;
    display: flex;
    gap: 4px;
  }
  .prescription-actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
    flex-wrap: wrap;
  }
  .btn-reschedule {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: rgba(88, 166, 255, 0.12);
    color: var(--blue);
    border: 1px solid rgba(88, 166, 255, 0.35);
    border-radius: 4px;
    padding: 4px 10px;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;
    user-select: none;
  }
  .btn-reschedule:hover {
    background: rgba(88, 166, 255, 0.22);
  }
  .btn-reschedule:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Goal Card Styles */
  .goal-card {
    background: var(--subcard-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px;
    margin-bottom: 12px;
  }
  .goal-card:last-child {
    margin-bottom: 0;
  }
  .goal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .goal-badges {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .goal-category-badge {
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 4px;
    background: var(--card-bg);
    border: 1px solid var(--border);
    color: var(--fg);
  }
  .goal-status-badge {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 4px;
  }
  .goal-status-badge.active {
    background: rgba(88, 166, 255, 0.15);
    color: var(--blue);
    border: 1px solid rgba(88, 166, 255, 0.3);
  }
  .goal-status-badge.completed {
    background: rgba(63, 185, 80, 0.15);
    color: var(--green);
    border: 1px solid rgba(63, 185, 80, 0.3);
  }
  .goal-status-badge.paused {
    background: rgba(210, 153, 34, 0.15);
    color: var(--yellow);
    border: 1px solid rgba(210, 153, 34, 0.3);
  }
  .goal-status-badge.archived {
    background: rgba(128, 128, 128, 0.15);
    color: var(--desc);
    border: 1px solid rgba(128, 128, 128, 0.3);
  }
  .goal-percent {
    font-size: 14px;
    font-weight: 700;
    color: var(--blue);
  }
  .goal-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--fg);
    margin-bottom: 6px;
  }
  .goal-desc {
    font-size: 12px;
    color: var(--desc);
    margin-bottom: 10px;
    line-height: 1.4;
  }
  .progress-track {
    height: 6px;
    background: rgba(255, 255, 255, 0.08);
    border-radius: 3px;
    overflow: hidden;
    margin-bottom: 8px;
  }
  .progress-fill {
    height: 100%;
    background: var(--blue);
    border-radius: 3px;
    transition: width 0.3s;
  }
  .progress-fill.done {
    background: var(--green);
  }
  .goal-meta {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 11px;
    color: var(--desc);
    margin-bottom: 8px;
    flex-wrap: wrap;
  }
  .goal-meta .cwd {
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .speculated-result {
    margin-top: 8px;
    padding: 6px 10px;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 11.5px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .speculated-result.ok {
    border-color: rgba(63, 185, 80, 0.3);
    color: var(--green);
  }
  .speculated-result.fail {
    border-color: rgba(248, 81, 73, 0.3);
    color: var(--red);
  }
  .linked-tasks-toggle {
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: pointer;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--blue);
    user-select: none;
  }
  .linked-tasks-list {
    margin-top: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-left: 4px;
  }
  .empty-box {
    text-align: center;
    padding: 24px 0;
    color: var(--desc);
    font-size: 13px;
  }
`;

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? "");
}

function formatTime(startTime?: string, dueDate?: string): string {
  const v = startTime ?? dueDate;
  if (!v) return "";
  try {
    const d = new Date(v);
    if (isNaN(d.getTime())) return v;
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const h = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${m}-${day} ${h}:${min}`;
  } catch {
    return v;
  }
}

function categoryLabel(cat?: string): string {
  switch (cat) {
    case "career":
      return "💼 事业";
    case "academic":
      return "🎓 学业";
    case "trading":
      return "📈 交易";
    case "life":
      return "🌱 生活";
    default:
      return "🧭 通用";
  }
}

function statusLabel(status?: string): { text: string; cls: string } {
  switch (status) {
    case "completed":
      return { text: "已完成", cls: "completed" };
    case "paused":
      return { text: "已暂停", cls: "paused" };
    case "archived":
      return { text: "已归档", cls: "archived" };
    default:
      return { text: "进行中", cls: "active" };
  }
}

function prescriptionBadge(status?: string): { text: string; cls: string } {
  switch (status) {
    case "warning":
      return { text: "⚠ 建议调优", cls: "warning" };
    case "optimized":
      return { text: "⚡ 节奏校准", cls: "optimized" };
    case "ready":
      return { text: "✓ 推演通过", cls: "ready" };
    default:
      return { text: "前瞻推演", cls: "ready" };
  }
}

/** 目标与日常运转数据缓存（避免组件间循环依赖） */
export let goalsData: GoalView[] | null = null;
export let lifeTasksData: MindwtrTaskView[] | null = null;

export function setGoalsData(goals: GoalView[], lifeTasks: MindwtrTaskView[]): void {
  goalsData = goals;
  lifeTasksData = lifeTasks;
}

export class GoalsPanel {
  private static instance?: GoalsPanel;

  static reveal(client: GateClient, store: Store): GoalsPanel {
    if (this.instance) {
      this.instance.panel.reveal(vscode.ViewColumn.Beside);
      this.instance.refresh();
      return this.instance;
    }
    this.instance = new GoalsPanel(client, store);
    return this.instance;
  }

  static show(client: GateClient, store: Store): GoalsPanel {
    return this.reveal(client, store);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private goals: GoalView[] = [];
  private lifeTasks: MindwtrTaskView[] = [];
  private readonly expandedGoalIds = new Set<string>();
  private loaded = false;

  private constructor(
    private readonly client: GateClient,
    private readonly store: Store,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "hg-goals",
      "🎯 目标看板与生活运转",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => {
      GoalsPanel.instance = undefined;
      for (const d of this.disposables) d.dispose();
      this.client.off("goals", this.onGoalsMsg);
    });

    // 监听 Webview 的用户操作
    this.panel.webview.onDidReceiveMessage((m: {
      cmd: string;
      taskId?: string;
      goalId?: string;
      dueDate?: string;
      startTime?: string;
      label?: string;
    }) => {
      if (m.cmd === "complete" && m.taskId) {
        this.client.send({ type: "goal-task-complete", taskId: m.taskId, goalId: m.goalId });
        vscode.window.setStatusBarMessage(m.goalId ? "✓ 任务已打勾，目标进度推进中" : "✓ 任务已打勾完成", 3000);
      } else if (m.cmd === "reschedule" && m.taskId) {
        this.client.send({ type: "goal-task-reschedule", taskId: m.taskId, dueDate: m.dueDate, startTime: m.startTime });
        vscode.window.setStatusBarMessage(m.label ? `⚡ 已执行推演处方：${m.label}` : "⚡ 已执行推演处方：任务日程已顺延", 3000);
      } else if (m.cmd === "refresh") {
        this.refresh();
      }
    });

    // 监听 WebSocket 的 'goals' 消息
    this.client.on("goals", this.onGoalsMsg);

    // 监听全局 store 变更
    const storeSub = this.store.onChange(() => {
      if (this.store.goals.length > 0 || this.store.lifeTasks.length > 0) {
        this.syncFromStore();
        this.render();
      }
    });
    this.disposables.push(storeSub);

    // 同步现有 store 数据
    this.syncFromStore();

    // 初始化向 WebSocket 发送 { "type": "goals-get" }
    this.refresh();
  }

  private readonly onGoalsMsg = (msg: { goals?: GoalView[]; lifeTasks?: MindwtrTaskView[] }): void => {
    this.goals = msg.goals ?? [];
    this.lifeTasks = msg.lifeTasks ?? [];
    this.loaded = true;
    this.initExpandedState();
    this.render();
  };

  private syncFromStore(): void {
    if (this.store.goals.length > 0 || this.store.lifeTasks.length > 0) {
      this.goals = this.store.goals;
      this.lifeTasks = this.store.lifeTasks;
      this.loaded = true;
      this.initExpandedState();
    } else if (goalsData) {
      this.goals = goalsData;
      this.lifeTasks = lifeTasksData ?? [];
      this.loaded = true;
      this.initExpandedState();
    }
  }

  private initExpandedState(): void {
    for (const g of this.goals) {
      if (g.linkedTasks && g.linkedTasks.length > 0 && !this.expandedGoalIds.has(g.id)) {
        this.expandedGoalIds.add(g.id);
      }
    }
  }

  refresh(): void {
    this.client.send({ type: "goals-get" });
    this.render();
  }

  private renderTask(t: MindwtrTaskView, goalId?: string): string {
    const time = formatTime(t.startTime, t.dueDate);
    const tags = t.tags ?? [];
    const p = t.prescription;

    let prescriptionHtml = "";
    if (p) {
      const badge = prescriptionBadge(p.status);
      const isWarn = p.status === "warning";
      const perceptions = p.evidence?.perceptions ?? [];
      const memories = p.evidence?.memories ?? [];
      const actions = p.actions ?? [];

      const evidenceList = [
        ...perceptions.map((e) => `<li>• ${esc(e)}</li>`),
        ...memories.map((m) => `<li>• ${esc(m)}</li>`),
      ].join("");

      const actionsHtml = actions
        .map((act) => {
          if (act.actionType === "reschedule_task") {
            const dueDate = act.payload?.dueDate ?? "";
            const startTime = act.payload?.startTime ?? "";
            const label = act.label || "一键顺延";
            return `<button class="btn-reschedule" data-action="reschedule" data-task-id="${esc(t.id)}" data-due="${esc(dueDate)}" data-start="${esc(startTime)}" data-label="${esc(label)}">⚡ ${esc(label)}</button>`;
          }
          return `<span class="task-tag">${esc(act.label)}</span>`;
        })
        .join("");

      prescriptionHtml = `
        <div class="prescription-box ${isWarn ? "warning" : ""}">
          <div class="prescription-header">
            <span class="prescription-badge ${badge.cls}">${badge.text}</span>
            <span class="prescription-summary">${esc(p.summary)}</span>
          </div>
          ${evidenceList ? `<ul class="evidence-list">${evidenceList}</ul>` : ""}
          ${actionsHtml ? `<div class="prescription-actions">${actionsHtml}</div>` : ""}
        </div>
      `;
    }

    return `
      <div class="task-item">
        <div class="task-main">
          <button class="btn-complete" data-action="complete" data-task-id="${esc(t.id)}" ${goalId ? `data-goal-id="${esc(goalId)}"` : ""}>✓ 完成</button>
          <div class="task-content">
            <div class="task-title">${esc(t.title)}</div>
            ${t.notes ? `<div class="task-notes">${esc(t.notes)}</div>` : ""}
          </div>
          <div class="task-meta">
            ${time ? `<div class="task-time"><span>⏱</span> ${esc(time)}</div>` : ""}
            ${tags.length ? `<div class="task-tags">${tags.map((tag) => `<span class="task-tag">${esc(tag.replace(/^#/, ""))}</span>`).join("")}</div>` : ""}
          </div>
        </div>
        ${prescriptionHtml}
      </div>
    `;
  }

  private renderGoal(g: GoalView): string {
    const cat = categoryLabel(g.category);
    const st = statusLabel(g.status);
    const progress = Math.min(100, Math.max(0, Math.round(Number(g.progress) || 0)));
    const linked = g.linkedTasks ?? [];
    const isExpanded = this.expandedGoalIds.has(g.id);
    const spec = g.lastSpeculatedResult;

    let specHtml = "";
    if (spec) {
      const isOk = spec.ok;
      const text = spec.summary || (isOk ? "沙箱试错完毕，意图对齐" : "发现落差，需调优");
      specHtml = `
        <div class="speculated-result ${isOk ? "ok" : "fail"}">
          <span>${isOk ? "✓" : "⚠"}</span>
          <span>前瞻推演${isOk ? "通过" : "预警"}：${esc(text)}</span>
        </div>
      `;
    }

    let linkedHtml = "";
    if (linked.length > 0) {
      const taskRows = linked.map((t) => this.renderTask(t, g.id)).join("");
      linkedHtml = `
        <div class="linked-tasks-toggle" data-action="toggle-tasks" data-goal-id="${esc(g.id)}">
          <span>🔗 关联支撑任务 (${linked.length})</span>
          <span class="arrow">${isExpanded ? "▲" : "▼"}</span>
        </div>
        <div class="linked-tasks-list" id="linked-${esc(g.id)}" style="display: ${isExpanded ? "flex" : "none"}">
          ${taskRows}
        </div>
      `;
    }

    return `
      <div class="goal-card">
        <div class="goal-header">
          <div class="goal-badges">
            <span class="goal-category-badge">${cat}</span>
            <span class="goal-status-badge ${st.cls}">${st.text}</span>
          </div>
          <span class="goal-percent">${progress}%</span>
        </div>
        <div class="goal-title">${esc(g.title)}</div>
        ${g.description ? `<div class="goal-desc">${esc(g.description)}</div>` : ""}
        <div class="progress-track">
          <div class="progress-fill ${progress >= 100 ? "done" : ""}" style="width: ${progress}%"></div>
        </div>
        <div class="goal-meta">
          ${g.deadline ? `<span>截止: ${esc(g.deadline.split("T")[0])}</span>` : ""}
          ${g.cwd ? `<span class="cwd">目录: ${esc(g.cwd)}</span>` : ""}
        </div>
        ${specHtml}
        ${linkedHtml}
      </div>
    `;
  }

  render(): void {
    if (!this.panel.visible) return;

    const lifeTasksHtml = this.lifeTasks.length > 0
      ? `<div class="task-list">${this.lifeTasks.map((t) => this.renderTask(t)).join("")}</div>`
      : `<div class="empty-box">暂无待办琐事，生活运转平稳 ☕</div>`;

    const goalsHtml = this.goals.length > 0
      ? this.goals.map((g) => this.renderGoal(g)).join("")
      : `<div class="empty-box">还没有设定目标，前瞻推演将在此汇聚 🎯</div>`;

    this.panel.webview.html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>${CSS}</style>
</head>
<body>
  <div class="header">
    <h2>🎯 目标看板与生活运转</h2>
    <div class="header-actions">
      <button class="btn-action" data-action="refresh">🔄 刷新看板</button>
    </div>
  </div>

  <!-- 卡片一：☕ 今日生活与日常运转 (Life Ops) -->
  <div class="section-card">
    <div class="section-title">
      <span>☕ 今日生活与日常运转 (Life Ops)</span>
      <span class="section-badge">${this.lifeTasks.length} 项待办</span>
    </div>
    ${lifeTasksHtml}
  </div>

  <!-- 卡片二：🎯 目标推进与罗盘 -->
  <div class="section-card">
    <div class="section-title">
      <span>🎯 目标推进与罗盘</span>
      <span class="section-badge">${this.goals.length} 个目标</span>
    </div>
    ${goalsHtml}
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    document.addEventListener("click", (e) => {
      const target = e.target.closest("[data-action]");
      if (!target) return;
      const action = target.dataset.action;

      if (action === "complete") {
        const taskId = target.dataset.taskId;
        const goalId = target.dataset.goalId;
        target.disabled = true;
        target.textContent = "…";
        vscode.postMessage({ cmd: "complete", taskId, goalId });
      } else if (action === "reschedule") {
        const taskId = target.dataset.taskId;
        const dueDate = target.dataset.due;
        const startTime = target.dataset.start;
        const label = target.dataset.label;
        target.disabled = true;
        target.textContent = "顺延中…";
        vscode.postMessage({ cmd: "reschedule", taskId, dueDate, startTime, label });
      } else if (action === "refresh") {
        target.textContent = "刷新中…";
        vscode.postMessage({ cmd: "refresh" });
      } else if (action === "toggle-tasks") {
        const goalId = target.dataset.goalId;
        const el = document.getElementById("linked-" + goalId);
        const arrow = target.querySelector(".arrow");
        if (el) {
          const isHidden = el.style.display === "none";
          el.style.display = isHidden ? "flex" : "none";
          if (arrow) arrow.textContent = isHidden ? "▲" : "▼";
        }
      }
    });
  </script>
</body>
</html>`;
  }
}

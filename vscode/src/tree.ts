import * as vscode from "vscode";
import type { Store } from "./store.ts";
import type { HarnessAvailability, SessionInfo } from "./protocol.ts";

export type TreeNode = HarnessNode | SessionNode | InfoNode;

export class HarnessNode {
  readonly kind = "harness";
  constructor(readonly harness: HarnessAvailability) {}
}

export class SessionNode {
  readonly kind = "session";
  constructor(readonly session: SessionInfo) {}
}

export class InfoNode {
  readonly kind = "info";
  constructor(
    readonly label: string,
    readonly icon?: string,
    /** 点击节点执行的命令（如配置服务器地址） */
    readonly command?: string,
  ) {}
}

const STATUS_LABEL: Record<string, string> = {
  starting: "启动中",
  ready: "运行中",
  awaiting: "待审批",
  saved: "已归档",
  error: "错误",
  stopped: "已停止",
};

/** 侧栏树：harness（含可用性）→ 它名下的会话 */
export class HarnessTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private allCollapsed = false;
  /** VS Code 按节点 id 记住展开状态：同样的 id 刷新时 collapsibleState 会被忽略。
      折叠/展开按钮点击时换一代 id，强制 VS Code 重建节点并应用新状态。 */
  private gen = 0;

  constructor(
    private readonly store: Store,
    private readonly state: () => string,
  ) {
    store.onChange(() => this.emitter.fire());
  }

  refresh(): void {
    this.emitter.fire();
  }

  /** 一键折叠 / 展开所有 harness（树标题栏按钮） */
  collapseAll(): void {
    this.allCollapsed = true;
    this.gen++;
    this.emitter.fire();
  }

  expandAll(): void {
    this.allCollapsed = false;
    this.gen++;
    this.emitter.fire();
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === "harness") {
      const h = node.harness;
      const item = new vscode.TreeItem(
        h.label,
        this.allCollapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.id = `h:${h.id}#${this.gen}`;
      item.contextValue = "harness";
      item.description = h.available ? undefined : "未就绪";
      item.tooltip = new vscode.MarkdownString(
        [
          `**${h.label}**  \`${h.id}\``,
          "",
          h.version ? `版本：${h.version}` : "",
          h.binPath ? `路径：\`${h.binPath}\`` : "",
          h.note ? `\n${h.note}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
      // 可用性用图标区分：探活通过=绿色对勾，其余=灰色/警示
      item.iconPath = new vscode.ThemeIcon(
        h.state === "probed-ok" ? "pass-filled" : h.available ? "circle-outline" : "circle-slash",
        new vscode.ThemeColor(h.state === "probed-ok" ? "charts.green" : "disabledForeground"),
      );
      const count = this.store.sessionsOf(h.id).length;
      if (count) item.description = `${h.available ? "" : "未就绪 · "}${count} 个会话`;
      return item;
    }

    if (node.kind === "session") {
      const s = node.session;
      const item = new vscode.TreeItem(s.title || `(空会话 #${s.id})`, vscode.TreeItemCollapsibleState.None);
      item.id = `s:${s.id}#${this.gen}`;
      item.contextValue = s.live ? "session-live" : s.resumable ? "session-saved" : "session";
      item.description = `${STATUS_LABEL[s.status] ?? s.status} · ${s.cwd}`;
      item.tooltip = new vscode.MarkdownString(
        [
          `**${s.harnessLabel}** · \`#${s.id}\``,
          "",
          `目录：\`${s.cwd}\``,
          s.worktree ? `worktree：\`${s.worktree.branch}\`` : "",
          s.error ? `\n错误：${s.error}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
      item.iconPath = new vscode.ThemeIcon(
        s.status === "ready" ? "comment-discussion"
          : s.status === "error" ? "error"
            : s.status === "awaiting" ? "shield"
              : "comment",
      );
      item.command = { command: "harnessgate.openChat", title: "打开对话", arguments: [s.id] };
      return item;
    }

    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.contextValue = "info";
    if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
    if (node.command) item.command = { command: node.command, title: node.label };
    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) {
      if (this.state() !== "connected") {
        // 未连接时给出路：远程用户第一件事就是改服务地址
        return [
          new InfoNode("未连接服务 · 配置服务器地址…", "settings-gear", "harnessgate.configServer"),
          new InfoNode("重新连接", "plug", "harnessgate.connect"),
        ];
      }
      const list = this.store.harnesses
        .filter((h) => !h.blocked)
        .sort(
          (a, b) =>
            Number(b.available) - Number(a.available) ||
            this.store.sessionsOf(b.id).length - this.store.sessionsOf(a.id).length ||
            a.label.localeCompare(b.label),
        );
      if (!list.length) return [new InfoNode("没有可用的 harness", "info")];
      return list.map((h) => new HarnessNode(h));
    }
    if (node.kind === "harness") {
      const ss = this.store.sessionsOf(node.harness.id);
      if (!ss.length) return [new InfoNode("还没有会话", "dash")];
      return ss.map((s) => new SessionNode(s));
    }
    return [];
  }
}

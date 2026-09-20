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
  constructor(readonly label: string, readonly icon?: string) {}
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

  constructor(
    private readonly store: Store,
    private readonly state: () => string,
  ) {
    store.onChange(() => this.emitter.fire());
  }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === "harness") {
      const h = node.harness;
      const item = new vscode.TreeItem(h.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `h:${h.id}`;
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
      item.id = `s:${s.id}`;
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
    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) {
      if (this.state() !== "connected") {
        return [new InfoNode("未连接服务（点标题栏的插头图标重连）", "plug")];
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

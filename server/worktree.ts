import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { promisify } from "node:util";
import { join } from "node:path";

const run = promisify(execFile);

export type WorktreeInfo = { dir: string; branch: string; repo: string };

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], { timeout: 30_000 });
  return stdout.trim();
}

/** 找到目录所属的 git 仓库根；不是仓库返回 null */
export async function repoRoot(dir: string): Promise<string | null> {
  try {
    return await git(dir, ["rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
}

/**
 * 为一个会话创建隔离工作区（git worktree + 独立分支）。
 * 主工作区完全不受影响；改动落在 worktree 目录里，分支名可在 UI 看到，方便 merge。
 * 返回 null 表示这个工作区无法隔离（不是 git 仓库 / 仓库还没有任何提交）。
 */
export async function createWorktree(
  baseDir: string,
  sessionId: string,
  root = join(process.env.HOME ?? "/root", ".harnessgate", "worktrees"),
): Promise<WorktreeInfo | null> {
  const repo = await repoRoot(baseDir);
  if (!repo) return null;
  try {
    await git(repo, ["rev-parse", "HEAD"]); // 还没有提交的仓库无法建 worktree
  } catch {
    return null;
  }
  const dir = join(root, sessionId);
  mkdirSync(root, { recursive: true });
  if (existsSync(dir)) return { dir, branch: `hg/${sessionId}`, repo };
  const branch = `hg/${sessionId}`;
  await git(repo, ["worktree", "add", "-b", branch, dir]);
  return { dir, branch, repo };
}

/** 移除 worktree（分支保留，方便之后 merge 或手动删） */
export async function removeWorktree(info: WorktreeInfo): Promise<void> {
  try {
    await git(info.repo, ["worktree", "remove", "--force", info.dir]);
  } catch {
    /* 尽力而为 */
  }
}

/** worktree 的 diff 统计（未提交改动 + 未跟踪文件） */
export async function worktreeDiffStat(info: WorktreeInfo): Promise<string> {
  try {
    const stat = await git(info.dir, ["diff", "--stat"]);
    const untracked = await git(info.dir, ["ls-files", "--others", "--exclude-standard"]);
    const extra = untracked ? untracked.split("\n").map((f) => ` ${f} (未跟踪)`).join("\n") : "";
    return [stat, extra].filter(Boolean).join("\n");
  } catch {
    return "";
  }
}

/** 列出某会话 worktree 的改动摘要（供 UI 展示"这个会话改了什么"） */
export async function worktreeStatus(info: WorktreeInfo): Promise<string> {
  try {
    return await git(info.dir, ["status", "--short"]);
  } catch {
    return "";
  }
}

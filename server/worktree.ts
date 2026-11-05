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
 * 工作队前置准备：目录不是 git 仓库就自动初始化（git init + 首个空提交）。
 * 拆 worktree、按提交算 diff 都需要 HEAD，这些准备工作属于"管理者"的活，不该让人手工做。
 */
export async function ensureCrewRepo(dir: string): Promise<void> {
  if (await repoRoot(dir)) return;
  await git(dir, ["init"]);
  await run(
    "git",
    [
      "-C", dir,
      "-c", "user.email=harnessgate@local",
      "-c", "user.name=HarnessGate",
      "commit", "--allow-empty", "-m", "chore: 初始提交（工作队自动初始化）",
    ],
    { timeout: 30_000 },
  );
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

/**
 * 为指定目标获取或维护唯一的推演工作区（单目标单分支）。
 * 每个目标在仓库中只拥有一个固定的分支（hg/spec-${slug}）和沙箱目录。
 */
export async function ensureGoalWorktree(
  baseDir: string,
  goalId: string,
  root = join(process.env.HOME ?? "/root", ".harnessgate", "worktrees"),
): Promise<WorktreeInfo | null> {
  const repo = await repoRoot(baseDir);
  if (!repo) return null;
  try {
    await git(repo, ["rev-parse", "HEAD"]);
  } catch {
    return null;
  }
  const slug = goalId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "goal";
  const branch = `hg/spec-${slug}`;
  const dir = join(root, `spec-${slug}`);

  mkdirSync(root, { recursive: true });

  // 1. 如果工作树目录已存在，检查是否有效
  if (existsSync(dir)) {
    try {
      const top = await git(dir, ["rev-parse", "--show-toplevel"]);
      if (top === dir) {
        try {
          await git(dir, ["checkout", branch]);
        } catch {
          /* 忽略 */
        }
        return { dir, branch, repo };
      }
    } catch {
      try {
        await run("rm", ["-rf", dir]);
        await git(repo, ["worktree", "prune"]);
      } catch {
        /* 忽略 */
      }
    }
  }

  // 2. 检查分支是否已存在于该仓库
  let branchExists = false;
  try {
    await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    branchExists = true;
  } catch {
    branchExists = false;
  }

  // 3. 创建/关联工作树
  if (branchExists) {
    await git(repo, ["worktree", "add", dir, branch]);
  } else {
    await git(repo, ["worktree", "add", "-b", branch, dir]);
  }

  return { dir, branch, repo };
}

/** 还原推演工作区：回退到指定基线 commit 并彻底清除未跟踪临时文件 */
export async function resetWorktree(info: WorktreeInfo, baselineCommit?: string): Promise<void> {
  try {
    await git(info.dir, ["checkout", "-f", info.branch]);
    await git(info.dir, ["clean", "-ffd"]);
    if (baselineCommit) {
      await git(info.dir, ["reset", "--hard", baselineCommit]);
    } else {
      await git(info.dir, ["reset", "--hard", "HEAD"]);
    }
  } catch {
    /* 尽力而为 */
  }
}

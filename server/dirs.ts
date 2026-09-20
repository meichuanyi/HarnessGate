import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export type DirSuggestion = { name: string; path: string; git: boolean };

export type DirListing = {
  input: string;
  dir: string;
  exists: boolean;
  isDir: boolean;
  entries: DirSuggestion[];
  error?: string;
};

const MAX_ENTRIES = 20;

/**
 * 目录补全：把输入拆成「已确定的目录 + 待补全片段」，列出候选子目录。
 * 输入本身是已存在的目录时列出它的子目录（便于继续往下钻）；否则列出其父目录下
 * 名称包含该片段的目录。不存在的路径不算错——建会话时服务端会 mkdir -p。
 */
export function listDirs(rawInput: string, base: string): DirListing {
  const input = expandTilde(String(rawInput ?? "").trim());
  const abs = input ? (isAbsolute(input) ? input : resolve(base, input)) : base;
  let exists = false;
  let isDir = false;
  try {
    const st = statSync(abs);
    exists = true;
    isDir = st.isDirectory();
  } catch {
    /* 不存在：按待创建的路径处理 */
  }

  const dir = exists && isDir ? abs : dirname(abs);
  const frag = exists && isDir ? "" : basename(abs);

  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => isDirectoryEntry(dir, e))
      .map((e) => e.name);
  } catch (err) {
    // 路径不存在是正常情况（用户就是要新建它），不当错误报；只有真读不了才算错
    return {
      input,
      dir,
      exists,
      isDir,
      entries: [],
      error: exists ? (err instanceof Error ? err.message : String(err)) : undefined,
    };
  }

  const f = frag.toLowerCase();
  const matched = f ? names.filter((n) => n.toLowerCase().includes(f)) : names;
  matched.sort((a, b) => rank(a, f) - rank(b, f) || a.localeCompare(b));

  return {
    input,
    dir,
    exists,
    isDir,
    entries: matched.slice(0, MAX_ENTRIES).map((name) => ({
      name,
      path: join(dir, name),
      git: existsSync(join(dir, name, ".git")),
    })),
  };
}

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function isDirectoryEntry(
  dir: string,
  e: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean },
): boolean {
  if (e.isDirectory()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return statSync(join(dir, e.name)).isDirectory();
  } catch {
    return false;
  }
}

/** 前缀命中优先，其次普通目录，隐藏目录垫底 */
function rank(name: string, frag: string): number {
  if (frag && name.toLowerCase().startsWith(frag)) return 0;
  return name.startsWith(".") ? 2 : 1;
}

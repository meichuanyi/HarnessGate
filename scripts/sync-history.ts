#!/usr/bin/env node
/**
 * 手动同步各 harness 的历史会话（服务里启动时也会自动跑一次）
 *
 *   npm run sync-history                    # 增量：只导没导过/有变化的
 *   npm run sync-history -- --force         # 全部重新导入
 *   npm run sync-history -- --only zcode    # 只同步某个 harness
 *   npm run sync-history -- --include-tmp   # 连 /tmp 下的会话一起导
 *   npm run sync-history -- --include-self  # 连本工具目录下的会话一起导（默认当调试噪音跳过）
 */
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { HistorySync } from "../server/history.ts";
import { SessionStore } from "../server/store.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const dataDir = process.env.HG_DATA_DIR ?? join(homedir(), ".harnessgate");
const port = process.env.HG_PORT ?? "9830";

// 服务在跑就让它来同步（否则我们写文件会被服务内存里的旧状态覆盖）
async function tryViaService(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
  } catch {
    return false;
  }
  const q = new URLSearchParams();
  if (value("--only")) q.set("harnessId", value("--only")!);
  if (flag("--force")) q.set("force", "1");
  if (flag("--include-tmp")) q.set("includeTmp", "1");
  if (flag("--include-self")) q.set("includeSelf", "1");
  const res = await fetch(`http://127.0.0.1:${port}/sync-history?${q}`, { method: "POST" });
  const data = (await res.json()) as { summaries: Array<{ label: string; found: number; imported: number; updated: number; skipped: number }> };
  console.log("（通过运行中的服务同步）\n");
  console.log("harness            发现   新增   更新   跳过");
  for (const s of data.summaries) {
    console.log(`${s.label.padEnd(18)}${String(s.found).padStart(5)}${String(s.imported).padStart(7)}${String(s.updated).padStart(7)}${String(s.skipped).padStart(7)}`);
  }
  console.log(`\n共新增 ${data.summaries.reduce((a, s) => a + s.imported, 0)} 个会话`);
  return true;
}

if (await tryViaService()) process.exit(0);
console.log("（服务未运行，直接本地同步）");
const store = new SessionStore(join(dataDir, "sessions.json"));
const sync = new HistorySync(store, join(dataDir, "history-index.json"), undefined, (l) => console.log(`[history] ${l}`));

console.log(`可同步的历史源: ${sync.availableProviders().map((p) => `${p.id}(${p.label})`).join(", ") || "无"}`);
const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");   // 本工具目录（去掉尾斜杠，否则前缀匹配会失效）
const summaries = sync.run({
  harnessId: value("--only"),
  force: flag("--force"),
  includeTmp: flag("--include-tmp"),
  excludeDirs: flag("--include-self") ? [] : [ROOT],
});

console.log("\nharness            发现   新增   更新   跳过");
for (const s of summaries) {
  console.log(`${s.label.padEnd(18)}${String(s.found).padStart(5)}${String(s.imported).padStart(7)}${String(s.updated).padStart(7)}${String(s.skipped).padStart(7)}`);
}
const total = summaries.reduce((a, s) => a + s.imported, 0);
console.log(`\n共新增 ${total} 个会话；库里现在 ${store.all().length} 条`);

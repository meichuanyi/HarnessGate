#!/usr/bin/env node
/**
 * 一次性回填：全量扫描 fs-audit.log，把每个会话的 fs.change 文件清单
 * 合并进 sessions.json 的 changedFiles（改动面板的数据源）。
 * 用法：npm run backfill-changes
 */
import { createReadStream } from "node:fs";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

const AUDIT = join(homedir(), ".harnessgate", "fs-audit.log");
const STORE = join(homedir(), ".harnessgate", "sessions.json");
const bySess = new Map();
const rl = readline.createInterface({ input: createReadStream(AUDIT, { encoding: "utf8" }) });
let n = 0;
for await (const line of rl) {
  if (!line.includes('"fs.change"')) continue;
  try {
    const e = JSON.parse(line);
    const sid = e.session, p = e.path, ts = e.ts;
    if (!sid || !p) continue;
    let m = bySess.get(sid);
    if (!m) { m = new Map(); bySess.set(sid, m); }
    m.set(p, ts);   // 后写覆盖先写（保留最新时间）
    if (++n % 50000 === 0) console.log(`  已扫 ${n} 条…`);
  } catch { /* 坏行 */ }
}
console.log(`审计扫描完成：${bySess.size} 个会话有 fs.change 记录，共 ${n} 条`);

const store = JSON.parse(readFileSync(STORE, "utf8"));
const sessions = store.sessions ?? store;
let patched = 0;
for (const s of sessions) {
  const m = bySess.get(s.id);
  if (!m || !m.size) continue;
  const existing = new Map((s.changedFiles ?? []).map((c) => [c.path, c.ts]));
  for (const [p, ts] of m) existing.set(p, ts);
  s.changedFiles = [...existing.entries()]
    .sort((a, b) => b[1].localeCompare(a[1]))
    .slice(0, 500)
    .map(([path, ts]) => ({ path, ts }));
  patched++;
}
const tmp = STORE + ".tmp";
writeFileSync(tmp, JSON.stringify(store, null, 1));
renameSync(tmp, STORE);
console.log(`回填完成：${patched} 个会话的 changedFiles 已写入`);

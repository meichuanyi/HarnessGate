#!/usr/bin/env node
/**
 * inotify 泄漏修复的端到端验证：
 *   B（归一化）：/tmp/leak-fix 与 /tmp/leak-fix/ 两个会话 → 只应有 1 个 watch.start（归一化后的 cwd）
 *   A（exit 注销）：kill -9 会话 C 的 harness 子进程 → 应出现 watch.stop（以前永不关闭）
 *   顺带验证多成员空间：A+B 同目录，杀别的会话不影响；A、B 都删掉后 watcher 才关
 *
 * 断言全部基于审计台账（~/.harnessgate/fs-audit.log）。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const AUDIT = join(homedir(), ".harnessgate", "fs-audit.log");
const token = process.env.HG_TOKEN ?? readFileSync(join(homedir(), ".harnessgate", "token"), "utf8").trim();
const ws = new WebSocket(`ws://localhost:${process.env.HG_PORT ?? 9830}/ws?token=${encodeURIComponent(token)}`);

const T0 = Date.now();
const started = Date.now();
const sids = { A: null, B: null, C: null };
const fails = [];
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "✔" : "✘"} ${name}${extra ? "  " + extra : ""}`);
  if (!ok) fails.push(name);
};
const tail = (ms = 1500) => new Promise((r) => setTimeout(r, ms));

/** 取 T0 之后的 watch 事件 */
function events() {
  return readFileSync(AUDIT, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter((e) => e && e.ts && new Date(e.ts).getTime() >= T0 - 60_000 && String(e.op).startsWith("workspace.watch"));
}

const waitReady = (label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} 等就绪超时`)), 120_000);
  const onMsg = (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === "session" && m.session.id === sids[label] && m.session.status === "ready") {
      clearTimeout(timer); ws.off("message", onMsg); resolve(m.session);
    }
    if (m.type === "session" && m.session.id === sids[label] && m.session.status === "error") {
      clearTimeout(timer); ws.off("message", onMsg); reject(new Error(`${label} 起不来: ${m.session.error}`));
    }
  };
  ws.on("message", onMsg);
});

ws.on("error", (e) => { console.log("WS 错误", e.message); process.exit(1); });

ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === "session" && m.session.status === "ready" && !Object.values(sids).includes(m.session.id)) {
    // 记住按创建顺序：A→leak-fix，B→leak-fix/，C→leak-fix2
    if (sids.A === null && m.session.cwd === "/tmp/leak-fix") return;
  }
});

const ready = [];
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === "session" && m.session.status === "ready" && m.session.harnessId === "zcode"
      && /leak-fix/.test(m.session.cwd ?? "") && !ready.find((s) => s.id === m.session.id)) {
    ready.push(m.session);
  }
});

ws.on("open", async () => {
  try {
    const base = `/tmp/leak-fix-${Date.now().toString(36)}`;
    console.log(`① 创建 A（${base}）和 B（${base}/）——验证尾斜杠归一化`);
    const send = (o) => ws.send(JSON.stringify(o));
    send({ type: "create", harnessId: "zcode", cwd: base });
    await tail(600);
    send({ type: "create", harnessId: "zcode", cwd: `${base}/` });
    await tail(600);
    send({ type: "create", harnessId: "zcode", cwd: `${base}-2` });
    await tail(600);

    const deadline = Date.now() + 120_000;
    while (ready.length < 3 && Date.now() < deadline) await tail(500);
    if (ready.length < 3) throw new Error(`只有 ${ready.length}/3 个会话就绪`);
    const A = ready.find((s) => s.cwd === base);
    const B = ready.find((s) => s.cwd === `${base}/`);
    const C = ready.find((s) => s.cwd === `${base}-2`);
    sids.A = A.id; sids.B = B.id; sids.C = C.id;

    await tail(1000);
    const ev1 = events();
    const starts1 = ev1.filter((e) => e.op === "workspace.watch.start").map((e) => e.cwd);
    check("B 修复：两个尾斜杠变体只建 1 个 watcher",
      starts1.filter((c) => c === base).length === 1 && !starts1.some((c) => c.endsWith("/") && c.length > 1),
      JSON.stringify(starts1));
    check("B 修复：watch.start 的 cwd 是归一化后的（无尾斜杠）", !starts1.some((c) => c.endsWith("/") && c.length > 1));

    console.log("② kill -9 会话 C 的 harness 子进程——验证 exit 注销");
    const { execSync } = await import("node:child_process");
    // harness 子进程会被包装脚本 exec 改名（zcode-acp-zcode → node zcode-acp-server），
    // 按 cmdline 找不可靠；改扫 /proc 按 cwd 定位（cwd = 会话目录，全场唯一）
    const pids = execSync("ls /proc | grep -E '^[0-9]+$'").toString().split("\n").filter(Boolean);
    let killed = 0;
    for (const pid of pids) {
      let cwd2 = "";
      try { cwd2 = execSync(`readlink /proc/${pid}/cwd`).toString().trim(); } catch { continue; }
      if (cwd2 === `${base}-2`) { execSync(`kill -9 ${pid}`); killed++; break; }
    }
    if (!killed) throw new Error("没找到 C 会话的子进程（按 cwd 定位失败）");
    await tail(3000);
    const ev2 = events();
    const stops2 = ev2.filter((e) => e.op === "workspace.watch.stop").map((e) => e.cwd);
    check("A 修复：harness 被杀后 watcher 关闭", stops2.length >= 1, JSON.stringify(stops2));
    // 被杀的那个会话所在目录的 watcher 应已关；另一个目录不受影响
    const stoppedSet = new Set(stops2);
    check("A 修复：关闭的是被杀会话的目录，且 watch.stop 的 cwd 已归一化",
      [...stoppedSet].every((c) => c === base || c === `${base}-2`));

    console.log("③ 删掉剩余会话——验证多成员空间到最后一人退出才关");
    for (const sid of [sids.A, sids.B].filter(Boolean)) ws.send(JSON.stringify({ type: "delete", sessionId: sid }));
    await tail(3000);
    const ev3 = events();
    const stops3 = ev3.filter((e) => e.op === "workspace.watch.stop").map((e) => e.cwd);
    check("多成员空间：最后一人退出后关闭", stops3.includes(base), JSON.stringify(stops3));

    console.log(`\n=== ${fails.length ? "FAIL: " + fails.join("；") : "ALL PASS"} (${((Date.now() - started) / 1000).toFixed(0)}s) ===`);
    ws.close();
    process.exit(fails.length ? 1 : 0);
  } catch (err) {
    console.log("!!", err.message);
    process.exit(1);
  }
});

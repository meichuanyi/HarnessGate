#!/usr/bin/env node
/**
 * 验证模型/配置面板的修复（一次性会话 cwd=/tmp/hg-fix-test，结束即删，不碰真实数据）：
 *  A 冷会话：configOptions 来自 probe 兜底
 *  B 新建活会话有模型配置（harness session/new 上报）
 *  C 活会话切换模型生效
 *  D close 后冷会话仍显示配置，且 currentValue 保留用户选择（chosen 覆盖）
 *  E 冷会话下发 config：不报「会话未在运行」，chosen 落盘并广播
 *  F resume 后活会话配置不空白，且冷会话所选值被重放
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const token = readFileSync(join(homedir(), ".harnessgate", "token"), "utf8").trim();
const ws = new WebSocket(`ws://localhost:9830/ws?token=${encodeURIComponent(token)}`);
const CWD = "/tmp/hg-fix-test";
const seen = [];
const errors = [];
let sid = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sess = (id) => seen.filter((m) => m.type === "session" && m.session.id === id).map((m) => m.session);
const modelOf = (s) => (s.configOptions ?? []).find((o) => o.id === "model");
async function waitFor(desc, pred, ms = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = pred();
    if (v) return v;
    await sleep(400);
  }
  throw new Error(`等待超时: ${desc}`);
}

const results = [];
const ok = (name, pass, detail = "") => {
  results.push(pass);
  console.log(`${pass ? "✔" : "✘"} ${name}${detail ? ` — ${detail}` : ""}`);
};

ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  seen.push(m);
  if (m.type === "error") errors.push(m);
});

setTimeout(() => { console.log("总超时"); process.exit(1); }, 240_000).unref();

ws.on("open", async () => {
  try {
    const hello = await waitFor("hello", () => seen.find((m) => m.type === "hello"));
    // A
    const cold = (hello.sessions ?? []).filter((s) => !s.live && s.harnessId === "zcode");
    const withCfg = cold.filter((s) => modelOf(s)?.options?.length);
    ok("A 冷会话(zcode)有模型配置（probe 兜底）", cold.length > 0 && withCfg.length === cold.length,
       `${withCfg.length}/${cold.length} 个冷会话带 model 选项`);

    // B/C：建一次性活会话
    ws.send(JSON.stringify({ type: "create", harnessId: "zcode", cwd: CWD }));
    const created = await waitFor("会话 ready", () => {
      for (const s of seen.filter((m) => m.type === "session").map((m) => m.session)) {
        if (s.cwd === CWD) { sid = s.id; if (s.status === "ready") return s; }
      }
      return undefined;
    }, 60_000);
    const model1 = modelOf(created);
    const alt = (model1?.options ?? []).map((o) => o.value).find((v) => v !== model1?.currentValue);
    ok("B 新建活会话有模型配置", Boolean(alt), `current=${model1?.currentValue ?? "?"}`);

    ws.send(JSON.stringify({ type: "config", sessionId: sid, configId: "model", value: alt }));
    await waitFor("活会话切换生效", () => sess(sid).some((s) => modelOf(s)?.currentValue === alt));
    ok("C 活会话切换模型生效", true, `model → ${alt}`);

    // D：停掉变冷，配置仍在且保留所选
    ws.send(JSON.stringify({ type: "close", sessionId: sid }));
    const coldS = await waitFor("close 后冷广播", () => sess(sid).find((s) => !s.live));
    ok("D 冷会话配置保留（probe + chosen 覆盖）", modelOf(coldS)?.currentValue === alt,
       `current=${modelOf(coldS)?.currentValue ?? "?"}（期望 ${alt}）`);

    // E：冷会话直接下发 config（此前报「会话未在运行」）
    const other = (modelOf(coldS)?.options ?? []).map((o) => o.value).find((v) => v !== alt);
    const errBefore = errors.length;
    ws.send(JSON.stringify({ type: "config", sessionId: sid, configId: "model", value: other }));
    await sleep(1500);
    const last = sess(sid).at(-1);
    const noErr = !errors.slice(errBefore).some((e) => e.sessionId === sid);
    ok("E 冷会话 config 生效（不报错+chosen 广播）", noErr && modelOf(last ?? {})?.currentValue === other,
       `current=${modelOf(last ?? {})?.currentValue ?? "?"} error=${errors.length - errBefore}`);

    // F：恢复 → 配置不空白且为冷会话所选
    ws.send(JSON.stringify({ type: "resume", sessionId: sid }));
    await waitFor("resume ready", () => sess(sid).some((s) => s.status === "ready"), 60_000);
    const finalS = await waitFor("重放冷会话所选模型", () => {
      const s = sess(sid).at(-1);
      return modelOf(s)?.currentValue === other ? s : undefined;
    }, 20_000).catch(() => sess(sid).at(-1));
    const fm = modelOf(finalS ?? {});
    ok("F 恢复后活会话配置不空白", Boolean(fm?.options?.length));
    ok("F 恢复后模型为冷会话所选（重放生效）", fm?.currentValue === other,
       `current=${fm?.currentValue ?? "?"}（期望 ${other}）`);

    ws.send(JSON.stringify({ type: "delete", sessionId: sid }));
    await sleep(1500);
    console.log(`\n=== ${results.every(Boolean) && results.length >= 6 ? "PASS" : "FAIL"} ===`);
    process.exit(results.every(Boolean) ? 0 : 1);
  } catch (err) {
    console.log(`\n=== FAIL (${err.message}) ===`);
    try { if (sid) ws.send(JSON.stringify({ type: "delete", sessionId: sid })); } catch {}
    setTimeout(() => process.exit(1), 1200);
  }
});
ws.on("error", (e) => { console.log("WS 连接失败:", e.message); process.exit(1); });

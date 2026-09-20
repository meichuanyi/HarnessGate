#!/usr/bin/env node
/**
 * 验证：会话记住上次选的模型
 * ① 建 claude 会话 → 切 model=haiku → 检查落盘 chosen
 * ② 重启由外部脚本做（本脚本只做 ① 和 ③，通过参数区分）
 * ③ 重启后 revive 该会话 → info.configOptions 的 model currentValue 应为 haiku，且日志有重放记录
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const phase = process.argv[2] ?? "1";
let fired = false;
const sidFile = "/tmp/hg-remember-oc-sid";
const token = readFileSync(join(homedir(), ".harnessgate", "token"), "utf8").trim();
const ws = new WebSocket(`ws://localhost:9830/ws?token=${encodeURIComponent(token)}`);
const done = (code, why) => { console.log(`\n=== ${code ? "PASS" : "FAIL"}${why ? ` (${why})` : ""} ===`); try { ws.close(); } catch {} process.exit(code ? 0 : 1); };
setTimeout(() => done(false, "总超时"), 180_000).unref();

ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (phase === "1") {
    if (m.type === "hello") { ws.send(JSON.stringify({ type: "create", harnessId: process.argv[3] ?? "claude", cwd: "/tmp/hg-remember-oc" })); return; }
    if (m.type === "session" && m.session.cwd === "/tmp/hg-remember-oc" && m.session.status === "ready" && !fired) {
      fired = true;
      const sid = m.session.id;
      const modelOpt = (m.session.configOptions ?? []).find((o) => o.id === "model");
      const another = (modelOpt?.options ?? []).map((o) => o.value).find((v) => v !== modelOpt?.currentValue);
      if (!another) return done(false, "claude 没有可切换的模型选项");
      console.log(`① 会话 ${sid} 就绪，切模型 ${modelOpt.currentValue} → ${another}`);
      ws.send(JSON.stringify({ type: "config", sessionId: sid, configId: "model", value: another }));
      setTimeout(() => {
        const rec = JSON.parse(readFileSync(join(homedir(), ".harnessgate", "sessions.json"), "utf8"));
        const list = rec.sessions ?? rec;
        const me = list.find((s) => s.id === sid);
        const ok = me?.chosen?.model === another;
        console.log(`落盘 chosen:`, JSON.stringify(me?.chosen), ok ? "✔" : "✘");
        writeFileSync(sidFile, sid);
        ws.send(JSON.stringify({ type: "close", sessionId: sid }));
        setTimeout(() => done(ok), 1500);
      }, 2500);
    }
  }
  if (phase === "3") {
    if (m.type === "hello") {
      const sid = readFileSync(sidFile, "utf8").trim();
      console.log(`③ 重启后 revive 会话 ${sid}`);
      ws.send(JSON.stringify({ type: "resume", sessionId: sid }));
      return;
    }
    if (m.type === "session" && m.session.id === readFileSync(sidFile, "utf8").trim() && m.session.status === "ready" && !fired) {
      fired = true;
      const modelOpt = (m.session.configOptions ?? []).find((o) => o.id === "model");
      const shown = modelOpt?.currentValue;
      const rec = JSON.parse(readFileSync(join(homedir(), ".harnessgate", "sessions.json"), "utf8"));
      const list = rec.sessions ?? rec;
      const me = list.find((s) => s.id === m.session.id);
      const want = me?.chosen?.model;
      const ok = shown === want && Boolean(want);
      console.log(`③ UI 显示模型=${shown}，落盘 chosen=${want} →`, ok ? "✔ 一致" : "✘ 不一致");
      done(ok);
    }
  }
});
setTimeout(() => { if (phase === "1") ws.send(JSON.stringify({ type: "create", harnessId: process.argv[3] ?? "claude", cwd: "/tmp/hg-remember-oc" })); }, 1000);

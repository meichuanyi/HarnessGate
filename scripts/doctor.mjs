#!/usr/bin/env node
/**
 * HarnessGate doctor —— harness 可用性矩阵
 *
 *   npm run doctor                     只看"装没装"（快）
 *   npm run doctor -- --probe          真探活：启动 ACP、initialize、session/new
 *   npm run doctor -- --probe --only gemini,qwen-code
 *   npm run doctor -- --json
 *
 * 三态结论：可用 / 需认证 / 起不来，并告诉你要装什么。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const PROBE = args.includes("--probe");
const DEEP = args.includes("--deep");   // 连"发一句话能不能回"都验，才算真可用
const JSON_OUT = args.includes("--json");
const onlyIdx = args.indexOf("--only");
const ONLY = onlyIdx >= 0 ? new Set(String(args[onlyIdx + 1] ?? "").split(",").filter(Boolean)) : null;
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 0;
const cwdIdx = args.indexOf("--cwd");
const CWD = cwdIdx >= 0 ? String(args[cwdIdx + 1]) : process.env.HG_DEFAULT_CWD ?? ROOT;
const TIMEOUT = Number(process.env.HG_DOCTOR_TIMEOUT ?? 30_000);

function loadMerged() {
  const curated = JSON.parse(readFileSync(join(ROOT, "harness.json"), "utf8"));
  const importedFile = join(ROOT, "harness.registry.json");
  const imported = existsSync(importedFile) ? JSON.parse(readFileSync(importedFile, "utf8")).harnesses ?? [] : [];
  const ids = new Set(curated.harnesses.map((h) => h.id));
  return [...curated.harnesses, ...imported.filter((h) => !ids.has(h.id))];
}

function which(cmd) {
  if (isAbsolute(cmd) || cmd.includes("/")) return existsSync(cmd) ? cmd : null;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir && existsSync(join(dir, cmd))) return join(dir, cmd);
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 真探活：启动 harness → initialize → session/new */
async function probe(spec) {
  const started = Date.now();
  // 与运行时保持一致：需要代理的 harness 探活时也走代理
  // 探活不碰用户的真实会话：${HG_SESSION_ID} 统一替换成 probe（专用的探活会话键）
  const specEnv = Object.fromEntries(
    Object.entries(spec.env ?? {}).map(([k, v]) => [k, String(v).replaceAll("${HG_SESSION_ID}", "probe")]),
  );
  const env = { ...process.env, ...specEnv };
  if (spec.proxy) {
    env.HTTPS_PROXY = env.HTTPS_PROXY ?? spec.proxy;
    env.HTTP_PROXY = env.HTTP_PROXY ?? spec.proxy;
    env.ALL_PROXY = env.ALL_PROXY ?? spec.proxy;
    env.NO_PROXY = env.NO_PROXY ?? "localhost,127.0.0.1,::1,192.168.0.0/16,10.0.0.0/8,100.64.0.0/10";
  }
  const child = spawn(spec.cmd, spec.args, {
    cwd: CWD,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let gotReply = "";        // 收集 agent 真正吐出来的文本（比 usage 可靠：很多适配器不上报 usage）
  child.stderr.on("data", (d) => {
    stderr = (stderr + d.toString()).slice(-3000);
  });
  const done = (state, detail, extra) => ({
    state,
    detail: String(detail ?? "").replace(/\s+/g, " ").slice(0, 140),
    ms: Date.now() - started,
    ...(extra ?? {}),
  });

  /** 从 session/new 的返回里抽出可切换的配置项（含模型列表），供 UI 在建会话前展示 */
  const configsOf = (res) => {
    const opts = res?.configOptions ?? [];
    return opts
      .filter((o) => o && Array.isArray(o.options) && o.options.length)
      .map((o) => ({
        id: String(o.id),
        name: String(o.name ?? o.id),
        category: o.category ? String(o.category) : undefined,
        currentValue: o.currentValue != null ? String(o.currentValue) : undefined,
        options: o.options.map((v) => ({ value: String(v.value), name: String(v.name ?? v.value) })),
      }));
  };

  try {
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout),
    );
    const work = acp
      .client({ name: "harnessgate-doctor" })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        const u = ctx.params?.update ?? {};
        if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text" && u.content.text?.trim()) {
          gotReply += u.content.text;
        }
      })
      .connectWith(stream, async (ctx) => {
      const init = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });
      if (spec.authMethod) {
        try {
          await ctx.request(acp.methods.agent.authenticate, { methodId: spec.authMethod });
        } catch (err) {
          return done("auth", `认证失败（${spec.authMethod}）：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const who = `${init.agentInfo?.name ?? "agent"} ${init.agentInfo?.version ?? ""}`.trim();
      try {
        const s = await ctx.request(acp.methods.agent.session.new, { cwd: CWD, mcpServers: [] });
        const configs = configsOf(s);
        if (!DEEP) return done("ok", `${who} · session ${String(s.sessionId).slice(0, 12)}（未试对话）`, { configs });

        // 真发一句，捕捉"能建会话但发消息就报没 API key / 起不来"的情况。
        // 深探只测默认模型会错杀：默认模型挂（网络/上游问题）不代表整个 harness 不可用——
        // 所以失败后自动换一个备选模型再试一次，任一模型能对话就算通过。
        const DEEP_TURN_MS = 60_000;
        const modelCfg = configs.find((c) => c.id === "model");
        const curModel = modelCfg?.currentValue;
        const altModel = (modelCfg?.options ?? []).map((o) => o.value).find((v) => v && v !== curModel);

        async function deepTurn() {
          gotReply = "";
          const r = await Promise.race([
            ctx.request(acp.methods.agent.session.prompt, {
              sessionId: s.sessionId,
              prompt: [{ type: "text", text: "只回复两个字：收到" }],
            }),
            new Promise((_, rej) => setTimeout(() => rej(new Error("__turn_timeout__")), DEEP_TURN_MS).unref?.()),
          ]);
          return { r, reply: gotReply.trim() };
        }

        // 有些 harness 会把上游错误/内部状态当成"回复"吐回来（例如 "HTTP 401: Not allowed"），那不算可用
        function classify(res) {
          if (res.err) {
            if (res.err.message === "__turn_timeout__") return { state: "timeout", why: "60s 无响应" };
            if (/api key|unauthor|auth|login|credential|402|401/i.test(res.err.message)) return { state: "auth", why: res.err.message };
            return { state: "failed", why: res.err.message };
          }
          const reply = res.reply;
          if (
            reply &&
            reply.length < 200 &&
            /(HTTP\s*[45]\d\d|unauthor|not allowed|api key|rate limit|forbidden|^retrying\b|^retry\b|no (on-device )?model|no model (is )?available|not configured)/i.test(reply)
          ) return { state: "failed", why: `模型接入有问题：${reply.slice(0, 90)}` };
          if (reply) return { state: "ok", why: `回复「${reply.slice(0, 20)}」` };
          const errLine = stderr.split("\n").find((l) => /error|api key|unauthor|not found/i.test(l)) || "";
          return { state: "failed", why: `无回复（stopReason=${res.r?.stopReason}）${errLine ? " · " + errLine.trim().slice(0, 80) : ""}` };
        }

        let first;
        try { first = await deepTurn(); } catch (err) { first = { err }; }
        const v1 = classify(first);
        if (v1.state === "ok") return done("ok", `${who} · 对话正常${curModel ? `（${curModel}）` : ""}（${v1.why}）`, { configs, deepModel: curModel });
        if (v1.state === "auth") return done("auth", v1.why);

        // 默认模型失败 → 换备选模型再试一次（不重试 auth：那是要登录，换模型没用）
        if (altModel) {
          try {
            await ctx.request(acp.methods.agent.session.set_config_option, {
              sessionId: s.sessionId,
              configId: "model",
              value: altModel,
            });
            let second;
            try { second = await deepTurn(); } catch (err) { second = { err }; }
            const v2 = classify(second);
            if (v2.state === "ok") {
              return done("ok", `${who} · 默认模型 ${curModel ?? "（默认）"}失败（${v1.why}），备选 ${altModel} 验证通过`, { configs, deepModel: altModel });
            }
            return done(v2.state === "timeout" ? "timeout" : "failed", `${who} · 默认模型与备选 ${altModel} 都不行：${v1.why.slice(0, 70)} / ${v2.why.slice(0, 70)}`);
          } catch (err) {
            return done("failed", `${who} · ${v1.why.slice(0, 90)}（切换备选模型也失败：${err instanceof Error ? err.message : String(err)}）`);
          }
        }
        return done(v1.state, `${who} · ${v1.why}`);
      } catch (err) {
        const m0 = err instanceof Error ? err.message : String(err);
        if (/api key|unauthor|auth|login|credential|402|401/i.test(m0)) return done("auth", m0);
        return done("failed", m0);
      }
      try {
        return done("failed", "unreachable");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/auth|login|credential|unauthor/i.test(msg)) return done("auth", msg);
        return done("failed", msg);
      }
    });
    const timeout = new Promise((resolve) => setTimeout(() => resolve(done("timeout", "无响应")), TIMEOUT).unref?.());
    return await Promise.race([work, timeout]);
  } catch (err) {
    return done("failed", err instanceof Error ? err.message : String(err));
  } finally {
    child.kill("SIGTERM");
    setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 1500).unref?.();
  }
}

const ICON = { ok: "✅", installed: "📦", auth: "🔐", failed: "⚠️ ", timeout: "⏱", missing: "❌", needDownload: "⬇️ " };

async function main() {
  let list = loadMerged();
  if (ONLY) list = list.filter((h) => ONLY.has(h.id));
  for (const h of list) {
    h._bin = which(h.cmd);
    h._state = h.requiresDownload && !h._bin ? "needDownload" : h._bin ? "installed" : "missing";
  }
  if (!ONLY) {
    // 默认先看"本机可能能跑的"
    list.sort((a, b) => {
      const rank = (x) => (x._state === "installed" ? 0 : x._state === "needDownload" ? 1 : 2);
      return rank(a) - rank(b) || a.id.localeCompare(b.id);
    });
  }
  if (LIMIT > 0) list = list.slice(0, LIMIT);

  const rows = [];
  for (const h of list) {
    let state = h._state, detail = "", result;
    if (PROBE && h._state === "installed") {
      process.stderr.write(`  探活 ${h.id} …`);
      const r = await probe(h);
      process.stderr.write(`\r\x1b[K`);
      state = r.state;
      detail = r.detail;
      h._ms = r.ms;
      result = r;
    } else if (h._state === "missing") {
      detail = `找不到 ${h.cmd}`;
    } else if (h._state === "needDownload") {
      detail = "需要下载二进制";
    } else {
      detail = h._bin ?? "";
    }
    rows.push({ id: h.id, name: h.label, state, detail, ms: h._ms, source: h.source ?? "curated", version: h.version, note: h.note, _result: result });
  }

  // 持久化探活结果：服务端据此把"已验证可用/需登录/起不来"显示在界面上
  if (PROBE) {
    const file = join(homedir(), ".harnessgate", "probe.json");
    let prev = {};
    try { prev = JSON.parse(readFileSync(file, "utf8")).results ?? {}; } catch {}
    for (const r of rows) {
      if (["ok", "auth", "failed", "timeout"].includes(r.state)) {
        // 探活顺手把可切换的配置项（模型列表等）存下来，UI 建会话前就能展示
        const configs = r._result?.configs;
        const prevEntry = prev[r.id];
        const ts = new Date().toISOString();
        // 浅探不能覆盖深探结论：
        //  - 深探通过过的，浅探 ok 只刷新 configs/ts，绿灯保留（浅探证明不了对话可用）
        //  - lastDeep（最近一次深度验证的结论）只有深探能改
        if (!DEEP && prevEntry?.deep && prevEntry.state === "ok" && r.state === "ok") {
          prev[r.id] = { ...prevEntry, ...(configs?.length ? { configs } : {}), ts };
        } else {
          prev[r.id] = {
            state: r.state,
            detail: r.detail,
            deep: DEEP && r.state === "ok",
            ...(DEEP ? { lastDeep: r.state } : { lastDeep: prevEntry?.lastDeep }),
            ...(configs?.length ? { configs } : {}),
            ...(r._result?.deepModel ? { deepModel: r._result.deepModel } : {}),
            ts,
          };
        }
      }
    }
    mkdirSync(join(homedir(), ".harnessgate"), { recursive: true });
    writeFileSync(file, JSON.stringify({ "//": "由 npm run doctor -- --probe 生成", results: prev }, null, 1));
    console.error(`  （探活结果已写入 ${file}）`);
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log(`\nHarnessGate doctor${PROBE ? (DEEP ? "（探活 + 真实对话）" : "（探活：只验证到建会话）") : "（仅检查安装）"} · cwd=${CWD}\n`);
    const w = Math.max(6, ...rows.map((r) => r.id.length));
    for (const r of rows) {
      const t = r.ms ? `${(r.ms / 1000).toFixed(1)}s` : "";
      console.log(`${(ICON[r.state] ?? "?").padEnd(3)} ${r.id.padEnd(w)}  ${r.name.slice(0, 22).padEnd(22)} ${t.padStart(6)}  ${r.detail}`);
    }
    const c = (s) => rows.filter((r) => r.state === s).length;
    console.log(
      `\n合计 ${rows.length}：` +
        (PROBE
          ? `✅ 探活通过 ${c("ok")}  🔐 需认证 ${c("auth")}  ⚠️ 起不来 ${c("failed")}  ⏱ 超时 ${c("timeout")}`
          : `📦 命令已就位 ${c("installed")}`) +
        `  ⬇️ 需下载 ${c("needDownload")}  ❌ 未安装 ${c("missing")}`,
    );
    const todo = rows.filter((r) => ["auth", "failed", "timeout", "missing", "needDownload"].includes(r.state));
    if (todo.length) {
      console.log(`\n需要处理的 ${todo.length} 个：`);
      for (const r of todo.slice(0, 12)) console.log(`  ${ICON[r.state]} ${r.id}: ${r.detail.slice(0, 110)}`);
    }
    if (!PROBE) {
      const inst = rows.filter((r) => r.state === "installed").length;
      console.log(`\n提示：加 --probe 对这 ${inst} 个做真实探活（逐个启动 ACP，最长 ${TIMEOUT / 1000}s/个）`);
      console.log(`      加 --download 的导入：npm run import-registry -- --download`);
    }
  }
}

await main();
await sleep(50);
process.exit(0);

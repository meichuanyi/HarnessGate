#!/usr/bin/env node
/**
 * 技能管理端到端验证（不碰原生 skills，全部用 hg-e2e-* 测试技能）：
 *  A snapshot：能列出 zcode/claude 的原生技能（只读）
 *  B save 新建 → 库里出现
 *  C mount 到 zcode → ~/.zcode/skills/ 下是指向主库的软链，snapshot mountedOn 含 zcode
 *  D read：frontmatter + 正文完整
 *  E 改名：renameFrom 旧名消失、挂载保留
 *  F delete：软链摘除、库清空、回收站有归档
 */
import { readFileSync, lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const token = readFileSync(join(homedir(), ".harnessgate", "token"), "utf8").trim();
const ws = new WebSocket(`ws://localhost:9830/ws?token=${encodeURIComponent(token)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seen = [];
const results = [];
const ok = (name, pass, detail = "") => { results.push(pass); console.log(`${pass ? "✔" : "✘"} ${name}${detail ? ` — ${detail}` : ""}`); };
async function waitFor(desc, pred, ms = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = pred(); if (v) return v; await sleep(300); }
  throw new Error(`等待超时: ${desc}`);
}
const snap = () => seen.filter((m) => m.type === "skills").at(-1);
const lib = (s) => (s?.library ?? []).find((x) => x.name === s?._name);
ws.on("message", (raw) => { const m = JSON.parse(String(raw)); seen.push(m); if (m.type === "error") console.log(`  (error): ${m.message}`); });
setTimeout(() => { console.log("总超时"); process.exit(1); }, 90_000).unref();

ws.on("open", async () => {
  try {
    ws.send(JSON.stringify({ type: "skills" }));
    const s0 = await waitFor("snapshot", () => snap());
    const nativeZcode = (s0.mounts.find((m) => m.harnessId === "zcode")?.skills ?? []).filter((x) => x.native).length;
    const nativeClaude = (s0.mounts.find((m) => m.harnessId === "claude")?.skills ?? []).filter((x) => x.native).length;
    ok("A snapshot 列出原生技能（只读）", nativeZcode > 0 && nativeClaude > 0, `zcode ${nativeZcode} 个 / claude ${nativeClaude} 个，合计 token ≈${s0.mounts.reduce((n, m) => n + m.totalTokens, 0)}`);

    // B 新建
    ws.send(JSON.stringify({ type: "skills-save", skill: { name: "hg-e2e-demo", description: "端到端验证用技能：一个简短描述", body: "# 演示\n正文第一行。" } }));
    await waitFor("库中出现", () => (snap()?.library ?? []).some((x) => x.name === "hg-e2e-demo"));
    const meta = snap().library.find((x) => x.name === "hg-e2e-demo");
    ok("B save 新建落库", meta && meta.tokens > 0, `tokens≈${meta?.tokens}`);

    // C 挂载到 zcode
    ws.send(JSON.stringify({ type: "skills-mount", name: "hg-e2e-demo", harnessId: "zcode", on: true }));
    await waitFor("挂载生效", () => (snap()?.library ?? []).find((x) => x.name === "hg-e2e-demo")?.mountedOn?.includes("zcode"));
    const link = join(homedir(), ".zcode", "skills", "hg-e2e-demo");
    const st = lstatSync(link);
    const content = readFileSync(join(link, "SKILL.md"), "utf8");
    ok("C 软链挂载到 zcode", st.isSymbolicLink() && /端到端验证用技能/.test(content), `symlink=${st.isSymbolicLink()}`);

    // D 读全文
    const reqId = "rd1";
    ws.send(JSON.stringify({ type: "skills-read", reqId, name: "hg-e2e-demo" }));
    const rd = await waitFor("read 响应", () => seen.find((m) => m.type === "skills-content" && m.reqId === reqId));
    ok("D read 返回 frontmatter+正文", /^---\nname: hg-e2e-demo\n/.test(rd.content) && rd.content.includes("正文第一行"));

    // E 改名（挂载应保留）
    ws.send(JSON.stringify({ type: "skills-save", skill: { name: "hg-e2e-renamed", description: "改过名的技能", body: "# 改名\n正文。", renameFrom: "hg-e2e-demo" } }));
    await waitFor("改名生效", () => (snap()?.library ?? []).some((x) => x.name === "hg-e2e-renamed") && !(snap()?.library ?? []).some((x) => x.name === "hg-e2e-demo"));
    const renamed = snap().library.find((x) => x.name === "hg-e2e-renamed");
    ok("E 改名且挂载保留", renamed?.mountedOn?.includes("zcode") && lstatSync(join(homedir(), ".zcode", "skills", "hg-e2e-renamed")).isSymbolicLink(), `mountedOn=${renamed?.mountedOn}`);

    // F 删除
    ws.send(JSON.stringify({ type: "skills-delete", name: "hg-e2e-renamed" }));
    await waitFor("删除生效", () => !(snap()?.library ?? []).some((x) => x.name === "hg-e2e-renamed"));
    await sleep(300);
    let linkGone = false;
    try { lstatSync(join(homedir(), ".zcode", "skills", "hg-e2e-renamed")); } catch { linkGone = true; }
    const trash = readdirSync(join(homedir(), ".harnessgate", "skills.trash")).filter((f) => f.endsWith("hg-e2e-renamed"));
    ok("F 删除：摘链+进回收站", linkGone && trash.length > 0, `trash=${trash[0]}`);
    console.log(`\n=== ${results.every(Boolean) ? "PASS" : "FAIL"} ===`);
    process.exit(results.every(Boolean) ? 0 : 1);
  } catch (err) {
    console.log(`\n=== FAIL (${err.message}) ===`);
    process.exit(1);
  }
});

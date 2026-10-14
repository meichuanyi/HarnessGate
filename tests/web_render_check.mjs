#!/usr/bin/env node
/**
 * web 渲染回归检查：从 web/index.html 提取关键渲染函数，在 vm 沙箱里带桩执行，
 * 对产出的 HTML 做「标签配平 + 关键结构断言」。
 * 起因：renderHarnessGrid 加按钮时丢了卡片的 </div>，总览卡片一层套一层——
 * 语法检查和未声明调用检查都测不出这种 bug，只有真渲染才能抓住。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = join(ROOT, "web", "index.html");

function allScriptSrc(html) {
  // 页面有多个脚本块，函数可能分布在任意块里：全部拼起来再找（经典脚本本来就共享全局作用域）
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n;\n");
}

/** 按花括号配对提取函数源码（仅适用于函数体内字符串里花括号自配对的渲染函数） */
function extractFn(src, name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`找不到函数 ${name}`);
  let depth = 0, started = false;
  for (let k = src.indexOf("{", i); k < src.length; k++) {
    if (src[k] === "{") { depth++; started = true; }
    else if (src[k] === "}") { depth--; if (started && depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error(`函数 ${name} 花括号不配对`);
}

/** 迷你标签配平检查：返回 {balance, 卡片等指定标签所在深度}；void 元素与自闭合不算 */
const VOID = new Set(["input", "br", "img", "hr", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"]);
function checkTags(html) {
  let balance = 0, minBalance = 0;
  const stack = [];
  const re = /<\/?([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g;
  let m;
  const depths = {};
  while ((m = re.exec(html))) {
    const [full, tag, selfClose] = m;
    if (VOID.has(tag.toLowerCase()) || selfClose === "/") continue;
    if (full.startsWith("</")) {
      const top = stack.pop();
      if (top !== tag.toLowerCase()) throw new Error(`标签错配：期望 </${top}> 实际 </${tag}>（位置 ${m.index} 附近：${html.slice(Math.max(0, m.index - 40), m.index + 20)}…）`);
      balance--;
    } else {
      if (tag === "div" && /class="[^"]*\bcard\b/.test(full)) depths[stack.length] = (depths[stack.length] || 0) + 1;
      stack.push(tag.toLowerCase());
      balance++;
      if (balance < minBalance) minBalance = balance;
    }
  }
  if (stack.length) throw new Error(`标签未闭合：还剩 ${stack.join(",")}`);
  return { balance, depths };
}

let failed = false;
const fail = (msg) => { failed = true; console.error(`✘ ${msg}`); };

try {
  const src = allScriptSrc(readFileSync(HTML, "utf8"));

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---- renderHarnessGrid：总览卡片 ----
  {
    const root = { innerHTML: "", querySelectorAll: () => [] };
    const harnesses = new Map([
      ["a", { id: "a", label: "可用A", available: true, note: "", driver: "", registered: false }],
      ["b", { id: "b", label: "可装B", available: false, canInstall: true, note: "本机没有", driver: "", registered: false }],
      ["c", { id: "c", label: "安装中C", available: false, canInstall: true, manageBusy: true, note: "", driver: "", registered: false }],
      ["d", { id: "d", label: "缺凭证D", available: false, canInstall: false, note: "需登录", driver: "", registered: false }],
    ]);
    const ctx = { harnesses, sessions: new Map(), esc, $: (sel) => (sel === "viewRoot" ? root : null), console };
    vm.runInNewContext(extractFn(src, "renderHarnessGrid"), ctx);
    ctx.renderHarnessGrid();
    const html = root.innerHTML;
    const { balance, depths } = checkTags(html);
    if (balance !== 0) fail(`renderHarnessGrid 输出 div 配平不为 0（${balance}）`);
    const cardDepths = Object.entries(depths);
    if (cardDepths.length !== 1) {
      // 卡片必须全部在同一深度——出现多个深度说明发生了嵌套（曾因丢 </div> 一层套一层）
      fail(`renderHarnessGrid 卡片不在同一层级：${JSON.stringify(cardDepths)}`);
    }
    const cards = (html.match(/class="card /g) || []).length;
    if (cards !== 4) fail(`renderHarnessGrid 卡片数量 ${cards} ≠ 4`);
    if (!/data-hinstall="b"/.test(html) || /data-hinstall="d"/.test(html)) fail("安装按钮出现的位置不对（b 该有，d 不该有）");
    if (!/data-hinstall="c" disabled>/.test(html) || !/安装中…/.test(html)) fail("manageBusy 的按钮应 disabled 且显示「安装中…」");
  }

  // ---- renderSetPanel：设置抽屉（覆盖 utilityMode 两种取值下的模板块） ----
  for (const mode of ["harness", "api"]) {
    const el = () => ({ value: "", innerHTML: "", style: {}, hidden: false, dataset: {}, checked: false, textContent: "" });
    const root = Object.assign(el(), { querySelectorAll: () => [] });
    const harnesses = new Map([
      ["x", { id: "x", label: "X", available: false, canInstall: true, manageSupported: false, note: "本机没有", manageBusy: false }],
      ["y", { id: "y", label: "Y", available: true, manageSupported: true, installedVersion: "1.0", latestVersion: "1.0", manageBusy: false }],
    ]);
    const ctx = {
      harnesses, sessions: new Map(), esc,
      appSettings: { utilityMode: mode },
      mcpServers: [], skillsLibrary: [], skillsMounts: [],
      $: (sel) => (sel === "setPanel" ? root : el()),
      send: () => {}, showToast: () => {},
      wireMcpPanel: () => {}, wireSkillsPanel: () => {}, renderNewMcpRow: () => {},
      console,
    };
    vm.runInNewContext(extractFn(src, "renderSetPanel"), ctx);
    ctx.renderSetPanel();
    const html = root.innerHTML;
    const { balance } = checkTags(html);
    if (balance !== 0) fail(`renderSetPanel(${mode}) 输出 div 配平不为 0（${balance}）`);
    if (mode === "api" && !/id="utilHarnessCfg" style="display:none"/.test(html)) fail("utilityMode=api 时 harness/模型块应默认隐藏");
    if (mode === "harness" && !/id="utilApiCfg" style="display:none"/.test(html)) fail("utilityMode=harness 时 API 块应默认隐藏");
    if (!/data-hmanage="x"/.test(html)) fail("设置抽屉应列出可一键安装的 harness（x）");
  }
} catch (err) {
  failed = true;
  console.error(`✘ 渲染检查异常：${err.message}`);
}

if (failed) { console.error("\nweb 渲染回归检查失败。"); process.exit(1); }
console.log("✔ web 渲染回归检查通过（renderHarnessGrid / renderSetPanel 标签配平与结构断言）");

#!/usr/bin/env node
// web/ 前端静态检查（无构建单文件，缺一层编译器兜底）：
//   1) 每个内联脚本/本地脚本的语法校验（node:vm 编译）；
//   2) 扫描「调用了从未声明的标识符」——曾发生过 updateStarBtn 漏定义导致整页渲染中断。
// 词法清洗会屏蔽字符串/注释/正则字面量，避免把 CSS 的 rgba()/url() 之类当成函数调用误报。
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import vm from "node:vm";

// esbuild 若可用则用它做语法检查（报错带精确行列）；否则退化为 node:vm
let esbuild = null;
try { esbuild = await import("esbuild"); } catch { /* 无 esbuild，用 vm */ }

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 可选：传入要检查的 HTML 路径（默认 web/index.html），便于对样例做回归验证
const HTML = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, "web", "index.html");

// 控制流/声明关键字：出现在 `name(` 前不算函数调用
const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "instanceof", "new", "delete",
  "void", "in", "of", "case", "do", "else", "try", "throw", "yield", "await", "function", "class",
  "super", "this", "with", "default", "export", "import", "async",
]);

// 运行时可用的内置/宿主全局，不在脚本里声明也合法
const GLOBALS = new Set([
  // JS 内置
  "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt", "Math", "JSON", "Date",
  "RegExp", "Error", "TypeError", "RangeError", "SyntaxError", "EvalError", "ReferenceError",
  "Promise", "Map", "Set", "WeakMap", "WeakSet", "Proxy", "Reflect", "Intl", "Function", "eval",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent",
  "encodeURI", "decodeURI", "structuredClone", "queueMicrotask", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "setImmediate", "requestAnimationFrame", "cancelAnimationFrame",
  "requestIdleCallback", "atob", "btoa", "fetch", "URL", "URLSearchParams", "TextEncoder",
  "TextDecoder", "AbortController", "AbortSignal", "Blob", "File", "FileReader", "FormData",
  "Headers", "Request", "Response", "WebSocket", "EventSource", "Worker", "Image", "Audio",
  "Event", "CustomEvent", "EventTarget", "Node", "Element", "HTMLElement", "DOMParser",
  "MutationObserver", "IntersectionObserver", "ResizeObserver", "PerformanceObserver",
  "crypto", "performance", "console", "process", "globalThis",
  // 浏览器宿主
  "window", "document", "navigator", "location", "history", "screen", "localStorage",
  "sessionStorage", "indexedDB", "caches", "alert", "confirm", "prompt", "open", "close",
  "scrollTo", "scrollBy", "getComputedStyle", "matchMedia", "getSelection", "Notification",
  "ClipboardItem", "isSecureContext", "self", "top", "parent", "frames", "devicePixelRatio",
  "innerWidth", "innerHeight", "addEventListener", "removeEventListener", "dispatchEvent",
  "flutter_inappwebview", "Android", "webkit",
]);

function extractBlocks(html) {
  const blocks = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || "";
    const body = m[2] || "";
    const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || "text/javascript";
    if (!/javascript|module/i.test(type)) continue; // 跳过 JSON/模板等非 JS 块
    const src = (attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (src) {
      if (/^https?:|^\/\//.test(src)) continue; // 外链不检查
      const p = resolve(join(ROOT, "web"), src.replace(/^\//, ""));
      if (existsSync(p)) blocks.push({ name: src, code: readFileSync(p, "utf8"), baseLine: 1 });
      continue;
    }
    const openEnd = m[0].indexOf(">") + 1;
    const baseLine = html.slice(0, m.index + openEnd).split("\n").length; // 内联脚本首行在 HTML 中的行号
    blocks.push({ name: "web/index.html", code: body, baseLine });
  }
  return blocks;
}

// 屏蔽字符串/注释/正则字面量的内容（保留长度与换行，便于定位），但保留模板里 ${} 中的表达式
function sanitize(code) {
  const out = code.split("");
  const n = code.length;
  const blank = (i) => {
    if (code[i] !== "\n") out[i] = " ";
  };
  const isRegexStart = (i) => {
    for (let j = i - 1; j >= 0; j--) {
      const c = code[j];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
      if ("(=:[!&|?{};,+-*%^~<>".includes(c)) return true;
      // 关键字后（return/typeof/case/...）也视为正则开始
      if (/[A-Za-z_$]/.test(c)) {
        let k = j;
        while (k >= 0 && /[A-Za-z_$]/.test(code[k])) k--;
        return /^(return|typeof|case|in|of|delete|void|instanceof|do|else|yield|await)$/.test(
          code.slice(k + 1, j + 1),
        );
      }
      return false;
    }
    return true;
  };
  let i = 0;
  while (i < n) {
    const c = code[i];
    if (c === "/" && code[i + 1] === "/") {
      while (i < n && code[i] !== "\n") { blank(i); i++; }
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      blank(i); blank(i + 1); i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) { blank(i); i++; }
      if (i < n) { blank(i); blank(i + 1); i += 2; }
      continue;
    }
    if (c === "'" || c === '"') {
      blank(i); i++;
      while (i < n && code[i] !== c) {
        if (code[i] === "\\") { blank(i); i++; if (i < n) { blank(i); i++; } continue; }
        blank(i); i++;
      }
      if (i < n) { blank(i); i++; }
      continue;
    }
    if (c === "`") {
      blank(i); i++;
      while (i < n) {
        if (code[i] === "\\") { blank(i); i++; if (i < n) { blank(i); i++; } continue; }
        if (code[i] === "`") { blank(i); i++; break; }
        if (code[i] === "$" && code[i + 1] === "{") {
          // 保留 ${ 与其中的表达式（递归清洗），直到匹配的 }
          out[i] = "$"; out[i + 1] = "{"; i += 2;
          let depth = 1;
          const start = i;
          while (i < n && depth > 0) {
            if (code[i] === "{") depth++;
            else if (code[i] === "}") depth--;
            if (depth === 0) break;
            i++;
          }
          const inner = code.slice(start, i);
          const cleaned = sanitize(inner).split("");
          for (let k = 0; k < cleaned.length; k++) out[start + k] = cleaned[k];
          if (i < n) { out[i] = "}"; i++; }
          continue;
        }
        blank(i); i++;
      }
      continue;
    }
    if (c === "/" && isRegexStart(i)) {
      blank(i); i++;
      let inClass = false;
      while (i < n) {
        const d = code[i];
        if (d === "\\") { blank(i); i++; if (i < n) { blank(i); i++; } continue; }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) { blank(i); i++; break; }
        else if (d === "\n") break;
        blank(i); i++;
      }
      while (i < n && /[a-z]/i.test(code[i])) { blank(i); i++; }
      continue;
    }
    i++;
  }
  return out.join("");
}

function idsIn(text) {
  return text.replace(/=[^,]+/g, " ").match(/[A-Za-z_$][\w$]*/g) || [];
}

function collectDeclared(code) {
  const set = new Set();
  const add = (re, group = 1) => {
    let m;
    while ((m = re.exec(code))) for (const id of idsIn(m[group] || "")) set.add(id);
  };
  add(/\bfunction\s+([A-Za-z_$][\w$]*)/g);
  add(/\bclass\s+([A-Za-z_$][\w$]*)/g);
  // const/let/var（含解构）
  {
    const re = /\b(?:const|let|var)\s+([^;=]+?)(?=\s*=|;|\bin\b|\bof\b|$)/g;
    let m;
    while ((m = re.exec(code))) for (const id of idsIn(m[1])) set.add(id);
  }
  add(/\bfunction\s*(?:[A-Za-z_$][\w$]*)?\s*\(([^()]*)\)/g);
  add(/\bcatch\s*\(([^()]*)\)/g);
  add(/\(([^()]*)\)\s*=>/g);          // 箭头函数括号参数
  add(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g); // 单参数箭头 a => a
  return set;
}

function findUndefinedCalls(code, declared) {
  const findings = [];
  const re = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    const name = m[1];
    if (KEYWORDS.has(name)) continue;
    // 前一个词若是 function/new/class，则这里是声明而非调用
    let j = m.index - 1;
    while (j >= 0 && /\s/.test(code[j])) j--;
    let k = j;
    while (k >= 0 && /[A-Za-z_$]/.test(code[k])) k--;
    const prev = code.slice(k + 1, j + 1);
    if (prev === "function" || prev === "new" || prev === "class") continue;
    if (declared.has(name) || GLOBALS.has(name)) continue;
    const line = code.slice(0, m.index).split("\n").length;
    findings.push({ name, line });
  }
  return findings;
}

function main() {
  if (!existsSync(HTML)) {
    console.error(`✘ 找不到 ${HTML}`);
    process.exit(2);
  }
  const html = readFileSync(HTML, "utf8");
  const blocks = extractBlocks(html);
  if (!blocks.length) {
    console.error("✘ 未提取到任何脚本块");
    process.exit(2);
  }

  let failed = false;
  const allDeclared = new Set();
  const prepared = blocks.map((b) => {
    const clean = sanitize(b.code);
    for (const id of collectDeclared(clean)) allDeclared.add(id);
    return { ...b, clean };
  });

  // 1) 语法
  for (const b of prepared) {
    if (esbuild) {
      try {
        esbuild.transformSync(b.code, { loader: "js", sourcefile: b.name });
      } catch (e) {
        failed = true;
        for (const er of e.errors?.length ? e.errors : [{ text: e.message }]) {
          const loc = er.location ? `:${b.baseLine + er.location.line - 1}` : "";
          console.error(`✘ 语法错误 [${b.name}${loc}] ${er.text}`);
        }
      }
    } else {
      try {
        new vm.Script(b.code, { filename: b.name });
      } catch (e) {
        failed = true;
        console.error(`✘ 语法错误 [${b.name}]: ${e.message}`);
      }
    }
  }

  // 2) 未声明调用（跨脚本块共享声明）
  let total = 0;
  for (const b of prepared) {
    for (const f of findUndefinedCalls(b.clean, allDeclared)) {
      // 用原始块名（inline 不好定位行号则提示），汇总去重
      failed = true;
      total++;
      console.error(`✘ 调用未声明标识符 [${b.name}:${b.baseLine + f.line - 1}] ${f.name}()`);
    }
  }

  const names = prepared.reduce((s, b) => s + (b.name.startsWith("web/index.html") ? 0 : 1), 0);
  if (failed) {
    console.error(`\n前端静态检查失败（${total} 处未声明调用）。`);
    process.exit(1);
  }
  console.log(`✔ 前端静态检查通过（${prepared.length} 个脚本块${names ? `，含 ${names} 个外链本地脚本` : ""}，无未声明调用）`);
}

main();

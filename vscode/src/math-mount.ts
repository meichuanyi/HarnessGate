/**
 * 数学公式支持：
 * - katexInline()：扩展宿主侧用——把 KaTeX 的 js/css（字体内联成 data URI）读成字符串，
 *   直接嵌进 webview HTML。不走 webview 资源服务，避开 CSP 与资源加载的兼容层。
 * - MATH_MOUNT_SOURCE：webview 侧源码——重绑 mdToHtml 为「提取占位符 → 渲染 → 还原」
 *   管线，并用 window.katex 挂载 .ktx（KaTeX 内联在前，同步可用）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";

declare const __dirname: string;

function katexDir(): string {
  const ext = vscode.extensions.getExtension("meichuan.harnessgate");
  const root = ext ? ext.extensionUri.fsPath : join(__dirname, "..");
  return join(root, "media", "katex");
}

let cache: { js: string; css: string } | undefined;

/** KaTeX 全内联（js + css，字体转 data URI；缺的字体让浏览器回退）。面板打开时读一次并缓存。 */
export function katexInline(): { js: string; css: string } {
  if (cache) return cache;
  const dir = katexDir();
  const js = readFileSync(join(dir, "katex.min.js"), "utf8").replace(/<\/script/gi, "<\\/script");
  let css = readFileSync(join(dir, "katex.min.css"), "utf8");
  css = css.replace(/url\(fonts\/([A-Za-z0-9_.-]+)\.woff2\)/g, (m, name: string) => {
    try {
      const b64 = readFileSync(join(dir, "fonts", `${name}.woff2`)).toString("base64");
      return `url(data:font/woff2;base64,${b64})`;
    } catch {
      return m;   // 精简包没有的字体：保留相对路径（404 后按 font-family 回退）
    }
  });
  cache = { js, css };
  return cache;
}

export const MATH_MOUNT_SOURCE = String.raw`
/* ---------- 数学公式：KaTeX 挂载（与服务端网页版同管线） ---------- */
(function () {
  const core = mdToHtml;
  mdToHtml = function (src) {
    const extracted = extractMath(src);
    const html = restoreMathPlaceholders(core(extracted.text), extracted.math);
    scheduleMathMount();
    return html;
  };
  function extractMath(src) {
    const math = [];
    const ph = (tex, display) => { math.push({ tex: tex, display: display }); return '\uE000' + (math.length - 1) + '\uE001'; };
    const mathish = (s) => /[\\^_{}=]/.test(s) && /[A-Za-z0-9]/.test(s);
    let text = String(src ?? '');
    const codes = [];
    text = text
      .replace(/\`\`\`[\s\S]*?\`\`\`/g, (m) => { codes.push(m); return '\uE002' + (codes.length - 1) + '\uE003'; })
      .replace(/\`[^\`\n]+\`/g, (m) => { codes.push(m); return '\uE002' + (codes.length - 1) + '\uE003'; });
    text = text
      .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => ph(tex.trim(), 1))
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => ph(tex.trim(), 1))
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => ph(tex.trim(), 0))
      .replace(/\$([^$\n]+)\$/g, (m, tex) => (mathish(tex) ? ph(tex, 0) : m));
    text = text.replace(/\uE002(\d+)\uE003/g, (_, i) => codes[Number(i)]);
    return { text: text, math: math };
  }
  function restoreMathPlaceholders(html, math) {
    return html.replace(/\uE000(\d+)\uE001/g, (_, i) => {
      const m = math[Number(i)];
      if (!m) return '';
      return '<span class="ktx" data-display="' + m.display + '" data-tex="' + esc(m.tex) + '">' + esc(m.tex) + '</span>';
    });
  }
  function mountMath(root) {
    if (!root || !root.querySelectorAll) return;
    const nodes = root.querySelectorAll('.ktx:not([data-done])');
    if (!nodes.length) return;
    if (!window.katex) return;   // KaTeX 尚未就绪：先显示原文，onload 后会再挂载一轮
    for (const el of nodes) {
      el.setAttribute('data-done', '1');
      const tex = el.dataset.tex || '';
      try { window.katex.render(tex, el, { throwOnError: false, displayMode: el.dataset.display === '1' }); }
      catch (e) { el.textContent = tex; }
    }
  }
  let scheduled = false;
  function scheduleMathMount() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; mountMath(document); });
  }
  if (window.katex) mountMath(document);
  else {
    const t = setInterval(() => {
      if (window.katex) { clearInterval(t); mountMath(document); }
    }, 400);
    setTimeout(() => clearInterval(t), 20000);
  }
})();
`;

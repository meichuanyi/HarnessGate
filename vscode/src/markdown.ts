/* eslint-disable */
/**
 * Markdown → HTML（从 web/index.html 的渲染器抽出，浏览器与插件共用同一套逻辑）。
 * 无依赖：先转义再套标签；流式未闭合的代码围栏也当代码块处理。
 */
const ESC_MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, (c) => ESC_MAP[c] ?? c);

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function isSeparatorRow(line: string): boolean {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line);
}

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line) && line.split("|").length >= 3;
}

function inlineMd(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
}

function tableHtml(rows: string[]): string {
  const cells = rows.map(splitRow);
  const hasSep = rows.length > 1 && isSeparatorRow(rows[1] ?? "");
  const head = cells[0] || [];
  const body = hasSep ? cells.slice(2) : cells.slice(1);
  let h = '<table>';
  if (hasSep) h += "<thead><tr>" + head.map((c) => `<th>${inlineMd(esc(c))}</th>`).join("") + "</tr></thead>";
  h += "<tbody>";
  const bodyRows = hasSep ? body : (head.length ? body : []);
  if (!hasSep && head.length) h += "<tr>" + head.map((c) => `<td>${inlineMd(esc(c))}</td>`).join("") + "</tr>";
  for (const r of bodyRows) h += "<tr>" + r.map((c) => `<td>${inlineMd(esc(c))}</td>`).join("") + "</tr>";
  return h + "</tbody></table>";
}

function mdToHtml(src: string): string {
  const lines = String(src ?? "").split("\n");
  const out: string[] = [];
  let inCode = false, lang = "", buf: string[] = [], para: string[] = [], lists: string[] = [];
  const closePara = () => { if (para.length) { out.push("<p>" + para.join("<br>") + "</p>"); para = []; } };
  const closeLists = () => { while (lists.length) out.push(lists.pop() === "ul" ? "</ul>" : "</ol>"); };
  const flushCode = () => { out.push(`<pre${lang ? ` data-lang="${esc(lang)}"` : ""}><code>${esc(buf.join("\n"))}</code></pre>`); buf = []; lang = ""; };
  for (let i2 = 0; i2 < lines.length; i2++) {
    const raw = lines[i2] ?? "";
    const line = raw.replace(/\s+$/, "");
    const fence = line.match(/^\s*```\s*([\w+#.-]*)\s*$/);
    if (fence) {
      if (!inCode) { closePara(); closeLists(); inCode = true; lang = fence[1] ?? ""; buf = []; }
      else { flushCode(); inCode = false; }
      continue;
    }
    if (inCode) { buf.push(raw); continue; }
    if (!line.trim()) { closePara(); closeLists(); continue; }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { closePara(); closeLists(); const lv = (m[1] ?? "").length; out.push(`<h${lv}>${inlineMd(esc(m[2] ?? ""))}</h${lv}>`); continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { closePara(); closeLists(); out.push("<hr>"); continue; }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) { closePara(); if (lists[lists.length - 1] !== "ul") { closeLists(); out.push("<ul>"); lists.push("ul"); } out.push(`<li>${inlineMd(esc(m[1] ?? ""))}</li>`); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { closePara(); if (lists[lists.length - 1] !== "ol") { closeLists(); out.push("<ol>"); lists.push("ol"); } out.push(`<li>${inlineMd(esc(m[1] ?? ""))}</li>`); continue; }
    if ((m = line.match(/^\s*>\s?(.*)$/))) { closePara(); closeLists(); out.push(`<blockquote>${inlineMd(esc(m[1] ?? ""))}</blockquote>`); continue; }
    if (isTableRow(line)) {                       // 表格：收集连续的表格行
      closePara(); closeLists();
      const rows: string[] = [];
      while (i2 < lines.length && isTableRow(lines[i2] ?? "")) { rows.push(lines[i2] ?? ""); i2++; }
      out.push(tableHtml(rows));
      continue;
    }
    para.push(inlineMd(esc(line)));
  }
  if (inCode) flushCode();       // 流式中未闭合的代码块
  closePara(); closeLists();
  return out.join("");
}

/* ---------- 数学公式提取（与网页版同管线的前半段，KaTeX 由 webview 挂载）----------
   先从原文抠出数学段（$$…$$ / $…$ / \[…\] / \(…\)）换成私有区占位符（转义/行内变换碰不到），
   渲染后再还原成 .ktx 占位 span（data-tex 带原文），webview 里 mountMath 用 KaTeX 渲染。
   代码块/行内代码不参与提取；$…$ 需含 ^ _ \ { } = 之一才当公式（避免 "$5 和 $10" 误伤）。 */
export type MathSeg = { tex: string; display: 0 | 1 };

const mathish = (s: string): boolean => /[\\^_{}=]/.test(s) && /[A-Za-z0-9]/.test(s);

export function extractMath(src: string): { text: string; math: MathSeg[] } {
  const math: MathSeg[] = [];
  const ph = (tex: string, display: 0 | 1): string => {
    math.push({ tex, display });
    return `\uE000${math.length - 1}\uE001`;
  };
  let text = String(src ?? "");
  const codes: string[] = [];
  text = text
    .replace(/```[\s\S]*?```/g, (m) => { codes.push(m); return `\uE002${codes.length - 1}\uE003`; })
    .replace(/`[^`\n]+`/g, (m) => { codes.push(m); return `\uE002${codes.length - 1}\uE003`; });
  text = text
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex: string) => ph(tex.trim(), 1))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex: string) => ph(tex.trim(), 1))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex: string) => ph(tex.trim(), 0))
    .replace(/\$([^$\n]+)\$/g, (m, tex: string) => (mathish(tex) ? ph(tex, 0) : m));
  text = text.replace(/\uE002(\d+)\uE003/g, (_, i: string) => codes[Number(i)] ?? "");
  return { text, math };
}

export function restoreMathPlaceholders(html: string, math: MathSeg[]): string {
  return html.replace(/\uE000(\d+)\uE001/g, (_, i: string) => {
    const m = math[Number(i)];
    if (!m) return "";
    return `<span class="ktx" data-display="${m.display}" data-tex="${esc(m.tex)}">${esc(m.tex)}</span>`;
  });
}

/** mdToHtml + 数学占位符：插件侧渲染含公式的消息用这个（webview 的 mountMath 负责最终排版） */
export function mdToHtmlMath(src: string): string {
  const { text, math } = extractMath(src);
  return restoreMathPlaceholders(mdToHtml(text), math);
}

export { mdToHtml, inlineMd, esc };


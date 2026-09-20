import { transformSync } from "esbuild";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 生成 src/generated/renderer-source.ts：
 * 把 markdown.ts（TypeScript）转译成**纯 JavaScript**，再字符串化。
 * 之所以不用源码直接字符串化：注入 Webview 的必须是合法 JS——
 * TS 的类型标注（如 `(s: unknown): string`）在浏览器里是语法错误，
 * 会让整个 Webview 脚本失效（表现为页面永远停在"加载中"）。
 */

const root = dirname(fileURLToPath(import.meta.url));

export function generateRendererSourceSync() {
  const ts = readFileSync(join(root, "src/markdown.ts"), "utf8");
  const stripped = ts
    .replace(/^import .*$/gm, "")
    .replace(/export const RENDERER_SOURCE: string = (?:.|\n)*?;\n$/, "")
    .replace(/export \{ mdToHtml, inlineMd, esc \};\n?/, "")
    .replace(/\/\*\*\n \* 同一套渲染器的源码字符串[\s\S]*?\*\/\n/, "")
    .trim();

  const js = transformSync(stripped, { loader: "ts", target: "es2020" }).code.trim();
  if (!js.includes("function mdToHtml")) throw new Error("渲染器转译结果异常");
  if (new RegExp(":\\s*(string|number|boolean|unknown)\\b").test(js)) {
    throw new Error("转译后仍含类型标注");
  }

  const out = `/* 该文件由 esbuild.mjs 生成（把 markdown.ts 转译成 JS 再字符串化），勿手改 */
export const RENDERER_SOURCE: string = ${JSON.stringify(js + "\n")};
`;
  const target = join(root, "src/generated");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "renderer-source.ts"), out);
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && self === process.argv[1]) {
  generateRendererSourceSync();
  console.log("renderer-source.ts 已生成");
}

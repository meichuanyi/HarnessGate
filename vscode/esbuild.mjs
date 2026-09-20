import { build, context } from "esbuild";
import { generateRendererSourceSync } from "./gen-renderer.mjs";

generateRendererSourceSync();   // 先生成 Webview 注入串（构建时转译成合法 JS）

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode", "bufferutil", "utf-8-validate"],   // ws 的可选原生加速模块，缺失时会自动降级
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("esbuild 监听中…");
} else {
  await build(options);
}

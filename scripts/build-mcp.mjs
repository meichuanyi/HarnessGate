#!/usr/bin/env node
/**
 * 打包中枢 MCP 为自包含 JS（esbuild bundle，连 MCP SDK / ws 一起打进去），
 * 安装到 ~/.harnessgate/bin/（可用 HG_MCP_OUT 覆盖）。
 *
 * 为什么：生产条目（~/.harnessgate/mcp.json 的 harnessgate / harnessgate-admin）
 * 若指向 tsx + 工作树源码，等于生产环境现场解释开发目录——文件改一半存盘、
 * 切分支、npm install 变动都会直接影响新建会话的中枢 MCP。指向打包产物后
 * 工作树随便折腾；升级 = 重跑本脚本，新会话自动用新版（MCP 子进程随会话创建
 * 拉起），已运行会话不受影响。
 *
 * 产物用 .mjs 扩展名：node 按最近 package.json 的 type 字段判 .js 模块类型，
 * ~/.harnessgate/bin 的祖先目录里若有 CJS package.json 会把 .js 当 CommonJS，
 * 顶层 await/import 直接炸；.mjs 恒为 ESM，不受任何祖先配置影响。
 */
import { build } from "esbuild";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OUT = process.env.HG_MCP_OUT ?? join(homedir(), ".harnessgate", "bin");
mkdirSync(OUT, { recursive: true });

await build({
  entryPoints: {
    "hg-mcp-core": "server/mcp-sessions.ts",
    "hg-mcp-admin": "server/mcp-admin.ts",
  },
  outdir: OUT,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "none",
  outExtension: { ".js": ".mjs" },
  banner: {
    js: `/* HarnessGate 中枢 MCP —— scripts/build-mcp.mjs 打包于 ${new Date().toISOString()}
 * 源码：server/mcp-sessions.ts（核心）/ server/mcp-admin.ts（管理面）
 * 改完源码重跑 npm run build:mcp 即更新；无需重启主进程，新会话自动用新版 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url); /* CJS 依赖（ws 等）里残留的 require("events") 在纯 ESM 下无着落，补一个 require 让 esbuild 的 __require shim 能兜住 node 内建模块 */`,
  },
});

// write:true 时 result.outputFiles 为空，直接扫产物目录报告
for (const f of readdirSync(OUT).filter((f) => f.endsWith(".mjs")).sort()) {
  const kb = (statSync(join(OUT, f)).size / 1024).toFixed(1);
  console.log(`✅ ${join(OUT, f)} (${kb} KB)`);
}

import * as vscode from "vscode";
import type { HarnessGateApi } from "../../extension.ts";

/** 打包产物（dist/extension.js）加载后能否连上服务 */
export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension("meichuan.harnessgate");
  if (!ext) throw new Error("插件未被加载");
  const api = (await ext.activate()) as HarnessGateApi;
  if (!api?.store) throw new Error("activate 没有导出 API");
  for (let i = 0; i < 40 && api.store.harnesses.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  const n = api.store.harnesses.length;
  const cmds = (await vscode.commands.getCommands(true)).filter((c) => c.startsWith("harnessgate."));
  console.log(`✔ 插件加载成功；harness ${n} 个；命令 ${cmds.length} 个`);
  if (!n) throw new Error("没同步到 harness（服务没跑？）");
}

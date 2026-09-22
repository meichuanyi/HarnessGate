import * as vscode from "vscode";
import type { GateClient } from "./client.ts";

/**
 * 工作目录输入：服务器上的路径，支持边打边列目录（复用服务端的 dirs 补全）。
 * 新建会话与新建圆桌共用。
 */
export async function promptCwd(client: GateClient, initial: string): Promise<string | undefined> {
  const input = vscode.window.createInputBox();
  input.title = "工作目录（服务器上的路径）";
  input.placeholder = "/path/on/server";
  input.value = initial;
  input.prompt = "输入片段会列出子目录；不存在的目录会在创建时自动建立";
  let reqId = "";
  const req = () => {
    reqId = Math.random().toString(36).slice(2);
    client.send({ type: "dirs", reqId, input: input.value.trim() });
  };
  const onDirs = (msg: { reqId: string; dir: string; exists: boolean; isDir: boolean; entries: Array<{ name: string; path: string; git: boolean }>; error?: string }) => {
    if (msg.reqId !== reqId) return;
    if (msg.error) input.prompt = `读不了这个目录：${msg.error}`;
    else if (!msg.exists) input.prompt = "目录不存在 · 回车将创建";
    else if (!msg.isDir) input.prompt = "这是文件，不是目录";
    else input.prompt = `${msg.entries.length} 个子目录 · 回车在该目录新建会话`;
  };
  client.on("dirs", onDirs);
  input.onDidChangeValue(() => {
    if (input.value.trim().length >= 1) req();
  });
  req();

  const result = await new Promise<string | undefined>((resolve) => {
    input.onDidAccept(() => resolve(input.value.trim()));
    input.onDidHide(() => resolve(undefined));
    input.show();
  });
  client.off("dirs", onDirs);
  input.dispose();
  return result;
}

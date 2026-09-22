import * as vscode from "vscode";
import type { HarnessGateApi } from "../../extension.ts";

/**
 * 聚焦诊断：打开一个大会话（>300 条 transcript），限时等渲染回执。
 * 失败时打印 webview 回报的错误（chat.ts 的 wvError 转发）。
 *   HG_TEST=bigload node out-test/runTest.js
 */
export async function run(): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const ext = vscode.extensions.getExtension("meichuan.harnessgate");
  const api = (await ext?.activate()) as HarnessGateApi | undefined;
  if (!api) throw new Error("插件未激活");

  await vscode.commands.executeCommand("harnessgate.connect");
  for (let i = 0; i < 40 && api.state() !== "connected"; i++) await sleep(250);
  for (let i = 0; i < 40 && !api.store.sessions.size; i++) await sleep(250);

  const wvErrors: string[] = [];
  api.client.on("message", () => {});   // 保活引用
  // wvError 通过 output channel 记录，这里直接读 ChatPanel 侧状态

  const big = await new Promise<{ id: string; total: number } | undefined>((resolve) => {
    // 只挑归档会话（同 index.ts：曾误选用户正在用的 live 会话并 close，杀掉在途回合）
    const cands = [...api.store.sessions.values()]
      .filter((s) => !s.live && s.status === "saved")
      .sort((a, b) => (b.lastActiveAt || "").localeCompare(a.lastActiveAt || ""));
    let i = 0;
    let waiting = "";
    const onT = (m: unknown) => {
      const mm = m as { type: string; sessionId: string; entries?: Array<Record<string, unknown>> };
      if (mm.type !== "transcript" || mm.sessionId !== waiting) return;
      const n = (mm.entries ?? []).length;
      if (n > 300) resolve({ id: mm.sessionId, total: n });
      else step();
    };
    const step = () => {
      const s = cands[i++];
      if (!s) { api.client.off("transcript", onT); resolve(undefined); return; }
      waiting = s.id;
      api.client.send({ type: "transcript", sessionId: s.id });
    };
    api.client.on("transcript", onT);
    step();
    setTimeout(() => { api.client.off("transcript", onT); resolve(undefined); }, 45000);
  });

  if (!big) throw new Error("没找到 >300 条的会话");
  console.log(`大会话: #${big.id.slice(0, 8)}（${big.total} 条）`);

  api.openChat(big.id);
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    const info = api.chatRenderInfo(big.id);
    if (info) {
      console.log(`✔ 渲染回执: count=${info.count} start=${info.start} total=${info.total} 用时=${info.ms}ms`);
      api.client.send({ type: "close", sessionId: big.id });
      return;
    }
  }
  api.client.send({ type: "close", sessionId: big.id });
  throw new Error(`12s 内没有渲染回执（webview 错误见 HarnessGate 输出通道）：${wvErrors.join(" | ") || "无 wvError 记录"}`);
}

import * as vscode from "vscode";
import type { HarnessGateApi } from "../../extension.ts";

/**
 * 聚焦复现（用户报告：打开会话看不到对话记录）：
 * 用与真实点击完全相同的入口（executeCommand openChat）打开多种状态的会话，
 * 验证渲染回执（count>0）确实到达。任何一步失败即复现。
 */
export async function run(): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const ext = vscode.extensions.getExtension("meichuan.harnessgate");
  const api = (await ext?.activate()) as HarnessGateApi | undefined;
  if (!api) throw new Error("插件未激活");

  await vscode.commands.executeCommand("harnessgate.connect");
  for (let i = 0; i < 40 && api.state() !== "connected"; i++) await sleep(250);
  for (let i = 0; i < 40 && !api.store.sessions.size; i++) await sleep(250);
  console.log("会话总数:", api.store.sessions.size);

  // 按最近活跃取前 12 个会话（混合 live/saved/空），逐一走真实打开流程：
  // 先从服务端要 transcript 条数，再打开面板，断言渲染回执的条数与服务端一致（0 条也必须回执）
  const cands = [...api.store.sessions.values()]
    .sort((a, b) => (b.lastActiveAt || "").localeCompare(a.lastActiveAt || ""))
    .slice(0, 12);

  let opened = 0, okCount = 0;
  for (const s of cands) {
    const serverCount = await new Promise<number>((resolve) => {
      const onT = (m: unknown) => {
        const mm = m as { type: string; sessionId: string; entries?: Array<Record<string, unknown>> };
        if (mm.type === "transcript" && mm.sessionId === s.id) {
          api.client.off("transcript", onT);
          resolve((mm.entries ?? []).length);
        }
      };
      api.client.on("transcript", onT);
      api.client.send({ type: "transcript", sessionId: s.id });
      setTimeout(() => { api.client.off("transcript", onT); resolve(-1); }, 8000);
    });
    await vscode.commands.executeCommand("harnessgate.openChat", s.id);
    let info: { count: number; start: number; total: number; ms: number } | undefined;
    for (let i = 0; i < 30 && !info; i++) {
      await sleep(400);
      info = api.chatRenderInfo(s.id);
    }
    opened++;
    if (info && serverCount >= 0 && info.total === serverCount) {
      okCount++;
      console.log(`✔ ${s.status.padEnd(7)} #${s.id.slice(0, 8)} 服务端 ${serverCount} 条 = 面板 ${info.total} 条（首屏 ${info.count}）${info.ms}ms`);
    } else {
      console.log(`✘ ${s.status.padEnd(7)} #${s.id.slice(0, 8)} 服务端 ${serverCount} 条 vs 回执 ${JSON.stringify(info ?? null)}`);
    }
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await sleep(300);
  }
  console.log(`=== 打开 ${opened} 个会话，渲染一致 ${okCount} 个 ===`);
  if (opened === 0) throw new Error("没有可测的会话");
  if (okCount < opened) throw new Error(`${opened - okCount} 个会话打开后记录不一致`);
}

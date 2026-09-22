import * as vscode from "vscode";
import type { HarnessGateApi } from "../../extension.ts";

/**
 * 视觉复现：驱动一个长 Markdown 输出的会话，中途重开面板，
 * 然后用 CDP 截整个 VS Code 窗口的图（/tmp/vscode-shot.png），人工查看渲染是否混乱/重复。
 *   HG_TEST=vis xvfb-run -a node out-test/runTest.js
 * 需要先在 runTests 的 launchArgs 里加 --remote-debugging-port=9222。
 */
export async function run(): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const ext = vscode.extensions.getExtension("meichuan.harnessgate");
  const api = (await ext?.activate()) as HarnessGateApi | undefined;
  if (!api) throw new Error("插件未激活");

  await vscode.commands.executeCommand("harnessgate.connect");
  for (let i = 0; i < 40 && api.state() !== "connected"; i++) await sleep(250);
  for (let i = 0; i < 40 && !api.store.sessions.size; i++) await sleep(250);

  const prefer = ["zcode", "hermes", "claude", "codex"];
  const usable = api.store.harnesses.filter((h) => h.available && !h.blocked);
  const pick = prefer.map((id) => usable.find((h) => h.id === id)).find(Boolean) ?? usable[0];
  if (!pick) throw new Error("没有可用 harness");

  const created = await api.createSession(pick.id, "/tmp/hg-vis-test");
  if (!created) throw new Error("创建会话失败");
  for (let i = 0; i < 120; i++) {
    const s = api.store.getSession(created.id);
    if (s?.status === "ready" || s?.status === "error") break;
    await sleep(500);
  }

  api.openChat(created.id);
  await sleep(800);

  const LONG = [
    "# 性能优化指南",
    "",
    "## 1. 核心思路",
    "优化前先测量。**没有数据的优化是盲目的**，以下是三步法：",
    "",
    "| 步骤 | 工具 | 产出 |",
    "| --- | --- | --- |",
    "| 基准 | bench | 基线数据 |",
    "| 剖析 | profile | 热点清单 |",
    "| 改造 | - | 对比报告 |",
    "",
    "## 2. 代码示例",
    "```python",
    "def bench(fn, n=1000):",
    "    t0 = time.time()",
    "    for _ in range(n):",
    "        fn()",
    "    return (time.time() - t0) / n",
    "```",
    "",
    "## 3. 注意事项",
    "- 先优化算法复杂度，再看常数",
    "- `O(n log n)` 通常优于 `O(n²)`",
    "",
    "写完后请把这整篇内容**原样重复输出一遍**（用于测试渲染）。",
  ].join("\n");

  let turnEnded = false;
  const onMsg = (m: Record<string, unknown>) => {
    if (m.type === "turn_end" && m.sessionId === created.id) turnEnded = true;
  };
  api.client.on("message", onMsg);
  api.client.send({ type: "prompt", sessionId: created.id, text: LONG });

  // 流式中途：关掉面板再重开（复现「打开会话看不到/重复」的路径）
  await sleep(6000);
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await sleep(500);
  api.openChat(created.id);

  for (let i = 0; i < 360 && !turnEnded; i++) await sleep(500);
  api.client.off("message", onMsg);
  await sleep(2500);   // 等最后渲染稳定

  console.log("VIS-DONE turnEnded=" + turnEnded);
  // 截图由外部 CDP 完成；这里保持窗口不动即可
  api.client.send({ type: "delete", sessionId: created.id });
  await sleep(1500);
}

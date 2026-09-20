import * as vscode from "vscode";
import type { HarnessGateApi } from "../../extension.ts";

/**
 * 插件端到端测试：连真实 HarnessGate 服务（本机 9830），验证
 * 连接 → 状态同步 → 新建会话 → 发消息 → 收到流式回复 → 会话出现在列表里。
 * 会在服务器上真的建一个会话（目录 /tmp/hg-vscode-test）。
 */
export async function run(): Promise<void> {
  const results: Array<[string, boolean, string]> = [];
  const check = (name: string, ok: boolean, extra = "") => {
    results.push([name, ok, extra]);
    console.log(`${ok ? "✔" : "✘"} ${name}${extra ? "  " + extra : ""}`);
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const ext = vscode.extensions.getExtension("harnessgate.harnessgate");
  check("插件被识别", Boolean(ext), ext?.id ?? "未找到");
  const api = (await ext?.activate()) as HarnessGateApi | undefined;
  check("插件激活成功", Boolean(ext?.isActive));
  check("activate 导出了测试 API", Boolean(api?.store && api?.client));

  const cmds = await vscode.commands.getCommands(true);
  for (const c of [
    "harnessgate.connect",
    "harnessgate.refresh",
    "harnessgate.newSession",
    "harnessgate.openChat",
    "harnessgate.syncHistory",
    "harnessgate.deleteSession",
  ]) {
    check(`命令已注册 ${c}`, cmds.includes(c));
  }

  await vscode.commands.executeCommand("harnessgate.connect");
  // 等 hello
  for (let i = 0; i < 40 && api?.state() !== "connected"; i++) await sleep(250);
  check("已连上服务", api?.state() === "connected", api?.state() ?? "?");

  for (let i = 0; i < 40 && !(api?.store.harnesses.length); i++) await sleep(250);
  const hs = api?.store.harnesses ?? [];
  check("同步到 harness 列表", hs.length > 0, `${hs.length} 个`);
  const usable = hs.filter((h) => h.available && !h.blocked);
  check("有可用 harness", usable.length > 0, usable.map((h) => h.id).join(", "));
  check("会话列表已同步", (api?.store.sessions.size ?? 0) > 0, `${api?.store.sessions.size ?? 0} 个`);
  check("服务端默认目录已同步", Boolean(api?.store.defaultCwd), api?.store.defaultCwd ?? "");

  // 树视图 provider 的数据（直接调 provider 拿不到实例，这里用 store 语义等价验证）
  // 优先用实测稳定的 harness（opencode 的免费模型偶发无限慢，不能让测试陪它赌）
  const prefer = ["zcode", "hermes", "claude", "codex"];
  const pick = prefer.map((id) => usable.find((h) => h.id === id)).find(Boolean) ?? usable[0];
  if (!pick) throw new Error("没有可用 harness，无法继续");

  const before = api!.store.sessionsOf(pick.id).length;
  console.log(`  用 ${pick.id} 建会话（目录 /tmp/hg-vscode-test）…`);
  const created = await api!.createSession(pick.id, "/tmp/hg-vscode-test");
  check("新建会话成功", Boolean(created), created ? `#${created.id}` : "超时");
  check("会话进入列表", api!.store.sessionsOf(pick.id).length === before + 1);

  if (created) {
    // 等会话就绪
    for (let i = 0; i < 120; i++) {
      const s = api!.store.getSession(created.id);
      if (s?.status === "ready") break;
      if (s?.status === "error") break;
      await sleep(500);
    }
    const s = api!.store.getSession(created.id);
    check("会话就绪", s?.status === "ready", s?.status ?? "?");

    // 打开对话面板并观察流式（面板是 webview，这里验证数据面：update 消息能被收到）
    api!.openChat(created.id);
    await sleep(800);

    const seen: string[] = [];
    let turnEnded = false;
    const onMsg = (m: Record<string, unknown>) => {
      if (m.type === "update" && m.sessionId === created.id) {
        const u = m.update as { sessionUpdate?: string; content?: { text?: string } };
        if (u?.sessionUpdate === "agent_message_chunk" && u.content?.text) seen.push(u.content.text);
      }
      if (m.type === "turn_end" && m.sessionId === created.id) turnEnded = true;
    };
    api!.client.on("message", onMsg);
    api!.client.send({ type: "prompt", sessionId: created.id, text: "只回复两个字：收到" });

    // 模型偶发慢（实测有 3 分钟的一轮），等 5 分钟；超时后用台账兜底验证
    for (let i = 0; i < 600 && !turnEnded; i++) await sleep(500);
    api!.client.off("message", onMsg);
    let replyText = seen.join("");
    if (!seen.length) {
      console.log("  （实时流没等到，改用台账验证回复）");
      const entries = await new Promise<Array<Record<string, unknown>>>((resolve) => {
        const onT = (m: unknown) => {
          const mm = m as { type: string; sessionId: string; entries?: Array<Record<string, unknown>> };
          if (mm.type === "transcript" && mm.sessionId === created.id) {
            api!.client.off("transcript", onT);
            resolve(mm.entries ?? []);
          }
        };
        api!.client.on("transcript", onT);
        api!.client.send({ type: "transcript", sessionId: created.id });
        setTimeout(() => resolve([]), 10000);
      });
      replyText = entries
        .filter((e) => e.kind === "assistant")
        .map((e) => String(e.text ?? ""))
        .join("");
    }
    check("收到回复（流式或台账）", replyText.length > 0, `${seen.length} chunk / 台账 ${replyText.length} 字`);
    check("本轮正常结束", turnEnded);
    check("回复内容合理", replyText.includes("收到"), JSON.stringify(replyText.slice(0, 40)));

    // 面板标题里应能拿到会话标题（服务端从首条消息推导）
    await sleep(1200);
    const titled = api!.store.getSession(created.id)?.title ?? "";
    check("会话标题已回填", titled.length > 0, titled.slice(0, 30));

    // 清理：删掉测试会话
    api!.client.send({ type: "delete", sessionId: created.id });
    await sleep(1500);
    check("测试会话已清理", !api!.store.getSession(created.id));
  }

  console.log("\n=== 测试完成 ===");
  const failed = results.filter(([, ok]) => !ok);
  console.log(`共 ${results.length} 项，失败 ${failed.length}`);
  if (failed.length) throw new Error(`${failed.length} 项未通过: ${failed.map(([n]) => n).join(", ")}`);
}

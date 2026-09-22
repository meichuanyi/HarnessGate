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

  const ext = vscode.extensions.getExtension("meichuan.harnessgate");
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
    "harnessgate.rooms",
    "harnessgate.configServer",
    "harnessgate.collapseAll",
    "harnessgate.expandAll",
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

  // ---- 圆桌：原生面板（回归：以前只有「在浏览器打开」按钮） ----
  for (let i = 0; i < 20 && !(api?.store.roomsList().length); i++) await sleep(500);
  const rooms0 = api?.store.roomsList() ?? [];
  check("圆桌列表已同步", rooms0.length > 0, `${rooms0.length} 个`);
  let roomsPanelOk = true;
  try {
    await vscode.commands.executeCommand("harnessgate.rooms");
  } catch (err) {
    roomsPanelOk = false;
    console.log("  ✘ 圆桌面板打开失败:", err);
  }
  check("圆桌面板能打开", roomsPanelOk);
  {
    let rinfo: { rooms: number; ms: number } | undefined;
    for (let i = 0; i < 30 && !rinfo; i++) {
      await sleep(400);
      rinfo = api?.roomsRenderInfo();
    }
    check("圆桌面板完成渲染", Boolean(rinfo && rinfo.rooms > 0), rinfo ? `${rinfo.rooms} 个圆桌 · ${rinfo.ms}ms` : "12s 无回执");
  }

  // ---- 大会话加载回归（用户报告：800 条历史会话一直卡「加载中」） ----
  // 只挑归档（saved）会话：曾按「最近活跃」挑选，结果选中了用户正在用的 live 会话，
  // 测完 close 把正在跑的回合连同 harness 进程一起杀掉（表现为 ACP connection closed）。
  {
    const big = await new Promise<{ id: string; total: number } | undefined>((resolve) => {
      const cands = [...(api?.store.sessions.values() ?? [])]
        .filter((s) => !s.live && s.status === "saved")
        .sort((a, b) => (b.lastActiveAt || "").localeCompare(a.lastActiveAt || ""));
      let i = 0;
      let waiting = "";
      const onT = (m: unknown) => {
        const mm = m as { type: string; sessionId: string; entries?: Array<Record<string, unknown>> };
        if (mm.type !== "transcript" || mm.sessionId !== waiting) return;
        const n = (mm.entries ?? []).length;
        if (n > 300) resolve({ id: mm.sessionId, total: n });
        else step();   // 这个不够大，看下一个
      };
      const step = () => {
        const s = cands[i++];
        if (!s) { api!.client.off("transcript", onT); resolve(undefined); return; }
        waiting = s.id;
        api!.client.send({ type: "transcript", sessionId: s.id });
      };
      api!.client.on("transcript", onT);
      step();
      setTimeout(() => { api!.client.off("transcript", onT); resolve(undefined); }, 45000);
    });
    check("找到大会话（>300 条）", Boolean(big), big ? `#${big.id.slice(0, 8)} ${big.total} 条` : "没有，跳过");
    if (big) {
      api!.openChat(big.id);
      let info: { count: number; start: number; total: number; ms: number } | undefined;
      for (let i = 0; i < 60 && !info; i++) {
        await sleep(500);
        info = api!.chatRenderInfo(big.id);
      }
      check("大会话面板完成渲染（不再卡加载中）", Boolean(info), info ? `${info.count}/${info.total} 条 · ${info.ms}ms` : "30s 无回执");
      check("首屏只发窗口内条目", Boolean(info && info.count <= 150 && info.count < info.total), info ? `count=${info.count}` : "");
      check("窗口外还有更早条目（可分页载入）", Boolean(info && info.start > 0), info ? `start=${info.start}` : "");
      // 打开归档会话会触发 resume（拉起 agent），测完关掉，别留进程
      api!.client.send({ type: "close", sessionId: big.id });
      await sleep(1500);
    }
  }

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

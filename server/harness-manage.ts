import { execFile } from "node:child_process";
import { bundleVersion, downloadHarnessBinary, fetchRegistryAgent, installRegistryHarness } from "./harness-download.ts";
import type { HarnessSpec } from "./types.ts";

/**
 * harness 版本管理：本机版本探测 + 上游最新版对照 + 一键安装/升级。
 * 只执行本地注册表里预声明的 npm 包/命令/下载分发/注册表条目——客户端消息里只能传
 * harnessId 和 action，不存在「把任意命令/URL 传给端点」的面。
 */
export type ManageInfo = {
  supported: boolean;
  installed?: string;
  latest?: string;
  busy?: boolean;
  checkedAt?: number;
};

export type ManageResult = { ok: boolean; from?: string; to?: string; output: string; binPath?: string };

const LATEST_TTL = 6 * 3600_000;
const state = new Map<string, ManageInfo>();
let specs: HarnessSpec[] = [];

function sh(cmd: string, timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const [bin = "", ...args] = cmd.split(/\s+/);
    execFile(bin, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (err: Error | null, stdout?: string, stderr?: string) => {
      resolve({ ok: !err, out: `${stdout || ""}${stderr ? `\n${stderr}` : ""}`.trim() });
    });
  });
}

export function manageInfo(id: string): ManageInfo {
  return state.get(id) ?? { supported: false };
}

/** npm 包的本机已装版本；跑不了返回 undefined */
async function npmInstalled(pkg: string): Promise<string | undefined> {
  const r = await sh(`npm ls -g ${pkg} --json`, 20_000);
  if (!r.ok) return undefined;
  try {
    return JSON.parse(r.out)?.dependencies?.[pkg]?.version;
  } catch {
    return undefined;
  }
}

async function npmLatest(pkg: string): Promise<string | undefined> {
  const r = await sh(`npm view ${pkg} version`, 30_000);
  return r.ok ? r.out.trim() || undefined : undefined;
}

/** 自定义 versionCmd 取版本：取第一行，剥掉前缀非数字部分（如 "opencode 1.2.3"） */
async function cmdVersion(cmd: string): Promise<string | undefined> {
  const r = await sh(cmd, 20_000);
  if (!r.ok) return undefined;
  return r.out.split(/\r?\n/)[0]?.trim().replace(/^[^\d]*/, "") || undefined;
}

export function initManage(harnesses: HarnessSpec[], onAvailChange: () => void): void {
  // 声明 manage 的参与版本管理；requiresDownload 条目参与一键下载（supported=false，不进「版本管理」列表，只在不可用卡片上出「安装」按钮）
  specs = harnesses.filter((h) => h.manage?.pkg || h.manage?.versionCmd || h.manage?.registry || (h.requiresDownload && h.download?.archive));
  for (const h of specs) {
    if (!state.has(h.id)) {
      state.set(h.id, { supported: Boolean(h.manage?.pkg || h.manage?.versionCmd || h.manage?.registry) });
    }
  }
  if (!specs.length) return;
  void refreshAll(onAvailChange);
  setInterval(() => void refreshAll(onAvailChange), LATEST_TTL);
}

async function refreshAll(onAvailChange: () => void): Promise<void> {
  for (const h of specs) {
    const st = state.get(h.id)!;
    if (st.busy) continue;   // 升级中不动它的状态，manageRun 自己会刷新
    if (h.manage?.pkg) {
      st.installed = await npmInstalled(h.manage.pkg);
      if (!st.latest || !st.checkedAt || Date.now() - st.checkedAt > LATEST_TTL) {
        const v = await npmLatest(h.manage.pkg);
        if (v) {
          st.latest = v;
          st.checkedAt = Date.now();
        }
      }
    } else if (h.manage?.versionCmd) {
      st.installed = await cmdVersion(h.manage.versionCmd);
    } else if (h.manage?.registry) {
      // registry 型：installed 从本机二进制包内读（zipapp/par 的 _version.py），latest 从 ACP 官方注册表 agent.json 取
      st.installed = await bundleVersion(h.cmd);
      if (!st.latest || !st.checkedAt || Date.now() - st.checkedAt > LATEST_TTL) {
        try {
          const meta = await fetchRegistryAgent(h.manage.registry);
          st.latest = meta.version;
          st.checkedAt = Date.now();
        } catch { /* 注册表拉不动（网络/代理）：保留旧 latest，下轮再试 */ }
      }
    }
  }
  onAvailChange();
}

/** 一键安装/升级（install=本机没有时装，update=有旧版时升级；npm 语义下都是装 @latest） */
export async function manageRun(
  id: string,
  _action: "install" | "update",
): Promise<ManageResult> {
  const h = specs.find((x) => x.id === id);
  if (!h) return { ok: false, output: "该 harness 没有可执行的一键安装方式（未声明 manage，也未声明下载分发，或已经装好）" };
  // requiresDownload 条目：按注册表预声明的分发信息下载二进制（to 带注册表里的版本号）
  if (h.requiresDownload && h.download?.archive) {
    const dst = state.get(id);
    if (dst?.busy) return { ok: false, output: "该 harness 已有管理动作在进行中，请等它结束" };
    if (dst) dst.busy = true;
    try {
      const target = await downloadHarnessBinary(id, h.download);
      return { ok: true, to: h.version, output: `已下载并解压到 ${target}`, binPath: target };
    } catch (err) {
      return { ok: false, output: err instanceof Error ? err.message : String(err) };
    } finally {
      if (dst) dst.busy = false;
    }
  }
  const st = state.get(id);
  if (!h.manage || !st) return { ok: false, output: "该 harness 未声明 manage，不参与自动安装/升级" };
  if (st.busy) return { ok: false, output: "该 harness 已有管理动作在进行中，请等它结束" };
  st.busy = true;
  try {
    const from = st.installed;
    let out: string;
    if (h.manage.pkg) {
      const r = await sh(`npm i -g ${h.manage.pkg}@latest`, 600_000);
      out = r.out.slice(-2000);
      if (!r.ok) return { ok: false, from, output: out || "npm 安装失败" };
      st.installed = await npmInstalled(h.manage.pkg);
      const v = await npmLatest(h.manage.pkg);
      if (v) {
        st.latest = v;
        st.checkedAt = Date.now();
      }
    } else if (h.manage.updateCmd) {
      const r = await sh(h.manage.updateCmd, 600_000);
      out = r.out.slice(-2000);
      if (!r.ok) return { ok: false, from, output: out || "更新命令执行失败" };
      if (h.manage.versionCmd) st.installed = await cmdVersion(h.manage.versionCmd);
    } else if (h.manage.registry) {
      // registry 型：安装与升级同一条路（下载→校验→原子替换），装没装过都行
      const r = await installRegistryHarness(h.manage.registry, h.cmd);
      st.installed = r.version;
      st.latest = r.version;
      st.checkedAt = Date.now();
      out = `已就位 ${r.version}：${r.target}`;
    } else {
      return { ok: false, from, output: "未配置 updateCmd / registry" };
    }
    return { ok: true, from, to: st.installed, output: out };
  } finally {
    st.busy = false;
  }
}

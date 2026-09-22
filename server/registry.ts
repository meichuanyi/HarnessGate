import { accessSync, constants, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { HarnessAvailability, HarnessSpec, Registry } from "./types.ts";

/**
 * 加载 harness.json（手写，优先）并与 harness.registry.json（ACP 注册表导入）合并。
 * 同 id 时手写条目覆盖导入条目。
 */
export function loadRegistry(file: string): Registry {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Registry;
  if (!Array.isArray(raw.harnesses) || raw.harnesses.length === 0) {
    throw new Error(`注册表 ${file} 里没有任何 harness`);
  }
  const importedFile = join(dirname(file), "harness.registry.json");
  let imported: HarnessSpec[] = [];
  if (existsSync(importedFile)) {
    try {
      imported = (JSON.parse(readFileSync(importedFile, "utf8")) as Registry).harnesses ?? [];
    } catch (err) {
      console.error(`[registry] ${importedFile} 解析失败，忽略:`, err instanceof Error ? err.message : err);
    }
  }
  const curatedIds = new Set(raw.harnesses.map((h) => h.id));
  // 手写条目也可能通过别的命令跑同一个包（例如 codex 用全局二进制，注册表里 codex-acp 用 npx 同一包），
  // 这类同源条目要吸收掉，否则侧栏会出现两个一模一样的 harness
  const curatedPkgs = new Set(raw.harnesses.map((h) => packageKey(h)).filter(Boolean) as string[]);
  const dupes = imported.filter((h) => {
    if (curatedIds.has(h.id)) return true;
    const key = packageKey(h);
    return Boolean(key && curatedPkgs.has(key));
  });
  if (dupes.length) {
    console.error(
      `[registry] 忽略 ${dupes.length} 个与手写条目同源的导入项: ${dupes
        .map((h) => `${h.id}(${packageKey(h)})`)
        .join(", ")}`,
    );
  }
  const merged = [...raw.harnesses, ...imported.filter((h) => !dupes.includes(h))];
  return { ...raw, harnesses: merged };
}

/**
 * 识别"同一个东西的两种启动方式"用的归一化 key。
 * 手写条目通常写二进制名（codex-acp），导入条目写 npx 包名（@agentclientprotocol/codex-acp）——
 * 二进制的名字一般就是包名的最后一段，所以取包名末段作为 key 就能把两者对上。
 */
export function packageKey(spec: HarnessSpec): string | undefined {
  const text = [spec.cmd, ...(spec.args ?? [])].join(" ");
  const m = text.match(/@[a-z0-9][\w.-]*\/([\w.-]+)/i);
  const seg = m?.[1];
  if (seg) return seg.toLowerCase().replace(/@[\d.]+$/, "");
  // 纯二进制名（无路径分隔符、不是包管理器）也当作 key，好跟 npx 形式的同源条目对上
  const base = spec.cmd.split("/").pop() ?? "";
  if (!base || /^(npx|uvx|node|python3?|bunx?)$/i.test(base)) return undefined;
  return base.toLowerCase();
}

/** 在 PATH 里找可执行文件；cmd 是路径时直接检查。 */
export function findBinary(cmd: string): string | null {
  if (isAbsolute(cmd) || cmd.includes("/")) {
    try {
      accessSync(cmd, constants.X_OK);
      return cmd;
    } catch {
      return null;
    }
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, cmd);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* 继续找 */
    }
  }
  return null;
}

export type Trust = { tier: "vendor" | "known" | "unknown"; reason?: string };

/** 读取人工分级（harness.trust.json），决定展示优先级与是否屏蔽 */
export type TrustTable = {
  vendor: Record<string, string>;
  known: Record<string, string>;
  unknown: Record<string, string>;
  blocked: Record<string, string>;
};

export function loadTrust(file: string): TrustTable {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return { vendor: raw.vendor ?? {}, known: raw.known ?? {}, unknown: raw.unknown ?? {}, blocked: raw.blocked ?? {} };
  } catch {
    return { vendor: {}, known: {}, unknown: {}, blocked: {} };
  }
}

export function trustOf(spec: HarnessSpec, trust: ReturnType<typeof loadTrust>): Trust {
  if (trust.blocked[spec.id]) return { tier: "unknown", reason: trust.blocked[spec.id] };
  if (trust.vendor[spec.id]) return { tier: "vendor", reason: trust.vendor[spec.id] };
  if (trust.known[spec.id]) return { tier: "known", reason: trust.known[spec.id] };
  if (trust.unknown[spec.id]) return { tier: "unknown", reason: `存疑：${trust.unknown[spec.id]}（默认隐藏，可勾选「显示存疑项」查看）` };
  return { tier: spec.source === "acp-registry" ? "unknown" : "vendor", reason: spec.source === "acp-registry" ? "社区提交，来源未经核实：星数极低或找不到公开仓库" : "本机手工配置" };
}

/** UI 里按 harness 配置的运行时覆盖（当前只有代理）。与 harness.json / registry.json 分离存储，
 *  对两类条目都生效；空字符串 = 清除（直连）。 */
export type HarnessOverrides = Record<string, { proxy?: string }>;

export function loadOverrides(file: string): HarnessOverrides {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return raw.overrides ?? {};
  } catch {
    return {};
  }
}

export function applyOverrides(reg: Registry, ov: HarnessOverrides): void {
  for (const h of reg.harnesses) {
    const o = ov[h.id];
    if (!o) continue;
    if (o.proxy !== undefined) h.proxy = o.proxy || undefined;
  }
}

export function saveOverrides(file: string, ov: HarnessOverrides): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ overrides: ov }, null, 1));
  renameSync(tmp, file);
}

export type ProbeConfigOption = {
  id: string;
  name: string;
  category?: string;
  currentValue?: string;
  options: Array<{ value: string; name: string }>;
};

export type ProbeResults = Record<
  string,
  {
    state: string;
    detail?: string;
    deep?: boolean;
    /** 最近一次「深度探活」（真实对话）的结论：failed/timeout 时，浅探通过也不算可用 */
    lastDeep?: string;
    ts?: string;
    configs?: ProbeConfigOption[];
  }
>;

export function loadProbe(file: string): ProbeResults {
  try {
    return JSON.parse(readFileSync(file, "utf8")).results ?? {};
  } catch {
    return {};
  }
}

let globalPkgs: Set<string> | null = null;
/** 全局安装的 npm 包名集合（缓存一次） */
function globalPackages(): Set<string> {
  if (globalPkgs) return globalPkgs;
  try {
    const out = execFileSync("npm", ["ls", "-g", "--depth=0", "--json"], { encoding: "utf8", timeout: 20_000 });
    globalPkgs = new Set(Object.keys(JSON.parse(out).dependencies ?? {}));
  } catch {
    globalPkgs = new Set();
  }
  return globalPkgs;
}

/** npx 缓存里有没有这个包（~/.npm/_npx/<hash>/node_modules/<pkg>） */
function inNpxCache(pkg: string): boolean {
  const root = join(homedir(), ".npm", "_npx");
  if (!existsSync(root)) return false;
  try {
    for (const dir of readdirSync(root)) {
      if (existsSync(join(root, dir, "node_modules", pkg))) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

export type LocalState = "probed-ok" | "probed-auth" | "probed-failed" | "installed" | "needs-download" | "missing" | "blocked";

/** 本机真实可用性：不看"启动器在不在"，看 agent 本身在不在、探活过没过 */
export function localState(spec: HarnessSpec, trust: ReturnType<typeof loadTrust>, probe: ProbeResults): LocalState {
  if (trust.blocked[spec.id]) return "blocked";
  const p = probe[spec.id];
  if (p?.state === "ok" && p.deep) return "probed-ok";        // 真实对话通过
  if (p?.state === "ok" && !p.deep) {
    // 能建会话但对话从未验证过（或上次深探失败）→ 不算可用：建得了会话不代表聊得动
    if (p.lastDeep === "failed" || p.lastDeep === "timeout") return "probed-failed";
    return "installed";
  }
  if (p?.state === "auth") return "probed-auth";
  if (p?.state === "failed" || p?.state === "timeout") return "probed-failed";
  if (spec.cmd === "npx" || spec.cmd === "uvx") {
    const pkg = (spec.args ?? []).find((a) => !a.startsWith("-"));
    if (pkg && (globalPackages().has(pkg) || inNpxCache(pkg))) return "installed";   // 已下载但未探活
    return "needs-download";
  }
  return findBinary(spec.cmd) ? "installed" : "missing";
}

export function availability(spec: HarnessSpec, trust?: ReturnType<typeof loadTrust>, probe: ProbeResults = {}): HarnessAvailability {
  const binPath = findBinary(spec.cmd);
  const blocked = trust ? Boolean(trust.blocked[spec.id]) : false;
  const state: LocalState = trust ? localState(spec, trust, probe) : (binPath ? "installed" : "missing");
  const available = state === "probed-ok" || state === "installed";
  const t = trust ? trustOf(spec, trust) : undefined;
  const note =
    state === "blocked" ? `已屏蔽：${trust!.blocked[spec.id]}`
    : state === "needs-download" ? `本机没有：首次使用需要下载（${spec.cmd}），下载后请跑一次 npm run doctor -- --probe 验证`
    : state === "probed-auth" ? `需先登录该 CLI（探活：${probe[spec.id]?.detail ?? ""}）`
    : state === "probed-failed" ? `探活失败：${probe[spec.id]?.detail ?? ""}`
    : state === "missing" ? `未安装：找不到 ${spec.cmd}${spec.proxy ? `（已配代理 ${spec.proxy}）` : ""}`
    : state === "installed" && probe[spec.id]?.state === "ok" ? "启动正常，但没试过对话（跑 npm run doctor -- --probe --deep 可验证）"
    : state === "installed" && spec.cmd === "npx" ? "本机已下载（未探活）"
    : spec.proxy ? `${spec.note ?? ""}（走代理 ${spec.proxy}）`
    : spec.note;
  return {
    id: spec.id,
    label: spec.label,
    available,
    binPath,
    note,
    proxy: spec.proxy,
    experimental: spec.experimental,
    source: spec.source,
    version: spec.version,
    description: spec.description,
    tier: t?.tier,
    trustReason: t?.reason,
    blocked,
    state,
    configs: probe[spec.id]?.configs,
    extraAgents: (spec as unknown as { extraAgents?: string[] }).extraAgents,
  };
}

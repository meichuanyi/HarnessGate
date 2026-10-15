import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * harness 二进制一键下载（requiresDownload 条目）：curl 下载 → sha256 校验 → 解压 → chmod。
 * 行为与 scripts/import-registry.mjs 的 downloadBinary 一致（那边是 CLI 同步版，这里是常驻服务的 async 版）。
 * archive/cmd 只来自本地注册表文件里预声明的分发信息——客户端消息只能传 harnessId，没有「传任意 URL/命令」的面。
 */

export type DownloadDist = { archive: string; cmd: string; sha256?: string };

const AGENTS_DIR = join(homedir(), ".harnessgate", "agents");

function sh(bin: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout || ""}${stderr ? `\n${stderr}` : ""}`.trim() });
    });
  });
}

/** 环境代理优先；否则探测本机常见代理端口（只认真能上网的，端口开着但连不通的不算） */
async function detectProxy(): Promise<string | null> {
  const env = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.ALL_PROXY ?? process.env.all_proxy;
  if (env) return env;
  for (const port of [7890, 7891, 7892, 7893, 1080, 8080]) {
    const url = `http://127.0.0.1:${port}`;
    const r = await sh("curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "-m", "8", "-x", url, "https://www.google.com/generate_204"], 15_000);
    if (r.ok && (r.out === "204" || r.out === "200")) return url;
  }
  return null;
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** 下载并解压某 harness 的本机二进制，返回可执行文件绝对路径；目标已存在则直接返回 */
export async function downloadHarnessBinary(id: string, dist: DownloadDist): Promise<string> {
  const dir = join(AGENTS_DIR, id);
  const cmdName = basename(dist.cmd);
  const target = join(dir, cmdName);
  if (existsSync(target)) return target;
  mkdirSync(dir, { recursive: true });
  const archive = join(dir, basename(new URL(dist.archive).pathname));
  if (!existsSync(archive)) {
    // 用 curl 而不是 fetch：Node 的 fetch 不读代理配置，且这台机器直连 github.com 常失败
    const proxy = await detectProxy();
    const args = ["-sSL", "--fail", "--retry", "2", "--connect-timeout", "20", "-o", archive];
    if (proxy) args.push("-x", proxy);
    args.push(dist.archive);
    const r = await sh("curl", args, 600_000);
    if (!r.ok) {
      rmSync(archive, { force: true });
      throw new Error(`下载失败：${(r.out || "未知错误").split("\n")[0]?.slice(0, 160) || "未知错误"}`);
    }
  }
  if (dist.sha256) {
    const got = sha256(archive);
    if (got !== dist.sha256) {
      rmSync(archive, { force: true });
      throw new Error(`sha256 不匹配（期望 ${dist.sha256.slice(0, 12)}… 实际 ${got.slice(0, 12)}…），已删除下载文件`);
    }
  }
  // 按压缩格式选解压方式（.zip 用 unzip、缺了退 python3；其余 tar 通吃 .tar.gz/.tar.bz2/.tar.xz）
  if (archive.endsWith(".zip")) {
    let r = await sh("unzip", ["-o", "-q", archive, "-d", dir], 300_000);
    if (!r.ok) {
      r = await sh("python3", ["-c", "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", archive, dir], 300_000);
    }
    if (!r.ok) throw new Error(`解压失败：${r.out.slice(0, 160)}`);
  } else {
    const r = await sh("tar", ["xf", archive, "-C", dir], 300_000);
    if (!r.ok) throw new Error(`解压失败：${r.out.slice(0, 160)}`);
  }
  if (!existsSync(target)) {
    // 有些包解出来嵌套一层或改名，找一下可执行文件
    const found = await sh("find", [dir, "-maxdepth", "2", "-type", "f", "-name", cmdName], 30_000);
    const hit = found.ok ? found.out.trim().split("\n")[0] : "";
    if (!hit) throw new Error(`解压后找不到 ${cmdName}`);
    chmodSync(hit, 0o755);
    return hit;
  }
  chmodSync(target, 0o755);
  return target;
}

/** ---------- registry 型 harness（manage.registry）：版本源 = ACP 官方注册表 ---------- */

export type RegistryAgentMeta = { version: string; dist?: DownloadDist };

/** 平台键，对齐注册表 agent.json 里 distribution.binary 的键名（linux-x86_64 / darwin-aarch64 / windows-…） */
function platKey(): string {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch;
  return `${os}-${arch}`;
}

/** 拉取 ACP 官方注册表里某 harness 的 agent.json：version=上游最新版，distribution.binary[本平台]=分发信息。
 *  dl.google.com 这类静态分发服务器没有 latest/manifest 接口，且 URL 命名规则跨版本会变（枚举必漏报），
 *  注册表条目是唯一权威的「最新版本」源。 */
export async function fetchRegistryAgent(registryId: string): Promise<RegistryAgentMeta> {
  const url = `https://raw.githubusercontent.com/agentclientprotocol/registry/main/${registryId}/agent.json`;
  const args = ["-sSL", "--fail", "--connect-timeout", "20"];
  const proxy = await detectProxy();
  if (proxy) args.push("-x", proxy);
  args.push(url);
  const r = await sh("curl", args, 30_000);
  if (!r.ok || !r.out) throw new Error(`拉取注册表失败（${registryId}）：${(r.out || "网络错误").split("\n")[0]?.slice(0, 120) || "网络错误"}`);
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(r.out) as Record<string, unknown>;
  } catch {
    throw new Error(`注册表 agent.json 不是合法 JSON（${registryId}）`);
  }
  const version = typeof j.version === "string" ? j.version : "";
  if (!version) throw new Error(`注册表条目 ${registryId} 缺 version 字段`);
  const binary = (j.distribution as { binary?: Record<string, DownloadDist> } | undefined)?.binary;
  return { version, dist: binary?.[platKey()] };
}

/** zip 完整性校验：返回第一个 CRC 损坏的文件名，完好返回 null。
 *  自动下载出过截断包（表现为 BadZipFile），下载后不校验就解压会埋雷。 */
async function zipFirstBad(file: string): Promise<string | null> {
  const r = await sh("python3", ["-c", "import zipfile,sys; print(zipfile.ZipFile(sys.argv[1]).testzip() or '')", file], 600_000);
  const out = r.out.trim();
  if (!r.ok) return out || "无法校验";
  return out === "" ? null : out;
}

/** 读 zipapp/par 包内嵌版本：找 *_version.py 里的 __version__，从值里抠出 x.y(.z…) 版本号
 *  （如 "agy_acp_server_1.1.1" → "1.1.1"）。只在中央目录定位后读一个小文件，大包也很快。 */
export async function bundleVersion(file: string): Promise<string | undefined> {
  if (!existsSync(file)) return undefined;
  const code = [
    "import zipfile,sys",
    "z = zipfile.ZipFile(sys.argv[1])",
    "v = ''",
    "for n in z.namelist():",
    "    if n.endswith('_version.py'):",
    "        for line in z.read(n).decode('utf-8','replace').splitlines():",
    "            s = line.strip()",
    "            if s.startswith('__version__') and '=' in s:",
    "                v = s.split('=',1)[1].strip().strip('\\'\"').split(',')[0].strip()",
    "                break",
    "        if v: break",
    "print(v)",
  ].join("\n");
  const r = await sh("python3", ["-c", code, file], 120_000);
  if (!r.ok) return undefined;
  const v = r.out.trim();
  if (!v) return undefined;
  return v.match(/(\d+(?:\.\d+)+)/)?.[1];
}

/**
 * registry 型 harness 的安装/升级（install/update 同一条路）：下载注册表声明的发行包到暂存区 →
 * zip 完整性校验 → 解压后核验内嵌版本与注册表声明一致 → 旧二进制挪进暂存区后原子替换 → finally 清理。
 * 任何一步失败都直接抛错，旧版保持可用（区别于 downloadHarnessBinary 的「已存在即跳过」——那边没法升级）。
 */
export async function installRegistryHarness(
  registryId: string,
  targetPath: string,
): Promise<{ version: string; target: string }> {
  const meta = await fetchRegistryAgent(registryId);
  const dist = meta.dist;
  if (!dist?.archive || !dist?.cmd) throw new Error(`注册表条目 ${registryId} 没有 ${platKey()} 的分发信息`);
  const dir = dirname(targetPath);
  const cmdName = basename(dist.cmd);
  mkdirSync(dir, { recursive: true });
  const stage = join(dir, `.update-${meta.version}-${Date.now()}`);
  mkdirSync(stage, { recursive: true });
  try {
    const archive = join(stage, basename(new URL(dist.archive).pathname));
    const args = ["-sSL", "--fail", "--retry", "2", "--connect-timeout", "20", "-o", archive];
    const proxy = await detectProxy();
    if (proxy) args.push("-x", proxy);
    args.push(dist.archive);
    const r = await sh("curl", args, 600_000);
    if (!r.ok) throw new Error(`下载失败：${(r.out || "未知错误").split("\n")[0]?.slice(0, 160) || "未知错误"}`);
    if (dist.sha256) {
      const got = sha256(archive);
      if (got !== dist.sha256) throw new Error(`sha256 不匹配（期望 ${dist.sha256.slice(0, 12)}… 实际 ${got.slice(0, 12)}…）`);
    }
    const bad = await zipFirstBad(archive);
    if (bad) throw new Error(`下载的 zip 不完整（${bad}），已放弃，旧版未动`);
    const ex = await sh("unzip", ["-o", "-q", archive, "-d", stage], 600_000);
    if (!ex.ok) throw new Error(`解压失败：${ex.out.slice(0, 160)}`);
    const newTarget = join(stage, cmdName);
    if (!existsSync(newTarget)) throw new Error(`解压后找不到 ${cmdName}`);
    const got = await bundleVersion(newTarget);
    if (!got || got !== meta.version) {
      throw new Error(`解压出的版本是 ${got ?? "未知"}，与注册表声明的 ${meta.version} 不一致，已放弃，旧版未动`);
    }
    for (const name of readdirSync(stage)) {
      if (name === basename(archive)) continue;
      const from = join(stage, name);
      if (!statSync(from).isFile()) continue;
      // 新主程序落位前先把旧主程序挪进暂存区（暂存区 finally 里整体删除）
      if (name === cmdName && existsSync(targetPath)) renameSync(targetPath, join(stage, `old-${name}`));
      renameSync(from, join(dir, name));
    }
    chmodSync(targetPath, 0o755);
    return { version: meta.version, target: targetPath };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

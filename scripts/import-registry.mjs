#!/usr/bin/env node
/**
 * 从 ACP 官方注册表导入全部 harness 到 harness.registry.json
 *
 *   node scripts/import-registry.mjs                # 只生成注册表条目（不下载二进制）
 *   node scripts/import-registry.mjs --download     # 顺带把 linux-x86_64 二进制下载到 ~/.harnessgate/agents/
 *
 * harness.json（手写）始终优先；导入的条目只是补充。
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { connect } from "node:net";

const OUT = join(process.cwd(), "harness.registry.json");
const AGENTS_DIR = join(homedir(), ".harnessgate", "agents");
const DOWNLOAD = process.argv.includes("--download");
const onlyIdx = process.argv.indexOf("--only");
/** --only a,b 时：仍然写全量条目，但只下载这几个二进制 */
const ONLY_DOWNLOAD = onlyIdx >= 0 ? new Set(String(process.argv[onlyIdx + 1] ?? "").split(",").filter(Boolean)) : null;
const PLAT = "linux-x86_64";

async function fetchRegistry(root) {
  const url = "https://codeload.github.com/agentclientprotocol/registry/tar.gz/refs/heads/main";
  console.log(`下载注册表: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tgz = join(tmpdir(), "acp-registry.tar.gz");
  writeFileSync(tgz, buf);
  mkdirSync(root, { recursive: true });
  execFileSync("tar", ["xzf", tgz, "-C", root, "--strip-components=1"]);
  console.log(`已解压到 ${root} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

/** 直连 GitHub 发布页在部分网络下不通；若没显式配代理，自动找本机常见代理端口 */
function detectProxy() {
  const env = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.ALL_PROXY ?? process.env.all_proxy;
  if (env) return env;
  // 只认"真的能上网"的代理：端口开着但连不通的不算
  for (const port of [7890, 7891, 7892, 7893, 1080, 8080]) {
    const url = `http://127.0.0.1:${port}`;
    try {
      const code = execFileSync("curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "-m", "8", "-x", url,
        "https://www.google.com/generate_204"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      if (code === "204" || code === "200") {
        console.log(`    探测到可用代理 ${url}`);
        return url;
      }
    } catch {
      /* 这个端口不行，试下一个 */
    }
  }
  return null;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function downloadBinary(id, dist) {
  const dir = join(AGENTS_DIR, id);
  const cmdName = basename(dist.cmd);
  const target = join(dir, cmdName);
  if (existsSync(target)) return target;
  mkdirSync(dir, { recursive: true });
  const archive = join(dir, basename(new URL(dist.archive).pathname));
  if (!existsSync(archive)) {
    console.log(`  ↓ ${id}: ${dist.archive}`);
    // 用 curl 而不是 fetch：Node 的 fetch 不读代理配置，且在这台机器上直连 github.com 会失败
    try {
      const proxy = detectProxy();
      const curlArgs = ["-sSL", "--fail", "--retry", "2", "--connect-timeout", "20", "-o", archive];
      if (proxy) curlArgs.push("-x", proxy);
      curlArgs.push(dist.archive);
      if (proxy) console.log(`    走代理 ${proxy}`);
      execFileSync("curl", curlArgs, { stdio: ["ignore", "ignore", "pipe"], timeout: 600_000 });
    } catch (err) {
      throw new Error(`curl 下载失败: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
    }
  }
  if (dist.sha256) {
    const got = sha256(archive);
    if (got !== dist.sha256) {
      rmSync(archive, { force: true });
      throw new Error(`sha256 不匹配（期望 ${dist.sha256.slice(0, 12)}… 实际 ${got.slice(0, 12)}…），已删除下载文件`);
    }
  }
  // 按压缩格式选解压方式（goose=.tar.bz2、kimi=.tar.gz、antigravity=.zip）
  if (archive.endsWith(".zip")) {
    try {
      execFileSync("unzip", ["-o", "-q", archive, "-d", dir], { timeout: 300_000 });
    } catch {
      execFileSync("python3", ["-c", `import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])`, archive, dir], { timeout: 300_000 });
    }
  } else {
    execFileSync("tar", ["xf", archive, "-C", dir], { timeout: 300_000 });
  }
  console.log(`    已解压 (${(statSync(archive).size / 1e6).toFixed(1)} MB)`);
  if (!existsSync(target)) {
    // 有些包解出来是别的名字，找一下可执行文件
    const found = execFileSync("find", [dir, "-maxdepth", "2", "-type", "f", "-name", cmdName]).toString().trim();
    if (!found) throw new Error(`解压后找不到 ${cmdName}`);
  }
  chmodSync(target, 0o755);
  return target;
}

function writeOut(harnesses) {
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        "//": "由 scripts/import-registry.mjs 生成，请勿手改；手写条目请放 harness.json（优先）",
        generatedAt: new Date().toISOString(),
        source: "agentclientprotocol/registry",
        count: harnesses.length,
        harnesses,
      },
      null,
      1,
    ),
  );
}

const root = join(tmpdir(), "acp-registry-src");
rmSync(root, { recursive: true, force: true });
await fetchRegistry(root);

const { readdirSync, statSync } = await import("node:fs");
const harnesses = [];
const seen = [];
let npxCount = 0, binCount = 0, uvxCount = 0, dl = 0, skipped = 0;

for (const id of readdirSync(root).sort()) {
  const file = join(root, id, "agent.json");
  if (!existsSync(file) || !statSync(file).isFile()) continue;
  let a;
  try {
    a = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    console.log(`  ! ${id}: agent.json 解析失败，跳过`);
    skipped++;
    continue;
  }
  const dist = a.distribution ?? {};
  const entry = {
    id,
    label: a.name ?? id,
    source: "acp-registry",
    version: a.version,
    description: (a.description ?? "").slice(0, 200),
    repository: a.repository,
    experimental: true,
  };

  if (dist.npx) {
    entry.cmd = "npx";
    entry.args = ["-y", dist.npx.package, ...(dist.npx.args ?? [])];
    entry.note = `npx ${dist.npx.package}（首次运行会下载）`;
    npxCount++;
  } else if (dist.uvx) {
    entry.cmd = "uvx";
    entry.args = [dist.uvx.package ?? dist.uvx, ...(dist.uvx.args ?? [])];
    entry.note = `uvx ${dist.uvx.package ?? ""}`;
    uvxCount++;
  } else if (dist.binary?.[PLAT]) {
    const d = dist.binary[PLAT];
    const cmdName = basename(d.cmd);
    if (DOWNLOAD && (!ONLY_DOWNLOAD || ONLY_DOWNLOAD.has(id))) {
      try {
        const path = await downloadBinary(id, d);
        entry.cmd = path;
        entry.args = d.args ?? [];
        entry.note = `已下载二进制 ${path}`;
        dl++;
      } catch (err) {
        entry.cmd = cmdName;
        entry.args = d.args ?? [];
        entry.requiresDownload = true;
        entry.download = { archive: d.archive, cmd: d.cmd };
        entry.note = `下载失败（${err instanceof Error ? err.message : err}），可用 --download 重试`;
        skipped++;
      }
    } else {
      entry.cmd = cmdName;
      entry.args = d.args ?? [];
      entry.requiresDownload = true;
      entry.download = { archive: d.archive, cmd: d.cmd };
      entry.note = `需要下载 linux-x86_64 二进制（npm run import-registry -- --download）`;
    }
    binCount++;
  } else {
    console.log(`  ! ${id}: 没有 linux/npx 分发方式，跳过`);
    skipped++;
    continue;
  }
  harnesses.push(entry);
  seen.push(entry);
  if (DOWNLOAD) writeOut(seen); // 边下边写：中途被打断也能留下可用结果
}

writeOut(harnesses);

console.log(`\n写入 ${OUT}`);
console.log(`  npx: ${npxCount}  binary: ${binCount}  uvx: ${uvxCount}  已下载: ${dl}  跳过: ${skipped}`);
console.log(`  共 ${harnesses.length} 个 harness`);
if (!DOWNLOAD && binCount) console.log(`\n提示: 加 --download 可把 ${binCount} 个二进制 agent 下到 ${AGENTS_DIR}`);

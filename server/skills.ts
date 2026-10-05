import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  lstatSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";

/**
 * 技能管理：主库（~/.harnessgate/skills）+ 软链挂载到各 harness 的 skills 目录。
 *
 * token 成本模型：skill 是惰性加载的，常驻系统提示词的只有 name+description；
 * 「装在库里」不花钱，「挂载中」才花钱——管理的就是挂载。
 * 挂载 = 在 harness 目录建软链指向库；卸载 = 删链（库文件不动）。
 * harness 目录里原有的真实目录视为「原生」skill，只读展示，不碰。
 */

/** 每个可管理 harness 的 skills 目录（新增 harness 在这里登记） */
const HARNESS_SKILL_DIRS: Record<string, string> = {
  zcode: join(homedir(), ".zcode", "skills"),
  claude: join(homedir(), ".claude", "skills"),
};

export type SkillMeta = {
  name: string;
  description: string;
  /** 常驻 token 估算（name+description 字符数/3，中英混排的经验值，排序比较够用） */
  tokens: number;
  /** 挂载中的 harness id */
  mountedOn: string[];
};

export type MountedSkill = { name: string; /** true = harness 目录里的真实目录（非库挂载），只读 */ native: boolean; tokens: number };
export type HarnessMounts = { harnessId: string; skills: MountedSkill[]; totalTokens: number };

export type SkillsSnapshot = {
  library: SkillMeta[];
  mounts: HarnessMounts[];
};

export type SkillUpsertInput = { name: string; description: string; body: string; renameFrom?: string };
export type SkillResult = { error: string } | { ok: true };

const NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;

export class SkillsStore {
  private readonly libraryDir: string;

  constructor(dataDir: string) {
    this.libraryDir = join(dataDir, "skills");
    mkdirSync(this.libraryDir, { recursive: true });
  }

  /** 可管理的 harness（显式登记的 + 目录恰好存在的自动发现，如 ~/.codex/skills） */
  manageableHarnesses(known: Array<{ id: string }>): Array<{ id: string; dir: string }> {
    const out = new Map<string, string>();
    for (const [id, dir] of Object.entries(HARNESS_SKILL_DIRS)) out.set(id, dir);
    for (const h of known) {
      if (out.has(h.id)) continue;
      const dir = join(homedir(), `.${h.id}`, "skills");
      if (existsSync(dir)) out.set(h.id, dir);
    }
    return [...out.entries()].map(([id, dir]) => ({ id, dir }));
  }

  snapshot(known: Array<{ id: string }>): SkillsSnapshot {
    const targets = this.manageableHarnesses(known);
    const mountedOn = new Map<string, string[]>();   // skillName -> harness ids
    const mounts: HarnessMounts[] = [];
    for (const { id, dir } of targets) {
      const skills: MountedSkill[] = [];
      if (existsSync(dir)) {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.name.startsWith(".")) continue;
          const full = join(dir, e.name);
          const st = lstatSync(full);
          if (!st.isDirectory() && !st.isSymbolicLink()) continue;
          if (!existsSync(join(full, "SKILL.md"))) continue;
          if (st.isSymbolicLink() && this.isLibraryLink(full)) {
            const ids = mountedOn.get(e.name) ?? [];
            ids.push(id);
            mountedOn.set(e.name, ids);
            const meta = this.readMeta(full);
            skills.push({ name: e.name, native: false, tokens: meta.tokens });
          } else {
            // 真实目录，或指向库之外的软链（如 zcode 的 ~/.agents/skills 共享链接）：只读原生
            const meta = this.readMeta(full);
            skills.push({ name: e.name, native: true, tokens: meta.tokens });
          }
        }
      }
      skills.sort((a, b) => a.name.localeCompare(b.name));
      mounts.push({ harnessId: id, skills, totalTokens: skills.reduce((n, s) => n + s.tokens, 0) });
    }

    const library: SkillMeta[] = [];
    for (const e of readdirSync(this.libraryDir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const meta = this.readMeta(join(this.libraryDir, e.name));
      library.push({ ...meta, mountedOn: mountedOn.get(e.name) ?? [] });
    }
    library.sort((a, b) => a.name.localeCompare(b.name));
    return { library, mounts };
  }

  /** 读单个 skill 全文（库里的；也可读原生目录的，用于查看） */
  read(name: string, opts?: { nativeHarness?: string }): string | { error: string } {
    const dir = opts?.nativeHarness
      ? HARNESS_SKILL_DIRS[opts.nativeHarness] ?? join(homedir(), `.${opts.nativeHarness}`, "skills")
      : this.libraryDir;
    const file = join(dir, name, "SKILL.md");
    if (!NAME_RE.test(name) || !existsSync(file)) return { error: `skill 不存在: ${name}` };
    return readFileSync(file, "utf8");
  }

  save(input: SkillUpsertInput): SkillResult {
    const name = String(input.name ?? "").trim();
    if (!NAME_RE.test(name)) return { error: "名称只能包含字母/数字/._-" };
    const description = String(input.description ?? "").trim().replace(/\r/g, "");
    const body = String(input.body ?? "").replace(/\r/g, "");
    if (!description) return { error: "description 不能为空（它是常驻系统提示词，也是模型决定用不用它的唯一依据）" };
    const from = input.renameFrom?.trim();
    const targetDir = join(this.libraryDir, name);

    if (from && from !== name) {
      if (!NAME_RE.test(from)) return { error: "原名称不合法" };
      const fromDir = join(this.libraryDir, from);
      if (!existsSync(fromDir)) return { error: `原 skill 不存在: ${from}` };
      if (existsSync(targetDir)) return { error: `已有同名 skill: ${name}` };
      // 软链指向旧路径，改名后全部摘掉，move 完按原挂载清单重挂
      const remount = this.mountedHarnessIdsOf(from);
      for (const h of remount) this.setMount(from, h, false);
      renameSync(fromDir, targetDir);
      for (const h of remount) this.setMount(name, h, true);
    } else {
      mkdirSync(targetDir, { recursive: true });
    }
    const fm = ["---", `name: ${name}`, `description: ${yamlFold(description)}`, "---"].join("\n");
    const file = join(targetDir, "SKILL.md");
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${fm}\n\n${body.trim()}\n`);
    renameSync(tmp, file);
    return { ok: true };
  }

  remove(name: string): SkillResult {
    if (!NAME_RE.test(name)) return { error: "名称不合法" };
    const dir = join(this.libraryDir, name);
    if (!existsSync(dir)) return { error: `skill 不存在: ${name}` };
    for (const h of this.mountedHarnessIdsOf(name)) this.setMount(name, h, false);
    const trash = join(this.libraryDir, "..", "skills.trash");
    mkdirSync(trash, { recursive: true });
    renameSync(dir, join(trash, `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}`));
    return { ok: true };
  }

  setMount(name: string, harnessId: string, on: boolean): SkillResult {
    const dir = HARNESS_SKILL_DIRS[harnessId] ?? join(homedir(), `.${harnessId}`, "skills");
    const target = join(this.libraryDir, name);
    if (!NAME_RE.test(name) || !existsSync(target)) return { error: `库里没有这个 skill: ${name}` };
    mkdirSync(dir, { recursive: true });
    const link = join(dir, name);
    if (on) {
      if (existsSync(link)) {
        return { error: `${harnessId} 已有同名 ${existsSync(join(link, "SKILL.md")) && lstatSync(link).isSymbolicLink() ? "挂载" : "原生 skill（目录已存在，需先处理）"}` };
      }
      symlinkSync(target, link);
    } else {
      // 只摘「指向主库的链」；harness 自己的软链（如 ~/.agents 共享）绝不能动
      if (!existsSync(link) || !lstatSync(link).isSymbolicLink() || !this.isLibraryLink(link)) {
        return { error: `${harnessId} 没有挂载它（或是 harness 自带的链接，不归主库管）` };
      }
      rmSync(link);
    }
    return { ok: true };
  }

  /** 该路径是否为指向主库内部 的软链 */
  private isLibraryLink(full: string): boolean {
    try {
      const rel = relative(this.libraryDir, realpathSync(full));
      return rel !== "" && !rel.startsWith("..") && !rel.startsWith(`..${sep}`);
    } catch {
      return false;
    }
  }

  private mountedHarnessIdsOf(name: string): string[] {
    const out: string[] = [];
    for (const [id, dir] of Object.entries(HARNESS_SKILL_DIRS)) {
      const link = join(dir, name);
      if (existsSync(link) && lstatSync(link).isSymbolicLink() && this.isLibraryLink(link)) out.push(id);
    }
    return out;
  }

  /** 解析 SKILL.md frontmatter（name/description），失败给空元数据——不完整文件也列出 */
  private readMeta(dir: string): { name: string; description: string; tokens: number } {
    let text = "";
    try {
      text = readFileSync(join(dir, "SKILL.md"), "utf8");
    } catch {
      return { name: basename(dir), description: "", tokens: 0 };
    }
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
    const name = fm.match(/^name:[ \t]*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? basename(dir);
    let desc = "";
    const inline = fm.match(/^description:[ \t]*(.*)$/m)?.[1]?.trim() ?? "";
    if (inline && inline !== ">-" && inline !== ">") {
      desc = inline.replace(/^["']|["']$/g, "");
    } else {
      // 折叠块（description: >- 后跟缩进行）：收集到下一个顶格 key 为止
      const lines = fm.split("\n");
      const i = lines.findIndex((l) => /^description:/.test(l));
      if (i >= 0) {
        const buf: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          const line = lines[j];
          if (line === undefined || !/^[ \t]+\S/.test(line)) break;
          buf.push(line.trim());
        }
        desc = buf.join(" ");
      }
    }
    return { name, description: desc, tokens: Math.ceil(`${name} ${desc}`.length / 3) };
  }
}

/** description 含换行/冒号开头等 YAML 雷区时用折叠块写，否则单行 */
function yamlFold(description: string): string {
  if (!/[:#\n]/.test(description)) return description;
  const lines = description.split("\n").map((l) => `  ${l}`);
  return `>-\n${lines.join("\n")}`;
}

export const skillTrashHint = `删除的 skill 进 ~/.harnessgate/skills.trash（按时间戳归档，误删可手工找回）`;

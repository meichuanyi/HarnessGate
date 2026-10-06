import { deriveTitle } from "./session.ts";
import { UtilitySessions } from "./utility-session.ts";
import type { SessionStore, PersistedSession } from "./store.ts";
import type { AppSettings } from "./settings.ts";

/** 会话自动打标：
 *  ① 项目标签——创建时从 cwd 提取（目录最后一段）；
 *  ② 语义标签——首轮对话结束后，经 UtilitySessions（一次性工具会话统一接口）问 harness
 *     拿 1-3 个标签。临时会话不进列表、不广播、用完即删；用户手动编辑过标签的会话永不自动碰。 */

/** cwd → 项目标签（目录最后一段，去 .git 等噪音；home 根目录返回 null） */
export function projectTagOf(cwd: string): string | null {
  const seg = cwd.split("/").filter(Boolean).pop() ?? "";
  const t = seg.trim();
  if (!t || t === "." || t.startsWith(".")) return null;
  return t.slice(0, 24);
}

/** 从打标器回复里抽 JSON 字符串数组（容忍 ```json 围栏与前后废话） */
export function parseTaggerReply(text: string): string[] {
  const m = text.match(/\[[^\]]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim().replace(/^#/, ""))
      .filter(Boolean)
      .map((x) => x.slice(0, 12))
      .slice(0, 3);
  } catch {
    return [];
  }
}

export class AutoTagger {
  private queue: string[] = [];
  private running = false;

  constructor(
    private readonly store: SessionStore,
    private readonly utility: UtilitySessions,
    private readonly settings: () => AppSettings,
    /** 打标成功后的回调（index.ts 里广播 session 更新） */
    private readonly onTags: (sessionId: string, tags: string[]) => void,
  ) {}

  /** 创建会话时打项目标签（同步、确定性、不依赖任何开关以外的资源） */
  applyProjectTags(rec: PersistedSession): void {
    const s = this.settings();
    if (!s.autoProjectTags || rec.utility) return;
    const tag = projectTagOf(rec.cwd);
    if (!tag) return;
    const tags = new Set(rec.tags ?? []);
    tags.add(tag);
    rec.tags = [...tags].slice(0, 20);
  }

  /** 首轮结束：符合条件则入队语义打标 */
  maybeEnqueue(sessionId: string): void {
    const s = this.settings();
    if (!s.autoSemanticTags) return;
    const rec = this.store.get(sessionId);
    if (!rec || rec.utility || rec.tagsManual || rec.roomId) return; // 工具/手动编辑过/圆桌成员不打
    const firstUser = rec.transcript.find((e) => e.kind === "user");
    if (!firstUser) return;
    const text = firstUser.text ?? "";
    if (text.trim().length < 20) return; // 太短语义不足
    if (rec.semanticTagged) return;
    this.queue.push(sessionId);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const sid = this.queue.shift()!;
        try {
          await this.tagOne(sid);
        } catch (err) {
          console.log(`[auto-tagger] ${sid} 打标失败: ${err instanceof Error ? err.message : err}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async tagOne(sid: string): Promise<void> {
    const rec = this.store.get(sid);
    if (!rec || rec.tagsManual) return;
    const title = rec.title ?? deriveTitle(rec.transcript);
    const firstUser = rec.transcript.find((e) => e.kind === "user");
    const body = firstUser?.text.slice(0, 500) ?? "";
    const wanted = this.settings().taggerHarnessId;

    const prompt =
      `[HG-UTILITY:auto-tagger]\n` +
      `给下面这段对话打 1-3 个简短中文标签（每条 2-6 个字，主题/项目/任务类型）。\n` +
      `只输出一个 JSON 字符串数组，例如 ["重构","anki"]，不要输出任何其他内容。\n\n` +
      `标题：${title}\n内容：${body}`;
    const r = await this.utility.ask({
      purpose: "auto-tagger",
      prompt,
      harnessId: wanted || undefined,
      model: this.settings().taggerModel || undefined,
      timeoutMs: 90_000,
    });
    if (!r.ok) {
      console.log(`[auto-tagger] 打标失败（${r.error}，${r.elapsedMs}ms）`);
      return;
    }
    const tags = parseTaggerReply(r.text);
    if (!tags.length) return;
    const fresh = this.store.get(sid);
    if (!fresh || fresh.tagsManual) return; // 打标期间用户编辑过则以用户为准
    const merged = new Set([...(fresh.tags ?? []), ...tags]);
    const updated = { ...fresh, tags: [...merged].slice(0, 20), semanticTagged: true };
    this.store.upsert(updated);
    this.onTags(sid, [...merged]);
  }
}


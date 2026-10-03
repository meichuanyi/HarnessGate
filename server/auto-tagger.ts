import { join } from "node:path";

import { AuditLog } from "./audit.ts";
import type { HarnessSpec, SessionInfo } from "./types.ts";
import { HarnessSession, deriveTitle } from "./session.ts";
import { SessionStore, type PersistedSession } from "./store.ts";
import { WorkspaceHub } from "./workspace.ts";
import type { AppSettings } from "./settings.ts";
import type { SessionHooks } from "./session.ts";

/** 会话自动打标：
 *  ① 项目标签——创建时从 cwd 提取（目录最后一段）；
 *  ② 语义标签——首轮对话结束后用一次性「utility 临时会话」问一句 harness 拿 1-3 个标签。
 *  临时会话不进列表、不广播（onStatus 静默）、用完即删；用户手动编辑过标签的会话永不自动碰。 */

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
    private readonly audit: AuditLog,
    private readonly hub: WorkspaceHub,
    private readonly hooks: SessionHooks,
    private readonly specOf: (id: string) => HarnessSpec | undefined,
    private readonly firstAvailableSpec: () => HarnessSpec | undefined,
    /** harness → 模型配置的 configId（探活收集；无模型配置的 harness 返回 undefined） */
    private readonly modelConfigIdOf: (harnessId: string) => string | undefined,
    private readonly settings: () => AppSettings,
    private readonly dataDir: string,
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
    if (!firstUser || "text" in firstUser === false) return;
    const text = (firstUser as { text?: string }).text ?? "";
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
    const firstUser = rec.transcript.find((e) => e.kind === "user") as { text?: string } | undefined;
    const body = (firstUser?.text ?? "").slice(0, 500);
    const wanted = this.settings().taggerHarnessId;
    const spec = (wanted ? this.specOf(wanted) : undefined) ?? this.firstAvailableSpec();
    if (!spec) {
      console.log("[auto-tagger] 没有可用 harness，跳过");
      return;
    }

    // 一次性 utility 会话：静默（onStatus 丢弃），用完即删
    const quietHooks: SessionHooks = {
      ...this.hooks,
      onStatus: () => {},
      onUpdate: () => {},
      onTurnEnd: () => {},
      onPermission: () => {},
      onLog: () => {},
      onPersist: () => {},   // 临时会话不落盘（内容无价值），结束直接删
      onStopped: () => {},
    };
    const record = HarnessSession.newRecord(spec, join(this.dataDir, "tagger"));
    record.utility = true;
    // 指定了打标模型：经 chosen → 预置配置，ready 后自动下发（复用现有链路）
    const wantedModel = this.settings().taggerModel;
    const modelConfigId = wantedModel ? this.modelConfigIdOf(spec.id) : undefined;
    if (wantedModel && modelConfigId) record.chosen = { [modelConfigId]: wantedModel };
    const tmp = new HarnessSession(spec, record, this.audit, quietHooks, this.hub);
    try {
      void tmp.start("new");
      // 等上下文就绪（进程启动+initialize+session/new 是异步的，直接 prompt 会被丢弃）
      let ready = false;
      for (let i = 0; i < 60; i++) {
        const st = tmp.info().status;
        if (st === "ready" || st === "awaiting") { ready = true; break; }
        if (st === "error") break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!ready) {
        console.log(`[auto-tagger] 打标器会话未就绪（${tmp.info().status}），放弃`);
        return;
      }
      const prompt =
        `给下面这段对话打 1-3 个简短中文标签（每条 2-6 个字，主题/项目/任务类型）。\n` +
        `只输出一个 JSON 字符串数组，例如 ["重构","anki"]，不要输出任何其他内容。\n\n` +
        `标题：${title}\n内容：${body}`;
      const res = await tmp.promptAndWait(prompt, 90_000);
      const tags = parseTaggerReply(res.text);
      if (!tags.length) return;
      const fresh = this.store.get(sid);
      if (!fresh || fresh.tagsManual) return; // 打标期间用户编辑过则以用户为准
      const merged = new Set([...(fresh.tags ?? []), ...tags]);
      const updated = { ...fresh, tags: [...merged].slice(0, 20), semanticTagged: true };
      this.store.upsert(updated);
      this.audit.append({ session: sid, op: "auto-tagger.apply", tags });
      this.onTags(sid, [...merged]);
    } finally {
      await tmp.stop().catch(() => {});
      this.store.remove(record.id);
    }
  }
}

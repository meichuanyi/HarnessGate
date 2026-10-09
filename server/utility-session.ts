import { join } from "node:path";

import type { HarnessSpec } from "./types.ts";
import { HarnessSession } from "./session.ts";
import type { SessionHooks } from "./session.ts";
import type { AuditLog } from "./audit.ts";
import type { SessionStore } from "./store.ts";
import type { WorkspaceHub } from "./workspace.ts";

/** 一次性工具会话（utility session）统一接口。
 *  「起临时 harness 会话 → 等就绪 → 问一句 → 收回答 → 销毁」是多个功能的公共底座：
 *  自动打标、定时任务蒸馏、会话标题/摘要生成……都走 askUtility，不再各自内联这套流程。
 *
 *  特性：
 *  - 会话带 utility 标记：不进会话列表、onStatus 广播静默、不落盘，用完即删；
 *  - 就绪等待：进程启动 + ACP initialize + session/new 异步完成前直接 prompt 会被丢弃（实测踩坑）；
 *  - 全局并发闸：同时最多 maxConcurrent 个工具会话，避免批量任务瞬间起一堆 harness 进程；
 *  - 失败语义：任何环节失败都返回 ok=false，绝不抛出（打标/蒸馏类任务都是锦上添花，静默降级）。 */

export type UtilityAskOptions = {
  /** 用途标记（审计与日志，如 "auto-tagger" / "title" / "distill"） */
  purpose: string;
  /** 发给模型的完整指令 */
  prompt: string;
  /** 指定 harness id；空 = 由 resolveHarness 回调决定（设置里的 taggerHarnessId → 自动选可用） */
  harnessId?: string;
  /** 指定模型（该 harness 模型配置的 value）；空 = harness 默认模型。经 chosen 预置下发 */
  model?: string;
  /** 整体超时（默认 90s，覆盖进程启动 + 模型回答） */
  timeoutMs?: number;
  /** 回答截断长度（默认 4000） */
  maxReplyChars?: number;
};

export type UtilityAskResult =
  | { ok: true; text: string; harnessId: string; elapsedMs: number }
  | { ok: false; error: string; elapsedMs: number };

export type UtilitySessionDeps = {
  store: SessionStore;
  audit: AuditLog;
  hub: WorkspaceHub;
  makeHooks: () => SessionHooks;
  /** harness 解析：显式指定 → 设置偏好 → 自动选探活可用第一个。返回 undefined = 无可用 */
  resolveHarness: (explicit?: string) => HarnessSpec | undefined;
  /** harness → 模型配置 configId（把 model value 经 chosen 下发用；无模型配置返回 undefined） */
  modelConfigIdOf: (harnessId: string) => string | undefined;
  /** harness 默认模型（探活 currentValue）；设置未指定模型时显式钉住它，显示=实际 */
  defaultModelFor?: (harnessId: string) => string | undefined;
  dataDir: string;
  maxConcurrent?: number;
  /** 自定义 API 通道（OpenAI 兼容）：非 null 时 ask() 直接 HTTP 调用，不起 harness 临时会话 */
  apiConfig?: () => { baseUrl: string; apiKey: string; model: string } | null;
};

export class UtilitySessions {
  private inflight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly d: UtilitySessionDeps) {}

  private get maxConcurrent(): number {
    return this.d.maxConcurrent ?? 2;
  }

  /** 并发闸：满了就排队（FIFO） */
  private async acquire(): Promise<void> {
    if (this.inflight < this.maxConcurrent) {
      this.inflight++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.inflight++;
  }

  private release(): void {
    this.inflight--;
    const next = this.waiters.shift();
    if (next) next();
  }

  async ask(opts: UtilityAskOptions): Promise<UtilityAskResult> {
    const t0 = Date.now();
    // 自定义 API 通道（设置里 utilityMode=api）：直接 HTTP，免 harness 进程——
    // 打标/蒸馏这类一次性问答走 API 比临时会话快得多也省得多
    const api = this.d.apiConfig?.();
    if (api) {
      try {
        const res = await fetch(`${api.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${api.apiKey}` },
          body: JSON.stringify({
            model: api.model,
            messages: [{ role: "user", content: opts.prompt }],
            max_tokens: 1000,
          }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return { ok: false, error: `API ${res.status}: ${body.slice(0, 200)}`, elapsedMs: Date.now() - t0 };
        }
        const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const text = (j.choices?.[0]?.message?.content ?? "").slice(0, opts.maxReplyChars ?? 4000);
        if (!text.trim()) return { ok: false, error: "API 空回答", elapsedMs: Date.now() - t0 };
        return { ok: true, text, harnessId: `api:${api.model}`, elapsedMs: Date.now() - t0 };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err), elapsedMs: Date.now() - t0 };
      }
    }
    const timeoutMs = opts.timeoutMs ?? 90_000;
    const maxChars = opts.maxReplyChars ?? 4000;
    await this.acquire();
    let tmp: HarnessSession | null = null;
    let record: import("./store.ts").PersistedSession | null = null;
    try {
      const spec = this.d.resolveHarness(opts.harnessId);
      if (!spec) return { ok: false, error: "没有可用 harness", elapsedMs: Date.now() - t0 };

      record = HarnessSession.newRecord(spec, join(this.d.dataDir, "utility", opts.purpose));
      record.utility = true;
      if (opts.model) {
        const modelConfigId = this.d.modelConfigIdOf(spec.id);
        if (modelConfigId) record.chosen = { [modelConfigId]: opts.model };
      }
      // 工具会话全静默：不进列表/不广播/不落盘（内容无价值，结束即删）
      const quietHooks: SessionHooks = {
        ...this.d.makeHooks(),
        onStatus: () => {},
        onUpdate: () => {},
        onTurnEnd: () => {},
        onPermission: () => {},
        onLog: () => {},
        onPersist: () => {},
        onStopped: () => {},
      };
      const tmpSess = new HarnessSession(spec, record, this.d.audit, quietHooks, this.d.hub);
      tmp = tmpSess;
      void tmp.start("new");

      // 等上下文就绪
      const readyDeadline = Date.now() + Math.min(30_000, timeoutMs);
      let ready = false;
      while (Date.now() < readyDeadline) {
        const st = tmp.info().status;
        if (st === "ready" || st === "awaiting") { ready = true; break; }
        if (st === "error") break;
        await new Promise((r) => setTimeout(r, 400));
      }
      if (!ready || !tmp) {
        return { ok: false, error: `工具会话未就绪（${tmp?.info().status ?? "unknown"}）`, elapsedMs: Date.now() - t0 };
      }

      const deadline = Date.now() + Math.max(5_000, timeoutMs - (Date.now() - t0));
      const res = await tmp.promptAndWait(opts.prompt, deadline - Date.now());
      const text = (res.text || "").slice(0, maxChars);
      if (!text.trim()) return { ok: false, error: "空回答", elapsedMs: Date.now() - t0 };
      return { ok: true, text, harnessId: spec.id, elapsedMs: Date.now() - t0 };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), elapsedMs: Date.now() - t0 };
    } finally {
      try { await tmp?.stop(); } catch {}
      if (record) this.d.store.remove(record.id);
      this.release();
    }
  }
}

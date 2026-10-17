import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NotificationConfig } from "./notify.ts";

/** 用户运行时配置（DATA_DIR/settings.json）：改完即时生效，UI 可编辑。
 *  「后台智能」= 打标/蒸馏/收编摘要等轻量模型任务，可走 harness 或自定义 OpenAI 兼容 API。 */
export type AppSettings = {
  /** 会话创建时自动打项目目录标签（目录最后一段） */
  autoProjectTags: boolean;
  /** 首轮对话后自动语义打标 */
  autoSemanticTags: boolean;
  /** 后台智能走哪条通道：harness（临时会话）| api（自定义 OpenAI 兼容接口直调） */
  utilityMode: "harness" | "api";
  /** harness 模式：用哪个 harness（空 = 自动选探活可用的第一个） */
  utilityHarnessId: string;
  /** harness 模式：用哪个模型（该 harness 模型配置的 value；空 = 默认模型） */
  utilityModel: string;
  /** api 模式：OpenAI 兼容 base（如 http://127.0.0.1:8000/v1） */
  utilityApiBase: string;
  /** api 模式：API Key */
  utilityApiKey: string;
  /** api 模式：模型名（如 gpt-4o-mini / 自己网关里的任意路由名） */
  utilityApiModel: string;
  /** 轻量大模型（可选）：打标等轻任务专用；留空则跟随 utility 通道 */
  lightApiBase: string;
  lightApiKey: string;
  lightApiModel: string;
  /** 外部通知通道配置（目标推演、重要报警推送） */
  notification?: NotificationConfig;
};

const DEFAULTS: AppSettings = {
  autoProjectTags: true,
  autoSemanticTags: true,
  utilityMode: "harness",
  utilityHarnessId: "",
  utilityModel: "",
  utilityApiBase: "",
  utilityApiKey: "",
  utilityApiModel: "",
  lightApiBase: "",
  lightApiKey: "",
  lightApiModel: "",
  notification: {
    enabled: true,
    channelType: "custom_gateway",
    endpoint: "http://192.168.6.108:818/api/push/a6089c81f4754037966345f83ff0cb3e",
  },
};

export class SettingsStore {
  private data: AppSettings = { ...DEFAULTS };
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        const merged = { ...DEFAULTS, ...parsed } as AppSettings;
        // 旧字段迁移：taggerHarnessId/taggerModel → utilityHarnessId/utilityModel（只在新字段为空时搬）
        const legacyH = typeof parsed.taggerHarnessId === "string" ? (parsed.taggerHarnessId as string) : "";
        const legacyM = typeof parsed.taggerModel === "string" ? (parsed.taggerModel as string) : "";
        if (legacyH && !merged.utilityHarnessId) merged.utilityHarnessId = legacyH;
        if (legacyM && !merged.utilityModel) merged.utilityModel = legacyM;
        // 确保 notification 默认值安全填充
        if (parsed.notification && typeof parsed.notification === "object") {
          merged.notification = {
            ...DEFAULTS.notification!,
            ...(parsed.notification as NotificationConfig),
          };
        } else if (!merged.notification) {
          merged.notification = { ...DEFAULTS.notification! };
        }
        this.data = merged;
      } catch (err) {
        console.error(`[settings] 读取失败，用默认值:`, err instanceof Error ? err.message : err);
      }
    }
  }

  get(): AppSettings {
    return { ...this.data };
  }

  update(patch: Partial<AppSettings> & Record<string, unknown>): AppSettings {
    const next = { ...this.data };
    if (typeof patch.autoProjectTags === "boolean") next.autoProjectTags = patch.autoProjectTags;
    if (typeof patch.autoSemanticTags === "boolean") next.autoSemanticTags = patch.autoSemanticTags;
    if (patch.utilityMode === "harness" || patch.utilityMode === "api") next.utilityMode = patch.utilityMode;
    for (const k of ["utilityHarnessId", "utilityModel", "utilityApiBase", "utilityApiKey", "utilityApiModel", "lightApiBase", "lightApiKey", "lightApiModel"] as const) {
      if (typeof patch[k] === "string") next[k] = (patch[k] as string).trim();
    }
    if (patch.notification && typeof patch.notification === "object") {
      const nPatch = patch.notification as Partial<NotificationConfig>;
      next.notification = {
        enabled: typeof nPatch.enabled === "boolean" ? nPatch.enabled : (next.notification?.enabled ?? true),
        channelType: nPatch.channelType || next.notification?.channelType || "custom_gateway",
        endpoint: typeof nPatch.endpoint === "string" ? nPatch.endpoint.trim() : (next.notification?.endpoint || ""),
        secret: typeof nPatch.secret === "string" ? nPatch.secret.trim() : next.notification?.secret,
      };
    }
    this.data = next;
    try {
      writeFileSync(this.file, JSON.stringify(next, null, 2));
    } catch (err) {
      console.error(`[settings] 写入失败:`, err instanceof Error ? err.message : err);
    }
    return { ...next };
  }
}

/** 便捷构造（index.ts 主流程用） */
export function settingsFileOf(dataDir: string): string {
  return join(dataDir, "settings.json");
}

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 用户运行时配置（DATA_DIR/settings.json）：改完即时生效，UI 可编辑 */
export type AppSettings = {
  /** 会话创建时自动打项目目录标签（目录最后一段） */
  autoProjectTags: boolean;
  /** 首轮对话后自动语义打标（临时 harness 会话执行） */
  autoSemanticTags: boolean;
  /** 语义打标用哪个 harness（空 = 自动选探活可用的第一个） */
  taggerHarnessId: string;
  /** 语义打标用哪个模型（该 harness 模型配置的 value；空 = harness 默认模型） */
  taggerModel: string;
};

const DEFAULTS: AppSettings = {
  autoProjectTags: true,
  autoSemanticTags: true,
  taggerHarnessId: "",
  taggerModel: "",
};

export class SettingsStore {
  private data: AppSettings = { ...DEFAULTS };
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<AppSettings>;
        this.data = { ...DEFAULTS, ...parsed };
      } catch (err) {
        console.error(`[settings] 读取失败，用默认值:`, err instanceof Error ? err.message : err);
      }
    }
  }

  get(): AppSettings {
    return { ...this.data };
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.data };
    if (typeof patch.autoProjectTags === "boolean") next.autoProjectTags = patch.autoProjectTags;
    if (typeof patch.autoSemanticTags === "boolean") next.autoSemanticTags = patch.autoSemanticTags;
    if (typeof patch.taggerHarnessId === "string") next.taggerHarnessId = patch.taggerHarnessId.trim();
    if (typeof patch.taggerModel === "string") next.taggerModel = patch.taggerModel.trim();
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

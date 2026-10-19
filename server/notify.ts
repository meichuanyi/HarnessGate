/**
 * 统一通知调度器（Notification Dispatcher）
 * 
 * 支持的渠道类型：
 * 1. custom_gateway: 自建统一聚合推送网关（如 NAS 部署的 Gotify/推送网关通道，格式为 { title, content, type: "text" }）
 * 2. feishu_bot: 飞书官方自定义机器人 Webhook (https://open.feishu.cn/open-apis/bot/v2/hook/...)
 * 3. generic_webhook: 标准通用 Webhook（POST JSON）
 */

export type NotificationChannelType = "custom_gateway" | "feishu_bot" | "generic_webhook";

export type NotificationConfig = {
  enabled: boolean;
  channelType: NotificationChannelType;
  endpoint: string;
  secret?: string;
};

export type NotificationPayload = {
  title: string;
  content: string;
  level?: "info" | "success" | "warn" | "error";
  metadata?: Record<string, unknown>;
};

export type NotificationResult = {
  ok: boolean;
  error?: string;
};

export async function sendNotification(
  cfg: NotificationConfig | undefined,
  payload: NotificationPayload,
): Promise<NotificationResult> {
  if (!cfg || !cfg.enabled) {
    return { ok: false, error: "通知通道未启用" };
  }
  const endpoint = cfg.endpoint?.trim();
  if (!endpoint) {
    return { ok: false, error: "通知 endpoint 为空" };
  }

  let body: unknown;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  switch (cfg.channelType) {
    case "custom_gateway": {
      // 兼容现有的 NAS 自建飞书/多渠道网关 (http://192.168.6.108:818/api/push/...)
      body = {
        title: payload.title,
        content: payload.content,
        type: "text",
        ...(payload.metadata ? { metadata: payload.metadata } : {}),
      };
      break;
    }

    case "feishu_bot": {
      // 飞书官方机器人 Webhook 格式
      body = {
        msg_type: "text",
        content: {
          text: `${payload.title}\n\n${payload.content}`,
        },
      };
      break;
    }

    case "generic_webhook":
    default: {
      body = {
        title: payload.title,
        content: payload.content,
        level: payload.level ?? "info",
        timestamp: new Date().toISOString(),
        ...payload.metadata,
      };
      break;
    }
  }

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

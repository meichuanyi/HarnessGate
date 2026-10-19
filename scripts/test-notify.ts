import { sendNotification, type NotificationConfig } from "../server/notify.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function run() {
  console.log("=== 测试 Notification 调度器功能 ===");

  // 1. 未启用时静默返回
  const disabledCfg: NotificationConfig = {
    enabled: false,
    channelType: "custom_gateway",
    endpoint: "http://127.0.0.1:9999/dummy",
  };
  const r1 = await sendNotification(disabledCfg, { title: "t", content: "c" });
  assert(!r1.ok && r1.error === "通知通道未启用", "未启用应拦截");

  // 2. 空 endpoint 拦截
  const emptyCfg: NotificationConfig = {
    enabled: true,
    channelType: "custom_gateway",
    endpoint: "",
  };
  const r2 = await sendNotification(emptyCfg, { title: "t", content: "c" });
  assert(!r2.ok && r2.error === "通知 endpoint 为空", "空 endpoint 应拦截");

  // 3. 真实局域网推送网关测试
  const realCfg: NotificationConfig = {
    enabled: true,
    channelType: "custom_gateway",
    endpoint: "http://192.168.6.108:818/api/push/a6089c81f4754037966345f83ff0cb3e",
  };
  console.log("向真实局域网推送网关发送验证消息...");
  const r3 = await sendNotification(realCfg, {
    title: "【系统测试】HarnessGate 通用通知解耦测试",
    content: "通知渠道已成功解耦为全局可配置组件，推演与告警消息已接入统一分发层。",
    level: "success",
  });
  assert(r3.ok, `真实推送应成功: ${r3.error}`);
  console.log("✔ 真实网关推送验证成功！");

  console.log("🎉 通知调度器测试全部通过！");
}

run().catch((err) => {
  console.error("❌ 测试失败:", err);
  process.exit(1);
});

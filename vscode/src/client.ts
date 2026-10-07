import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { ClientMsg, ServerMsg } from "./protocol.ts";

export type ClientState = "idle" | "connecting" | "connected" | "error";

/**
 * HarnessGate 服务的 WS 客户端：自动重连 + 消息分发。
 * 所有 UI（树视图、聊天面板）都订阅这里的事件，不直接碰 socket。
 */
export class GateClient extends EventEmitter {
  private ws?: WebSocket;
  private state: ClientState = "idle";
  private retry = 0;
  private timer?: NodeJS.Timeout;
  private closedByUs = false;
  private lastError?: string;
  /** 半开死链检测：20s 一发 ping，45s 无下行数据强制断开重连（与 APP 同款修复） */
  private heartbeat?: NodeJS.Timeout;
  private lastReceived = Date.now();
  /** 断线期间待发消息（重连 hello 后补发；上限 50） */
  private outbox: ClientMsg[] = [];
  /** 服务端 ≥0.6.25 才有心跳（旧版对 ping 回"未知消息类型"错误） */
  private heartbeatSupported = false;
  private serverVersion = "";

  constructor(
    private url: () => string,
    private token: () => string,
    private log: (line: string) => void,
  ) {
    super();
  }

  getState(): ClientState {
    return this.state;
  }

  getLastError(): string | undefined {
    return this.lastError;
  }

  private setState(s: ClientState): void {
    if (this.state === s) return;
    this.state = s;
    this.emit("state", s);
  }

  connect(): void {
    this.closedByUs = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const base = this.url().trim();
    if (!base) {
      this.lastError = "未配置服务地址（harnessgate.url）";
      this.setState("error");
      return;
    }
    const token = this.token().trim();
    const target = token ? `${base}${base.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : base;
    this.setState("connecting");
    this.log(`连接 ${base}${token ? "（带 token）" : ""}`);

    let ws: WebSocket;
    try {
      ws = new WebSocket(target, { handshakeTimeout: 8000 });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.setState("error");
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      this.retry = 0;
      this.lastError = undefined;
      this.setState("connected");
      this.log("已连接");
      this.startHeartbeat();
    });
    ws.on("message", (raw: WebSocket.RawData) => {
      this.lastReceived = Date.now();
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(raw)) as ServerMsg;
      } catch {
        this.log(`收到无法解析的消息: ${String(raw).slice(0, 200)}`);
        return;
      }
      // hello 带服务端版本与助理会话：版本用于心跳门槛，收到即补发断线期间的消息
      if (msg.type === "hello") {
        this.serverVersion = (msg as { version?: string }).version ?? "";
        this.heartbeatSupported = this.serverVersion === "" ? false : this.versionAtLeast("0.6.25");
        if (this.outbox.length) {
          const pending = this.outbox.splice(0, 50);
          for (const m of pending) {
            try {
              this.ws?.send(JSON.stringify(m));
            } catch {
              /* 单条失败忽略 */
            }
          }
          this.log(`重连后补发 ${pending.length} 条排队消息`);
        }
      }
      this.emit("message", msg);
      this.emit(msg.type, msg);
    });
    ws.on("close", (code: number) => {
      this.ws = undefined;
      this.stopHeartbeat();
      if (this.closedByUs) {
        this.setState("idle");
        return;
      }
      this.lastError = code === 4401 ? "服务端要求 token（设置 harnessgate.token）" : `连接断开 (code ${code})`;
      this.log(this.lastError);
      this.setState("error");
      this.scheduleRetry();
    });
    ws.on("error", (err: Error) => {
      this.lastError = err.message;
      this.log(`连接错误: ${err.message}`);
    });
  }

  private scheduleRetry(): void {
    if (this.timer) return;
    const delay = Math.min(1000 * 2 ** this.retry, 15_000);
    this.retry++;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.connect();
    }, delay);
  }

  send(msg: ClientMsg): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // 断线窗口：入队暂存，重连 hello 后补发（不再静默丢——半开/断线发消息
      // 就是「会话不响应」的元凶，APP 端同款修复）
      if (msg.type !== "ping" && this.outbox.length < 50) this.outbox.push(msg);
      return false;
    }
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private versionAtLeast(v: string): boolean {
    const a = this.serverVersion.split(".").map(Number);
    const b = v.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    }
    return true;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastReceived = Date.now();
    this.heartbeat = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastReceived > 45_000) {
        this.log("45s 无下行数据，判定死链，强制重连");
        this.ws.terminate(); // 触发 close → 指数退避重连
        return;
      }
      if (this.heartbeatSupported) this.send({ type: "ping" });
    }, 20_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  dispose(): void {
    this.closedByUs = true;
    this.stopHeartbeat();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.ws?.close();
    this.ws = undefined;
  }
}

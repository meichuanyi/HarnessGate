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
    });
    ws.on("message", (raw: WebSocket.RawData) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(raw)) as ServerMsg;
      } catch {
        this.log(`收到无法解析的消息: ${String(raw).slice(0, 200)}`);
        return;
      }
      this.emit("message", msg);
      this.emit(msg.type, msg);
    });
    ws.on("close", (code: number) => {
      this.ws = undefined;
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  dispose(): void {
    this.closedByUs = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.ws?.close();
    this.ws = undefined;
  }
}

import type { HarnessAvailability, SessionInfo } from "./protocol.ts";

/**
 * 全局状态：服务端推来的 harness 列表与会话列表。
 * 树视图、聊天面板、命令都从这里读，避免各自维护副本。
 */
export class Store {
  harnesses: HarnessAvailability[] = [];
  sessions = new Map<string, SessionInfo>();
  defaultCwd = "";
  private listeners = new Set<() => void>();

  onChange(fn: () => void): { dispose(): void } {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  private fire(): void {
    for (const fn of this.listeners) fn();
  }

  setHello(harnesses: HarnessAvailability[], sessions: SessionInfo[], defaultCwd: string): void {
    this.harnesses = harnesses;
    this.sessions = new Map(sessions.map((s) => [s.id, s]));
    if (defaultCwd) this.defaultCwd = defaultCwd;
    this.fire();
  }

  upsertSession(s: SessionInfo): void {
    this.sessions.set(s.id, s);
    this.fire();
  }

  removeSession(id: string): void {
    this.sessions.delete(id);
    this.fire();
  }

  getSession(id: string): SessionInfo | undefined {
    return this.sessions.get(id);
  }

  sessionsOf(harnessId: string): SessionInfo[] {
    return [...this.sessions.values()]
      .filter((s) => s.harnessId === harnessId)
      .sort((a, b) => (b.lastActiveAt || "").localeCompare(a.lastActiveAt || ""));
  }

  getHarness(id: string): HarnessAvailability | undefined {
    return this.harnesses.find((h) => h.id === id);
  }
}

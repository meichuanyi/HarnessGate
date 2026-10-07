import type { HarnessAvailability, Room, Schedule, SessionInfo, WorkspaceReport } from "./protocol.ts";

/**
 * 全局状态：服务端推来的 harness 列表、会话列表与圆桌列表。
 * 树视图、聊天面板、圆桌面板都从这里读，避免各自维护副本。
 */
export class Store {
  harnesses: HarnessAvailability[] = [];
  sessions = new Map<string, SessionInfo>();
  rooms = new Map<string, Room>();
  defaultCwd = "";
  /** 定时任务（schedules 消息维护） */
  schedules: Schedule[] = [];
  /** 最近一次工作区报告（workspace 请求/响应） */
  workspaceReports: WorkspaceReport[] | null = null;
  /** 常驻助理会话 id（hello 下发；null = 尚未创建） */
  assistantSessionId: string | null = null;
  /** 会话过滤词（标题/目录/标签） */
  filterText = "";
  private listeners = new Set<() => void>();

  onChange(fn: () => void): { dispose(): void } {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  private fire(): void {
    for (const fn of this.listeners) fn();
  }

  setHello(
    harnesses: HarnessAvailability[],
    sessions: SessionInfo[],
    defaultCwd: string,
    rooms?: Room[],
    schedules?: Schedule[],
    assistantSessionId?: string | null,
  ): void {
    this.harnesses = harnesses;
    this.sessions = new Map(sessions.map((s) => [s.id, s]));
    if (rooms) this.rooms = new Map(rooms.map((r) => [r.id, r]));
    if (schedules) this.schedules = schedules;
    this.assistantSessionId = assistantSessionId ?? null;
    if (defaultCwd) this.defaultCwd = defaultCwd;
    this.fire();
  }

  setSchedules(schedules: Schedule[]): void {
    this.schedules = schedules;
    this.fire();
  }

  setWorkspaceReports(reports: WorkspaceReport[]): void {
    this.workspaceReports = reports;
    this.fire();
  }

  setRooms(rooms: Room[]): void {
    this.rooms = new Map(rooms.map((r) => [r.id, r]));
    this.fire();
  }

  upsertRoom(room: Room): void {
    this.rooms.set(room.id, room);
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

  getRoom(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  /** 最新活跃在前 */
  roomsList(): Room[] {
    return [...this.rooms.values()].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  }

  sessionsOf(harnessId: string): SessionInfo[] {
    const q = this.filterText.trim().toLowerCase();
    return [...this.sessions.values()]
      .filter((s) => s.harnessId === harnessId)
      .filter(
        (s) =>
          !q ||
          (s.title ?? "").toLowerCase().includes(q) ||
          s.cwd.toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q) ||
          (s.tags ?? []).some((t) => t.toLowerCase().includes(q)),
      )
      .sort((a, b) => {
        // 助理 > 收藏 > 最近活跃
        const rank = (x: SessionInfo) => (x.assistant ? 2 : x.starred ? 1 : 0);
        if (rank(a) !== rank(b)) return rank(b) - rank(a);
        return (b.lastActiveAt || "").localeCompare(a.lastActiveAt || "");
      });
  }

  /** 全库标签计数（过滤建议用） */
  tagCounts(): Map<string, number> {
    const m = new Map<string, number>();
    for (const s of this.sessions.values()) {
      for (const t of s.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1);
    }
    return m;
  }

  getHarness(id: string): HarnessAvailability | undefined {
    return this.harnesses.find((h) => h.id === id);
  }
}

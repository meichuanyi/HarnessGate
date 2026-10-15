import { makeEvent, type Sensor, type SensoryEvent } from "./types.ts";

/**
 * 会话感官（SessionSensor）：HarnessGate 原生的「工兵完工」监听。
 *
 * 工兵会话（圆桌成员/推测沙箱/定时任务）每结束一个回合都是一条过程事件：
 * 正常收尾是 normal——活儿干完了，张力该给认知层报个到；出错是 loud——
 * 工兵摔了工具，值得立刻被注意。事件主语是会话 id，聚类后前端能看到
 * 「一轮工作队收工」这种聚合图景，而不是 N 条散乱的 turn_end。
 *
 * [hg-diff] 上游无此感官：这是 HarnessGate 宿主的进程内事件源（非 vendored）。
 */
export class SessionSensor implements Sensor {
  readonly name = "session";
  onEvent?: (evt: SensoryEvent) => void;
  private count = 0;

  /** 由宿主 makeHooks.onTurnEnd 调用；stopReason 语义见 server/session.ts */
  emitTurnEnd(info: { sessionId: string; harnessLabel?: string; stopReason: string }): void {
    const salience = info.stopReason === "error" ? "loud" : "normal";
    this.onEvent?.(
      makeEvent({
        modality: "process",
        kind: `session.turn-${info.stopReason}`,
        subject: info.sessionId,
        summary: `工兵会话 ${info.sessionId}${info.harnessLabel ? `（${info.harnessLabel}）` : ""} 回合结束（${info.stopReason}）`,
        salience,
        payload: { ...info },
      }),
    );
    this.count++;
  }

  start(): void {
    /* 进程内事件源：无需启停 */
  }

  stop(): void {
    /* 进程内事件源：无需启停 */
  }
}

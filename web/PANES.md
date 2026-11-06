# 分屏格体系(Panes)规格 —— 考古重建版

> 2026-11-06 由 a5a5782(步1)+121eea2(步2)提交信息与代码内「步 N」注释重建。
> 原规格定稿于当时会话上下文(27 决定/7 步/29 边缘定案/24 回归清单),本文是主干还原,落地细节以代码为准。

## 体系与不变式

- `#paneRoot`(格容器)与 `#viewRoot`(其他视图)互斥显隐;chat 视图 = 格。
- 格 DOM 一次挂载常驻,`render()` 永不重建聊天。
- **状态镜像不变式**:`state.sessionId / state.harnessId` 是「焦点格」的镜像,唯一写入口 `focusPane / openSessionInto`,其余代码禁写(57 处外围引用靠镜像存活)。
- `PANE_MAX = 3`(性能边界:3×单格流式成本);布局持久化 `localStorage.hg_panes = {v,sids,focus,widths}`。
- `paneOf(sid)`:sid→格;**同会话至多一格**(transcript 无 reqId 配对下的路由基石)。
- 移动端强制单格(CSS 兜底 + `enforcePaneDeviceMode` 为事实源)。

## 格对象(makePane 九件套)

`sid/harnessId/els/entries/nodes/streamingAssistant/transcriptTotal/transcriptStart/loadingEarlier` + 搜索五件套 + 附件 `files` + transcript 串行化游标 `transBusy/transQueued/transKind` + 拖宽 `w`。

## 七步路线与状态

| 步 | 内容 | 状态 |
|---|---|---|
| 1 | 骨架:#paneRoot + CSS(.pane/.paneBar/.paneGrip/.foc/.pDot/.pBadge/.panePick)+ 格核心函数声明,零接线 | ✅ a5a5782 |
| 2 | 单格收编:聊天主链路整体搬进格(renderPaneChat/openSessionInto/paneApplyTranscript/21 函数 pane 首参),恒 1 格行为等价,九件套全局删除 | ✅ 121eea2 |
| 3 | 多格正确性:transcript 按格单飞串行化(transBusy/transQueued,防切会话在途回包污染)+ 抽屉快照化(wfPanel/gearSid 打开时绑定发起格,不读全局「当前会话」) | ✅ 2026-11-06 |
| 4 | 分屏入口:paneBar ⧉/✕ 按钮事件委托 + 空槽 picker(⧉ 分出空格先选会话,VS Code split 心智)+ 同会话双开拒绝路由 | ✅ 2026-11-06 |
| 5 | grip 拖宽 + 布局持久化恢复(启动按 hg_panes 复格复会话) | ⬜ |
| 6 | 边缘定案收尾:移动端单格强制、会话树右键「在分屏格打开」、关闭焦点格的输入态、broadcast 只投焦点格的外围件刷新 | ⬜ |
| 7 | 回归清单全跑 + 删过渡注释(步 2 的 id 兼容双标记在步 4 后删 id 只留 hg-* 类)+ 发布 | ⬜ |

## 关键函数索引(web/index.html)

`paneOf` `paneNearBottom`(140px)`makePane` `makePaneDom`(data-act=split/close,委托在 paneRoot)
`mountPane`(上限拒绝+补 grip)`focusPane`(焦点顶线+镜像+树高亮+落盘)`closePane`(清 timer+摘 grip/DOM+焦点移交右邻,末格 navHome)
`capturePaneEls`(短键缓存)`renderPaneBar`(pDot 灰/绿/蓝呼吸 + pBadge 待审批)
`openSessionInto(pane,id)`(装载:缓存秒显/resume 判定/focusPane)`renderPaneChat`(完整聊天模板;空格=sid null 走 picker 分支)
`paneApplyTranscript`(游标/前拼/全量;回包 sid≠pane.sid 丢弃——步 3)

## 边缘定案(考古到的)

- transcript 回包无 reqId → 同会话至多一格 + 按格单飞 + sid 失配丢弃。
- 容器隐藏时 scrollHeight=0 → paneNearBottom 恒真 → 隐藏格流式照常跟贴。
- 附件每格一份(防 A 格附件随 B 格消息发出);草稿/查重/补发队列本就 sid 键控,全局保留。
- grip 永远只插在两格之间(末格无 grip)。
- `hg_*` 类与旧 id 双标记:零散 $() 引用兼容;步 7 删 id。

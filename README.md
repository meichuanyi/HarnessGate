# HarnessGate

**一个入口，驱动所有编程 agent。** 自托管的 harness 远程控制台：把 Claude Code、Codex、ZCode、OpenCode、Hermes 等 47 个 ACP agent 聚合到一个界面，浏览器或 VS Code 远程派活、看流式输出、管权限、收交付件——agent 和文件全在服务器上，客户端只是遥控器。

```
浏览器 / VS Code ──WebSocket──▶ HarnessGate（服务器，ACP 客户端）──stdio ACP──▶ harness 进程们
                                    └── 文件 / 终端 / 权限 / 审计 全部在服务器落地
```

## 为什么是它

- **聚合，不是捆绑**：任何说 ACP（Agent Client Protocol）的 agent 加一行配置就能进来；内置注册表一键导入 47 个，探活分级（厂商 / 社区 / 存疑 / 屏蔽），绿色 = 真跑通一次对话。
- **不只是一对一聊天**：多 agent 可以坐在一起——圆桌讨论互相批注，或者组队分工真的写代码。
- **跨设备续命**：会话、圆桌、工作队状态全部落盘。服务重启、电脑换手机，接着聊；中断的任务可以断点续跑。
- **诚实的设计**：多 agent 协同没有"共享大脑"，上下文靠显式摘录投喂；每一步决策（包括机器自动做的）都进审计台账，可回溯。

## 快速开始

```bash
git clone <repo> && cd HarnessGate && npm install
npm start                     # 默认 http://0.0.0.0:9830
```

浏览器打开 `http://<服务器IP>:9830` → 选 harness → 填工作目录 → 开聊。
VS Code 用户装 `vscode/` 下的插件（瘦客户端，同一份会话），设置 `harnessgate.url` 指向服务器即可。

## 三种用法

### ① 一对一会话

选 harness、给目录、发消息。流式输出、工具调用时间线、模型/权限模式切换、附件、Markdown（含 KaTeX 公式）。会话落盘，重启后自动恢复上下文（resume / fork / load 三路兜底，按会话来源自动选）。

会话内还有：发言索引（点自己的历史发言直接跳转）、全文搜索（命中行下拉 + 关键词高亮）、打断当前回合、改动清单（本会话碰过的文件，可下载）、自动决策档位（见下）。

### ② 圆桌会议：多 agent 围一个议题

向导三步：选目录 → 选 ≥2 个 harness（可各自配模型）→ 写议题开跑。

- **结构**：主持人开场拆题 → 逐轮发言（并行=信息对称 / 串行=能接话）→ 轮间小结投喂下一轮 → 四段式总结（共识/分歧/待决/点子）。
- **共识即停**：轮数是上限不是剧本。主持人每轮小结时顺带判定收敛（第 2 轮起），判「已收敛」就提前收尾；也可以选**无上限轮数**，聊到收敛为止。
- **评分锦标赛**（可选）：主持人逐轮给发言打分，分数有三个后果——高分发言下一轮被完整摘录（低分狠截）、每人收到私密点评（针对性改进）、最终按累计分加权并点名最佳贡献。
- **界面**：分栏看每个 agent 逐字流式输出，按轮次纵向排列；worker/成员栏有活性标签（● 已运行 X 分钟 · 活动 Y 秒前），静默逼近阈值会变黄——一眼分清「在忙」和「挂了」。

### ③ 工作队：分工协作真的干活

给一个目标，剩余全自动：

```
工头拆解（2-6 个任务，带文件所有权标注，互不相交）
  → 每个队员一个独立 git worktree，并行开工
  → 提交层面强制所有权（越权改动根本进不了 commit）
  → 零上下文评审：另一个厂商的 harness 只看任务书 + diff，rubric 逐条打分，≥8 分才通过
  → 打回带意见重做（上限可调）；依赖满足即接力，无人空闲阻塞
  → 顺序合并回主目录（默认人工确认，冲突 abort 留人工）→ 工头收尾报告
```

三道防线对应多 agent 协作的三大实证风险：**写冲突**（worktree + 所有权强制）、**回声室**（评审零共享上下文 + 异厂商去相关）、**mock 稀释**（评审显式检查是否弱化测试/用占位实现）。

配套机制：

- **看门狗（Temporal 式）**：任务没有总时长上限——只要 agent 还在吐事件就一直干；静默超线（默认 20 分钟，可调）才优雅取消，任务退回待办换人重试。单个任务挂死不冻结全场（持续派发，非批式栅栏）。
- **断点续跑**：停止/出错的工作队点「继续运行」——保留任务板、跳过拆解、被打断的任务退回待办、失败任务重置重试预算。
- **决策与交付面板**：自动权限决策记录（⚠️ 危险操作标记、工具入参、agent 当时的意图说明）+ 每个任务的产物清单，单文件或 tar.gz 一键下载。

## 自动决策（权限委托）

ACP agent 干活时会请求授权。HarnessGate 提供三档：

| 档位 | 行为 |
|---|---|
| 人工审批（默认） | 每个请求弹按钮 |
| 只读自动 | read/grep 类自动放行，写和执行仍弹按钮 |
| 全自动 | 全部自动决策；**危险操作也决策不拦截**，但打红色 ⚠ 标记进台账 |

决策器按选项语义打分（`allow_always > allow_once > 推荐项 > 行动项`，拒绝类永不自动选），每条决策记录：工具入参、涉及文件、agent 当时的自述、所属任务、决策理由。工作队在 git worktree 里跑且产物有版本控制，适合全自动；危险模式（`HG_DANGER_HOLD=1`）可强制危险操作人工确认。

## 安全与审计

- 文件读写、终端、权限全部在服务器执行落地，浏览器/插件不接触任何文件。
- 所有敏感动作进 JSONL 台账（`~/.harnessgate/fs-audit.log`）：会话操作、权限请求（含自动决策的理由与标记）、文件改动（按"谁正在跑 turn"归因，标 exact/ambiguous/idle 置信度）、agent 日志。
- 默认关闭 token 认证（单人自用取舍）——**任何能访问端口的人都能以服务器权限驱动 agent**。对外暴露请开 `HG_AUTH=on` 或挂认证反代。
- 开认证后的网页体验：**登录门**——首次打开弹全屏卡片输 token（`~/.harnessgate/token`），输错有提示可重试，验证通过自动进入；**token 记在本设备（localStorage），之后免填**。也支持一键链接 `http://<host>/?token=<token>`（打开即登录，token 存住后自动从地址栏抹掉，不留历史）。注意「验证通过」以收到 hello 为准——服务端先完成 WS 握手再拒绝未授权连接（4401），不能拿 onopen 当成功。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `HG_PORT` / `HG_HOST` | 9830 / 0.0.0.0 | 监听 |
| `HG_AUTH` / `HG_TOKEN` | off / 自动生成 | 认证开关与凭证（`~/.harnessgate/token`） |
| `HG_DATA_DIR` | ~/.harnessgate | 全部落盘数据 |
| `HG_DEFAULT_CWD` | /root/projects | 新会话默认目录 |
| `HG_ROOM_TURN_TIMEOUT_MS` | 300000 | 圆桌单次发言**静默**上限（看门狗） |
| `HG_MAX_TURN_MIN` | 30 | 单回合最长时长（分钟）：超时自动打断并**停止会话**防占用（0=不限制）；会话可从列表恢复继续 |
| `HG_IDLE_STOP_MIN` | 30 | 空闲自动停止（分钟）：进程活着但持续无回合，自动停进程释放内存（0=不限制；房间成员会话不参与） |
| `HG_CREW_TURN_TIMEOUT_MS` | 1200000 | 工作队单任务**静默**上限 |
| `HG_CREW_APPROVE_SCORE` | 8 | 评审通过分数线（0-10） |
| `HG_DANGER_HOLD` | 关 | =1 时危险操作强制人工确认 |

加一个 harness 只改 `harness.json`：

```json
{ "id": "gemini", "label": "Gemini CLI", "cmd": "npx",
  "args": ["-y", "@google/gemini-cli", "--acp"], "note": "…" }
```

支持 `env`（含 `${HG_SESSION_ID}` 占位符）、`proxy`（推理网关不通时走本机代理）等字段。探活：`npm run doctor -- --probe --deep`（真实对话验证，默认模型失败会自动换备选模型重试，避免错杀）；结果写入 `probe.json`，界面绿点 = 探活真通过。

## 历史会话导入

HarnessGate 自动发现各 harness 本地存储里的历史会话并增量导入（OpenCode/ZCode 的 SQLite、Claude/Codex/OpenClaw 的 JSONL、Hermes 的自有库），启动时后台同步，也可 `npm run sync-history` 手动跑。导入的会话可查看、可 fork 继续。

## 客户端

- **Web**（`web/`，单文件无构建）：三级导航（harness → 会话 → 对话）、圆桌/工作队独立界面、手机自适应（抽屉侧栏、横滑分栏、触屏适配）。
- **VS Code 插件**（`vscode/`）：侧栏树 + 对话面板，支持打断、搜索、发言索引、模型记忆；圆桌等重界面提供「在浏览器打开」直达。打包：`cd vscode && npm run package`。

## 已知边界（诚实清单）

1. 跨 harness 无法共享上下文窗口——圆桌的"讨论"是独立会话间的摘录传递（700-900 字截断），主持人小结是模型观察不是事实。
2. 共享目录多会话并行改同一文件时无法按会话拆 diff（归因可判"谁碰过"）；要独立交付件请用工作队的 worktree 隔离。
3. fs 委托多数 harness 不使用（它们直接读写磁盘），文件台账靠服务端 watcher 覆盖。
4. 各 harness 能力参差：有的声明支持图片实际透传失败，有的 `set_config_option` 会挂（已加超时保护）。探活矩阵见 `npm run doctor`。
5. 前端为无构建单文件（够用但朴素）；工作队 token 消耗约为单 agent 的 5-15 倍。

## 测试

```bash
python3 tests/ui.py                 # Web 全流程（真实浏览器）
python3 tests/roundtable_ui.py      # 圆桌界面 + 真跑一场
node tests/smoke.mjs <harness> "…提示词"   # 单 harness 冒烟
node tests/room.mjs                 # 圆桌协议（摘录投喂断言）
node tests/converge.mjs             # 无上限轮数 + 共识即停
node tests/tournament.mjs           # 评分锦标赛
node tests/crew_rubric.mjs          # 工作队 rubric 评审
node tests/resume_room.mjs          # 断点续跑（停止→继续→不重说已完成轮）
node tests/interrupt.mjs            # 打断当前回合
node tests/watchleak.mjs            # inotify watcher 生命周期
node tests/remember_model.mjs       # 会话记住上次模型
node tests/watchdog_test.mts        # 静默看门狗（假 agent 装死）
node tests/perm_capture_test.mts    # 权限决策采集 + 危险标记
```

## 部署

`systemd` 单元示例与常见问题见仓库 Issues；注意单元文件需显式写完整 `PATH`，否则部分 harness 会被误判未安装。

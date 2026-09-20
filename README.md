# HarnessGate

一个自托管的 **harness 远程控制台**：浏览器里选一个 harness（Claude Code / Codex / ZCode / OpenCode / Hermes …）发任务，看流式输出、工具调用时间线、授权请求，随时换 harness 在同一个工作区继续干活。会话会落盘，**服务重启后可以恢复，harness 侧的上下文也接得上**。

```
浏览器(你) ──WebSocket──▶ HarnessGate（服务器，ACP client）──stdio ACP──▶ harness 进程（服务器）
                              └── 文件 / 终端 / 权限 全部在服务器落地
```

**设计铁律（决定"读不读你本地文件"）**：agent 是 HarnessGate 的子进程，跑在服务器上；文件读写由 HarnessGate 在服务器执行。浏览器只是 WS 客户端，**不接触任何文件**。这与 VS Code 插件类方案（agent 在本地跑、读本地文件）是相反的两条路。

## 快速开始

```bash
cd /root/projects/HarnessGate
npm install
npm start                     # 默认端口 9830
```

浏览器打开 `http://<服务器IP>:9830` → 选 harness → 填工作目录 → 新建会话。**默认不需要 token**（见下方「安全」）。

环境变量：`HG_PORT`(9830) / `HG_HOST`(0.0.0.0) / `HG_AUTH`(off) / `HG_TOKEN` / `HG_DATA_DIR`(~/.harnessgate) / `HG_DEFAULT_CWD`。

## 功能状态

| 能力 | 状态 |
|---|---|
| 多 harness 统一接入（注册表驱动） | ✅ M1 |
| 流式输出 / 思考流 / 工具调用时间线 | ✅ M1（时间线在 M2 做实：按 toolCallId 就地更新状态） |
| fs 拦截与路径白名单（禁写工作区外） | ✅ M1（仅对支持 fs 委托的 agent 生效） |
| 工作区改动台账（不依赖委托） | ✅ M1 |
| 会话落盘 + 服务重启后 `session/load` 恢复 | ✅ M2 |
| 授权审批（ACP request_permission → 网页按钮） | ✅ M2 |
| 权限模式切换（plan / edit / yolo …） | ✅ M2 |
| 模型 / 推理强度切换（`session/set_config_option`） | ✅ M3（按 harness 支持情况） |
| 附件（图片 / 文本） | ✅ M3（按 harness 支持情况，见矩阵） |
| git worktree 隔离（主工作区不受影响） | ✅ M3（新建会话时勾「隔离」） |
| systemd 常驻（开机自启、崩溃自拉） | ✅ M3 |
| 全量 harness 导入（ACP 注册表 42 个） | ✅ M4（`npm run import-registry`） |
| `harnessgate doctor` 可用性矩阵（真实探活） | ✅ M4（`npm run doctor -- --probe`） |
| 原生二进制 agent 自动下载（sha256 校验 + 代理探测） | ✅ M4（`--download`） |
| **共同工作区**：多 harness 同一目录 + 改动归因 + 冲突检测 | ✅ M5（右侧「工作区」面板） |
| **圆桌会议**：多 harness 就一个议题轮流发言、互相批注 | ✅ M6（右侧「圆桌」面板） |
| 共同工作区（多 harness 并行同一目录 + 冲突归因） | ⬜ M5 |
| 圆桌会议（多 harness 互相投喂） | ⬜ M6 |

## Harness 实测矩阵（本机，2026-09-18）

| harness | 一轮对话 | 恢复 | 权限模式 | 图片附件 | 配置项切换 |
|---|---|---|---|---|---|
| Claude Code | ✅ 6–11s | ✅ | default/acceptEdits/plan/auto | ✅ **实测能看图**（红→红、绿→绿） | ✅ model: default/opus/sonnet/haiku（实测切 haiku 生效） |
| OpenCode | ✅ 5–23s | ✅ | build/plan（未声明 modes，用配置项） | 未测 | 列出 model（十几个）+ mode |
| ZCode (GLM-5.3) | ✅ 8–12s | ✅ | plan/build/edit/yolo/auto | ❌ **声明支持但实际没看到**（红/绿/蓝三张图全答错） | ❌ `set_config_option` 报 Internal error 或挂住 |
| Codex | ✅ 10s | ✅ | — | 未测 | — |
| Hermes | ✅ 42s | ✅ | — | 未测 | — |
| OpenClaw | ⚠️ 会话可建，turn 未跑通 | — | — | — | — |
| Qoder CLI | ⚪ 未测（`--acp` 未文档化） | — | — | — | — |

> 图片附件的对照组很关键：同一个 PNG，Claude 三张里答对两张（红/绿）、ZCode 三张全错；说明问题出在 ZCode 的 ACP 适配器没有把图片透传给模型，而不是我们这一层。

测试脚本：

```bash
node tests/smoke.mjs <harness> "<prompt>"     # 一轮对话（M1 冒烟）
node tests/m2.mjs create "<prompt>"           # 新建并提问，打印 SESSION=<id>
node tests/m2.mjs resume <id> "<prompt>"      # 恢复会话并提问
node tests/perm.mjs <harness> LIST            # 打印可用权限模式 + 配置项
node tests/perm.mjs <harness> plan "<prompt>" # 切模式并观察授权请求
node tests/perm.mjs <harness> "cfg:model=haiku"  # 切配置项并验证生效

# 环境变量：HG_ATTACH=/path/a.png,b.txt 带附件；HG_CWD=/path 指定工作目录；HG_ISOLATE=1 用 worktree 隔离
HG_CWD=/tmp/repo HG_ISOLATE=1 node tests/smoke.mjs opencode "建个文件，只回复 DONE"
```

## 全量 harness（M4）

```bash
npm run import-registry                      # 从 ACP 官方注册表导入 42 个 agent → harness.registry.json
npm run import-registry -- --download        # 顺带下载 17 个原生二进制的 linux-x86_64 包（~1GB，走代理）
npm run import-registry -- --download --only kimi,goose   # 只下指定几个

npm run doctor                               # 可用性一览（只看装没装）
npm run doctor -- --probe                    # 真实探活：启动 ACP → initialize → session/new
npm run doctor -- --probe --only gemini,qwen-code
```

`harness.json`（手写）优先于 `harness.registry.json`（导入），同 id 以手写为准。

**同源条目会自动去重**：手写条目常用全局二进制（`codex-acp`），导入条目用 npx 包（`npx -y @agentclientprotocol/codex-acp`）——同一个东西的两种启动方式。合并时按「包名末段 vs 二进制名」归一化比对，把手写的同源导入项忽略掉（启动时日志会打印忽略了哪些），否则侧栏会出现两个一模一样的 Codex。

### 分级与屏蔽（`harness.trust.json`）

ACP 注册表是社区提交的，里面既有厂商官方项目，也有来源不明的个人项目，甚至有跟编程无关的东西（例如某个"用 USDC 付费调用 agent 服务的市场"）。所以导入项都过一遍人工分级：

| 级别 | 判定 | 界面 |
|---|---|---|
| `vendor` | 厂商官方或一线项目（星数/归属可查） | 默认显示，绿色「厂商」徽章 |
| `known` | 星数 ≥300 或组织知名，且探活可用 | 默认显示，「社区」徽章 |
| `unknown` | 星数极低 / 无公开仓库 / 来源不明 | **默认隐藏**，勾选「显示存疑项」才出现，黄色「存疑」徽章并写明理由 |
| `blocked` | 与编程 harness 无关或明显不可信 | **永不显示** |

### 本机可用性：以"探活结果"为准

**深度探活（`--deep`，真实对话）的结论只有深度探活能改变**：`--probe`（浅探，只验证到建会话）
不会把验证过的 harness 刷成未验证，也不能把上次深探失败的"洗白"成可用——建得了会话不代表聊得动
（deepagents/dirac 都出现过"浅探通过、真聊就挂"）。浅探仍然会：刷新模型目录（configs）、
上报变坏的真实信号（比如 token 过期变成需认证）。

界面上的**绿色 = 探活真的跑通了**，而不是"启动命令存在"。判定顺序（`server/registry.ts` 的 `localState()`）：

| 状态 | 含义 | 界面 |
|---|---|---|
| `probed-ok` | 探活通过（initialize + session/new 都成功） | 绿点 + 「已验证」，可选 |
| `installed` | 本机已装/已下载，但还没探活 | 黄点 + 「本机有·未探活」 |
| `needs-download` | npx/uvx 包在本机和缓存里都没有 | 灰 + 「本机没有：首次使用需要下载」 |
| `probed-auth` | 探活要求先登录该 CLI | 灰 + 「需登录」+ 具体提示 |
| `probed-failed` | 探活失败（记录失败原因） | 灰 + 「探活失败: …」 |
| `missing` | 找不到可执行文件（二进制类） | 灰 + 「未安装」 |
| `blocked` | 与编程 harness 无关 / 明显不可信 | 不显示 |

探活结果持久化在 `~/.harnessgate/probe.json`，由 `npm run doctor -- --probe` 写入；让某个灰色的变成绿色：

```bash
npm install -g <包名>                    # 或 npm run import-registry -- --download
npm run doctor -- --probe --only <id>   # 探活并写回结果，界面立即更新
```

> 早期版本只检查"启动器在不在"，导致所有走 `npx` 的条目（如 Cline、Grok Build）都显示为可用——实际它们的包根本没下载，或者探活直接失败。现已按上表修正。

### M4 探活结果（本机，2026-09-18，15 个抽样）

| 状态 | harness |
|---|---|
| ✅ 探活通过（8） | opencode · zcode · openclaw · hermes · claude · codex · **codebuddy-code** · **glm-acp-agent** |
| 🔐 需先登录（3） | qoder · auggie（`auggie login`）· qwen-code |
| ⚠️ 起不来（3） | cline（ACP 连接被关闭）· gemini（缺 API key）· grok-build（连接被关闭） |
| ⏱ 超时（1） | factory-droid（30s 无响应） |
| ⬇️ 已下载待用 | kimi（96MB 二进制就位，探活报"需认证"） |

> 后两个 ✅（腾讯 Codebuddy、GLM Agent）是导入注册表后**新发现的可用 harness**，一行配置都没写。

## 加一个 harness

只改 `harness.json`：

```json
{ "id": "gemini", "label": "Gemini CLI", "cmd": "npx",
  "args": ["-y", "@google/gemini-cli", "--acp"],
  "env": { "SOME_VAR": "x" }, "note": "…", "experimental": true }
```

`env` 的值支持 `${HG_SESSION_ID}` 占位符（spawn 时替换为 HarnessGate 会话 id，探活时替换为 `probe`）。
需要「每个会话对应一个上游会话键」的 harness 用它，例如 OpenClaw 的
`"OPENCLAW_SESSION_KEY": "agent:main:hg-${HG_SESSION_ID}"`——否则所有会话会挤进同一个上游会话。

## VS Code 插件

`vscode/` 下是一个 VS Code 插件（瘦客户端）：**agent 与文件仍在服务器上**，插件只通过 WS 连 HarnessGate 服务，本机不需要装任何 agent CLI。

```
左侧活动栏 HarnessGate 图标
  └ harness 列表（绿色对勾 = 探活通过）→ 展开看它名下的会话
       └ 点会话 → 右侧打开对话面板（流式 / Markdown / 工具时间线 / 授权按钮 / 模型下拉）
标题栏 +  → 新建会话：选 harness → 输工作目录（服务器上的路径，带补全）→ 自动打开对话
```

功能：侧栏树（harness + 会话）、对话面板、新建/恢复/停止/删除会话、历史同步、连接日志。
**不含圆桌**——圆桌只在网页版。

安装：
```bash
cd vscode
npm install && npm run package        # 生成 harnessgate-0.1.0.vsix
code --install-extension harnessgate-0.1.0.vsix
```
然后设置服务地址（默认 `ws://127.0.0.1:9830/ws`，服务在别的机器就改成那台机器的 IP）；服务端开了认证时把 `~/.harnessgate/token` 填进 `harnessgate.token`。

开发与测试：
```bash
npm run build        # 打包 dist/extension.js
npm run typecheck
npm test             # 真实 VS Code 端到端测试（会真建会话、发消息；需服务在跑）
npm run test:vsix    # 验证打包产物能被装上并连上服务
```

## 数据与审计

都在 `~/.harnessgate/`：

- `token` — 访问凭证（首启动生成，0600）
- `sessions.json` — 会话落盘（transcript + ACP 会话 id + 状态），原子写 + 去抖
- `fs-audit.log` — JSONL 台账：`session.*` / `prompt` / `permission.request|answer` / `fs.read|write`（委托路径，写操作带白名单判定）/ `fs.change`（工作区监听，覆盖所有 harness）/ `agent.log`

```bash
grep '"op":"fs.change"' ~/.harnessgate/fs-audit.log | tail -5
grep '"op":"permission' ~/.harnessgate/fs-audit.log | tail -5
```

## 界面

三级导航，都在同一个页面里：

```
① Harness 总览（卡片网格，47 个）
      │  点卡片
      ▼
② 该 harness 的会话列表（含"新建会话"：工作目录 + git worktree 隔离）
      │  点会话行 / 点「进入对话」
      ▼
③ 对话（流式输出、工具时间线、授权按钮、模型/权限模式下拉、附件）
```

- 左侧栏是同一棵树（harness → 它的会话），带筛选框和「未装」开关（默认只看已安装的）
- 顶栏面包屑可逐级返回；会话级配置（Model / Session Mode）只在对话页出现
- **工作目录输入带补全**（VS Code 那种）：边打边列子目录，`↑`/`↓` 选择、`Tab` 或鼠标点选补全、`Esc` 关闭；
  git 仓库带 `git` 徽标；路径不存在时提示「回车将创建」（服务端会 `mkdir -p`，所以不存在的路径直接建会话也成立）
- 会话行支持：进入对话 / 恢复 / **接续** / 停止 / 删除；**点进归档会话会自动恢复**，不用再手点一次
- 助手回复按 **Markdown 渲染**（标题、列表、**表格**、行内代码、带语言标签的代码块、链接、引用、分割线）；渲染器是自己写的（无依赖、先转义再套标签、流式未闭合的 ``` 也当代码块处理）
- 如果某个会话在 agent 侧跑不动（旧版本创建的常见），会直接提示并给一个「在新会话里接续」按钮
- 顶部右侧：**工作区**抽屉（改动归因 + 冲突）、**圆桌**（独立界面，见下）、**日志**开关
- 圆桌讨论区：**分栏**（每个 harness 一栏，可同时看到逐字流式输出）／**时间线**（按轮次顺序读），主持人卡片横跨下方

前端是单文件 vanilla JS（无构建步骤），但已用真实浏览器做回归：
`python3 tests/ui.py`（需要 playwright + chromium），覆盖导航、发消息收回复、
输入不被状态刷新冲掉、标题回填、历史回放、目录补全、删除。

## 共同工作区（M5）

多个 harness 可以同时盯同一个目录干活。M5 解决了两件事：

**1. 改动归因**（以前多个会话共享目录时，同一个改动会同时记到所有会话名下）

现在每个工作区只有一个 watcher（不是每个会话一个），改动脉冲按"谁正在跑 turn"归因，并标注置信度：

| confidence | 含义 |
|---|---|
| `exact` | 当时只有这一个会话在跑 turn，归它 |
| `ambiguous` | 多个会话同时在跑，无法区分（都记上） |
| `idle` | 没有任何会话在跑 turn（可能是你手动改的，或 agent 的后台收尾） |

**2. 冲突检测**：同一个文件被两个及以上会话碰过 → 标记 `conflict`，在「工作区」面板高亮，并列出参与的 harness。

面板还会显示每个会话的 `shared` / `worktree` 模式；worktree 模式的会话直接给出 `git diff --stat`（真正的 per-session diff）。

```bash
node tests/ws.mjs /tmp/dir opencode zcode   # 验收：两个 harness 先后改同一文件
```

> 说明：共享目录模式下无法区分"谁的 diff"——因为改的是同一份工作树。要拿到每个会话独立的 diff，用 worktree 隔离模式建会话。

## 圆桌会议（M6）

让多个 harness 就同一个议题发言。顶栏点「圆桌」进入**独立界面**，三步向导：

```
① 选工作目录（带补全，不存在会自动创建）
      │
② 选参与的 harness（≥2 个，只列探活通过的）
   + 每个成员可单独选模型/权限模式等（下拉，建会话时自动应用）
   + 可选指定主持人
      │
③ 写议题 + 最多轮数（1-8 或无上限）+ 共识即停 + 发言方式（并行/串行）+ 是否允许改文件 → 开始
```

讨论区按轮次纵向排列，每轮内分栏：

```
① 主持人开场（切入角度）
─────────────────────────────
第 1 轮 [并行]        ← 轮内每个 harness 一栏，并排流式输出
  OpenCode │ ZCode │ Hermes
─────────────────────────────
第 1 轮小结（主持人：共识/分歧/还没人碰的角度）
─────────────────────────────
第 2 轮 [并行]
  OpenCode │ ZCode │ Hermes
─────────────────────────────
最终总结（主持人：共识/分歧/待决/点子清单）
```

这样既能横向对比（同一轮内不同 harness 的答案并排），又能纵向读时间线（一轮接一轮往下滚）。主持人区块横跨整行，用紫色边框和成员区分。

**成员模型/参数**：第 2 步勾选 harness 后，每个成员下方会出现它支持的可切换配置（模型、权限模式、思考深度等），选好后建会话时自动应用。

这些选项来自**探活**——`npm run doctor -- --probe --deep` 时服务端会建一次会话，把 harness 上报的 `configOptions` 存进 `probe.json`，UI 读它来渲染下拉。所以没探活过的 harness 没有可选项（跑一次 doctor 即可）。

⚠️ **列表是 harness 自己上报的，不保证上游真的支持**。实测：codex 报的模型目录里有 `glm-5`，但 relay 上只有 `glm-5.3`，选错会得到 `Invalid model name passed in model=glm-5`（错误会原样显示在它那一栏）。换模型后先看第一轮回复，报错就换回默认。

**发言方式**（逐轮可切，切换从下一轮生效）：

| | 并行（默认） | 串行 |
|---|---|---|
| 同轮内 | 所有人同时开始，只看前几轮的结论 | 依次发言，后发言者能看到同轮前面的人 |
| 时长 | 每轮 ≈ 最慢的那个 | 每轮 = 所有人相加 |
| 信息 | 对称（公平） | 有"接话"级联，但最后发言者信息最全 |

第 1 轮两者等价（prompt 里本来就没有别人的发言），所以默认并行。勾选「允许改文件」时建议切串行——多个 agent 同时改一个目录必然冲突。

**主持人**（可选，第 2 步指定，可以是成员之一或额外拉一个 harness）：

- **开场拆题**：把议题拆成 3-5 个切入角度，写进所有成员第 1 轮的 prompt
- **轮间小结**：每轮结束做「共识 / 分歧 / 还没人碰的角度」小结，**作为下一轮成员的输入**（这是"主持大局"真正落地的地方）
- **最终汇总**：四段式「共识 / 主要分歧 / 待决问题 / 值得跟进的点子」
- **风格**：发散优先（默认，主动指出没人碰的角度、不急于收敛）／推动收敛

三个开关都能单独关掉。设了主持人后一次 N 轮圆桌的发言次数是 `N×成员数 + 开场 + (N-1)次轮间小结 + 最终汇总`。

**轮数与提前结束**：轮数是「上限」而不是固定值——「共识即停」开着时（默认），主持人每次轮间小结会顺带做一次收敛判定（标准是"主要分歧是否都已充分辩论、各方立场是否明确"，**不要求意见一致**），判定已收敛就提前进最终汇总；第 1 轮不算（各自独立发言，还没见过别人的观点）。轮数也可以选「无上限」：讨论一直进行到主持人判定收敛或你手动点停止，没选主持人时会自动让第一位成员兼任。判定是模型的观察不是事实，界面上会标注在第几轮收敛、理由是什么；不满意就「继续追问」接着聊。无上限 + 关掉共识即停 = 只能手动停止，纯粹烧 token 看上限，慎重。

**评分锦标赛**（第 ③ 步可选）：主持人每轮小结时顺带给每位成员的发言打分（0-10，标准：论证质量/切题度/新颖性，明确要求"简洁与详实同权"防篇幅 bias）。分数有三个后果，构成筛选压力：**高分发言下一轮被完整摘录（≥8 分 900 字），低分狠截（<5 分只剩 150 字）**；每人收到只属于自己的分数+一句点评（私密投喂，避免公开分数引发迎合级联）；最终汇总按累计分加权采纳并点名「本场最佳贡献」。打分搭轮间小结的便车，不增加调用次数。提醒：分数是主持人一家之言，同厂商主持人可能偏袒自家兄弟——想严肃用锦标赛就选个不同厂商的主持人。

**权限**：圆桌自动创建的会话会**自动批准**权限请求（圆桌界面没有审批按钮，否则会永久挂起）。按 `allow_always > allow_once > 其他` 挑最宽松的选项，每次批准都带 `auto: true` 记进审计台账。注意副作用：自动批准后"只讨论不改文件"只剩 prompt 层面的约束，agent 执意要写文件时权限拦不住。

**超时保护**：单次发言上限 5 分钟（`HG_ROOM_TURN_TIMEOUT_MS` 可调）。某个 harness 卡在网络重试里时（实测 opencode 的 `big-pickle` 会无限重试 socket 错误）记为「无输出」继续往下走，不会拖死整场；并行模式下个别成员起不来也不影响其他人。

**删除**：删圆桌时可勾选「同时删除成员会话」，不勾选则只删圆桌记录、会话留在列表里继续单独聊。手动挂进来的会话永远不会被连带删除。

**实测效果**（zcode × hermes，1 轮并行 + 主持人，104 秒，`node tests/room.mjs`）：

```
[host/opening] ZCode：角度清单（请勿急于收敛）1.拟声怪响派 2.错误美学…
[member] ZCode：我的方案 blörp —— 拟声怪响 + 键盘手感 + 错误美学三角度叠加
[member] Hermes：最看好「错误美学 × 键盘手感」叠加…
[host/final] ZCode：① 共识 ② 分歧 ③ 待决 ④ 点子清单
流式 chunk 数: 320，涉及 2 个会话（分栏里能同时看到逐字输出）
```

**机制**：规则化主持人循环（不需要额外的模型来调度）——按轮次推进，轮内并行或串行，把其他成员的发言截断到 700 字 + 主持人小结一起拼进 prompt。默认**禁止改文件**（`writeAllowed=false`）。

**诚实边界**：跨 harness 无法共享上下文窗口。这里的"讨论"就是**独立会话之间的消息传递 + 摘录**，每个成员的记忆只在自己会话里累积；摘录会截断，所以它不是"共享大脑"。主持人的小结也是模型生成的观察，可能有偏差——UI 上标注了"可质疑"。

## 工作队（crew）：多 agent 协同干活

圆桌的升级模式：不再是"讨论"，而是**真的分工干活**。向导第 ③ 步把模式切成「工作队」即可（要求工作目录是 git 仓库）：

```
你给目标 → ① 工头拆解成 2-6 个任务（每个任务带「文件所有权」标注，任务间互不相交）
          → ② 每个队员一个独立 git worktree，并行干活
          → ③ 零上下文评审：由另一个厂商的 harness 只看任务书和 diff（不看实现者讨论）
               rubric 打分制：按任务书验收标准逐条判定 + 总分 0-10，≥8 分才通过
               通过 → 完成；打回 → 带逐条意见重做（上限可调，默认 2 次）
          → ④ 顺序合并回主目录（默认人工确认；冲突 abort 并留待人工）
          → ⑤ 工头收尾报告（完成了什么/失败原因/合并情况/后续建议）
```

**任务板 UI**：待办 / 进行中 / 待评审 / 完成，卡片显示队员、文件所有权、改动摘要、评审意见；
下面是各队员的实时输出分栏（干活的逐字流式），工头拆解和收尾报告横跨整行。

**三道防线**（来自多 agent 实证研究，见调研结论）：
1. **写冲突**：每队员独立 worktree + 任务文件所有权互不相交 + **提交层面强制**（只 stage 所有权内路径，harness 运行时垃圾如 `.zcode/` 自动排除）+ 顺序合并
2. **回声室**：reviewer 与 coder **零共享上下文**（不看实现过程只看 diff）+ 异厂商互审去相关
3. **mock 稀释**：评审显式检查"是否修改/弱化测试、用 mock 规避"，worker prompt 同步禁止

**rubric 评审**：评审员先从任务书抽验收标准建 rubric（没写就自己拆 2-4 个可验证的验收点），逐条 pass/fail 带依据，再给总分。通过线默认 8 分（`HG_CREW_APPROVE_SCORE` 可调）——模型说 approve 但分数不达标照样打回，分数有后果才算奖励。评审输出连 verdict 都解析不出时按**打回**处理（垃圾评审不能放行改动，宁可重试超限标失败，也不假通过）。任务卡上可展开逐条判定。

**成本提示**：这类模式 token 是单 agent 的 5-15 倍（Anthropic 实测 orchestrator-worker +15x）。
单任务超时默认 20 分钟（`HG_CREW_TURN_TIMEOUT_MS` 可调）。

## 安全（重要）

**默认关闭 token 认证**（`HG_AUTH=off`，写在 systemd 单元里）——这是单人自用的取舍：

> 本机 `0.0.0.0:9830` 上，任何能访问该端口的人都可以在你的服务器上**以 root 驱动 agent 执行任意命令**（agent 有文件和 shell 权限，部分 harness 默认 yolo 模式）。仅限可信网络使用。

启动日志里会打印醒目警告。要重新开启：

```bash
sudo sed -i '/HG_AUTH=off/d' /etc/systemd/system/harnessgate.service && sudo systemctl daemon-reload && sudo systemctl restart harnessgate
# 或者临时：HG_AUTH=on
```

开启后：页面顶部会出现 token 输入框（`~/.harnessgate/token`），也支持一键链接 `http://<ip>:9830/?token=<token>`（打开即登录，可收藏）。

如果以后要暴露到公网或多人使用，建议：开 `HG_AUTH=on` + 前面挂带认证的反代（Nginx/Caddy），并考虑给会话加 Docker 隔离。

已验证：`HG_AUTH=on` 时匿名连接会被 4401 拒绝，且关闭窗口期内塞入的指令不会被执行（实测 5 条 `create` 全部丢弃，未产生任何目录/会话）。

## 历史会话：自动发现 + 增量导入

**不是手工脚本**——HarnessGate 自己会去各家 harness 的存储里发现并导入历史会话：

| 来源 | 位置 | 形态 |
|---|---|---|
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite（session/message/part） |
| ZCode | `~/.zcode/cli/db/db.sqlite` | 同上 |
| Claude Code | `~/.claude/projects/**/*.jsonl` | JSONL |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | JSONL |
| Hermes | `~/.hermes/state.db` | SQLite（自有 schema） |
| OpenClaw | `~/.openclaw/agents/*/sessions/<uuid>.jsonl` | JSONL（文件极多，默认只看最近 600 个） |
| Codebuddy Code | `~/.codebuddy/projects/**/*.jsonl` | JSONL（自有格式：`message`/`function_call`/`reasoning`/`ai-title`；跳过 `subagents/`） |

- **启动时自动同步一次**（后台跑，不阻塞启动）；界面「同步历史」按钮可手动触发；命令行 `npm run sync-history`
- **增量**：`~/.harnessgate/history-index.json` 记录每条会话的指纹（文件大小+mtime / 数据库消息计数）。发现阶段只读**文件头和元数据**，所以 106MB 的 Claude 历史全扫一遍也只要约 2 秒；内容没变的不会重新解析
- **默认跳过**：`/tmp`、worktree 目录、**本工具自己目录下**的会话（调试噪音），以及 **OpenClaw 的 `[cron:…]` 自动化会话**（那是定时任务，不是人机对话）；`--include-tmp` 可放开前两类，`--include-self` 放开第三类（例如"本工具这个项目自己"的对话）
- 没有工作目录的 harness（如 Hermes 的飞书会话）兜底用家目录，否则会被整个跳过
- 标题会剥掉 `[message_id: …]`、"用户123: " 这类消息信封痕迹
- 每个会话保留最近 800 条记录（超出会在开头插一行提示），完整历史仍在各 harness 自己的存储里
- **加一个新来源**：在 `server/history.ts` 里加一个 provider（两种现成模板：SQLite 型 / JSONL 型），不需要写导入脚本

```bash
npm run sync-history                 # 增量
npm run sync-history -- --force      # 全部重新导入
npm run sync-history -- --only zcode # 只同步某一个
npm run sync-history -- --include-self   # 连「本工具自己目录下」的会话一起导（默认当调试噪音跳过）
```

> 服务在运行时，CLI 会**通过服务**同步（`POST /sync-history`），避免直接改文件被服务内存里的状态覆盖。

## 跨设备使用

状态全在服务器上（会话、台账、工作区都在 `~/.harnessgate/`），浏览器只是客户端，所以**任何设备打开同一个地址都是同一份会话**，可以随时换设备接着聊：

| 场景 | 地址 |
|---|---|
| 同一局域网 | `http://<服务器局域网IP>:9830` |
| 装了 Tailscale（本机已在 tailnet） | `http://<Tailscale IP>:9830`（异地也能用） |
| 服务器本机 | `http://127.0.0.1:9830` |

服务监听 `0.0.0.0`，三个地址都已验证可访问。注意开着 `HG_AUTH=off`，谁能访问这个端口谁就能驱动 agent，所以异地访问建议走 Tailscale（私有网络）而不是公网端口映射。

## 部署（systemd）

```bash
systemctl status harnessgate      # 已 enabled，开机自启
journalctl -u harnessgate -n 50
# 单元文件里显式写了完整 PATH —— systemd 默认 PATH 很干净，否则 opencode/hermes/qoder 会被判定"未安装"
```

## 恢复会话：三种 ACP 方式，各有适用场景

实测（2026-09-18，OpenCode 1.18.13）：

| 方式 | 行为 | 适用 |
|---|---|---|
| `session/resume` | 接着原会话跑，带回 configOptions | **本工具创建的会话** |
| `session/fork` | 把原会话**复制**成一个新会话（返回新 session id），事件流完整 | **从 agent 历史导入的老会话**（CLI 早期版本创建） |
| `session/load` | 只把历史回放给客户端，旧会话的 turn 常常跑不动（返回"缓存响应"：有 usage、零事件） | 兜底 |

会话记录里有个 `origin` 字段（`new` / `imported`），恢复时按它选顺序：`imported` 先 fork，其它先 resume，都不行再 load。fork 得到的新 id 会写回会话记录，之后就能正常继续。


```bash
# 也可以直接调
{"type":"handoff","sessionId":"<源会话 id>","keep":20}
```

实测：从 8/3 的老会话接续 → 新会话回复"已了解上下文：这是一个 FastAPI + React 的量化交易系统…"，上下文接上了。

> 老会话仍然可以查看（历史完整），也可以用 fork 直接在 HarnessGate 里继续。

**「接续」**（会话行按钮）仍然保留：它把最近 20 条记录作为背景注入一个全新会话，适用于 fork/resume/load 都不支持的 harness，或想把上下文带到**另一个 harness**去的情况。

## 已知局限（M4 后）

1. **fs 委托多数未被使用**：实测 OpenCode/ZCode/Claude 都自己直接读写磁盘，不回调客户端的 `fs/*`（所以 `fs.read/write` 多为空，真正覆盖的是 `fs.change` 台账）。
2. **恢复期间的回放**：`session/load` 后 harness 会回放历史，窗口一直抑制到"我们发第一句 prompt"为止。慢速 harness 若在恢复后主动推送事件，会被误抑制（M3 可改为按消息 id 去重）。
3. **共享目录拿不到 per-session diff**：归因能告诉你是"谁碰的"，但同一份工作树上的差异无法按会话拆分；需要独立 diff 就用 worktree 隔离模式。
4. **harness 能力参差**：ZCode 适配器声明的 `promptCapabilities.image` 名不副实，配置项切换也会挂（已加 10s 超时保护，不会拖死界面）。
5. **无认证协商**：不调用 `authenticate`（ZCode 适配器声明了却未实现），各 harness 用自己已有登录态。
6. **直连 GitHub 发布页不稳**：二进制下载走 curl，脚本会自动探测本机代理端口（7890/7891/7892/1080/8080）；也可以用 `https_proxy=... npm run import-registry -- --download` 显式指定。
7. 17 个原生二进制 agent 只下了 kimi 一个做验证，其余待 `--download`（约 1GB）。
8. 前端无构建步骤（单文件 vanilla JS），够用但还比较朴素。

## 路线图

- ~~**M3**~~ 已完成：模型/配置项切换、附件、git worktree 隔离、systemd 常驻（回放去重仍用"抑制到首次发言"的窗口方案）
- ~~**M4**~~ 已完成：42 个 agent 导入、doctor 真实探活、二进制自动下载
- ~~**M5**~~ 已完成：工作区归因（exact/ambiguous/idle）、冲突检测、worktree per-session diff
- ~~**M6**~~ 已完成：`room` 原语 + 规则化主持人循环（逐轮逐人 + 摘录投喂 + 可停止）
- **后续可选**：主持人 agent 化（让模型写总结与追问）、圆桌成员自动开 worktree、多用户与权限、每会话 Docker 隔离、ACP 注册表自动跟踪上游更新

## 目录

```
server/   index.ts(HTTP+WS) session.ts(ACP 封装) store.ts(落盘) workspace.ts(归因/冲突) worktree.ts(git 隔离)
          room.ts(圆桌：主持人循环/并行串行) dirs.ts(目录补全) registry.ts audit.ts types.ts
scripts/  import-registry.mjs（注册表导入/下载） doctor.mjs（可用性矩阵） sync-history.ts（历史同步）
          oc-probe.mjs（手动调试单个 ACP harness）
harness.json（手写，优先）  harness.registry.json（导入，勿手改）  harness.trust.json（分级/屏蔽）
web/      index.html（单文件前端：会话/圆桌分栏/流式/目录补全/工具时间线/授权按钮）
tests/    smoke.mjs  m2.mjs  perm.mjs  ws.mjs（共同工作区）  room.mjs（圆桌协议）
          ui.py（浏览器回归）  roundtable_ui.py（圆桌界面回归）
vscode/   VS Code 插件（瘦客户端：侧栏树 + 对话面板，不含圆桌）
```

# HarnessGate for VS Code

在你的**服务器**上远程驱动多个编码 agent（harness）：OpenCode、Claude Code、Codex、ZCode、Hermes、Antigravity、OpenClaw…

**agent 与文件都在服务器上**——这个插件是瘦客户端，只通过 WebSocket 连 HarnessGate 服务。你本机不需要装任何 agent CLI，也不需要把代码同步到本地。

## ⚠️ 前置条件：先安装后端 HarnessGate

这个插件**只是遥控器**，必须先有一台机器（你的服务器/VPS/NAS）上跑着 **HarnessGate 后端服务**，插件才有东西可连：

```bash
# 1. 在服务器上克隆并安装（需要 Node.js ≥ 20）
git clone <HarnessGate 仓库地址> HarnessGate
cd HarnessGate
npm install

# 2. 启动（默认监听 0.0.0.0:9830）
npm start

# 3.（推荐）注册成 systemd 常驻服务，开机自启、崩溃自拉
#    单元文件示例见主仓库 README「部署（systemd）」一节
```

服务器上要装你想用的 agent CLI（如 `opencode`、`claude`、`zcode` …），后端启动时会自动探活列出可用的。

**公网访问务必开认证**：启动前删掉 systemd 单元里的 `HG_AUTH=off`（或设 `HG_AUTH=on`），token 在服务器的 `~/.harnessgate/token`。

## 用法

1. 确认后端已在某台机器跑起来（上面一步）
2. VS Code 里配置服务地址：
   - 命令面板 → **`HarnessGate: 配置服务器地址…`**（推荐，两步填地址 + token）
   - 或直接改设置 `harnessgate.url`：本机默认 `ws://127.0.0.1:9830/ws`，远程填 `ws://<服务器IP>:9830/ws`
   - 服务端开了认证时，把 `~/.harnessgate/token` 的内容填进 `harnessgate.token`
3. 左侧活动栏点 HarnessGate 图标 → 看到 harness 列表（绿色对勾 = 探活通过）
4. 点标题栏 `+` 新建会话：选 harness → 输工作目录（服务器上的路径，支持边打边补全）→ 自动打开对话面板

## 功能

- **侧栏树**：harness（含可用性、版本、路径）→ 它名下的会话（含状态与工作目录）；标题栏一键折叠/展开全部 harness
- **对话面板**：流式输出、Markdown 渲染（表格/代码块）、工具调用时间线、思考过程、**授权按钮**、模型 / 权限模式下拉、对话搜索、长对话折叠与分页加载
- **圆桌面板**：多 harness 就一个议题轮流发言（新建向导 / 按轮分栏 / 主持人 / 停止 / 追加议题）
- **会话操作**：新建 / 恢复 / 停止 / 删除（右键会话行或用行内图标）
- **历史同步**：`HarnessGate: 同步历史会话` 从服务器上的 agent 历史里增量导入
- **日志**：对话面板右上「日志」按钮显示原始事件；`HarnessGate: 显示连接日志` 看连接层日志（含会话面板打开/渲染全过程，排查用）

## 命令

| 命令 | 说明 |
|---|---|
| `HarnessGate: 配置服务器地址…` | 两步填服务地址 + token，保存即重连 |
| `HarnessGate: 连接 / 重连服务` | 建立/重建到服务的连接 |
| `HarnessGate: 刷新` | 重新拉取 harness 与会话列表 |
| `HarnessGate: 新建会话…` | 选 harness + 工作目录，创建并打开对话 |
| `HarnessGate: 圆桌会议` | 打开原生圆桌面板 |
| `HarnessGate: 同步历史会话` | 增量导入 agent 历史会话 |
| `HarnessGate: 打开对话` | 打开选中会话的对话面板 |
| `HarnessGate: 恢复 / 停止 / 删除会话` | 会话生命周期操作 |
| `HarnessGate: 折叠 / 展开全部 harness` | 侧栏树一键收起/展开 |

## 设置

| 项 | 默认 | 说明 |
|---|---|---|
| `harnessgate.url` | `ws://127.0.0.1:9830/ws` | 服务端 WebSocket 地址 |
| `harnessgate.token` | 空 | 服务端开了认证时填（见 `~/.harnessgate/token`） |
| `harnessgate.defaultCwd` | 空 | 新建会话默认目录（服务器上的路径） |

## 开发

```bash
npm install
npm run build          # 打包 dist/extension.js
npm run typecheck      # 类型检查
npm run package        # 生成 .vsix
npm test               # 真实 VS Code 端到端测试（需服务在 9830 上跑着）
```

## 注意

- 服务端默认（`HG_AUTH=off`）**不做认证**，且能访问 9830 端口的人就能以服务器身份驱动 agent 执行命令——只在你信任的网络里用。
- 工作目录是**服务器上的路径**，不是你本机的路径。

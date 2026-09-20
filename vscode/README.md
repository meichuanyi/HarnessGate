# HarnessGate for VS Code

在你的**服务器**上远程驱动多个编码 agent（harness）：OpenCode、Claude Code、Codex、ZCode、Hermes、Antigravity、OpenClaw…

**agent 与文件都在服务器上**——这个插件是瘦客户端，只通过 WebSocket 连你已有的 HarnessGate 服务。你本机不需要装任何 agent CLI，也不需要把代码同步到本地。

## 用法

1. 在服务器上跑起 HarnessGate 服务（见主仓库 README）：
   ```bash
   systemctl start harnessgate     # 或 npm start
   ```
2. VS Code 里设置服务地址（默认 `ws://127.0.0.1:9830/ws`）：
   - 命令面板 → `HarnessGate: 连接 / 重连服务`
   - 若服务不在本机，改设置 `harnessgate.url` 为 `ws://<服务器IP>:9830/ws`
   - 服务端开了认证时，把 `~/.harnessgate/token` 的内容填进 `harnessgate.token`
3. 左侧活动栏点 HarnessGate 图标 → 看到 harness 列表（绿色对勾 = 探活通过）
4. 点标题栏 `+` 新建会话：选 harness → 输工作目录（服务器上的路径，支持边打边补全）→ 自动打开对话面板

## 功能

- **侧栏树**：harness（含可用性、版本、路径）→ 它名下的会话（含状态与工作目录）
- **对话面板**：流式输出、Markdown 渲染（表格/代码块）、工具调用时间线、思考过程、**授权按钮**、模型 / 权限模式下拉
- **会话操作**：新建 / 恢复 / 停止 / 删除（右键会话行或用行内图标）
- **历史同步**：`HarnessGate: 同步历史会话` 从服务器上的 agent 历史里增量导入
- **日志**：对话面板右上「日志」按钮显示原始事件；`HarnessGate: 显示连接日志` 看连接层日志

## 命令

| 命令 | 说明 |
|---|---|
| `HarnessGate: 连接 / 重连服务` | 建立/重建到服务的连接 |
| `HarnessGate: 刷新` | 重新拉取 harness 与会话列表 |
| `HarnessGate: 新建会话…` | 选 harness + 工作目录，创建并打开对话 |
| `HarnessGate: 同步历史会话` | 增量导入 agent 历史会话 |
| `HarnessGate: 打开对话` | 打开选中会话的对话面板 |
| `HarnessGate: 恢复 / 停止 / 删除会话` | 会话生命周期操作 |

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

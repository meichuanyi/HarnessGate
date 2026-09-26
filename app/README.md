# HarnessGate 移动客户端

HarnessGate 服务器的手机端薄客户端：连接你的服务器，远程查看/驱动上面的编码 agent。

## 功能范围

- **连接**：填服务器地址（`http(s)://host:port`）与 token（未开认证可留空），配置本地记住、下次自动连。
- **会话列表**：收藏置顶 → 最近活跃；运行中/空闲/待审批/已存档/出错 状态胶囊；下拉刷新；新建/恢复/停止/删除。
- **新建会话**：选 harness（探活通过优先）→ 填工作目录 → 可选 git worktree 隔离 → 创建后自动进入对话。
- **对话**：流式输出、Markdown（含 KaTeX 由 `flutter_markdown` 尽力渲染）、工具调用时间线、权限审批、打断当前回合、自动决策三档（人工/只读/全自动）、收藏。

编排类重界面（圆桌、工作队、定时）仍在网页端。

## 开发

```bash
flutter pub get
flutter run                # 需先 flutter devices / 连接手机或模拟器
flutter analyze
flutter test
```

## 打包

```bash
flutter build apk --debug      # 产物 build/app/outputs/flutter-apk/app-debug.apk
flutter build apk --release    # 发布包（当前用 debug 签名，正式发布需自备签名）
```

服务端 `HG_HOST=0.0.0.0` 监听，手机与服务器同网段时填 `http://<服务器IP>:9830` 即可。

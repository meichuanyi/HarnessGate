# dsh-harnessgate

[HarnessGate](../README.md) 的 **DeepSeek Harness (dsh) 桌面插件**——把「跨 harness 统一管理会话」递进 dsh：在 dsh 里一条命令看所有网关会话，一个路由打开完整管理面板。

## 拿安装包

| 通道 | 地址 | 状态 |
|---|---|---|
| alist `/shares` | `http://192.168.6.108:5244/p/shares/dsh-harnessgate-0.1.1.tgz?sign=7R227KLZdEG86YlXKbjHnNLYiQmSS_rguVky8EnEE9o=:0`（`:0` 结尾=永久签名；仅内网可达） | ✅ 可用 |
| GitHub Release | tag `dsh-v0.1.1` + 资产已建好（`releases/download/dsh-v0.1.1/dsh-harnessgate-0.1.1.tgz`） | ⛔ 暂不可用：meichuanyi 账号 2026-10-24 被 GitHub 风控整体隐藏（匿名访问用户主页/仓库/Release 全 404，owner 自己看一切正常），需申诉解封后自动恢复 |

## 装进 profile

```bash
# 0) 非本机先从上面通道下载 tarball
# 1) 装 包（本地 tarball；发布 npm 后换成包名）
cd ~/.dsh/profiles/web
pnpm add file:/path/to/dsh-harnessgate-<版本>.tgz
# （换版本重装时先 pnpm remove dsh-harnessgate——file: 依赖同名不刷新）
# （别用 pnpm add git+https://… 装：pnpm 对 git 依赖做全量 clone，代理/慢网下 7 分钟都跑不完，tarball 秒级）

# 2) 挂 行（二选一）
#    a. 作为 bundle：编辑 profile 的 package.json
#       "dsh": { "profile": { "bundles": [ ..., "dsh-harnessgate" ] } }
#    b. 手工行：往 profile 的 cordis.patch.yml 追加本包 cordis.patch.yml 的 insert 段

# 3) 起
dsh web          # 控制台打出 dsh web: URL；面板直接访问 http://127.0.0.1:3080/harnessgate
dsh --profile web --dump-config | grep -A4 harnessgate   # 验证行已入树
```

> 实测坑（0.2.1-rc.2，2026-10-24）：webserver 服务名是 `webServer`（rc.1 文档写 `httpServer` 已改名）；`dsh` CLI 自举要求全局安装（`npm i -g @deepseek-ai/dsh`，npx 跑 dump/boot 会 `sh: dsh: not found`）；`@deepseek-ai/dsh-base@0.0.1-rc.1` 系依赖未公开发布的 `dsh-permission`，别往 profile 里装旧版 base——宿主行由全局 CLI 的依赖树提供，profile 只装第三方插件。

## 用法

| 入口 | 效果 |
|---|---|
| `/harnessgate` | 状态概览：连接态 · harness 数 · 会话数 · 面板链接（只进 UI，不烧模型 token） |
| `/harnessgate list` | 最近会话列表（harness · 标题 · 在跑标记） |
| `/harnessgate panel` | 只拿面板 URL |
| `http://<dsh>:<port>/harnessgate` | 整页面板：顶栏 + 全幅 iframe 嵌 HG 自带 web UI（`?token=` 直过认证门） |

## 配置（行 config）

| 键 | 默认 | 说明 |
|---|---|---|
| `url` | `http://127.0.0.1:9830` | HG 服务器地址 |
| `token` | 空 | 显式 token（留空读 `tokenFile`） |
| `tokenFile` | `~/.harnessgate/token` | HG token 文件 |
| `panelPath` | `/harnessgate` | 面板路由（挂在 dsh webserver 上） |
| `listLimit` | `15` | `/harnessgate list` 上限 |

## 边界

- 薄客户端：dsh 侧只维护一份 WS 会话快照（断线 5s 重连），真相永远在 HG 服务器。
- 命令结果走 dsh-commands 注册表——不进模型历史、不影响 KV cache。
- dsh 还在 rc（本包按 0.0.1-rc.1 的 cordis 行格式 + `commands`/`httpServer` 服务写成），API 漂移时以官方 bundle 源码为准。

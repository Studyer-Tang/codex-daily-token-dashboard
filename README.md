# Codex Daily Token Widget

一个仅在本机运行、始终置顶的 Windows Codex 每日 Token 用量悬浮窗。

![Node.js](https://img.shields.io/badge/Node.js-20%2B-5FA04E)
![Privacy](https://img.shields.io/badge/data-local--only-6EE7A5)

## 功能

- 原生 Windows 悬浮小窗，无需打开浏览器
- 默认使用约 260×68 的极简信息条，适合贴在论文或编辑器边缘
- 今日用量、较昨日变化和近 7 天用量
- 七日迷你柱状图与今日 Token 构成
- 始终置顶、可拖动，也可以临时取消置顶
- 区分缓存输入、非缓存输入、输出和推理输出
- 网页看板按匿名任务编号排行，可展开查看每轮输入、缓存、输出和总量
- 自动识别高消耗轮次，大量任务和轮次采用分批显示
- 原生完整悬浮面板提供“概览 / 任务”双视图，可直接查看任务排行和每轮用量
- 任务轮次按需加载，使用鼠标滚轮浏览，不会拖慢日常刷新
- 自动读取活动会话与归档会话，按会话 ID 去重
- 日志扫描在独立 Worker 中执行，健康检查不会被大文件扫描阻塞
- 每 5 分钟自动刷新，并将最近一次聚合摘要缓存在本机
- 请求超时、服务退出或挂起时自动诊断、重启并重试
- 只绑定 `127.0.0.1`，不需要账号、API Key 或网络请求
- 不保存、不返回提示词、回复、项目路径或凭据

## Windows 快速使用

推荐从 GitHub Actions 或 Release 下载 `CodexTokenWidget-windows-x64.zip`。压缩包已经包含 Node.js，无需另行安装；解压整个文件夹后双击：

```text
CodexTokenWidget.exe
```

程序默认以极简信息条显示在桌面右上角，每 5 分钟自动刷新，只保留今日用量、同步状态、展开和隐藏。点击 `+` 或双击小窗可展开完整视图；顶部“概览 / 任务”可切换统计内容，在任务排行中点击某个任务查看每轮明细，并使用鼠标滚轮浏览。点击 `–` 再次收起，`TOP` 可切换置顶，`×` 会隐藏到系统托盘。

再次双击程序不会产生第二个实例，而会直接唤出现有悬浮窗。Windows 关机或注销时程序会正常退出；如果挂件异常结束，本地统计服务也会检测父进程并自行关闭。

从源码运行需要 Node.js 20 或更新版本，也可以在终端中运行：

```powershell
npm run widget
```

悬浮窗会在需要时静默启动本地统计服务，并在退出时结束自己启动的服务。数据不会离开电脑。

如果本地统计服务意外退出，悬浮窗会自动检测、重启并刷新数据，不需要手动重开程序。界面会显示具体的错误类型；完整诊断记录保存在：

```text
%LOCALAPPDATA%\CodexTokenWidget\widget.log
```

也可以右键系统托盘中的 Codex Token 图标，选择 **打开诊断日志**。日志达到 1 MB 后自动轮换，只保留当前文件和上一份日志。写入前会将用户目录和程序目录替换为 `%USERPROFILE%`、`%APPDIR%`，不会记录提示词或回复内容。

## 可选网页仪表盘

项目仍保留完整网页看板，运行：

```powershell
npm start
```

再访问 `http://127.0.0.1:4817`。网页中的“任务与每轮用量”只使用不可逆的匿名任务编号，不返回会话 ID、轮次 ID、路径或对话内容。需要停止时双击 `stop-dashboard.cmd`。

## 数据口径

程序只读取以下本机目录中的 `token_count` 事件：

```text
%USERPROFILE%\.codex\sessions\**\rollout-*.jsonl
%USERPROFILE%\.codex\archived_sessions\*.jsonl
```

优先使用 `last_token_usage`（单次模型调用用量）；旧日志只有 `total_token_usage` 时，按会话累计值求差，避免重复累计。新版日志通过 `task_started` 和 `task_complete` 边界，将一次对话轮次中的多次模型调用合并；缺少边界的旧记录会标为“未标记轮次”。缓存 Token 是输入 Token 的子集，因此总量使用日志中的 `total_tokens`，不会把缓存输入再次加到总量中。安装了 `rg`（ripgrep）时会启用高速扫描；否则自动回退为纯 Node.js 扫描。

统计是本机 Codex 记录口径，不等同于 API 账单或订阅额度。

聚合缓存和诊断日志默认位于 `%LOCALAPPDATA%\CodexTokenWidget`，不会写入 Git 仓库。环境变量 `CODEX_TOKEN_CACHE_DIR` 可以单独修改聚合缓存目录。

## 测试

```powershell
npm test
```

## 从源码构建悬浮窗

Windows 10/11 自带的 Windows PowerShell 5.1 即可编译，无需 Visual Studio：

```powershell
npm run build:widget
```

构建前请从托盘彻底退出正在运行的悬浮窗。构建结果为项目根目录下的 `CodexTokenWidget.exe`。构建脚本不会隐藏 PowerShell、绕过执行策略或修改系统安全设置。

生成包含 Node.js、网页资源和 SHA-256 校验值的完整发布包：

```powershell
npm run package:windows
```

二进制不直接提交到仓库；GitHub Actions 会从公开源码重新编译，并在 `dist` 中生成 ZIP 和校验文件。

## 参考项目

- [shanggqm/codexU](https://github.com/shanggqm/codexU) — Codex 本地 `token_count` 聚合与 Windows 数据源说明
- [xiufengsun/TokenTracker](https://github.com/xiufengsun/TokenTracker) — 本地优先的多工具 Token 仪表盘
- [douglasmonsky/codex-usage-tracker](https://github.com/douglasmonsky/codex-usage-tracker) — 本地会话用量数据与证据模型

## License

MIT

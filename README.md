# Codex Daily Token Widget

一个仅在本机运行、始终置顶的 Windows Codex 每日 Token 用量悬浮窗。

![Node.js](https://img.shields.io/badge/Node.js-20%2B-5FA04E)
![Privacy](https://img.shields.io/badge/data-local--only-6EE7A5)

## 功能

- 原生 Windows 悬浮小窗，无需打开浏览器
- 今日用量、较昨日变化和近 7 天用量
- 七日迷你柱状图与今日 Token 构成
- 始终置顶、可拖动，也可以临时取消置顶
- 区分缓存输入、非缓存输入、输出和推理输出
- 自动读取活动会话与归档会话，按会话 ID 去重
- 每 5 分钟自动刷新，并将最近一次聚合摘要缓存在本机
- 只绑定 `127.0.0.1`，不需要账号、API Key 或网络请求
- 不保存、不返回提示词、回复、项目路径或凭据

## Windows 快速使用

需要 Windows 10/11 和 Node.js 20 或更新版本。双击：

```text
CodexTokenWidget.exe
```

悬浮窗会显示在桌面右上角，每 5 分钟自动刷新。点击顶部 `–` 可切换为只保留今日用量和缓存环的极简模式，双击极简卡片或点击 `+` 恢复完整视图。按住窗口顶部可拖动，`TOP` 可切换置顶；点击 `×` 会隐藏到系统托盘，双击托盘图标恢复，右键可刷新或彻底退出。

也可以在终端中运行：

```powershell
npm run widget
```

悬浮窗会在需要时静默启动本地统计服务，并在退出时结束自己启动的服务。数据不会离开电脑。

如果本地统计服务意外退出，悬浮窗会自动检测、重启并刷新数据，不需要手动重开程序。界面会显示具体的错误类型；完整诊断记录保存在：

```text
%LOCALAPPDATA%\CodexTokenWidget\widget.log
```

也可以右键系统托盘中的 Codex Token 图标，选择 **打开诊断日志**。日志达到 1 MB 后自动轮换，只保留当前文件和上一份日志。

## 可选网页仪表盘

项目仍保留完整网页看板，运行：

```powershell
npm start
```

再访问 `http://127.0.0.1:4817`。需要停止时双击 `stop-dashboard.cmd`。

## 数据口径

程序只读取以下本机目录中的 `token_count` 事件：

```text
%USERPROFILE%\.codex\sessions\**\rollout-*.jsonl
%USERPROFILE%\.codex\archived_sessions\*.jsonl
```

优先使用 `last_token_usage`（当前轮次增量）；旧日志只有 `total_token_usage` 时，按会话累计值求差，避免重复累计。缓存 Token 是输入 Token 的子集，因此总量使用日志中的 `total_tokens`，不会把缓存输入再次加到总量中。安装了 `rg`（ripgrep）时会启用高速扫描；否则自动回退为纯 Node.js 扫描。

统计是本机 Codex 记录口径，不等同于 API 账单或订阅额度。

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

## 参考项目

- [shanggqm/codexU](https://github.com/shanggqm/codexU) — Codex 本地 `token_count` 聚合与 Windows 数据源说明
- [xiufengsun/TokenTracker](https://github.com/xiufengsun/TokenTracker) — 本地优先的多工具 Token 仪表盘
- [douglasmonsky/codex-usage-tracker](https://github.com/douglasmonsky/codex-usage-tracker) — 本地会话用量数据与证据模型

## License

MIT

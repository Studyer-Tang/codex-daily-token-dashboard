using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        bool created;
        using (var mutex = new Mutex(true, "Local\\CodexDailyTokenWidgetNative", out created))
        using (var showSignal = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\CodexDailyTokenWidgetShow"))
        {
            if (!created)
            {
                showSignal.Set();
                return;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TokenWidgetForm(showSignal));
        }
    }
}

internal sealed partial class TokenWidgetForm : Form
{
    private const int Port = 4817;
    private readonly Color bg = Color.FromArgb(20, 22, 24);
    private readonly Color surface = Color.FromArgb(27, 30, 33);
    private readonly Color surfaceHigh = Color.FromArgb(35, 38, 42);
    private readonly Color border = Color.FromArgb(54, 58, 63);
    private readonly Color text = Color.FromArgb(235, 236, 237);
    private readonly Color secondary = Color.FromArgb(166, 170, 174);
    private readonly Color tertiary = Color.FromArgb(112, 117, 122);
    private readonly Color blue = Color.FromArgb(143, 175, 166);
    private readonly Color violet = Color.FromArgb(167, 160, 181);
    private readonly Color cyan = Color.FromArgb(143, 184, 171);
    private readonly Color amber = Color.FromArgb(196, 166, 106);
    private readonly NotifyIcon trayIcon;
    private readonly System.Windows.Forms.Timer refreshTimer;
    private readonly ToolTip toolTip;
    private readonly object logLock = new object();
    private readonly object recoveryLock = new object();
    private readonly RegisteredWaitHandle showRegistration;
    private Process ownedServer;
    private bool requestBusy;
    private bool recoveryBusy;
    private volatile bool allowExit;
    private bool shownTrayHint;
    private bool dataReady;
    private bool compactMode = true;
    private bool taskView;
    private bool taskRequestBusy;
    private int selectedTaskIndex = -1;
    private int taskScroll;
    private int turnScroll;
    private bool compactTaskMode;
    private string focusedTaskId = "";
    private string pendingFocusTaskId = "";
    private int focusedTurnIndex = -1;
    private ToolStripMenuItem compactMenuItem;
    private ToolStripMenuItem totalModeMenuItem;
    private ToolStripMenuItem taskModeMenuItem;
    private string statusText = "正在连接本地数据";
    private Color statusColor;
    private double todayTotal;
    private double yesterdayTotal;
    private double weekTotal;
    private double monthTotal;
    private double uncachedInput;
    private double cachedInput;
    private double output;
    private double[] dailyValues = new double[0];
    private string[] dailyLabels = new string[0];
    private List<UsageTask> usageTasks = new List<UsageTask>();
    private readonly string logPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "CodexTokenWidget",
        "widget.log"
    );

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    public TokenWidgetForm(EventWaitHandle showSignal)
    {
        Text = "Codex Token Widget";
        ClientSize = new Size(260, 68);
        FormBorderStyle = FormBorderStyle.None;
        BackColor = bg;
        TopMost = true;
        ShowInTaskbar = true;
        StartPosition = FormStartPosition.Manual;
        DoubleBuffered = true;
        Font = new Font("Microsoft YaHei UI", 9);
        statusColor = secondary;
        var work = Screen.PrimaryScreen.WorkingArea;
        Location = new Point(work.Right - Width - 24, work.Top + 24);
        UpdateWindowRegion();
        InitializeTaskSearch();

        var menu = new ContextMenuStrip();
        var showItem = menu.Items.Add("显示悬浮窗");
        var refreshItem = menu.Items.Add("刷新数据");
        var logItem = menu.Items.Add("打开诊断日志");
        compactMenuItem = (ToolStripMenuItem)menu.Items.Add("极简模式");
        compactMenuItem.Checked = compactMode;
        var displayMenu = (ToolStripMenuItem)menu.Items.Add("小窗显示");
        totalModeMenuItem = (ToolStripMenuItem)displayMenu.DropDownItems.Add("今日总用量");
        taskModeMenuItem = (ToolStripMenuItem)displayMenu.DropDownItems.Add("关注任务的轮次");
        totalModeMenuItem.Checked = true;
        taskModeMenuItem.Enabled = false;
        var topItem = (ToolStripMenuItem)menu.Items.Add("始终置顶");
        topItem.Checked = true;
        menu.Items.Add(new ToolStripSeparator());
        var exitItem = menu.Items.Add("退出");
        showItem.Click += delegate { ShowWidget(); };
        refreshItem.Click += delegate { RequestUsage(); ShowWidget(); };
        logItem.Click += delegate { OpenLog(); };
        compactMenuItem.Click += delegate { ToggleCompact(); };
        totalModeMenuItem.Click += delegate { SetCompactDisplay(false); };
        taskModeMenuItem.Click += delegate { SetCompactDisplay(true); };
        topItem.Click += delegate { TopMost = !TopMost; topItem.Checked = TopMost; Invalidate(); };
        exitItem.Click += delegate { allowExit = true; Close(); };
        trayIcon = new NotifyIcon
        {
            Icon = SystemIcons.Information,
            Text = "Codex Token 用量",
            ContextMenuStrip = menu,
            Visible = true
        };
        trayIcon.DoubleClick += delegate { ShowWidget(); };
        showRegistration = ThreadPool.RegisterWaitForSingleObject(
            showSignal,
            delegate(object state, bool timedOut)
            {
                if (allowExit || IsDisposed || !IsHandleCreated) return;
                try { BeginInvoke(new Action(ShowWidget)); } catch { }
            },
            null,
            Timeout.Infinite,
            false
        );

        toolTip = new ToolTip { InitialDelay = 350, ReshowDelay = 100, AutoPopDelay = 3000, BackColor = surfaceHigh, ForeColor = text };
        toolTip.SetToolTip(this, "拖动顶部移动 · 右上角可置顶或隐藏");
        refreshTimer = new System.Windows.Forms.Timer { Interval = 300000 };
        refreshTimer.Tick += delegate { RequestUsage(); };
        refreshTimer.Start();
        Shown += delegate { BeginRecovery("应用启动"); };
        FormClosing += OnFormClosing;
        FormClosed += OnFormClosed;
        Log("INFO", "悬浮窗启动");
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        SyncTaskSearchVisibility();
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
        using (var page = new SolidBrush(bg))
        using (var path = Rounded(ClientRectangle, compactMode ? 14 : 20)) g.FillPath(page, path);
        using (var outline = new Pen(border))
        using (var path = Rounded(new Rectangle(0, 0, Width - 1, Height - 1), compactMode ? 14 : 20)) g.DrawPath(outline, path);
        if (compactMode)
        {
            DrawCompact(g);
            return;
        }
        DrawHeader(g);
        if (taskView)
        {
            DrawTaskPanel(g);
            DrawFooter(g);
            return;
        }
        DrawHero(g);
        DrawSummary(g);
        DrawTrend(g);
        DrawComposition(g);
        DrawFooter(g);
    }

    private void DrawHeader(Graphics g)
    {
        var iconRect = new Rectangle(18, 16, 34, 34);
        FillRound(g, iconRect, 9, surfaceHigh);
        DrawCentered(g, "C", new Font("Segoe UI", 12, FontStyle.Bold), blue, iconRect);
        Draw(g, "Codex 用量", 64, 16, 10.5f, text, FontStyle.Bold);
        Draw(g, "仅本机统计", 64, 35, 7.2f, tertiary);
        var overviewRect = new Rectangle(165, 18, 38, 26);
        var tasksRect = new Rectangle(207, 18, 38, 26);
        FillRound(g, overviewRect, 8, taskView ? bg : surfaceHigh);
        FillRound(g, tasksRect, 8, taskView ? surfaceHigh : bg);
        DrawCentered(g, "概览", new Font("Microsoft YaHei UI", 6.5f, FontStyle.Bold), taskView ? tertiary : text, overviewRect);
        DrawCentered(g, "任务", new Font("Microsoft YaHei UI", 6.5f, FontStyle.Bold), taskView ? text : tertiary, tasksRect);
        var compactRect = new Rectangle(251, 17, 28, 28);
        FillRound(g, compactRect, 14, Color.FromArgb(20, 30, 49));
        DrawCentered(g, "–", new Font("Segoe UI", 12, FontStyle.Bold), secondary, compactRect);
        var topRect = new Rectangle(285, 17, 49, 28);
        FillRound(g, topRect, 14, TopMost ? Color.FromArgb(43, 53, 50) : surfaceHigh);
        DrawCentered(g, "TOP", new Font("Segoe UI", 7.5f, FontStyle.Bold), TopMost ? blue : tertiary, topRect);
        var closeRect = new Rectangle(340, 17, 28, 28);
        FillRound(g, closeRect, 14, Color.FromArgb(20, 30, 49));
        DrawCentered(g, "×", new Font("Segoe UI", 13), secondary, closeRect);
    }

    private void DrawCompact(Graphics g)
    {
        var focusedTask = FocusedTask();
        var focusedTurn = FocusedTurn(focusedTask);
        if (compactTaskMode && focusedTask != null && focusedTurn != null)
        {
            var taskName = focusedTask.Label + (String.IsNullOrWhiteSpace(focusedTask.Title) ? "" : " · " + focusedTask.Title);
            Draw(g, ShortMessage(taskName, 15), 12, 8, 6.2f, secondary);
            Draw(g, FormatTiny(focusedTurn.TotalTokens), 11, 26, 15.5f, text, FontStyle.Bold);
        }
        else
        {
            Draw(g, "今日总用量", 12, 8, 7f, secondary);
            Draw(g, dataReady ? FormatTiny(todayTotal) : "—", 11, 26, 15.5f, text, FontStyle.Bold);
        }
        using (var separator = new Pen(border)) g.DrawLine(separator, 96, 11, 96, 56);
        if (compactTaskMode && focusedTask != null && focusedTurn != null)
        {
            DrawCentered(g, "‹", new Font("Segoe UI", 10), secondary, new Rectangle(104, 9, 22, 22));
            DrawCentered(g, (focusedTurnIndex + 1) + " / " + focusedTask.Turns.Count, new Font("Segoe UI", 6.7f, FontStyle.Bold), text, new Rectangle(126, 9, 60, 22));
            DrawCentered(g, "›", new Font("Segoe UI", 10), secondary, new Rectangle(186, 9, 22, 22));
            Draw(g, ShortMessage(String.IsNullOrWhiteSpace(focusedTurn.Prompt) ? "未记录提示词" : focusedTurn.Prompt, 14), 106, 35, 5.8f, tertiary);
        }
        else
        {
            using (var dot = new SolidBrush(statusColor)) g.FillEllipse(dot, 108, 22, 5, 5);
            Draw(g, CompactStatusText(), 119, 13, 6.9f, statusColor);
            Draw(g, focusedTask == null ? "本地 · 5 分钟刷新" : "点击左侧切换任务", 108, 35, 6.2f, tertiary);
        }

        var expandRect = new Rectangle(212, 10, 20, 20);
        FillRound(g, expandRect, 7, surfaceHigh);
        DrawCentered(g, "+", new Font("Segoe UI", 9.5f), secondary, expandRect);
        var closeRect = new Rectangle(238, 10, 14, 20);
        DrawCentered(g, "×", new Font("Segoe UI", 9.5f), tertiary, closeRect);
    }

    private string CompactStatusText()
    {
        if (statusText.StartsWith("已同步")) return statusText;
        if (statusText.Contains("恢复")) return "正在恢复";
        if (statusText.Contains("读取") || statusText.Contains("启动") || statusText.Contains("连接")) return "同步中";
        if (statusText.Contains("失败") || statusText.Contains("错误") || statusText.Contains("超时")) return "连接异常";
        return statusText.Length > 10 ? statusText.Substring(0, 9) + "…" : statusText;
    }

    private void DrawHero(Graphics g)
    {
        var card = new Rectangle(18, 66, 346, 132);
        FillRound(g, card, 18, surface);
        using (var cardBorder = new Pen(border))
        using (var path = Rounded(card, 18)) g.DrawPath(cardBorder, path);
        Draw(g, "今日 Token", 35, 83, 8.5f, secondary, FontStyle.Bold);
        Draw(g, dataReady ? FormatCompact(todayTotal) : "—", 34, 105, 27, text, FontStyle.Bold);
        Draw(g, dataReady ? FormatNumber(todayTotal) + " tokens" : "正在汇总本地会话", 36, 151, 8, tertiary);
        if (dataReady && yesterdayTotal > 0)
        {
            var change = ((todayTotal - yesterdayTotal) / yesterdayTotal) * 100;
            var pill = new Rectangle(35, 172, 108, 18);
            FillRound(g, pill, 9, change <= 0 ? Color.FromArgb(24, 69, 65) : Color.FromArgb(72, 38, 57));
            DrawCentered(g, (change > 0 ? "↑ " : "↓ ") + Math.Abs(change).ToString("0") + "%  较昨日", new Font("Microsoft YaHei UI", 7.3f, FontStyle.Bold), change <= 0 ? cyan : Color.FromArgb(251, 113, 133), pill);
        }
        var ring = new Rectangle(273, 87, 70, 70);
        using (var track = new Pen(Color.FromArgb(40, 55, 78), 8)) g.DrawEllipse(track, ring);
        if (dataReady)
        {
            var mix = Math.Max(1, uncachedInput + cachedInput + output);
            var start = -90f;
            var portions = new[] { uncachedInput / mix, cachedInput / mix, output / mix };
            var colors = new[] { blue, violet, cyan };
            for (var i = 0; i < portions.Length; i++)
            {
                var sweep = (float)(portions[i] * 360.0);
                if (sweep > 1) using (var pen = new Pen(colors[i], 8)) { pen.StartCap = LineCap.Round; pen.EndCap = LineCap.Round; g.DrawArc(pen, ring, start, Math.Max(1, sweep - 3)); }
                start += sweep;
            }
            var cachedPercent = cachedInput / mix * 100;
            DrawCentered(g, cachedPercent.ToString("0") + "%", new Font("Segoe UI", 10, FontStyle.Bold), text, new Rectangle(273, 104, 70, 22));
            DrawCentered(g, "缓存", new Font("Microsoft YaHei UI", 7), tertiary, new Rectangle(273, 124, 70, 18));
        }
    }

    private void DrawSummary(Graphics g)
    {
        DrawMetricCard(g, new Rectangle(18, 212, 168, 68), "最近 7 天", weekTotal, blue, "日均 " + FormatCompact(weekTotal / 7));
        DrawMetricCard(g, new Rectangle(196, 212, 168, 68), "最近 30 天", monthTotal, violet, "日均 " + FormatCompact(monthTotal / 30));
    }

    private void DrawMetricCard(Graphics g, Rectangle rect, string label, double value, Color accent, string note)
    {
        FillRound(g, rect, 16, surface);
        using (var p = new Pen(border)) using (var path = Rounded(rect, 16)) g.DrawPath(p, path);
        FillRound(g, new Rectangle(rect.X + 14, rect.Y + 14, 4, 22), 2, accent);
        Draw(g, label, rect.X + 28, rect.Y + 11, 7.5f, secondary, FontStyle.Bold);
        Draw(g, dataReady ? FormatCompact(value) : "—", rect.X + 28, rect.Y + 29, 14, text, FontStyle.Bold);
        DrawRight(g, dataReady ? note : "等待数据", rect.Right - 12, rect.Y + 13, 6.3f, tertiary);
    }

    private void DrawTrend(Graphics g)
    {
        var card = new Rectangle(18, 294, 346, 140);
        FillRound(g, card, 18, surface);
        using (var p = new Pen(border)) using (var path = Rounded(card, 18)) g.DrawPath(p, path);
        Draw(g, "最近 7 日趋势", 34, 311, 8.5f, secondary, FontStyle.Bold);
        DrawRight(g, "每日 Token", 347, 311, 7, tertiary);
        if (!dataReady || dailyValues.Length == 0) return;
        var maximum = 1.0;
        foreach (var value in dailyValues) maximum = Math.Max(maximum, value);
        var chartTop = 341;
        var chartHeight = 62;
        for (var i = 0; i < dailyValues.Length; i++)
        {
            var x = 39 + i * 45;
            var height = Math.Max(4, (int)Math.Round(dailyValues[i] / maximum * chartHeight));
            FillRound(g, new Rectangle(x, chartTop, 22, chartHeight), 8, Color.FromArgb(25, 37, 58));
            var bar = new Rectangle(x, chartTop + chartHeight - height, 22, height);
            FillRound(g, bar, 8, blue);
            DrawCentered(g, dailyLabels.Length > i ? dailyLabels[i] : "", new Font("Microsoft YaHei UI", 6.5f), i == dailyValues.Length - 1 ? blue : tertiary, new Rectangle(x - 5, 408, 32, 16));
        }
    }

    private void DrawComposition(Graphics g)
    {
        var card = new Rectangle(18, 446, 346, 66);
        FillRound(g, card, 16, surface);
        using (var p = new Pen(border)) using (var path = Rounded(card, 16)) g.DrawPath(p, path);
        Draw(g, "今日构成", 34, 460, 8, secondary, FontStyle.Bold);
        var total = Math.Max(1, uncachedInput + cachedInput + output);
        var barRect = new Rectangle(34, 483, 314, 8);
        FillRound(g, barRect, 4, Color.FromArgb(31, 43, 64));
        if (dataReady)
        {
            var x = barRect.X;
            var items = new[] { uncachedInput, cachedInput, output };
            var colors = new[] { blue, violet, cyan };
            for (var i = 0; i < items.Length; i++)
            {
                var width = i == items.Length - 1 ? barRect.Right - x : (int)Math.Round(items[i] / total * barRect.Width);
                if (width > 0) { FillRound(g, new Rectangle(x, barRect.Y, width, barRect.Height), 4, colors[i]); x += width; }
            }
        }
        DrawLegend(g, 34, 496, blue, "输入 " + FormatCompact(uncachedInput));
        DrawLegend(g, 145, 496, violet, "缓存 " + FormatCompact(cachedInput));
        DrawLegend(g, 258, 496, cyan, "输出 " + FormatCompact(output));
    }

    private void DrawTaskPanel(Graphics g)
    {
        if (selectedTaskIndex >= 0 && selectedTaskIndex < usageTasks.Count)
            DrawTaskDetail(g, usageTasks[selectedTaskIndex]);
        else
            DrawTaskList(g);
    }

    private void DrawTaskList(Graphics g)
    {
        Draw(g, String.IsNullOrWhiteSpace(TaskSearchQuery) ? "任务用量排行" : "搜索结果", 18, 68, 10.5f, text, FontStyle.Bold);
        var totalTurns = 0;
        foreach (var task in usageTasks) totalTurns += task.TurnCount;
        Draw(g, usageTasks.Count + " 个任务 · " + totalTurns + " 轮", 18, 96, 7, tertiary);
        var visible = 7;
        var end = Math.Min(usageTasks.Count, taskScroll + visible);
        DrawRight(g, usageTasks.Count > visible ? (taskScroll + 1) + "–" + end + " / " + usageTasks.Count + " · 滚轮浏览" : "点击查看每轮明细", 364, 96, 6.2f, tertiary);
        if (!dataReady)
        {
            DrawCentered(g, "正在读取本地任务记录", new Font("Microsoft YaHei UI", 8), secondary, new Rectangle(18, 190, 346, 80));
            return;
        }
        if (usageTasks.Count == 0)
        {
            DrawCentered(g, "当前范围内没有任务记录", new Font("Microsoft YaHei UI", 8), secondary, new Rectangle(18, 190, 346, 80));
            return;
        }
        var maximum = Math.Max(1, usageTasks[0].TotalTokens);
        taskScroll = Math.Max(0, Math.Min(taskScroll, Math.Max(0, usageTasks.Count - visible)));
        for (var slot = 0; slot < visible; slot++)
        {
            var index = taskScroll + slot;
            if (index >= usageTasks.Count) break;
            var task = usageTasks[index];
            var rect = new Rectangle(18, 121 + slot * 56, 346, 50);
            FillRound(g, rect, 11, surface);
            using (var p = new Pen(border)) using (var path = Rounded(rect, 11)) g.DrawPath(p, path);
            DrawCentered(g, (index + 1).ToString("00"), new Font("Segoe UI", 6.5f), tertiary, new Rectangle(rect.X + 4, rect.Y, 28, rect.Height));
            Draw(g, ShortMessage(TaskDisplayName(task), 24), rect.X + 36, rect.Y + 7, 8, text, FontStyle.Bold);
            Draw(g, task.TurnCount + " 轮 · " + FormatActivity(task.LastActivity), rect.X + 36, rect.Y + 25, 6.2f, tertiary);
            DrawRight(g, FormatCompact(task.TotalTokens), rect.Right - 13, rect.Y + 8, 8.5f, text);
            var bar = new Rectangle(rect.X + 36, rect.Bottom - 8, 210, 3);
            FillRound(g, bar, 2, surfaceHigh);
            var width = Math.Max(2, (int)Math.Round(task.TotalTokens / maximum * bar.Width));
            FillRound(g, new Rectangle(bar.X, bar.Y, width, bar.Height), 2, blue);
            DrawRight(g, "›", rect.Right - 12, rect.Y + 27, 8, tertiary);
        }
    }

    private void DrawTaskDetail(Graphics g, UsageTask task)
    {
        var back = new Rectangle(18, 67, 34, 25);
        FillRound(g, back, 8, surfaceHigh);
        DrawCentered(g, "‹", new Font("Segoe UI", 12), secondary, back);
        Draw(g, ShortMessage(TaskDisplayName(task), 22), 61, 68, 10, text, FontStyle.Bold);
        Draw(g, task.TurnCount + " 轮 · " + FormatActivity(task.LastActivity), 61, 88, 6.5f, tertiary);
        var focusRect = new Rectangle(286, 67, 78, 25);
        var isFocused = focusedTaskId == task.Id && compactTaskMode;
        FillRound(g, focusRect, 8, isFocused ? Color.FromArgb(43, 53, 50) : surfaceHigh);
        DrawCentered(g, isFocused ? "小窗显示中" : "小窗关注", new Font("Microsoft YaHei UI", 6.3f, FontStyle.Bold), isFocused ? blue : secondary, focusRect);
        if (task.DetailsLoaded && task.Turns.Count > 6)
            DrawRight(g, (turnScroll + 1) + "–" + Math.Min(task.Turns.Count, turnScroll + 6) + " / " + task.Turns.Count, 278, 88, 6.2f, tertiary);

        var summary = new Rectangle(18, 105, 346, 52);
        FillRound(g, summary, 11, surface);
        using (var p = new Pen(border)) using (var path = Rounded(summary, 11)) g.DrawPath(p, path);
        Draw(g, "总量", 32, 115, 6.5f, tertiary);
        Draw(g, FormatCompact(task.TotalTokens), 31, 130, 10, text, FontStyle.Bold);
        Draw(g, "输入 " + FormatCompact(task.InputTokens), 143, 117, 6.5f, secondary);
        Draw(g, "缓存 " + FormatCompact(task.CachedInputTokens), 143, 135, 6.5f, secondary);
        Draw(g, "输出 " + FormatCompact(task.OutputTokens), 260, 126, 6.5f, secondary);

        if (task.DetailsLoading)
        {
            DrawCentered(g, "正在读取每轮用量…", new Font("Microsoft YaHei UI", 8), secondary, new Rectangle(18, 220, 346, 80));
            return;
        }
        if (!String.IsNullOrWhiteSpace(task.DetailError))
        {
            DrawCentered(g, task.DetailError + "\n点击此处重试", new Font("Microsoft YaHei UI", 8), Color.FromArgb(251, 113, 133), new Rectangle(18, 220, 346, 80));
            return;
        }
        if (!task.DetailsLoaded || task.Turns.Count == 0)
        {
            DrawCentered(g, task.DetailsLoaded ? "没有可显示的轮次" : "点击任务后读取轮次", new Font("Microsoft YaHei UI", 8), secondary, new Rectangle(18, 220, 346, 80));
            return;
        }
        var visible = 6;
        turnScroll = Math.Max(0, Math.Min(turnScroll, Math.Max(0, task.Turns.Count - visible)));
        for (var slot = 0; slot < visible; slot++)
        {
            var index = turnScroll + slot;
            if (index >= task.Turns.Count) break;
            var turn = task.Turns[index];
            var y = 166 + slot * 57;
            var rect = new Rectangle(18, y, 346, 51);
            FillRound(g, rect, 9, index % 2 == 0 ? surface : bg);
            Draw(g, turn.Identified ? "第 " + turn.Number + " 轮" : "未标记轮次", rect.X + 12, rect.Y + 4, 7.2f, text, FontStyle.Bold);
            DrawRight(g, FormatCompact(turn.TotalTokens), rect.Right - 12, rect.Y + 4, 8, text);
            Draw(g, ShortMessage(String.IsNullOrWhiteSpace(turn.Prompt) ? "未记录提示词" : turn.Prompt, 35), rect.X + 12, rect.Y + 19, 5.9f, secondary);
            Draw(g, FormatActivity(turn.Timestamp), rect.X + 12, rect.Y + 35, 5.6f, tertiary);
            DrawRight(g, "输入 " + FormatTiny(turn.InputTokens) + " · 缓存 " + FormatTiny(turn.CachedInputTokens) + " · 输出 " + FormatTiny(turn.OutputTokens), rect.Right - 12, rect.Y + 35, 5.4f, tertiary);
        }
    }

    private void DrawLegend(Graphics g, int x, int y, Color color, string value)
    {
        using (var brush = new SolidBrush(color)) g.FillEllipse(brush, x, y + 4, 6, 6);
        Draw(g, dataReady ? value : "—", x + 11, y, 6.6f, secondary);
    }

    private void DrawFooter(Graphics g)
    {
        using (var brush = new SolidBrush(statusColor)) g.FillEllipse(brush, 22, 534, 6, 6);
        Draw(g, statusText, 34, 527, 7, statusColor);
        var refresh = new Rectangle(310, 521, 54, 25);
        FillRound(g, refresh, 12, surfaceHigh);
        DrawCentered(g, "刷新", new Font("Microsoft YaHei UI", 7, FontStyle.Bold), secondary, refresh);
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button != MouseButtons.Left) return;
        if (compactMode)
        {
            if (new Rectangle(234, 6, 24, 28).Contains(e.Location)) { HideToTray(); return; }
            if (new Rectangle(208, 6, 26, 28).Contains(e.Location)) { ToggleCompact(); return; }
            if (compactTaskMode && new Rectangle(100, 6, 28, 30).Contains(e.Location)) { ShiftFocusedTurn(-1); return; }
            if (compactTaskMode && new Rectangle(184, 6, 26, 30).Contains(e.Location)) { ShiftFocusedTurn(1); return; }
            if (new Rectangle(4, 4, 94, 60).Contains(e.Location) && FocusedTask() != null) { SetCompactDisplay(!compactTaskMode); return; }
            ReleaseCapture();
            SendMessage(Handle, 0xA1, new IntPtr(2), IntPtr.Zero);
            return;
        }
        if (new Rectangle(340, 17, 28, 28).Contains(e.Location)) { HideToTray(); return; }
        if (new Rectangle(251, 17, 28, 28).Contains(e.Location)) { ToggleCompact(); return; }
        if (new Rectangle(285, 17, 49, 28).Contains(e.Location)) { TopMost = !TopMost; Invalidate(); return; }
        if (new Rectangle(165, 18, 38, 26).Contains(e.Location)) { taskView = false; selectedTaskIndex = -1; Invalidate(); return; }
        if (new Rectangle(207, 18, 38, 26).Contains(e.Location)) { taskView = true; selectedTaskIndex = -1; Invalidate(); return; }
        if (new Rectangle(310, 521, 54, 25).Contains(e.Location)) { RequestUsage(); return; }
        if (taskView)
        {
            if (selectedTaskIndex >= 0)
            {
                var selected = selectedTaskIndex < usageTasks.Count ? usageTasks[selectedTaskIndex] : null;
                if (new Rectangle(286, 67, 78, 25).Contains(e.Location) && selected != null)
                {
                    if (selected.DetailsLoaded) FocusTaskInCompact(selected);
                    else { pendingFocusTaskId = selected.Id; RequestTaskDetails(selected); }
                    return;
                }
                if (new Rectangle(18, 67, 34, 25).Contains(e.Location))
                {
                    selectedTaskIndex = -1;
                    turnScroll = 0;
                    Invalidate();
                    return;
                }
                if (selected != null && !selected.DetailsLoading && (!selected.DetailsLoaded || !String.IsNullOrWhiteSpace(selected.DetailError)) && new Rectangle(18, 170, 346, 250).Contains(e.Location))
                {
                    RequestTaskDetails(selected);
                    return;
                }
            }
            else if (e.Y >= 121 && e.Y < 513)
            {
                var slot = (e.Y - 121) / 56;
                var index = taskScroll + slot;
                var rowTop = 121 + slot * 56;
                if (slot >= 0 && slot < 7 && index < usageTasks.Count && new Rectangle(18, rowTop, 346, 50).Contains(e.Location))
                {
                    selectedTaskIndex = index;
                    turnScroll = 0;
                    Invalidate();
                    RequestTaskDetails(usageTasks[index]);
                    return;
                }
            }
        }
        if (e.Y < 58) { ReleaseCapture(); SendMessage(Handle, 0xA1, new IntPtr(2), IntPtr.Zero); }
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        var active = compactMode
            ? new Rectangle(208, 6, 50, 28).Contains(e.Location) ||
                (FocusedTask() != null && new Rectangle(4, 4, 94, 60).Contains(e.Location)) ||
                (compactTaskMode && new Rectangle(100, 6, 110, 30).Contains(e.Location))
            : new Rectangle(165, 17, 203, 28).Contains(e.Location) || new Rectangle(310, 521, 54, 25).Contains(e.Location) ||
                (taskView && selectedTaskIndex < 0 && e.Y >= 121 && e.Y < 513) ||
                (taskView && selectedTaskIndex >= 0 && (new Rectangle(18, 67, 34, 25).Contains(e.Location) || new Rectangle(286, 67, 78, 25).Contains(e.Location)));
        Cursor = active ? Cursors.Hand : (e.Y < 58 ? Cursors.SizeAll : Cursors.Default);
    }

    protected override void OnMouseWheel(MouseEventArgs e)
    {
        base.OnMouseWheel(e);
        if (compactMode)
        {
            if (compactTaskMode) ShiftFocusedTurn(e.Delta > 0 ? -1 : 1);
            return;
        }
        if (!taskView) return;
        var direction = e.Delta > 0 ? -3 : 3;
        if (selectedTaskIndex >= 0 && selectedTaskIndex < usageTasks.Count)
        {
            var task = usageTasks[selectedTaskIndex];
            turnScroll = Math.Max(0, Math.Min(Math.Max(0, task.Turns.Count - 6), turnScroll + direction));
        }
        else
        {
            taskScroll = Math.Max(0, Math.Min(Math.Max(0, usageTasks.Count - 7), taskScroll + direction));
        }
        Invalidate();
    }

    protected override void OnMouseDoubleClick(MouseEventArgs e)
    {
        base.OnMouseDoubleClick(e);
        if (compactMode && e.Button == MouseButtons.Left) ToggleCompact();
    }

    protected override void WndProc(ref Message m)
    {
        base.WndProc(ref m);
        if (m.Msg == 0x0232) SnapToEdge();
    }

    private void SnapToEdge()
    {
        var work = Screen.FromControl(this).WorkingArea;
        var x = Left;
        var y = Top;
        if (Math.Abs(Left - work.Left) < 24) x = work.Left + 8;
        if (Math.Abs(Right - work.Right) < 24) x = work.Right - Width - 8;
        if (Math.Abs(Top - work.Top) < 24) y = work.Top + 8;
        if (Math.Abs(Bottom - work.Bottom) < 24) y = work.Bottom - Height - 8;
        Location = new Point(x, y);
    }

    private void ToggleCompact()
    {
        var right = Right;
        var top = Top;
        compactMode = !compactMode;
        compactMenuItem.Checked = compactMode;
        ClientSize = compactMode ? new Size(260, 68) : new Size(382, 558);
        Location = new Point(right - Width, top);
        UpdateWindowRegion();
        Invalidate();
    }

    private bool StartUsageService()
    {
        if (ServiceHealthy()) return true;
        try
        {
            if (ownedServer != null)
            {
                if (!ownedServer.HasExited) return true;
                ownedServer.Dispose();
                ownedServer = null;
            }
            var root = AppDomain.CurrentDomain.BaseDirectory;
            var bundledNode = Path.Combine(root, "runtime", "node.exe");
            var startInfo = new ProcessStartInfo
            {
                FileName = File.Exists(bundledNode) ? bundledNode : "node.exe",
                Arguments = "\"" + Path.Combine(root, "server.mjs") + "\"",
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            startInfo.EnvironmentVariables["CODEX_TOKEN_PARENT_PID"] = Process.GetCurrentProcess().Id.ToString();
            var serverProcess = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            ownedServer = serverProcess;
            serverProcess.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args)
            {
                if (!String.IsNullOrWhiteSpace(args.Data)) Log("SERVER", args.Data);
            };
            serverProcess.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args)
            {
                if (!String.IsNullOrWhiteSpace(args.Data)) Log("SERVER-ERROR", args.Data);
            };
            serverProcess.Exited += delegate(object sender, EventArgs args)
            {
                var exitCode = "unknown";
                try { exitCode = serverProcess.ExitCode.ToString(); } catch { }
                Log("WARN", "本地统计服务退出，exitCode=" + exitCode);
                if (allowExit || IsDisposed || !IsHandleCreated) return;
                try { BeginInvoke(new Action(delegate { BeginRecovery("统计服务意外退出"); })); } catch { }
            };
            if (!serverProcess.Start()) throw new InvalidOperationException("Node.js 进程未能启动");
            serverProcess.BeginOutputReadLine();
            serverProcess.BeginErrorReadLine();
            Log("INFO", "已启动本地统计服务，pid=" + serverProcess.Id);
            return true;
        }
        catch (Exception error)
        {
            LogError("启动本地统计服务失败", error);
            return false;
        }
    }

    private void BeginRecovery(string reason)
    {
        lock (recoveryLock)
        {
            if (recoveryBusy || allowExit || IsDisposed) return;
            recoveryBusy = true;
        }
        SetStatus(
            reason == "应用启动" ? "正在启动本地统计服务" : reason + " · 正在自动恢复",
            amber
        );
        Log("WARN", "开始自动恢复：" + reason);
        ThreadPool.QueueUserWorkItem(delegate
        {
            Exception lastError = null;
            for (var attempt = 1; attempt <= 3 && !allowExit; attempt++)
            {
                try
                {
                    Log("INFO", "自动恢复第 " + attempt + " 次尝试");
                    if (!StartUsageService()) throw new InvalidOperationException("无法启动 Node.js 本地服务");
                    for (var check = 0; check < 24 && !allowExit; check++)
                    {
                        if (ServiceHealthy())
                        {
                            // A widget replacement can briefly see the previous widget's service
                            // before that service notices its parent exited. Verify an unowned
                            // startup service is stable so the new widget can take over if needed.
                            if (reason == "应用启动" && ownedServer == null)
                            {
                                Thread.Sleep(2500);
                                if (!ServiceHealthy())
                                    throw new WebException("检测到旧统计服务已退出，正在接管");
                            }
                            Log("INFO", "本地统计服务已恢复");
                            BeginInvoke(new Action(delegate
                            {
                                lock (recoveryLock) recoveryBusy = false;
                                SetStatus("服务已恢复 · 正在刷新", cyan);
                                RequestUsage();
                            }));
                            return;
                        }
                        Thread.Sleep(250);
                    }
                    throw new TimeoutException("本地服务启动后 6 秒内未通过健康检查");
                }
                catch (Exception error)
                {
                    lastError = error;
                    LogError("自动恢复第 " + attempt + " 次失败", error);
                    StopOwnedServer();
                    Thread.Sleep(attempt * 500);
                }
            }
            if (allowExit) return;
            try
            {
                BeginInvoke(new Action(delegate
                {
                    lock (recoveryLock) recoveryBusy = false;
                    var detail = DescribeError(lastError);
                    SetStatus(detail + " · 自动恢复失败", Color.FromArgb(251, 113, 133));
                    toolTip.SetToolTip(this, "错误详情：" + detail + "\n右键托盘图标可打开诊断日志");
                }));
            }
            catch { }
        });
    }

    private void StopOwnedServer()
    {
        if (ownedServer == null) return;
        try { if (!ownedServer.HasExited) ownedServer.Kill(); } catch { }
        try { ownedServer.Dispose(); } catch { }
        ownedServer = null;
    }

    private bool ServiceHealthy()
    {
        try
        {
            var request = WebRequest.Create("http://127.0.0.1:" + Port + "/api/health");
            request.Timeout = 1500;
            using (var response = request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                return reader.ReadToEnd().Contains("codex-daily-token-dashboard");
        }
        catch { return false; }
    }

    private void RequestUsage()
    {
        if (requestBusy) return;
        requestBusy = true;
        SetStatus("正在读取本地记录", amber);
        var client = new WebClient { Encoding = System.Text.Encoding.UTF8 };
        var timedOut = 0;
        var timeoutTimer = new System.Threading.Timer(
            delegate(object state)
            {
                Interlocked.Exchange(ref timedOut, 1);
                try { client.CancelAsync(); } catch { }
            },
            null,
            50000,
            Timeout.Infinite
        );
        client.DownloadStringCompleted += delegate(object sender, DownloadStringCompletedEventArgs args)
        {
            Exception failure = null;
            try
            {
                if (args.Cancelled && Interlocked.CompareExchange(ref timedOut, 0, 0) == 1)
                    throw new TimeoutException("读取用量请求超过 50 秒");
                if (args.Cancelled) throw new WebException("用量请求已取消");
                if (args.Error != null) throw args.Error;
                RenderUsage(DeserializePayload(args.Result));
            }
            catch (Exception error) { failure = error; }
            finally { requestBusy = false; timeoutTimer.Dispose(); client.Dispose(); }
            if (failure != null)
            {
                var detail = DescribeError(failure);
                SetStatus(detail + " · 正在自动恢复", Color.FromArgb(251, 113, 133));
                toolTip.SetToolTip(this, "错误详情：" + detail + "\n正在自动检测并恢复本地服务");
                LogError("读取用量失败", failure);
                BeginRecovery(detail);
            }
        };
        var url = "http://127.0.0.1:" + Port + "/api/usage?days=30&taskDetail=summary" + TaskSearchParameter();
        client.DownloadStringAsync(new Uri(url));
    }

    private void RequestTaskDetails(UsageTask task)
    {
        if (task == null || taskRequestBusy || task.DetailsLoading) return;
        if (task.DetailsLoaded && String.IsNullOrWhiteSpace(task.DetailError)) return;
        taskRequestBusy = true;
        task.DetailsLoading = true;
        task.DetailError = "";
        Invalidate();
        var client = new WebClient { Encoding = Encoding.UTF8 };
        var timedOut = 0;
        var timeoutTimer = new System.Threading.Timer(
            delegate(object state)
            {
                Interlocked.Exchange(ref timedOut, 1);
                try { client.CancelAsync(); } catch { }
            },
            null,
            50000,
            Timeout.Infinite
        );
        client.DownloadStringCompleted += delegate(object sender, DownloadStringCompletedEventArgs args)
        {
            Exception failure = null;
            try
            {
                if (args.Cancelled && Interlocked.CompareExchange(ref timedOut, 0, 0) == 1)
                    throw new TimeoutException("读取任务轮次超过 50 秒");
                if (args.Cancelled) throw new WebException("任务轮次请求已取消");
                if (args.Error != null) throw args.Error;
                var data = DeserializePayload(args.Result);
                var items = data != null && data.ContainsKey("tasks") ? data["tasks"] as object[] : null;
                if (items == null || items.Length == 0) throw new InvalidDataException("未找到任务轮次");
                var detail = ParseUsageTask(Dict(items[0]), false);
                task.Turns = detail.Turns;
                task.TurnCount = detail.TurnCount;
                if (!String.IsNullOrWhiteSpace(detail.Title)) task.Title = detail.Title;
                task.DetailsLoaded = true;
                if (pendingFocusTaskId == task.Id)
                {
                    pendingFocusTaskId = "";
                    FocusTaskInCompact(task);
                }
                Log("INFO", "任务轮次读取成功：" + task.Id);
            }
            catch (Exception error) { failure = error; }
            finally
            {
                task.DetailsLoading = false;
                taskRequestBusy = false;
                timeoutTimer.Dispose();
                client.Dispose();
            }
            if (failure != null)
            {
                task.DetailError = ShortMessage(DescribeError(failure), 30);
                LogError("读取任务轮次失败", failure);
            }
            Invalidate();
        };
        var url = "http://127.0.0.1:" + Port + "/api/usage?days=30&task=" + Uri.EscapeDataString(task.Id);
        client.DownloadStringAsync(new Uri(url));
    }

    private static Dictionary<string, object> DeserializePayload(string json)
    {
        var serializer = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024, RecursionLimit = 128 };
        return serializer.DeserializeObject(json) as Dictionary<string, object>;
    }

    private string DescribeError(Exception error)
    {
        if (error == null) return "未知错误";
        var webError = error as WebException;
        if (webError != null)
        {
            if (webError.Status == WebExceptionStatus.ConnectFailure) return "无法连接本地统计服务";
            if (webError.Status == WebExceptionStatus.Timeout) return "读取本地日志超时";
            if (webError.Status == WebExceptionStatus.ConnectionClosed) return "本地服务连接意外关闭";
            if (webError.Status == WebExceptionStatus.ProtocolError)
            {
                var response = webError.Response as HttpWebResponse;
                if (response == null) return "本地服务返回协议错误";
                var prefix = "本地服务返回 HTTP " + (int)response.StatusCode;
                try
                {
                    using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                    {
                        var payload = new JavaScriptSerializer().DeserializeObject(reader.ReadToEnd()) as Dictionary<string, object>;
                        var detail = payload != null && payload.ContainsKey("detail")
                            ? Convert.ToString(payload["detail"])
                            : payload != null && payload.ContainsKey("error") ? Convert.ToString(payload["error"]) : "";
                        return String.IsNullOrWhiteSpace(detail) ? prefix : prefix + "：" + ShortMessage(detail, 34);
                    }
                }
                catch { return prefix; }
            }
        }
        if (error is InvalidDataException || error is KeyNotFoundException) return "返回的用量数据格式异常";
        if (error is TimeoutException) return ShortMessage(error.Message, 48);
        return ShortMessage(error.Message ?? error.GetType().Name, 48);
    }

    private static string ShortMessage(string value, int maximum)
    {
        var message = (value ?? "").Replace("\r", " ").Replace("\n", " ").Trim();
        return message.Length > maximum ? message.Substring(0, maximum - 1) + "…" : message;
    }

    private string RedactLogText(string value)
    {
        var result = value ?? "";
        var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var appDirectory = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        if (!String.IsNullOrWhiteSpace(appDirectory))
            result = Regex.Replace(result, Regex.Escape(appDirectory), "%APPDIR%", RegexOptions.IgnoreCase);
        if (!String.IsNullOrWhiteSpace(userProfile))
            result = Regex.Replace(result, Regex.Escape(userProfile), "%USERPROFILE%", RegexOptions.IgnoreCase);
        return result;
    }

    private void LogError(string context, Exception error)
    {
        Log("ERROR", context + Environment.NewLine + (error == null ? "未知错误" : error.ToString()));
    }

    private void Log(string level, string message)
    {
        try
        {
            lock (logLock)
            {
                var directory = Path.GetDirectoryName(logPath);
                Directory.CreateDirectory(directory);
                if (File.Exists(logPath) && new FileInfo(logPath).Length > 1024 * 1024)
                {
                    var previous = logPath + ".1";
                    if (File.Exists(previous)) File.Delete(previous);
                    File.Move(logPath, previous);
                }
                File.AppendAllText(
                    logPath,
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " [" + level + "] " + RedactLogText(message) + Environment.NewLine
                );
            }
        }
        catch { }
    }

    private void OpenLog()
    {
        Log("INFO", "用户打开诊断日志");
        try
        {
            Process.Start(new ProcessStartInfo { FileName = logPath, UseShellExecute = true });
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message + "\n\n日志位置：" + logPath, "无法打开诊断日志");
        }
    }

    private void RenderUsage(Dictionary<string, object> data)
    {
        if (data == null) throw new InvalidDataException("无用量数据");
        var today = Dict(data["today"]);
        var yesterday = Dict(data["yesterday"]);
        todayTotal = Number(today["totalTokens"]);
        yesterdayTotal = Number(yesterday["totalTokens"]);
        weekTotal = Number(Dict(data["last7"])["totalTokens"]);
        monthTotal = Number(Dict(data["last30"])["totalTokens"]);
        uncachedInput = Number(today["uncachedInputTokens"]);
        cachedInput = Number(today["cachedInputTokens"]);
        output = Number(today["outputTokens"]);
        var days = data["days"] as object[];
        var values = new List<double>();
        var labels = new List<string>();
        var dayNames = new[] { "日", "一", "二", "三", "四", "五", "六" };
        if (days != null)
        {
            for (var i = Math.Max(0, days.Length - 7); i < days.Length; i++)
            {
                var item = Dict(days[i]);
                values.Add(Number(item["totalTokens"]));
                DateTime date;
                labels.Add(DateTime.TryParse(Convert.ToString(item["day"]), out date) ? dayNames[(int)date.DayOfWeek] : "");
            }
        }
        dailyValues = values.ToArray();
        dailyLabels = labels.ToArray();
        var selectedId = selectedTaskIndex >= 0 && selectedTaskIndex < usageTasks.Count ? usageTasks[selectedTaskIndex].Id : "";
        var previous = new Dictionary<string, UsageTask>();
        foreach (var existing in usageTasks) if (!String.IsNullOrWhiteSpace(existing.Id)) previous[existing.Id] = existing;
        var parsedTasks = new List<UsageTask>();
        var rawTasks = data.ContainsKey("tasks") ? data["tasks"] as object[] : null;
        if (rawTasks != null)
        {
            foreach (var rawTask in rawTasks)
            {
                var parsed = ParseUsageTask(Dict(rawTask), true);
                UsageTask existing;
                if (previous.TryGetValue(parsed.Id, out existing))
                {
                    existing.Label = parsed.Label;
                    existing.Title = parsed.Title;
                    existing.LastActivity = parsed.LastActivity;
                    existing.TotalTokens = parsed.TotalTokens;
                    existing.InputTokens = parsed.InputTokens;
                    existing.CachedInputTokens = parsed.CachedInputTokens;
                    existing.OutputTokens = parsed.OutputTokens;
                    existing.TurnCount = parsed.TurnCount;
                    parsedTasks.Add(existing);
                }
                else parsedTasks.Add(parsed);
            }
        }
        usageTasks = parsedTasks;
        selectedTaskIndex = -1;
        if (!String.IsNullOrWhiteSpace(selectedId))
            for (var i = 0; i < usageTasks.Count; i++) if (usageTasks[i].Id == selectedId) { selectedTaskIndex = i; break; }
        taskScroll = Math.Max(0, Math.Min(taskScroll, Math.Max(0, usageTasks.Count - 7)));
        SetCompactDisplay(compactTaskMode);
        dataReady = true;
        SetStatus("已同步 · " + DateTime.Now.ToString("HH:mm"), cyan);
        toolTip.SetToolTip(this, "拖动顶部移动 · 右上角可置顶或隐藏");
        Log("INFO", "用量刷新成功");
    }

    private static UsageTask ParseUsageTask(Dictionary<string, object> item, bool summaryOnly)
    {
        if (item == null) throw new InvalidDataException("任务数据格式异常");
        var task = new UsageTask
        {
            Id = TextValue(item, "id"),
            Label = TextValue(item, "label"),
            Title = TextValue(item, "title"),
            LastActivity = TextValue(item, "lastActivity"),
            TotalTokens = NumberValue(item, "totalTokens"),
            InputTokens = NumberValue(item, "inputTokens"),
            CachedInputTokens = NumberValue(item, "cachedInputTokens"),
            OutputTokens = NumberValue(item, "outputTokens")
        };
        if (String.IsNullOrWhiteSpace(task.Label)) task.Label = "匿名任务";
        var rawTurns = item.ContainsKey("turns") ? item["turns"] as object[] : null;
        task.TurnCount = item.ContainsKey("turnCount") ? (int)Math.Round(Number(item["turnCount"])) : rawTurns == null ? 0 : rawTurns.Length;
        if (!summaryOnly && rawTurns != null)
        {
            foreach (var rawTurn in rawTurns)
            {
                var turn = Dict(rawTurn);
                if (turn == null) continue;
                task.Turns.Add(new UsageTurn
                {
                    Number = (int)Math.Round(NumberValue(turn, "number")),
                    Timestamp = TextValue(turn, "timestamp"),
                    Identified = BooleanValue(turn, "identified"),
                    Prompt = TextValue(turn, "prompt"),
                    TotalTokens = NumberValue(turn, "totalTokens"),
                    InputTokens = NumberValue(turn, "inputTokens"),
                    CachedInputTokens = NumberValue(turn, "cachedInputTokens"),
                    OutputTokens = NumberValue(turn, "outputTokens")
                });
            }
            task.TurnCount = task.Turns.Count;
            task.DetailsLoaded = true;
        }
        return task;
    }

    private static Dictionary<string, object> Dict(object value) { return value as Dictionary<string, object>; }
    private static double Number(object value) { return Convert.ToDouble(value); }
    private static double NumberValue(Dictionary<string, object> item, string key) { return item != null && item.ContainsKey(key) ? Number(item[key]) : 0; }
    private static string TextValue(Dictionary<string, object> item, string key) { return item != null && item.ContainsKey(key) ? Convert.ToString(item[key]) : ""; }
    private static bool BooleanValue(Dictionary<string, object> item, string key) { return item != null && item.ContainsKey(key) && Convert.ToBoolean(item[key]); }
    private static string FormatNumber(double value) { return Math.Round(value).ToString("N0", System.Globalization.CultureInfo.GetCultureInfo("zh-CN")); }
    private static string FormatTiny(double value)
    {
        if (value >= 100000000) return (value / 100000000).ToString("0.#") + "亿";
        if (value >= 1000000) return Math.Round(value / 10000).ToString("0") + "万";
        if (value >= 10000) return (value / 10000).ToString("0.#") + "万";
        return Math.Round(value).ToString("N0", System.Globalization.CultureInfo.GetCultureInfo("zh-CN"));
    }

    private static string FormatCompact(double value)
    {
        if (value >= 100000000) return (value / 100000000).ToString("0.##") + " 亿";
        if (value >= 10000) return (value / 10000).ToString("0.##") + " 万";
        return FormatNumber(value);
    }

    private static string FormatActivity(string value)
    {
        DateTime timestamp;
        return DateTime.TryParse(value, out timestamp) ? timestamp.ToLocalTime().ToString("MM/dd HH:mm") : "时间未知";
    }

    private static string TaskDisplayName(UsageTask task)
    {
        if (task == null) return "匿名任务";
        return task.Label + (String.IsNullOrWhiteSpace(task.Title) ? "" : " · " + task.Title);
    }

    private UsageTask FocusedTask()
    {
        if (String.IsNullOrWhiteSpace(focusedTaskId)) return null;
        foreach (var task in usageTasks) if (task.Id == focusedTaskId) return task;
        return null;
    }

    private UsageTurn FocusedTurn(UsageTask task)
    {
        if (task == null || task.Turns.Count == 0) return null;
        focusedTurnIndex = Math.Max(0, Math.Min(focusedTurnIndex, task.Turns.Count - 1));
        return task.Turns[focusedTurnIndex];
    }

    private void FocusTaskInCompact(UsageTask task)
    {
        if (task == null || !task.DetailsLoaded || task.Turns.Count == 0) return;
        focusedTaskId = task.Id;
        focusedTurnIndex = task.Turns.Count - 1;
        SetCompactDisplay(true);
        toolTip.SetToolTip(this, "小窗正在显示关注任务 · 滚轮或左右箭头切换轮次 · 点击左侧切换总量");
    }

    private void SetCompactDisplay(bool showTask)
    {
        var task = FocusedTask();
        compactTaskMode = showTask && task != null && task.Turns.Count > 0;
        totalModeMenuItem.Checked = !compactTaskMode;
        taskModeMenuItem.Checked = compactTaskMode;
        taskModeMenuItem.Enabled = task != null && task.Turns.Count > 0;
        Invalidate();
    }

    private void ShiftFocusedTurn(int amount)
    {
        var task = FocusedTask();
        if (task == null || task.Turns.Count == 0) return;
        focusedTurnIndex = Math.Max(0, Math.Min(task.Turns.Count - 1, focusedTurnIndex + amount));
        Invalidate();
    }

    private void SetStatus(string value, Color color) { statusText = value; statusColor = color; Invalidate(); }
    private void ShowWidget() { Show(); ShowInTaskbar = true; WindowState = FormWindowState.Normal; Activate(); RequestUsage(); }
    private void HideToTray()
    {
        ShowInTaskbar = false;
        Hide();
        if (shownTrayHint) return;
        trayIcon.BalloonTipTitle = "Codex Token 仍在运行";
        trayIcon.BalloonTipText = "双击托盘图标可恢复，右键可刷新或退出。";
        trayIcon.ShowBalloonTip(2500);
        shownTrayHint = true;
    }

    private void OnFormClosing(object sender, FormClosingEventArgs e)
    {
        if (allowExit || e.CloseReason == CloseReason.WindowsShutDown ||
            e.CloseReason == CloseReason.TaskManagerClosing || e.CloseReason == CloseReason.ApplicationExitCall)
        {
            allowExit = true;
            return;
        }
        e.Cancel = true;
        HideToTray();
    }

    private void OnFormClosed(object sender, FormClosedEventArgs e)
    {
        allowExit = true;
        showRegistration.Unregister(null);
        refreshTimer.Stop();
        trayIcon.Visible = false;
        trayIcon.Dispose();
        StopOwnedServer();
        Log("INFO", "悬浮窗退出");
    }

    private void UpdateWindowRegion()
    {
        using (var path = Rounded(new Rectangle(0, 0, Width, Height), compactMode ? 14 : 20))
            Region = new Region(path);
    }

    private static GraphicsPath Rounded(Rectangle rect, int radius)
    {
        var path = new GraphicsPath();
        var diameter = radius * 2;
        path.AddArc(rect.X, rect.Y, diameter, diameter, 180, 90);
        path.AddArc(rect.Right - diameter, rect.Y, diameter, diameter, 270, 90);
        path.AddArc(rect.Right - diameter, rect.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(rect.X, rect.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }

    private static void FillRound(Graphics g, Rectangle rect, int radius, Color color) { using (var path = Rounded(rect, radius)) using (var brush = new SolidBrush(color)) g.FillPath(brush, path); }
    private static void Draw(Graphics g, string value, int x, int y, float size, Color color, FontStyle style = FontStyle.Regular) { using (var font = new Font("Microsoft YaHei UI", size, style)) using (var brush = new SolidBrush(color)) g.DrawString(value, font, brush, x, y); }
    private static void DrawRight(Graphics g, string value, int right, int y, float size, Color color)
    {
        using (var font = new Font("Microsoft YaHei UI", size)) using (var brush = new SolidBrush(color)) { var width = g.MeasureString(value, font).Width; g.DrawString(value, font, brush, right - width, y); }
    }
    private static void DrawCentered(Graphics g, string value, Font font, Color color, Rectangle rect)
    {
        using (font) using (var brush = new SolidBrush(color)) using (var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center }) g.DrawString(value, font, brush, rect, format);
    }
}

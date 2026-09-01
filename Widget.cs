using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
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
        {
            if (!created) return;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TokenWidgetForm());
        }
    }
}

internal sealed class TokenWidgetForm : Form
{
    private const int Port = 4817;
    private readonly Color bg = Color.FromArgb(7, 11, 20);
    private readonly Color surface = Color.FromArgb(16, 24, 39);
    private readonly Color surfaceHigh = Color.FromArgb(20, 30, 49);
    private readonly Color border = Color.FromArgb(44, 58, 82);
    private readonly Color text = Color.FromArgb(248, 250, 252);
    private readonly Color secondary = Color.FromArgb(160, 174, 196);
    private readonly Color tertiary = Color.FromArgb(100, 116, 139);
    private readonly Color blue = Color.FromArgb(96, 165, 250);
    private readonly Color violet = Color.FromArgb(167, 139, 250);
    private readonly Color cyan = Color.FromArgb(94, 234, 212);
    private readonly Color amber = Color.FromArgb(251, 191, 36);
    private readonly NotifyIcon trayIcon;
    private readonly System.Windows.Forms.Timer refreshTimer;
    private readonly ToolTip toolTip;
    private readonly object logLock = new object();
    private readonly object recoveryLock = new object();
    private Process ownedServer;
    private bool requestBusy;
    private bool recoveryBusy;
    private bool allowExit;
    private bool shownTrayHint;
    private bool dataReady;
    private bool compactMode;
    private ToolStripMenuItem compactMenuItem;
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
    private readonly string logPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "CodexTokenWidget",
        "widget.log"
    );

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    public TokenWidgetForm()
    {
        Text = "Codex Token Widget";
        ClientSize = new Size(382, 558);
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

        var menu = new ContextMenuStrip();
        var showItem = menu.Items.Add("显示悬浮窗");
        var refreshItem = menu.Items.Add("刷新数据");
        var logItem = menu.Items.Add("打开诊断日志");
        compactMenuItem = (ToolStripMenuItem)menu.Items.Add("极简模式");
        var topItem = (ToolStripMenuItem)menu.Items.Add("始终置顶");
        topItem.Checked = true;
        menu.Items.Add(new ToolStripSeparator());
        var exitItem = menu.Items.Add("退出");
        showItem.Click += delegate { ShowWidget(); };
        refreshItem.Click += delegate { RequestUsage(); ShowWidget(); };
        logItem.Click += delegate { OpenLog(); };
        compactMenuItem.Click += delegate { ToggleCompact(); };
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
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
        using (var page = new LinearGradientBrush(ClientRectangle, Color.FromArgb(13, 20, 35), bg, 55f))
        using (var path = Rounded(ClientRectangle, 22)) g.FillPath(page, path);
        using (var outline = new Pen(Color.FromArgb(55, 72, 100)))
        using (var path = Rounded(new Rectangle(0, 0, Width - 1, Height - 1), 22)) g.DrawPath(outline, path);
        if (compactMode)
        {
            DrawCompact(g);
            return;
        }
        DrawHeader(g);
        DrawHero(g);
        DrawSummary(g);
        DrawTrend(g);
        DrawComposition(g);
        DrawFooter(g);
    }

    private void DrawHeader(Graphics g)
    {
        var iconRect = new Rectangle(18, 16, 34, 34);
        using (var icon = new LinearGradientBrush(iconRect, blue, violet, 45f)) g.FillEllipse(icon, iconRect);
        DrawCentered(g, "C", new Font("Segoe UI", 13, FontStyle.Bold), Color.White, iconRect);
        Draw(g, "CODEX USAGE", 64, 16, 10.5f, text, FontStyle.Bold);
        Draw(g, "LOCAL ACTIVITY", 64, 35, 7.5f, tertiary, FontStyle.Bold);
        var compactRect = new Rectangle(251, 17, 28, 28);
        FillRound(g, compactRect, 14, Color.FromArgb(20, 30, 49));
        DrawCentered(g, "–", new Font("Segoe UI", 12, FontStyle.Bold), secondary, compactRect);
        var topRect = new Rectangle(285, 17, 49, 28);
        FillRound(g, topRect, 14, TopMost ? Color.FromArgb(36, 56, 88) : Color.FromArgb(20, 30, 49));
        DrawCentered(g, "TOP", new Font("Segoe UI", 7.5f, FontStyle.Bold), TopMost ? blue : tertiary, topRect);
        var closeRect = new Rectangle(340, 17, 28, 28);
        FillRound(g, closeRect, 14, Color.FromArgb(20, 30, 49));
        DrawCentered(g, "×", new Font("Segoe UI", 13), secondary, closeRect);
    }

    private void DrawCompact(Graphics g)
    {
        var iconRect = new Rectangle(16, 16, 30, 30);
        using (var icon = new LinearGradientBrush(iconRect, blue, violet, 45f)) g.FillEllipse(icon, iconRect);
        DrawCentered(g, "C", new Font("Segoe UI", 11, FontStyle.Bold), Color.White, iconRect);
        Draw(g, "TODAY", 57, 13, 7.5f, secondary, FontStyle.Bold);
        Draw(g, dataReady ? FormatCompact(todayTotal) : "—", 55, 34, 19, text, FontStyle.Bold);
        using (var dot = new SolidBrush(statusColor)) g.FillEllipse(dot, 58, 81, 5, 5);
        Draw(g, statusText, 69, 74, 6.5f, statusColor);

        var ring = new Rectangle(241, 37, 52, 52);
        using (var track = new Pen(Color.FromArgb(40, 55, 78), 6)) g.DrawEllipse(track, ring);
        if (dataReady)
        {
            var mix = Math.Max(1, uncachedInput + cachedInput + output);
            var cachedPercent = cachedInput / mix * 100;
            using (var valuePen = new Pen(violet, 6)) { valuePen.StartCap = LineCap.Round; valuePen.EndCap = LineCap.Round; g.DrawArc(valuePen, ring, -90, (float)(cachedPercent * 3.6)); }
            DrawCentered(g, cachedPercent.ToString("0") + "%", new Font("Segoe UI", 8.5f, FontStyle.Bold), text, ring);
        }

        var expandRect = new Rectangle(278, 8, 26, 24);
        FillRound(g, expandRect, 12, Color.FromArgb(26, 39, 62));
        DrawCentered(g, "+", new Font("Segoe UI", 11, FontStyle.Bold), blue, expandRect);
        var closeRect = new Rectangle(309, 8, 22, 24);
        FillRound(g, closeRect, 11, Color.FromArgb(20, 30, 49));
        DrawCentered(g, "×", new Font("Segoe UI", 11), secondary, closeRect);
    }

    private void DrawHero(Graphics g)
    {
        var card = new Rectangle(18, 66, 346, 132);
        using (var cardBrush = new LinearGradientBrush(card, Color.FromArgb(29, 47, 78), Color.FromArgb(18, 28, 48), 15f))
        using (var path = Rounded(card, 18)) g.FillPath(cardBrush, path);
        using (var cardBorder = new Pen(Color.FromArgb(54, 79, 119)))
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
            using (var brush = new LinearGradientBrush(bar, blue, violet, 90f)) using (var path = Rounded(bar, 8)) g.FillPath(brush, path);
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
            if (new Rectangle(309, 8, 22, 24).Contains(e.Location)) { HideToTray(); return; }
            if (new Rectangle(278, 8, 26, 24).Contains(e.Location)) { ToggleCompact(); return; }
            ReleaseCapture();
            SendMessage(Handle, 0xA1, new IntPtr(2), IntPtr.Zero);
            return;
        }
        if (new Rectangle(340, 17, 28, 28).Contains(e.Location)) { HideToTray(); return; }
        if (new Rectangle(251, 17, 28, 28).Contains(e.Location)) { ToggleCompact(); return; }
        if (new Rectangle(285, 17, 49, 28).Contains(e.Location)) { TopMost = !TopMost; Invalidate(); return; }
        if (new Rectangle(310, 521, 54, 25).Contains(e.Location)) { RequestUsage(); return; }
        if (e.Y < 58) { ReleaseCapture(); SendMessage(Handle, 0xA1, new IntPtr(2), IntPtr.Zero); }
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        var active = compactMode
            ? new Rectangle(278, 8, 53, 24).Contains(e.Location)
            : new Rectangle(251, 17, 117, 28).Contains(e.Location) || new Rectangle(310, 521, 54, 25).Contains(e.Location);
        Cursor = active ? Cursors.Hand : (e.Y < 58 ? Cursors.SizeAll : Cursors.Default);
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
        ClientSize = compactMode ? new Size(340, 106) : new Size(382, 558);
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
            var startInfo = new ProcessStartInfo
            {
                FileName = "node.exe",
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
        try { var request = WebRequest.Create("http://127.0.0.1:" + Port + "/api/health"); request.Timeout = 700; using (request.GetResponse()) return true; }
        catch { return false; }
    }

    private void RequestUsage()
    {
        if (requestBusy) return;
        requestBusy = true;
        SetStatus("正在读取本地记录", amber);
        var client = new WebClient { Encoding = System.Text.Encoding.UTF8 };
        client.DownloadStringCompleted += delegate(object sender, DownloadStringCompletedEventArgs args)
        {
            Exception failure = null;
            try
            {
                if (args.Cancelled) throw new WebException("用量请求已取消");
                if (args.Error != null) throw args.Error;
                RenderUsage(new JavaScriptSerializer().DeserializeObject(args.Result) as Dictionary<string, object>);
            }
            catch (Exception error) { failure = error; }
            finally { requestBusy = false; client.Dispose(); }
            if (failure != null)
            {
                var detail = DescribeError(failure);
                SetStatus(detail + " · 正在自动重启", Color.FromArgb(251, 113, 133));
                toolTip.SetToolTip(this, "错误详情：" + detail + "\n正在自动检测并恢复本地服务");
                LogError("读取用量失败", failure);
                BeginRecovery(detail);
            }
        };
        client.DownloadStringAsync(new Uri("http://127.0.0.1:" + Port + "/api/usage?days=30"));
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
                return response == null
                    ? "本地服务返回协议错误"
                    : "本地服务返回 HTTP " + (int)response.StatusCode;
            }
        }
        if (error is InvalidDataException || error is KeyNotFoundException) return "返回的用量数据格式异常";
        if (error is TimeoutException) return "本地服务启动超时";
        var message = (error.Message ?? error.GetType().Name).Replace("\r", " ").Replace("\n", " ").Trim();
        return message.Length > 48 ? message.Substring(0, 47) + "…" : message;
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
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " [" + level + "] " + message + Environment.NewLine
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
        dataReady = true;
        SetStatus("已同步 · " + DateTime.Now.ToString("HH:mm"), cyan);
        toolTip.SetToolTip(this, "拖动顶部移动 · 右上角可置顶或隐藏");
        Log("INFO", "用量刷新成功");
    }

    private static Dictionary<string, object> Dict(object value) { return value as Dictionary<string, object>; }
    private static double Number(object value) { return Convert.ToDouble(value); }
    private static string FormatNumber(double value) { return Math.Round(value).ToString("N0", System.Globalization.CultureInfo.GetCultureInfo("zh-CN")); }
    private static string FormatCompact(double value)
    {
        if (value >= 100000000) return (value / 100000000).ToString("0.##") + " 亿";
        if (value >= 10000) return (value / 10000).ToString("0.##") + " 万";
        return FormatNumber(value);
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

    private void OnFormClosing(object sender, FormClosingEventArgs e) { if (allowExit) return; e.Cancel = true; HideToTray(); }
    private void OnFormClosed(object sender, FormClosedEventArgs e)
    {
        allowExit = true;
        refreshTimer.Stop();
        trayIcon.Visible = false;
        trayIcon.Dispose();
        StopOwnedServer();
        Log("INFO", "悬浮窗退出");
    }

    private void UpdateWindowRegion() { using (var path = Rounded(new Rectangle(0, 0, Width, Height), 22)) Region = new Region(path); }

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

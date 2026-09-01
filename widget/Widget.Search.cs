using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

internal sealed partial class TokenWidgetForm
{
    private const int EmSetCueBanner = 0x1501;
    private readonly Timer taskSearchTimer = new Timer { Interval = 450 };
    private TextBox taskSearchBox;
    private string taskSearchQuery = "";
    private bool taskSearchRefreshPending;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessage(IntPtr handle, int message, IntPtr parameter, string text);

    private string TaskSearchQuery { get { return taskSearchQuery; } }

    private void InitializeTaskSearch()
    {
        taskSearchBox = new TextBox
        {
            BackColor = surface,
            ForeColor = text,
            BorderStyle = BorderStyle.FixedSingle,
            Font = new Font("Microsoft YaHei UI", 7.5f),
            MaxLength = 80,
            Size = new Size(164, 24),
            Location = new Point(200, 68),
            Visible = false
        };
        taskSearchBox.HandleCreated += delegate
        {
            SendMessage(taskSearchBox.Handle, EmSetCueBanner, new IntPtr(1), "搜索任务或提示词");
        };
        taskSearchBox.TextChanged += delegate
        {
            taskSearchTimer.Stop();
            taskSearchTimer.Start();
        };
        taskSearchBox.KeyDown += delegate(object sender, KeyEventArgs args)
        {
            if (args.KeyCode == Keys.Escape)
            {
                taskSearchBox.Clear();
                args.SuppressKeyPress = true;
            }
            else if (args.KeyCode == Keys.Enter)
            {
                taskSearchTimer.Stop();
                ApplyTaskSearch();
                args.SuppressKeyPress = true;
            }
        };
        taskSearchTimer.Tick += delegate
        {
            taskSearchTimer.Stop();
            ApplyTaskSearch();
        };
        Controls.Add(taskSearchBox);
    }

    private void ApplyTaskSearch()
    {
        var next = (taskSearchBox.Text ?? "").Trim();
        var changed = !String.Equals(next, taskSearchQuery, StringComparison.Ordinal);
        if (changed)
        {
            taskSearchQuery = next;
            selectedTaskIndex = -1;
            taskScroll = 0;
            taskSearchRefreshPending = true;
            Invalidate();
        }
        if (!taskSearchRefreshPending) return;
        if (requestBusy)
        {
            taskSearchTimer.Start();
            return;
        }
        taskSearchRefreshPending = false;
        RequestUsage();
    }

    private string TaskSearchParameter()
    {
        return String.IsNullOrWhiteSpace(taskSearchQuery)
            ? ""
            : "&query=" + Uri.EscapeDataString(taskSearchQuery);
    }

    private void SyncTaskSearchVisibility()
    {
        if (taskSearchBox == null) return;
        var shouldShow = !compactMode && taskView && selectedTaskIndex < 0;
        if (taskSearchBox.Visible != shouldShow) taskSearchBox.Visible = shouldShow;
        if (shouldShow) taskSearchBox.BringToFront();
    }
}

using System.Diagnostics;
using System.Drawing;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Aerus.UsageHud.Desktop;

// Hosts the HUD in a WebView2 window with an embedded title strip and system tray support.
// The bundled Node runtime serves the dashboard on 127.0.0.1 only.
internal sealed class MainForm : Form
{
    public const string WindowTitle = "Aerus AI Usage HUD";

    private const int FirstPort = 8790;
    private const int PortAttempts = 10;
    private static readonly string WebView2DownloadUrl = "https://developer.microsoft.com/microsoft-edge/webview2/";

    // Window-message and style constants for a frameless window that still resizes and animates.
    private const int WmNcHitTest = 0x0084;
    private const int HtLeft = 10, HtRight = 11, HtTop = 12, HtTopLeft = 13, HtTopRight = 14;
    private const int HtBottom = 15, HtBottomLeft = 16, HtBottomRight = 17;
    private const int WsThickFrame = 0x00040000, WsMinimizeBox = 0x00020000, WsMaximizeBox = 0x00010000, WsSysMenu = 0x00080000;
    private const int WmNcLButtonDown = 0x00A1, HtCaption = 2;

    private static readonly Color Background = Color.FromArgb(3, 8, 15);
    private static readonly Color StripBackground = Color.FromArgb(5, 11, 20);
    private static readonly Color Cyan = Color.FromArgb(34, 227, 240);
    private static readonly Color MutedText = Color.FromArgb(126, 147, 171);

    private readonly string _appRoot = AppContext.BaseDirectory;
    // Each Windows user gets their own data folder. AERUS_HOME can point the app at another folder (used for testing).
    private readonly string _dataRoot = ResolveDataRoot();

    private readonly Panel _titleBar = new() { Dock = DockStyle.Top, Height = 36, BackColor = StripBackground };
    private readonly Button _maximizeButton = new();
    private readonly Button _pinButton = new();
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill, Visible = false };
    private readonly NotifyIcon _tray = new();
    private readonly Label _status = new()
    {
        Dock = DockStyle.Fill,
        TextAlign = ContentAlignment.MiddleCenter,
        ForeColor = Cyan,
        BackColor = Background,
        Font = new Font("Segoe UI", 16, FontStyle.Bold),
        Text = "AERUS AI USAGE HUD\r\n\r\nStarting local dashboard…",
    };

    private Process? _server;
    private ChildJob? _job;
    private Rectangle _normalBounds;
    private bool _miniMode;

    private static string ResolveDataRoot()
    {
        var home = Environment.GetEnvironmentVariable("AERUS_HOME");
        return string.IsNullOrWhiteSpace(home)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Aerus", "AI Usage HUD")
            : home;
    }

    public MainForm()
    {
        Text = WindowTitle;
        FormBorderStyle = FormBorderStyle.None;
        BackColor = Background;
        MinimumSize = new Size(1040, 760);
        // Opens wide enough for the Model Proportion panel on the right, but never bigger than the screen.
        var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1600, 900);
        Size = new Size(Math.Min(1800, (int)(area.Width * 0.92)), Math.Min(980, (int)(area.Height * 0.92)));
        StartPosition = FormStartPosition.CenterScreen;

        var icon = Path.Combine(_appRoot, "assets", "aerus-usage-hud.ico");
        if (File.Exists(icon)) Icon = new Icon(icon);

        BuildTitleBar();
        BuildTrayIcon();
        Controls.Add(_web);
        Controls.Add(_status);
        Controls.Add(_titleBar);
        Shown += async (_, _) => await StartAsync();
        FormClosing += (_, _) =>
        {
            _tray.Visible = false;
            _tray.Dispose();
            StopServer();
        };
        Resize += (_, _) => UpdateMaximizeButton();
    }

    // Paints the window border in the HUD's dark navy instead of the Windows accent colour.
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        var borderColor = (StripBackground.B << 16) | (StripBackground.G << 8) | StripBackground.R;
        DwmSetWindowAttribute(Handle, DwmBorderColorAttribute, ref borderColor, sizeof(int));
    }

    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr handle, int attribute, ref int value, int valueSize);
    private const int DwmBorderColorAttribute = 34;

    // Keeps the native resize and snap behaviour on a frameless window.
    protected override CreateParams CreateParams
    {
        get
        {
            var parameters = base.CreateParams;
            parameters.Style |= WsThickFrame | WsMinimizeBox | WsMaximizeBox | WsSysMenu;
            return parameters;
        }
    }

    // Maximizing a borderless window must fill the monitor's work area, not the frame size.
    private const int WmGetMinMaxInfo = 0x0024;

    [StructLayout(LayoutKind.Sequential)]
    private struct MinMaxInfo
    {
        public Point Reserved;
        public Size MaxSize;
        public Point MaxPosition;
        public Size MinTrackSize;
        public Size MaxTrackSize;
    }

    // Lets the frame edges resize the window, since the frame itself is hidden.
    protected override void WndProc(ref Message message)
    {
        if (message.Msg == WmGetMinMaxInfo)
        {
            var info = Marshal.PtrToStructure<MinMaxInfo>(message.LParam);
            var monitor = Screen.FromHandle(Handle);
            var work = monitor.WorkingArea;
            info.MaxPosition = new Point(work.Left - monitor.Bounds.Left, work.Top - monitor.Bounds.Top);
            info.MaxSize = work.Size;
            Marshal.StructureToPtr(info, message.LParam, false);
            message.Result = IntPtr.Zero;
            return;
        }

        if (message.Msg == WmNcHitTest && WindowState != FormWindowState.Maximized)
        {
            var lParam = (long)message.LParam;
            var point = PointToClient(new Point(unchecked((short)lParam), unchecked((short)(lParam >> 16))));
            var edge = Math.Max(6, (int)Math.Round(8 * DeviceDpi / 96.0));
            var left = point.X < edge;
            var right = point.X >= ClientSize.Width - edge;
            var top = point.Y < edge;
            var bottom = point.Y >= ClientSize.Height - edge;
            if (top && left) { message.Result = (IntPtr)HtTopLeft; return; }
            if (top && right) { message.Result = (IntPtr)HtTopRight; return; }
            if (bottom && left) { message.Result = (IntPtr)HtBottomLeft; return; }
            if (bottom && right) { message.Result = (IntPtr)HtBottomRight; return; }
            if (left) { message.Result = (IntPtr)HtLeft; return; }
            if (right) { message.Result = (IntPtr)HtRight; return; }
            if (top) { message.Result = (IntPtr)HtTop; return; }
            if (bottom) { message.Result = (IntPtr)HtBottom; return; }
        }
        base.WndProc(ref message);
    }

    private void BuildTitleBar()
    {
        _titleBar.Paint += (_, e) =>
        {
            using var pen = new Pen(Color.FromArgb(120, Cyan));
            e.Graphics.DrawLine(pen, 0, _titleBar.Height - 1, _titleBar.Width, _titleBar.Height - 1);
        };

        var appIcon = new PictureBox
        {
            Image = Icon?.ToBitmap(), SizeMode = PictureBoxSizeMode.StretchImage,
            Size = new Size(20, 20), Location = new Point(12, 8), BackColor = Color.Transparent,
        };
        var title = new Label
        {
            Text = "AERUS AI USAGE HUD", AutoSize = true,
            Font = new Font("Segoe UI Semibold", 9f), ForeColor = Cyan,
            BackColor = Color.Transparent, Location = new Point(42, 10),
        };
        var subtitle = new Label
        {
            Text = "Unified token tracking for Codex, Claude && Ollama", AutoSize = true,
            Font = new Font("Segoe UI", 8f), ForeColor = MutedText,
            BackColor = Color.Transparent, Location = new Point(206, 11),
        };
        _titleBar.Controls.Add(appIcon);
        _titleBar.Controls.Add(title);
        _titleBar.Controls.Add(subtitle);
        MakeDraggable(_titleBar);
        MakeDraggable(appIcon);
        MakeDraggable(title);
        MakeDraggable(subtitle);

        var controls = new FlowLayoutPanel
        {
            Dock = DockStyle.Right, Width = 184, Height = 36, FlowDirection = FlowDirection.RightToLeft,
            WrapContents = false, Margin = Padding.Empty, Padding = Padding.Empty, BackColor = Color.Transparent,
        };
        var close = CreateWindowButton("×", "Close", 13);
        close.FlatAppearance.MouseOverBackColor = Color.FromArgb(190, 42, 55);
        close.Click += (_, _) => Close();
        StyleWindowButton(_maximizeButton, "Maximize", 10);
        _maximizeButton.Text = "□";
        _maximizeButton.Click += (_, _) => ToggleMaximize();
        var minimize = CreateWindowButton("—", "Minimize", 10);
        minimize.Click += (_, _) => WindowState = FormWindowState.Minimized;
        StyleWindowButton(_pinButton, "Pin Always on Top", 10);
        _pinButton.Text = "⊤";
        _pinButton.Click += (_, _) => ToggleTopMost();
        controls.Controls.Add(close);
        controls.Controls.Add(_maximizeButton);
        controls.Controls.Add(minimize);
        controls.Controls.Add(_pinButton);
        _titleBar.Controls.Add(controls);
        UpdateMaximizeButton();
        UpdatePinButton();
    }

    private void BuildTrayIcon()
    {
        _tray.Icon = Icon ?? SystemIcons.Application;
        _tray.Text = WindowTitle;
        _tray.Visible = true;
        _tray.DoubleClick += (_, _) => RestoreWindow();

        var menu = new ContextMenuStrip();
        menu.Items.Add("Open HUD", null, (_, _) => RestoreWindow());
        menu.Items.Add("Toggle Mini-HUD Mode", null, async (_, _) =>
        {
            RestoreWindow();
            SetMiniMode(!_miniMode);
            if (_web.CoreWebView2 is not null)
            {
                await _web.CoreWebView2.ExecuteScriptAsync($"window.setAerusMiniHud && window.setAerusMiniHud({(_miniMode ? "true" : "false")});");
            }
        });
        menu.Items.Add("Toggle Always on Top", null, (_, _) => ToggleTopMost());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit Aerus HUD", null, (_, _) => Close());
        _tray.ContextMenuStrip = menu;
    }

    private void RestoreWindow()
    {
        if (!Visible) Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
    }

    private void ToggleTopMost()
    {
        TopMost = !TopMost;
        UpdatePinButton();
    }

    private void UpdatePinButton()
    {
        if (_pinButton.IsDisposed) return;
        _pinButton.ForeColor = TopMost ? Cyan : Color.FromArgb(205, 238, 222);
    }

    private void SetMiniMode(bool enabled)
    {
        if (_miniMode == enabled) return;
        _miniMode = enabled;
        if (enabled)
        {
            if (WindowState == FormWindowState.Maximized) WindowState = FormWindowState.Normal;
            _normalBounds = Bounds;
            MinimumSize = new Size(440, 260);
            var work = Screen.FromHandle(Handle).WorkingArea;
            var w = 520;
            var h = 300;
            Bounds = new Rectangle(work.Right - w - 20, work.Bottom - h - 20, w, h);
            TopMost = true;
        }
        else
        {
            MinimumSize = new Size(1040, 760);
            if (_normalBounds.Width >= 1040 && _normalBounds.Height >= 760)
            {
                Bounds = _normalBounds;
            }
            TopMost = false;
        }
        UpdatePinButton();
    }

    private static Button CreateWindowButton(string glyph, string name, float fontSize)
    {
        var button = new Button { Text = glyph };
        StyleWindowButton(button, name, fontSize);
        return button;
    }

    private static void StyleWindowButton(Button button, string name, float fontSize)
    {
        button.AccessibleName = name;
        button.Size = new Size(46, 36);
        button.Margin = Padding.Empty;
        button.Padding = Padding.Empty;
        button.TabStop = false;
        button.Cursor = Cursors.Hand;
        button.Font = new Font("Segoe UI Symbol", fontSize, FontStyle.Regular);
        button.ForeColor = Color.FromArgb(205, 238, 222);
        button.BackColor = StripBackground;
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderSize = 0;
        button.FlatAppearance.MouseOverBackColor = Color.FromArgb(18, 52, 66);
    }

    // Dragging the strip moves the window. Double-clicking it maximizes or restores.
    private void MakeDraggable(Control control)
    {
        control.MouseDown += (_, args) =>
        {
            if (args.Button != MouseButtons.Left) return;
            if (args.Clicks > 1) { ToggleMaximize(); return; }
            ReleaseCapture();
            SendMessage(Handle, WmNcLButtonDown, (IntPtr)HtCaption, IntPtr.Zero);
        };
    }

    private void ToggleMaximize() =>
        WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;

    private void UpdateMaximizeButton()
    {
        if (_maximizeButton.IsDisposed) return;
        var maximized = WindowState == FormWindowState.Maximized;
        _maximizeButton.Text = maximized ? "❐" : "□";
        _maximizeButton.AccessibleName = maximized ? "Restore" : "Maximize";
    }

    [DllImport("user32.dll")] private static extern bool ReleaseCapture();
    [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr handle, int message, IntPtr wParam, IntPtr lParam);

    private async Task StartAsync()
    {
        try
        {
            var port = FindFreePort();
            var url = $"http://127.0.0.1:{port}/";
            StartServer(port);

            if (!await WaitForServerAsync(url, TimeSpan.FromSeconds(20)))
            {
                ShowFailure("The usage server did not start. Reopen the HUD. If it keeps happening, reinstall it from the setup file.");
                return;
            }

            Directory.CreateDirectory(Path.Combine(_dataRoot, "WebView2"));
            var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(_dataRoot, "WebView2"));
            await _web.EnsureCoreWebView2Async(environment);
            _web.CoreWebView2.Settings.AreDevToolsEnabled = false;
            _web.CoreWebView2.WebMessageReceived += (_, args) =>
            {
                try
                {
                    using var doc = JsonDocument.Parse(args.TryGetWebMessageAsString());
                    if (doc.RootElement.TryGetProperty("type", out var typeProp) && typeProp.GetString() == "mini-hud")
                    {
                        var enabled = doc.RootElement.TryGetProperty("enabled", out var en) && en.GetBoolean();
                        BeginInvoke(() => SetMiniMode(enabled));
                    }
                }
                catch
                {
                    // Ignore malformed messages.
                }
            };
            _web.Source = new Uri(url);
            _web.Visible = true;
            _status.Visible = false;
        }
        catch (WebView2RuntimeNotFoundException)
        {
            var open = MessageBox.Show(
                this,
                "Microsoft Edge WebView2 Runtime is needed to show the HUD. It is included with Windows 11 and recent Windows 10 updates.\r\n\r\nOpen Microsoft's download page now?",
                WindowTitle,
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning);
            if (open == DialogResult.Yes) Process.Start(new ProcessStartInfo(WebView2DownloadUrl) { UseShellExecute = true });
            ShowFailure("The WebView2 Runtime is not installed.");
        }
        catch (Exception error)
        {
            ShowFailure($"Could not start the HUD: {error.Message}");
        }
    }

    private void StartServer(int port)
    {
        var node = Path.Combine(_appRoot, "runtime", "node.exe");
        var script = Path.Combine(_appRoot, "server.js");
        if (!File.Exists(node) || !File.Exists(script))
            throw new FileNotFoundException("The HUD program files are incomplete.", File.Exists(node) ? script : node);

        var startInfo = new ProcessStartInfo(node)
        {
            WorkingDirectory = _appRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        startInfo.ArgumentList.Add(script);
        startInfo.ArgumentList.Add("--no-open");
        startInfo.Environment["PORT"] = port.ToString();
        startInfo.Environment["AERUS_DATA_DIR"] = Path.Combine(_dataRoot, "data");
        _job ??= new ChildJob();
        _server = Process.Start(startInfo);
        if (_server is not null) _job.Add(_server);
    }

    private async Task<bool> WaitForServerAsync(string url, TimeSpan timeout)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        var stopwatch = Stopwatch.StartNew();
        while (stopwatch.Elapsed < timeout)
        {
            if (_server is null || _server.HasExited) return false;
            try
            {
                using var response = await client.GetAsync(url);
                if (response.IsSuccessStatusCode) return true;
            }
            catch (HttpRequestException)
            {
                // Not listening yet.
            }
            await Task.Delay(250);
        }
        return false;
    }

    private static int FindFreePort()
    {
        for (var port = FirstPort; port < FirstPort + PortAttempts; port++)
        {
            var listener = new TcpListener(IPAddress.Loopback, port);
            try
            {
                listener.Start();
                return port;
            }
            catch (SocketException)
            {
                // Taken. Try the next one.
            }
            finally
            {
                listener.Stop();
            }
        }
        throw new InvalidOperationException($"Ports {FirstPort}–{FirstPort + PortAttempts - 1} are all in use.");
    }

    private void ShowFailure(string message)
    {
        _web.Visible = false;
        _status.Text = $"AERUS AI USAGE HUD\r\n\r\n{message}";
        _status.Visible = true;
    }

    private void StopServer()
    {
        try
        {
            if (_server is not null && !_server.HasExited) _server.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException)
        {
            // Already exited.
        }
        _job?.Dispose();
        _job = null;
    }
}

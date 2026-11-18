using System.Drawing;
using System.Drawing.Drawing2D;
using System.Text.Json;
using System.Windows.Forms;

namespace ClaudePanel;

/// <summary>
/// Sistem tepsisi ikonu: paneli açar/kapatır, oturum işi bitince ya da cevap beklerken Windows
/// bildirimi gösterir. Pencere kapalıyken de çalışır (tarayıcı bildirimleri yalnız pencere açıkken gelir).
/// Kendi STA iş parçacığında, kendi mesaj döngüsüyle çalışır.
/// </summary>
sealed class Tray(string baseUrl, SessionStore store, HostedSessions hosted, IHostApplicationLifetime life,
    ILogger<Tray> log)
{
    const int PollMs = 3000;
    static readonly string SettingsFile = Path.Combine(Handoff.DataDir, "tray.json");

    NotifyIcon? _icon;
    SynchronizationContext? _ui;
    System.Threading.Timer? _timer;
    readonly SessionLanes _watch = new(store, hosted);
    TraySettings _settings = new();

    /// <summary>Tarayıcı bildirimi tekrar etmesin diye panel sayfası bunu okur.</summary>
    public bool Notifies => _icon is not null && _settings.Notify;

    public void Start()
    {
        _settings = LoadSettings();
        var t = new Thread(Run) { IsBackground = true, Name = "Tray" };
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        life.ApplicationStopping.Register(() => _ui?.Post(_ => Application.ExitThread(), null));
    }

    void Run()
    {
        Application.EnableVisualStyles();
        var menu = new ContextMenuStrip();
        _ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        var version = Handoff.Mine.ToString(3);

        var open = new ToolStripMenuItem("Paneli aç") { Font = new Font(menu.Font, FontStyle.Bold) };
        open.Click += (_, _) => OpenWindow();
        var notify = new ToolStripMenuItem("Bildirimler") { Checked = _settings.Notify, CheckOnClick = true };
        notify.CheckedChanged += (_, _) => { _settings.Notify = notify.Checked; SaveSettings(); };
        var quit = new ToolStripMenuItem("Paneli kapat");
        quit.Click += (_, _) => Quit();
        menu.Items.AddRange([open, notify, new ToolStripSeparator(),
            new ToolStripMenuItem($"Sürüm v{version}") { Enabled = false }, quit]);

        _icon = new NotifyIcon
        {
            Icon = MakeIcon(), Text = $"Claude Oturum Paneli v{version}", ContextMenuStrip = menu, Visible = true
        };
        _icon.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) OpenWindow(); };
        _icon.BalloonTipClicked += (_, _) => OpenWindow();

        if (!_settings.Introduced)
        {
            Show("Panel sistem tepsisinde", "Pencereyi kapatsanız da panel burada çalışır; oturum bildirimleri buradan gelir.");
            _settings.Introduced = true;
            SaveSettings();
        }

        _timer = new System.Threading.Timer(_ => Poll(), null, 1000, PollMs);
        Application.Run();
        _timer.Dispose();
        _icon.Visible = false;
        _icon.Dispose();
    }

    void Quit()
    {
        var text = hosted.AnyBusy
            ? "Panelde çalışan oturum var. Kapatırsanız o iş yarıda kalır; oturumlar panel yeniden açılınca geri gelir.\n\nYine de kapatılsın mı?"
            : "Panel kapatılsın mı? Panelde açık oturumlar sonraki açılışta geri gelir.";
        if (MessageBox.Show(text, "Claude Oturum Paneli", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
            life.StopApplication();
    }

    /// <summary>Çalışıyordan bekliyora geçen oturumu bildirir.</summary>
    void Poll()
    {
        if (!Monitor.TryEnter(_watch)) return; // önceki tur sürüyorsa üst üste binmesin
        try
        {
            foreach (var (name, cwd) in _watch.NewlyIdle())
                if (_settings.Notify)
                    _ui?.Post(_ => Show($"{name} bekliyor", $"İşi bitti ya da cevabınızı bekliyor.\n{cwd}"), null);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            log.LogDebug("Tepsi yoklaması atlandı: {Msg}", ex.Message); // bir tur atlanır, sonraki turda düzelir
        }
        finally { Monitor.Exit(_watch); }
    }

    /// <summary>Açık panel penceresini öne getirir, yoksa açar. Süreç taraması (WMI) tepsi iş parçacığını bekletmesin.</summary>
    void OpenWindow() => Task.Run(() => Launcher.OpenAppWindow(baseUrl));

    void Show(string title, string text) => _icon?.ShowBalloonTip(5000, title, text, ToolTipIcon.Info);

    /// <summary>logo.svg'nin küçük eşi: turuncu yuvarlak kare, dört beyaz kutu.</summary>
    static Icon MakeIcon()
    {
        using var bmp = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using var bg = new LinearGradientBrush(new Rectangle(0, 0, 32, 32),
                Color.FromArgb(0xF0, 0x95, 0x6B), Color.FromArgb(0xC9, 0x57, 0x3A), 45f);
            g.FillPath(bg, Rounded(new RectangleF(1, 1, 30, 30), 8));
            using var w = new SolidBrush(Color.White);
            foreach (var (x, y) in new[] { (7f, 9f), (17f, 9f), (7f, 17f), (17f, 17f) })
                g.FillPath(w, Rounded(new RectangleF(x, y, 8, 6), 2));
        }
        return Icon.FromHandle(bmp.GetHicon());
    }

    static GraphicsPath Rounded(RectangleF r, float rad)
    {
        var p = new GraphicsPath();
        p.AddArc(r.X, r.Y, rad, rad, 180, 90);
        p.AddArc(r.Right - rad, r.Y, rad, rad, 270, 90);
        p.AddArc(r.Right - rad, r.Bottom - rad, rad, rad, 0, 90);
        p.AddArc(r.X, r.Bottom - rad, rad, rad, 90, 90);
        p.CloseFigure();
        return p;
    }

    TraySettings LoadSettings()
    {
        try { return JsonSerializer.Deserialize<TraySettings>(File.ReadAllText(SettingsFile)) ?? new(); }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException) { return new(); }
    }

    void SaveSettings()
    {
        try
        {
            Directory.CreateDirectory(Handoff.DataDir);
            File.WriteAllText(SettingsFile, JsonSerializer.Serialize(_settings));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            log.LogDebug("Tepsi ayarı yazılamadı: {Msg}", ex.Message);
        }
    }

    sealed class TraySettings
    {
        public bool Notify { get; set; } = true;
        public bool Introduced { get; set; }
    }
}

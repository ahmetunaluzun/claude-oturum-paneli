using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Net;

namespace ClaudePanel;

/// <summary>
/// Paneli yeniden başlat (Ayarlar, Takip'teki "Yeni sürüm hazır" satırı). Yalnız panelde çalışan oturum yokken.
/// Eski süreç kanonik exe'yi (<see cref="CanonicalExe"/>) pencere açmadan ve devir bayrağıyla başlatır; kendini KAPATMAZ.
/// Kapatmayı yeni süreç yapar: oturum anahtarıyla (Handoff, panel-&lt;port&gt;.token) eskinin /api/quit'ini çağırır, eski
/// süreç bitip port boşalınca aynı portta açılır. Yeni süreç başlayamaz ya da devralamazsa eski panel açık kalır; neden
/// /api/version'daki restartError'da görünür. Olaylar logs\restart.log'a yazılır.
/// </summary>
static class Restart
{
    public const string FromArg = "--restart-from", ForceArg = "--restart-force";
    const string OldSuffix = ".old.exe";
    static readonly string LogFile = Path.Combine(Handoff.DataDir, "logs", "restart.log");
    static readonly object LogLock = new();
    const long LogMax = 256 * 1024;

    // Devir kodları (yeni sürecin çıkış kodu) → istemcideki hata anahtarı (rsErr_*).
    const int ExitNoToken = 2, ExitBusy = 3, ExitQuitFailed = 4, ExitTimeout = 5;

    static int _running; // aynı anda tek yeniden başlatma
    static volatile bool _handingOver; // yeni süreç bizi kapatıyor: uygulama penceresi kapanmasın, sayfa yeniden bağlansın
    public static bool HandingOver => _handingOver;
    public static string? LastError { get; private set; }

    /// <summary>Yeniden başlatılacak exe: çalışan dosya. Güncellemede çalışan exe "ClaudePanel.old.exe" adını alır, yenisi
    /// "ClaudePanel.exe" olarak yayınlanır; o durumda yanındaki yeni dosya (yoksa çalışan dosya). Mac'te çalışan ikili.</summary>
    public static string CanonicalExe()
    {
        var path = Environment.ProcessPath ?? "";
        var name = Path.GetFileName(path);
        if (!name.EndsWith(OldSuffix, StringComparison.OrdinalIgnoreCase)) return path;
        var fresh = Path.Combine(Path.GetDirectoryName(path) ?? "", name[..^OldSuffix.Length] + ".exe");
        return File.Exists(fresh) ? fresh : path;
    }

    static (string Path, DateTime At, long Len, string? Version) _disk;

    /// <summary>Kanonik exe'nin sürümü çalışan sürümden yeniyse o sürüm (3 parça), değilse null. Dosya sürümü 4 parçalıdır
    /// (0.18.0.0); karşılaştırma 3 parçayla (Handoff.Mine) yapılır, yoksa aynı sürüm "yeni" sayılır (18.11.2026 hatası).</summary>
    public static string? DiskVersion()
    {
        try
        {
            var path = CanonicalExe();
            var fi = new FileInfo(path);
            if (!fi.Exists) return null;
            var d = _disk;
            if (d.Path == path && d.At == fi.LastWriteTimeUtc && d.Len == fi.Length) return d.Version;
            var fv = FileVersionInfo.GetVersionInfo(path);
            var v = new Version(fv.FileMajorPart, fv.FileMinorPart, fv.FileBuildPart);
            string? newer = v > new Version(0, 0, 0) && v > Handoff.Mine ? v.ToString(3) : null;
            _disk = (path, fi.LastWriteTimeUtc, fi.Length, newer);
            return newer;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return null;
        }
    }

    /// <summary>"Çalışıyor" yanıtının gövdesi: çalışan oturum adları + oturum "boşta" olsa da süren arka plan işleri (Kapat ve Yeniden başlat ortak).</summary>
    public static object BusyBody(IReadOnlyList<string> busy, IReadOnlyList<BgJobOf> background) => new
    {
        error = "busy", sessions = busy,
        background = background.Select(b => new { session = b.Session, kind = b.Job.Kind, label = b.Job.Label, since = b.Job.Since, stale = b.Job.Stale })
    };

    /// <summary>POST /api/restart. busy: çalışan panel oturumlarının adları; background: arka plan işleri; force yalnız bilgisayardan (çağıran karar verir).</summary>
    public static async Task<IResult> Begin(IReadOnlyList<string> busy, IReadOnlyList<BgJobOf> background, bool force)
    {
        if ((busy.Count > 0 || background.Count > 0) && !force) return Results.Json(BusyBody(busy, background), statusCode: 409);
        if (Interlocked.Exchange(ref _running, 1) == 1) return Results.Json(new { error = "restarting" }, statusCode: 409);
        LastError = null;
        var exe = CanonicalExe();
        if (!File.Exists(exe)) return Fail("noexe", $"exe bulunamadı: {exe}");

        var psi = new ProcessStartInfo(exe) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(exe) ?? "" };
        psi.ArgumentList.Add("--no-window");
        psi.ArgumentList.Add(FromArg);
        psi.ArgumentList.Add(Environment.ProcessId.ToString(CultureInfo.InvariantCulture));
        if (force) psi.ArgumentList.Add(ForceArg);
        Process child;
        try
        {
            child = Process.Start(psi) ?? throw new InvalidOperationException("süreç başlamadı");
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException or IOException)
        {
            return Fail("start", $"yeni süreç başlatılamadı ({exe}): {ex.Message}");
        }
        Log("INFO", $"Yeniden başlatma: {exe} başlatıldı (PID {child.Id}){(force ? ", çalışan oturum olmasına rağmen (onaylı)" : "")}.");

        // Hemen ölen süreç (bozuk dosya, eksik kitaplık): eski panel açık kalır, hata hemen döner.
        using (var cts = new CancellationTokenSource(1500))
        {
            try { await child.WaitForExitAsync(cts.Token); }
            catch (OperationCanceledException) { /* çalışıyor: devir sürüyor */ }
        }
        if (child.HasExited) return Fail(ErrorOf(child.ExitCode), $"yeni süreç hemen kapandı (çıkış {child.ExitCode}); eski panel açık kalıyor.");
        _ = Watch(child);
        return Results.Json(new { ok = true, pid = child.Id });
    }

    // ---- "İşler bitince yeniden başlat" ----

    static readonly object WaitLock = new();
    static System.Threading.Timer? _waitTimer;
    static volatile bool _waiting;
    static int _waitChecking;
    const int WaitPollMs = 3000;

    /// <summary>Kullanıcı "işler bitince yeniden başlat" dedi: oturum çalışmıyor ve arka plan işi kalmayınca panel kendisi yeniden başlar.</summary>
    public static bool Waiting => _waiting;

    public static void WaitUntilIdle(HostedSessions hosted)
    {
        lock (WaitLock)
        {
            if (_waiting) return;
            _waiting = true;
            LastError = null;
            _waitTimer = new System.Threading.Timer(_ => _ = CheckWait(hosted), null, WaitPollMs, WaitPollMs);
        }
        Log("INFO", "Yeniden başlatma, çalışan oturumlar ve arka plan işleri bitince yapılmak üzere bekletiliyor.");
    }

    public static bool CancelWait(bool quiet = false)
    {
        lock (WaitLock)
        {
            if (!_waiting) return false;
            _waiting = false;
            _waitTimer?.Dispose();
            _waitTimer = null;
        }
        if (!quiet) Log("INFO", "Bekleyen yeniden başlatma iptal edildi.");
        return true;
    }

    static async Task CheckWait(HostedSessions hosted)
    {
        if (!_waiting || hosted.AnyBusy || hosted.BackgroundJobs().Count > 0) return;
        if (Interlocked.Exchange(ref _waitChecking, 1) == 1) return;
        try
        {
            if (!CancelWait(quiet: true)) return; // bu arada iptal edildi
            Log("INFO", "İşler bitti; bekleyen yeniden başlatma yapılıyor.");
            await Begin([], [], force: false); // başarısızlık LastError'a yazılır (arayüz /api/version'dan okur)
        }
        finally { Volatile.Write(ref _waitChecking, 0); }
    }

    /// <summary>Yeni süreç devralmadan kapanırsa (anahtar yok, çalışan oturum çıktı, kapatma reddedildi) nedeni sakla.</summary>
    static async Task Watch(Process child)
    {
        await child.WaitForExitAsync();
        if (_handingOver) return;
        var code = child.ExitCode;
        LastError = ErrorOf(code);
        Log("WARN", $"Yeni süreç devralmadan kapandı (çıkış {code}, {LastError}); eski panel açık kalıyor.");
        Volatile.Write(ref _running, 0);
    }

    static string ErrorOf(int code) => code switch
    {
        ExitNoToken => "token", ExitBusy => "busy", ExitQuitFailed => "quit", ExitTimeout => "timeout", _ => "exited"
    };

    static IResult Fail(string error, string message)
    {
        LastError = error;
        Log("WARN", message);
        Volatile.Write(ref _running, 0);
        return Results.Json(new { error }, statusCode: 500);
    }

    /// <summary>Eski süreç: /api/quit devir için çağrıldı (yeni süreç anahtarla geldi). Pencere kapatılmaz.</summary>
    public static void MarkHandingOver() { if (Volatile.Read(ref _running) == 1) _handingOver = true; }

    // ---- Yeni süreç tarafı ----

    public static int? FromPid(string[] args)
    {
        var i = Array.IndexOf(args, FromArg);
        return i >= 0 && i + 1 < args.Length && int.TryParse(args[i + 1], NumberStyles.None, CultureInfo.InvariantCulture, out var pid) ? pid : null;
    }

    /// <summary>Eski paneli kapatır ve bitmesini bekler. 0: devraldı, bu süreç panel olarak açılır; aksi çıkış kodu.</summary>
    public static async Task<int> TakeOver(string baseUrl, int port, int oldPid, bool force)
    {
        var token = Handoff.ReadToken(port);
        if (string.IsNullOrEmpty(token)) { Log("WARN", $"Devir: eski panelin anahtarı yok (port {port}); yeni süreç kapanıyor."); return ExitNoToken; }
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        var r = await Handoff.Quit(http, baseUrl, token, force);
        if (r == HttpStatusCode.Conflict) { Log("WARN", "Devir: panelde çalışan oturum var; eski panel açık kalıyor."); return ExitBusy; }
        if (r != HttpStatusCode.OK) { Log("WARN", $"Devir: eski panel kapatma isteğini reddetti ({(int?)r})."); return ExitQuitFailed; }

        // Eski süreç bitsin (veri dosyaları, tepsi ikonu) ve port boşalsın.
        var deadline = DateTime.UtcNow.AddSeconds(60);
        try
        {
            using var old = Process.GetProcessById(oldPid);
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(60));
            await old.WaitForExitAsync(cts.Token);
        }
        catch (ArgumentException) { /* zaten kapanmış */ }
        catch (OperationCanceledException) { Log("WARN", $"Devir: eski panel (PID {oldPid}) 60 sn'de kapanmadı."); return ExitTimeout; }
        while (DateTime.UtcNow < deadline && await Handoff.RunningVersion(http, baseUrl) is not null) await Task.Delay(250);
        if (await Handoff.RunningVersion(http, baseUrl) is not null) { Log("WARN", "Devir: port boşalmadı."); return ExitTimeout; }
        Log("INFO", $"Devir: eski panel (PID {oldPid}) kapandı; yeni panel PID {Environment.ProcessId}, sürüm {Handoff.Mine.ToString(3)}.");
        return 0;
    }

    public static void Log(string level, string message)
    {
        try
        {
            lock (LogLock)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(LogFile)!);
                if (File.Exists(LogFile) && new FileInfo(LogFile).Length > LogMax) File.Move(LogFile, LogFile + ".1", overwrite: true);
                File.AppendAllText(LogFile, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} [{level}] {message}{Environment.NewLine}");
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* log yazılamadı: iş sürer */ }
    }
}

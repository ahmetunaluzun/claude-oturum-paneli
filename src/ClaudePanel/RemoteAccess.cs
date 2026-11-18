using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace ClaudePanel;

/// <summary>
/// Telefondan erişim. Panel ağa açılmaz (yalnız 127.0.0.1); telefon Tailscale'in kendi yönlendirmesiyle
/// (tailscale serve) https://&lt;bilgisayar&gt;.&lt;ağ&gt;.ts.net adresinden gelir. O adresten gelen her istek,
/// okuma dahil, eşleştirilmiş cihaz anahtarı (çerez) ister. Eşleştirme bu bilgisayardaki panelden başlatılır:
/// tek kullanımlık 6 haneli kod + kare kod, 5 dakika geçerli, 5 yanlış denemede düşer.
/// Cihaz anahtarı diskte yalnız SHA-256 özeti olarak durur; 30 gün kullanılmayan cihaz düşer.
/// </summary>
public sealed class RemoteAccess
{
    public const string CookieName = "cp_dev";
    static readonly TimeSpan PairLifetime = TimeSpan.FromMinutes(5);
    static readonly TimeSpan DeviceIdle = TimeSpan.FromDays(30);
    const int MaxPairAttempts = 5;
    const int MaxDevices = 10;

    static readonly string File_ = Path.Combine(Handoff.DataDir, "remote.json");
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    readonly object _lock = new();
    readonly ILogger<RemoteAccess> _log;
    State _state;
    Pairing? _pairing;
    bool _noSave; // remote.json okunamadı ve kopyası da alınamadı: üzerine yazılırsa cihazlar kaybolur
    string? _tsHost; DateTime _tsCheckedAt;

    public sealed class Device
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
        public string Hash { get; set; } = "";
        public DateTimeOffset Created { get; set; }
        public DateTimeOffset LastSeen { get; set; }
    }
    sealed class State
    {
        public bool Enabled { get; set; }
        public List<Device> Devices { get; set; } = [];
    }
    sealed record Pairing(string Code, string Secret, DateTimeOffset Expires)
    {
        public int Attempts { get; set; }
    }

    // Telefona Tailscale indirme sayfası (sayfa cihaza göre App Store / Play Store'a yönlendirir).
    static string? _appQr;

    /// <summary>Tailscale indirme sayfasının kare kodu. Üretilemezse null döner ve sonraki çağrıda yeniden denenir
    /// (Lazy hatayı da önbelleğe alıyordu: bir kez düşünce Ayarlar'ın telefon bölümü kalıcı 500 veriyordu).</summary>
    static string? AppQr()
    {
        if (_appQr is { } q) return q;
        try { return _appQr = Remote.QrSvg(Tailscale.DownloadPage); }
        catch (Exception ex) when (ex is IOException or FileLoadException or BadImageFormatException or InvalidOperationException)
        {
            RemoteLog.Info($"Kare kod üretilemedi: {ex.GetType().Name}");
            return null;
        }
    }

    public RemoteAccess(ILogger<RemoteAccess> log)
    {
        _log = log;
        _state = Load();
        RemoteLog.Prune();
        RemoteLog.Info($"Açılış: telefondan erişim {(_state.Enabled ? "açık" : "kapalı")}, {_state.Devices.Count} cihaz yüklendi ({string.Join(", ", _state.Devices.Select(d => d.Id))})");
    }

    public bool Enabled { get { lock (_lock) return _state.Enabled; } }

    public void SetEnabled(bool on)
    {
        lock (_lock) { _state.Enabled = on; if (!on) _pairing = null; Save(); }
        _log.LogInformation("Telefondan erişim {Durum}", on ? "açıldı" : "kapatıldı");
        RemoteLog.Info($"Telefondan erişim {(on ? "açıldı" : "kapatıldı")}");
    }

    // ---- Adres ----

    /// <summary>Telefonun geleceği ad: CLAUDE_PANEL_REMOTE_HOST (test) yoksa Tailscale'in bu makineye verdiği ad.</summary>
    public string? Host
    {
        get
        {
            if (Environment.GetEnvironmentVariable("CLAUDE_PANEL_REMOTE_HOST") is { Length: > 0 } h) return h.ToLowerInvariant();
            lock (_lock)
            {
                if (DateTime.UtcNow - _tsCheckedAt < TimeSpan.FromSeconds(30)) return _tsHost;
                _tsCheckedAt = DateTime.UtcNow;
            }
            var host = Tailscale.DnsName();
            lock (_lock)
            {
                if (host != _tsHost) _log.LogInformation("Telefon adresi: {Adres}", host ?? "(Tailscale yok veya bağlı değil)");
                _tsHost = host;
            }
            return host;
        }
    }

    /// <summary>Uzaktan gelen istek kabul edilecek ad mı (erişim açık ve ad bu makinenin Tailscale adı).</summary>
    public bool HostAllowed(string host) =>
        Enabled && Host is { } h && string.Equals(host, h, StringComparison.OrdinalIgnoreCase);

    // ---- Eşleştirme ----

    public (string Code, string Secret, DateTimeOffset Expires) StartPairing()
    {
        var code = RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");
        var secret = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
        var p = new Pairing(code, secret, DateTimeOffset.UtcNow + PairLifetime);
        lock (_lock) _pairing = p;
        _log.LogInformation("Telefon eşleştirmesi başlatıldı, {Dk} dakika geçerli", PairLifetime.TotalMinutes);
        return (p.Code, p.Secret, p.Expires);
    }

    public void CancelPairing() { lock (_lock) _pairing = null; }

    public enum ClaimResult { Ok, Wrong, NoPairing, Full }

    /// <summary>Kod ya da kare koddaki gizli değer doğruysa yeni cihaz anahtarı üretir. Eşleştirme tek kullanımlık.</summary>
    public ClaimResult Claim(string? code, string? secret, string? name, out string token)
    {
        token = "";
        lock (_lock)
        {
            var p = _pairing;
            if (!_state.Enabled || p is null || DateTimeOffset.UtcNow > p.Expires) { _pairing = null; return ClaimResult.NoPairing; }
            var ok = (secret is { Length: > 0 } && FixedEquals(secret, p.Secret))
                     || (code is { Length: 6 } && FixedEquals(code, p.Code));
            if (!ok)
            {
                RemoteLog.Info("Eşleştirme: yanlış kod");
                if (++p.Attempts >= MaxPairAttempts) { _pairing = null; _log.LogWarning("Eşleştirme kodu {N} yanlış denemeden sonra iptal edildi", MaxPairAttempts); }
                return ClaimResult.Wrong;
            }
            _pairing = null;
            Prune();
            if (_state.Devices.Count >= MaxDevices) { RemoteLog.Warn("Eşleştirme: cihaz sınırı dolu"); return ClaimResult.Full; }
            token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
            var now = DateTimeOffset.UtcNow;
            var dev = new Device
            {
                Id = Convert.ToHexString(RandomNumberGenerator.GetBytes(6)).ToLowerInvariant(),
                Name = CleanName(name),
                Hash = HashOf(token),
                Created = now,
                LastSeen = now
            };
            _state.Devices.Add(dev);
            Save();
            _log.LogInformation("Yeni cihaz eşleşti: {Ad}", dev.Name);
            RemoteLog.Info($"Yeni cihaz eşleşti: {dev.Name} ({dev.Id}); toplam {_state.Devices.Count} cihaz");
            return ClaimResult.Ok;
        }
    }

    // ---- Cihaz doğrulama ----

    public Device? Validate(string? token)
    {
        if (token is not { Length: 64 }) return null;
        var hash = HashOf(token);
        lock (_lock)
        {
            var dev = _state.Devices.FirstOrDefault(d => FixedEquals(d.Hash, hash));
            if (dev is null) return null;
            var now = DateTimeOffset.UtcNow;
            if (now - dev.LastSeen > DeviceIdle) { _state.Devices.Remove(dev); Save(); RemoteLog.Info($"Cihaz silindi ({dev.Id}): 30 gündür kullanılmamış"); return null; }
            if (now - dev.LastSeen > TimeSpan.FromMinutes(10)) { dev.LastSeen = now; Save(); } // diske seyrek yaz
            return dev;
        }
    }

    public bool Revoke(string id)
    {
        lock (_lock)
        {
            var n = _state.Devices.RemoveAll(d => d.Id == id);
            if (n > 0) { Save(); _log.LogInformation("Cihaz kaldırıldı ({Id})", id); RemoteLog.Info($"Cihaz silindi ({id}): bilgisayardan kaldırıldı"); }
            return n > 0;
        }
    }

    public object Status() => new
    {
        enabled = Enabled,
        host = Host,
        tailscale = Tailscale.Find() is not null,
        appQr = AppQr(),
        devices = DevicesBrief()
    };

    /// <summary>Telefondaki Ayarlar için salt okunur görünüm: cihaz kimliği ve kare kod yok; istekte bulunan cihaz işaretli.</summary>
    public object View(string? currentId) => new
    {
        enabled = Enabled,
        host = Host,
        devices = DevicesBriefFor(currentId)
    };

    IEnumerable<object> DevicesBriefFor(string? currentId)
    {
        lock (_lock)
        {
            Prune();
            return _state.Devices.Select(d => new
            {
                d.Name, created = d.Created.ToUnixTimeMilliseconds(), lastSeen = d.LastSeen.ToUnixTimeMilliseconds(),
                current = d.Id == currentId
            }).ToList();
        }
    }

    IEnumerable<object> DevicesBrief()
    {
        lock (_lock)
        {
            Prune();
            return _state.Devices.Select(d => new { d.Id, d.Name, created = d.Created.ToUnixTimeMilliseconds(), lastSeen = d.LastSeen.ToUnixTimeMilliseconds() }).ToList();
        }
    }

    // ---- Yardımcılar ----

    void Prune()
    {
        var cut = DateTimeOffset.UtcNow - DeviceIdle;
        var old = _state.Devices.Where(d => d.LastSeen < cut).Select(d => d.Id).ToList();
        if (old.Count == 0) return;
        _state.Devices.RemoveAll(d => d.LastSeen < cut);
        Save();
        RemoteLog.Info($"Cihaz silindi ({string.Join(", ", old)}): 30 gündür kullanılmamış");
    }

    static string CleanName(string? name)
    {
        var s = new string((name ?? "").Where(c => !char.IsControl(c)).ToArray()).Trim();
        if (s.Length == 0) s = "Telefon";
        return s.Length > 40 ? s[..40] : s;
    }

    static string HashOf(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    static bool FixedEquals(string a, string b) =>
        CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(a), Encoding.UTF8.GetBytes(b));

    // Okunamayan dosya boş durumla açılır; ilk Save cihazları silerdi (§AG). Bu yüzden:
    // geçici kilit (eski sürüm o an yazıyor) için kısa yeniden deneme, kalıcı hatada dosyanın kopyası.
    State Load()
    {
        const int tries = 10;
        for (var i = 1; i <= tries; i++)
        {
            try
            {
                if (!File.Exists(File_)) return new State();
                return JsonSerializer.Deserialize<State>(File.ReadAllText(File_), Json) ?? new State();
            }
            catch (IOException ex) when (i < tries)
            {
                RemoteLog.Info($"remote.json okunamadı ({i}. deneme), yeniden deneniyor: {ex.Message}");
                Thread.Sleep(300);
            }
            catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
            {
                var copy = KeepUnreadable();
                _noSave = copy is null;
                _log.LogWarning("remote.json okunamadı, telefondan erişim kapalı başlıyor: {Hata}", ex.Message);
                RemoteLog.Warn($"remote.json okunamadı, boş durumla başlıyor ({ex.Message}); eski dosyanın kopyası: "
                               + (copy ?? "alınamadı, bu açılışta dosyaya yazılmayacak (panel yeniden açılınca tekrar okunur)"));
                break;
            }
        }
        return new State();
    }

    static string? KeepUnreadable()
    {
        try
        {
            var copy = $"{File_}.okunamadi-{DateTime.Now:yyyyMMdd-HHmmss}";
            File.Copy(File_, copy, overwrite: false);
            return copy;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return null; }
    }

    void Save()
    {
        if (_noSave)
        {
            RemoteLog.Warn("remote.json yazılmadı: açılışta okunamamıştı, üzerine yazmak kayıtlı cihazları silerdi");
            return;
        }
        try
        {
            Directory.CreateDirectory(Handoff.DataDir);
            var tmp = File_ + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(_state, Json));
            File.Move(tmp, File_, overwrite: true);
            RemoteLog.Info($"remote.json yazıldı: erişim {(_state.Enabled ? "açık" : "kapalı")}, {_state.Devices.Count} cihaz");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.LogWarning("remote.json yazılamadı: {Hata}", ex.Message);
            RemoteLog.Warn($"remote.json yazılamadı: {ex.Message}");
        }
    }
}

/// <summary>Tailscale komut satırı aracı: kurulu mu, bu makinenin adı ne, panel adrese yönlendirilmiş mi.</summary>
public static class Tailscale
{
    static readonly string[] Candidates =
    [
        @"C:\Program Files\Tailscale\tailscale.exe",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/usr/local/bin/tailscale",
        "/opt/homebrew/bin/tailscale"
    ];

    public static string? Find()
    {
        foreach (var c in Candidates) if (File.Exists(c)) return c;
        var exe = OperatingSystem.IsWindows() ? "tailscale.exe" : "tailscale";
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            if (dir.Length == 0) continue;
            var f = Path.Combine(dir, exe);
            if (File.Exists(f)) return f;
        }
        return null;
    }

    /// <summary>Bu makinenin tailnet adı (ör. masaustu.tail1234.ts.net); bağlı değilse null.</summary>
    public static string? DnsName()
    {
        var r = Run("status --json", 4000);
        if (r is null) return null;
        try
        {
            using var doc = JsonDocument.Parse(r.Value.Out);
            if (doc.RootElement.TryGetProperty("BackendState", out var bs) && bs.GetString() != "Running") return null;
            if (!doc.RootElement.TryGetProperty("Self", out var self) || !self.TryGetProperty("DNSName", out var dn)) return null;
            var name = dn.GetString()?.TrimEnd('.').ToLowerInvariant();
            return string.IsNullOrEmpty(name) ? null : name;
        }
        catch (JsonException) { return null; }
    }

    /// <summary>Tailscale'e "https://&lt;ad&gt; → 127.0.0.1:port" yönlendirmesini kalıcı kurdurur (yalnız tailnet içi).</summary>
    /// Ağda Serve/HTTPS henüz açılmamışsa komut bir onay adresi yazıp bekler: bekleme kesilir, adres döner
    /// (EnableUrl) ve kullanıcı açtıktan sonra yeniden denenir.
    public static (bool Ok, string Message, string? EnableUrl) Serve(int port, bool on)
    {
        var args = on ? $"serve --bg --yes http://127.0.0.1:{port}" : "serve reset";
        var r = Run(args, on ? 8000 : 15000);
        if (r is null) return (false, "notfound", null);
        var msg = (r.Value.Out + "\n" + r.Value.Err).Trim();
        var m = System.Text.RegularExpressions.Regex.Match(msg, @"https://login\.tailscale\.com/\S+");
        var url = m.Success ? m.Value : null;
        return (r.Value.Code == 0 && url is null, msg.Length > 600 ? msg[..600] : msg, url);
    }

    public const string DownloadPage = "https://tailscale.com/download";

    /// <summary>Kurulumu başlatır. Windows'ta winget görünür bir pencerede çalışır (yönetici onayı ister);
    /// winget yoksa ve diğer sistemlerde indirme sayfası döner, kurulumu kullanıcı yapar.</summary>
    public static (bool Started, string? Url) Install()
    {
        if (!OperatingSystem.IsWindows()) return (false, DownloadPage + (OperatingSystem.IsMacOS() ? "/mac" : ""));
        try
        {
            var psi = new ProcessStartInfo("winget")
            {
                UseShellExecute = true, // kendi konsol penceresi: kullanıcı ilerlemeyi ve onay penceresini görür
                ArgumentList = { "install", "--id", "Tailscale.Tailscale", "-e", "--accept-source-agreements", "--accept-package-agreements" }
            };
            return Process.Start(psi) is null ? (false, DownloadPage + "/windows") : (true, null);
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return (false, DownloadPage + "/windows"); // winget yok
        }
    }

    /// <summary>Bağlı değilse "tailscale up" başlatır ve yazdığı giriş adresini döner (komut arka planda girişi bekler).</summary>
    public static string? LoginUrl()
    {
        if (Find() is not { } exe) return null;
        var psi = new ProcessStartInfo(exe, OperatingSystem.IsWindows() ? "up --unattended" : "up")
        {
            RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true
        };
        Process? p;
        try { p = Process.Start(psi); }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or IOException) { return null; }
        if (p is null) return null;
        string? url = null;
        var found = new ManualResetEventSlim();
        void Scan(string? line)
        {
            if (line is null || url is not null) return;
            var m = System.Text.RegularExpressions.Regex.Match(line, @"https://login\.tailscale\.com/\S+");
            if (m.Success) { url = m.Value; found.Set(); }
        }
        p.OutputDataReceived += (_, e) => Scan(e.Data);
        p.ErrorDataReceived += (_, e) => Scan(e.Data);
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        // Giriş zaten yapılmışsa komut hemen biter, adres yoksa null döner. Adres çıktıysa süreç girişi beklemeye devam eder.
        for (var waited = 0; waited < 15000 && !found.IsSet && !p.HasExited; waited += 250) found.Wait(250);
        return url;
    }

    static (int Code, string Out, string Err)? Run(string args, int timeoutMs)
    {
        if (Find() is not { } exe) return null;
        try
        {
            using var p = Process.Start(new ProcessStartInfo(exe, args)
            {
                RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true
            });
            if (p is null) return null;
            var o = p.StandardOutput.ReadToEndAsync();
            var e = p.StandardError.ReadToEndAsync();
            if (!p.WaitForExit(timeoutMs))
            {
                // Zaman aşımı: süreç öldürülür, o ana kadarki çıktı döner (onay adresi orada olabilir).
                try { p.Kill(true); } catch (InvalidOperationException) { }
                p.WaitForExit(2000);
                return (-1, o.IsCompleted ? o.Result : "", e.IsCompleted ? e.Result : "");
            }
            return (p.ExitCode, o.Result, e.Result);
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or IOException or InvalidOperationException)
        {
            return null;
        }
    }
}

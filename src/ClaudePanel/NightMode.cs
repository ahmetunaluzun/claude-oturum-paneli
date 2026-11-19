using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ClaudePanel;

/// <summary>Gece modu ayarları (%LOCALAPPDATA%\ClaudePanel\night.json).</summary>
public sealed class NightSettings
{
    public bool Enabled { get; set; }
    public string Start { get; set; } = "00:30";
    public string End { get; set; } = "07:30";
    /// <summary>Bir oturuma bir gecede en çok kaç kez "devam" gönderilir (sonsuz döngü koruması).</summary>
    public int MaxNudges { get; set; } = 12;
    /// <summary>Haftalık kotadan en az bu kadar yüzde kalmalı; altına inince gece modu durur.</summary>
    public int WeeklyFloor { get; set; } = 10;
    /// <summary>5 saatlik kota bu yüzdeye ulaşınca sıfırlanma beklenir (ekstra ücretli kullanıma kaymasın).</summary>
    public int FiveHourMax { get; set; } = 95;
}

public sealed record NightEvent(long At, string Kind, string? Name, string? Cwd, string? Text);

/// <summary>
/// Gece modu: belirlenen saatlerde "Sizi bekliyor"daki panel oturumlarına devam mesajı gönderir.
/// Oturum [KARAR-BEKLIYOR] yazarsa bir daha dürtülmez (sabah kullanıcı karar verir); [GECE-BITTI] yazarsa iş bitmiştir.
/// Kota dolarsa sıfırlanmayı bekler. Gece boyunca hook'un okuduğu koruma dosyası dışarıya giden işlemleri engeller.
/// </summary>
public sealed class NightMode(HostedSessions hosted, ILogger<NightMode> log) : IDisposable
{
    public const string DecisionMark = "[KARAR-BEKLIYOR]";
    public const string DoneMark = "[GECE-BITTI]";
    static readonly TimeSpan TickEvery = TimeSpan.FromSeconds(60);
    /// <summary>Oturum bu kadar süredir beklemedeyse dürtülür (kaydet/temizle zinciri vb. araya girebilsin).</summary>
    const long IdleBeforeNudgeMs = 90_000;
    const int MaxEvents = 300;

    static readonly string SettingsFile = Path.Combine(Handoff.DataDir, "night.json");
    static readonly string EventsFile = Path.Combine(Handoff.DataDir, "night-events.jsonl");
    /// <summary>Hook (~\.claude\hooks\gece-modu-koruma.py) bu dosyayı okur. Test kopyası canlı korumaya dokunmasın diye veri klasöründe.</summary>
    public static readonly string GuardFile = Path.Combine(Handoff.DataDir, "night-guard.json");
    static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true };

    readonly object _lock = new();
    readonly Dictionary<string, int> _nudges = []; // oturum anahtarı → bu gece gönderilen devam sayısı
    NightSettings _settings = Load();
    Timer? _timer;
    bool _wasActive;
    string? _waitReason; // kota beklemesi: arayüzde gösterilir
    int _usageRefreshing;
    DateTimeOffset _usageCheckedAt;

    public void Start() => _timer = new Timer(_ => Tick(), null, TimeSpan.FromSeconds(20), TickEvery);

    /// <summary>Arayüzün gösterdiği kota önbelleği eskiyse (terminal oturumu yokken statusline yazmaz) arka planda yeniler.</summary>
    public void RefreshUsageSoon()
    {
        if (DateTimeOffset.UtcNow - _usageCheckedAt < TimeSpan.FromMinutes(1)) return;
        if (Interlocked.Exchange(ref _usageRefreshing, 1) == 1) return;
        _usageCheckedAt = DateTimeOffset.UtcNow;
        Task.Run(() => { try { ReadUsage(); } finally { Volatile.Write(ref _usageRefreshing, 0); } });
    }

    public NightSettings Settings { get { lock (_lock) return _settings; } }

    /// <summary>/api/state için hafif özet (her 2,5 sn'de okunur; olay dosyasına dokunmaz).</summary>
    public object Brief() => new { enabled = Settings.Enabled, active = _wasActive, waiting = _waitReason };

    public object Status() => new
    {
        settings = Settings,
        active = _wasActive,
        waiting = _waitReason,
        autostart = Autostart.IsEnabled(),
        autostartSupported = Autostart.Supported,
        events = ReadEvents()
    };

    public string? Update(NightSettings s)
    {
        if (!TryTime(s.Start, out _) || !TryTime(s.End, out _)) return "time";
        s.MaxNudges = Math.Clamp(s.MaxNudges, 1, 100);
        s.WeeklyFloor = Math.Clamp(s.WeeklyFloor, 0, 90);
        s.FiveHourMax = Math.Clamp(s.FiveHourMax, 50, 100);
        lock (_lock)
        {
            _settings = s;
            try
            {
                Directory.CreateDirectory(Handoff.DataDir);
                File.WriteAllText(SettingsFile, JsonSerializer.Serialize(s, Json));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                log.LogWarning("Gece modu ayarı yazılamadı: {Msg}", ex.Message);
                return "io";
            }
        }
        log.LogInformation("Gece modu ayarı: açık={On} {Start}-{End}", s.Enabled, s.Start, s.End);
        _ = Task.Run(Tick);
        return null;
    }

    static NightSettings Load()
    {
        try
        {
            if (File.Exists(SettingsFile))
                return JsonSerializer.Deserialize<NightSettings>(File.ReadAllText(SettingsFile), Json) ?? new();
        }
        catch (Exception ex) when (ex is IOException or JsonException) { }
        return new();
    }

    static bool TryTime(string? s, out TimeSpan t) =>
        TimeSpan.TryParseExact(s, @"hh\:mm", CultureInfo.InvariantCulture, out t) && t < TimeSpan.FromDays(1);

    /// <summary>Gece aralığında mı; aralık gece yarısını geçebilir (00:30–07:30 da 23:00–06:00 da olur).</summary>
    public static bool InWindow(TimeSpan now, TimeSpan start, TimeSpan end) =>
        start <= end ? now >= start && now < end : now >= start || now < end;

    /// <summary>Gece aralığının bitişi (koruma dosyasının son geçerlilik anı; panel ölürse koruma sabah kendiliğinden düşer).</summary>
    static DateTimeOffset WindowEnd(DateTimeOffset now, TimeSpan end)
    {
        var e = new DateTimeOffset(now.Date + end, now.Offset);
        return e > now ? e : e.AddDays(1);
    }

    void Tick()
    {
        if (!Monitor.TryEnter(_lock)) return;
        try { TickCore(); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException or JsonException)
        {
            log.LogWarning("Gece modu turu atlandı: {Msg}", ex.Message);
        }
        finally { Monitor.Exit(_lock); }
    }

    void TickCore()
    {
        var s = _settings;
        var now = DateTimeOffset.Now;
        var active = s.Enabled && TryTime(s.Start, out var start) && TryTime(s.End, out var end)
                     && InWindow(now.TimeOfDay, start, end);
        if (!active)
        {
            if (_wasActive) Event("end", null, null, "Gece modu bitti.");
            _wasActive = false;
            _waitReason = null;
            WriteGuard(null, null);
            AwakeOwners.Want("night", false);
            return;
        }
        if (!_wasActive)
        {
            _nudges.Clear();
            // Dünkü sınır/bitti işaretleri yeni gecede geçmez; karar bekleyen ise kullanıcı yazana kadar bekler.
            foreach (var h in hosted.List().Where(h => h.Night is "limit" or "done")) hosted.SetNight(h.Key, null);
            Event("start", null, null, $"Gece modu başladı ({s.Start}–{s.End}).");
            _wasActive = true;
        }
        // Gece boyunca bilgisayar boşta uyumasın (Windows: SetThreadExecutionState, Mac: caffeinate).
        AwakeOwners.Want("night", true);
        _ = TryTime(s.End, out var endT);
        var sessions = hosted.List();
        WriteGuard(sessions.Select(h => h.SessionId).OfType<string>().ToList(), WindowEnd(now, endT));

        var nowMs = now.ToUnixTimeMilliseconds();
        var candidates = new List<HostedInfo>();
        foreach (var h in sessions)
        {
            if (h.Status != "idle" || h.Task is not null || h.Night is not null) continue;
            var last = hosted.LastResultOf(h.Key) ?? "";
            if (Marked(last, DecisionMark))
            {
                hosted.SetNight(h.Key, "decision");
                Event("decision", h.Name, h.Cwd, Excerpt(last));
                continue;
            }
            if (Marked(last, DoneMark))
            {
                hosted.SetNight(h.Key, "done");
                Event("done", h.Name, h.Cwd, Excerpt(last));
                continue;
            }
            if (nowMs - h.StatusSince < IdleBeforeNudgeMs) continue;
            if (_nudges.GetValueOrDefault(h.Key) >= s.MaxNudges)
            {
                hosted.SetNight(h.Key, "limit");
                Event("limit", h.Name, h.Cwd, $"Bu gece {s.MaxNudges} kez devam ettirildi; sınıra ulaştı, sabahı bekliyor.");
                continue;
            }
            candidates.Add(h);
        }
        if (candidates.Count == 0) return;

        var wait = QuotaWait(s);
        if (wait is not null)
        {
            if (_waitReason != wait) Event("quota", null, null, wait);
            _waitReason = wait;
            return;
        }
        _waitReason = null;

        foreach (var h in candidates)
        {
            if (!hosted.Send(h.Key, Prompt(s), night: true)) continue;
            _nudges[h.Key] = _nudges.GetValueOrDefault(h.Key) + 1;
            Event("nudge", h.Name, h.Cwd, $"Devam gönderildi ({_nudges[h.Key]}/{s.MaxNudges}). Önceki yanıt: {Excerpt(hosted.LastResultOf(h.Key) ?? "")}");
        }
    }

    static string Prompt(NightSettings s) =>
        $"[Gece modu: kullanıcı uyuyor, {s.End}'e kadar cevap veremez.] Kaldığın işe devam et: son mesajını ve proje " +
        "kökündeki NEXT_SESSION.md'yi oku, sıradaki adımı yap, test et; CLAUDE_MEMORY.md ve NEXT_SESSION.md'yi güncelle; " +
        "tutarlı bir aşamada yerel commit at (push yok).\n" +
        $"Şu durumlarda DUR, yanıtının İLK satırına {DecisionMark} yaz, altına kararı ve seçenekleri kısaca yaz:\n" +
        "- dışarıya giden ya da para harcatan işlem (push, yayın, deploy, mail/mesaj, paylaşım, satın alma)\n" +
        "- geri alınamaz silme/üzerine yazma, git geçmişini değiştirme\n" +
        "- kullanıcının tercihine bağlı ürün, tasarım ya da kapsam kararı; önceki mesajında kullanıcıya sorduğun ve cevabı gelmemiş soru\n" +
        "- aynı hatayı iki denemede çözemediysen\n" +
        "Küçük ve geri alınabilir teknik kararlarda en makul yolu seç, gerekçesini NEXT_SESSION.md'ye yaz, devam et. " +
        ScheduledJobs.PromiseRule + " " +
        "AskUserQuestion ve plan modunu kullanma (cevap veren olmaz). " +
        $"Bu oturumda yapılacak iş kalmadıysa yanıtının İLK satırına {DoneMark} yaz.";

    /// <summary>Kota uygun değilse bekleme nedeni; uygunsa null. Kota okunamıyorsa devam edilir (claude kendisi sınırda durur).</summary>
    string? QuotaWait(NightSettings s)
    {
        var u = ReadUsage();
        if (u is null) return null;
        var (five, fiveReset, week, weekReset) = u.Value;
        if (week is { } w && 100 - w < s.WeeklyFloor)
            return $"Haftalık kotadan %{100 - w:0} kaldı (taban %{s.WeeklyFloor}); gece modu bekliyor. Sıfırlanma: {Local(weekReset)}.";
        if (five is { } f && f >= s.FiveHourMax)
            return $"5 saatlik kota %{f:0} dolu; sıfırlanması bekleniyor ({Local(fiveReset)}).";
        return null;
    }

    static string Local(DateTimeOffset? t) => t?.ToLocalTime().ToString("dd.MM HH:mm", CultureInfo.InvariantCulture) ?? "?";

    /// <summary>Kota (Quota.cs): önbellek 5 dakikadan eskiyse API'den yenilenir (gece terminal oturumu yokken statusline çalışmaz).</summary>
    (double? five, DateTimeOffset? fiveReset, double? week, DateTimeOffset? weekReset)? ReadUsage()
    {
        var q = Quota.Read(fetch: true, msg => log.LogDebug("{Msg}", msg));
        if (q is null) return null;
        return (q.Five.Used, q.Five.ResetsAt, q.Week.Used, q.Week.ResetsAt);
    }

    void WriteGuard(List<string>? sessionIds, DateTimeOffset? until)
    {
        try
        {
            if (sessionIds is null)
            {
                if (File.Exists(GuardFile)) File.Delete(GuardFile);
                return;
            }
            Directory.CreateDirectory(Handoff.DataDir);
            var tmp = GuardFile + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(new { until = until!.Value.ToUnixTimeSeconds(), sessions = sessionIds }));
            File.Move(tmp, GuardFile, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            log.LogWarning("Gece koruma dosyası yazılamadı: {Msg}", ex.Message);
        }
    }

    /// <summary>İşaret yanıtın ilk satırında mı (metin içinde anılması sayılmaz).</summary>
    public static bool Marked(string text, string mark) =>
        text.TrimStart().TrimStart('*', '#', '>', ' ', '`').StartsWith(mark, StringComparison.OrdinalIgnoreCase);

    static string Excerpt(string text)
    {
        var t = text.Replace("\r", "").Trim();
        return t.Length > 600 ? t[..600] + "…" : t;
    }

    void Event(string kind, string? name, string? cwd, string? text)
    {
        var e = new NightEvent(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), kind, name, cwd, text);
        log.LogInformation("Gece modu [{Kind}] {Name} {Cwd}: {Text}", kind, name, cwd, text);
        try
        {
            Directory.CreateDirectory(Handoff.DataDir);
            if (File.Exists(EventsFile) && new FileInfo(EventsFile).Length > 1_000_000)
                File.Move(EventsFile, EventsFile + ".old", overwrite: true);
            File.AppendAllText(EventsFile, JsonSerializer.Serialize(e, Json).Replace("\r", "").Replace("\n", "") + "\n");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            log.LogWarning("Gece modu olayı yazılamadı: {Msg}", ex.Message);
        }
    }

    /// <summary>Son olaylar (en yeni üstte). Dosyada durur: Windows yeniden başlasa da sabah rapor görünür.</summary>
    static List<NightEvent> ReadEvents()
    {
        try
        {
            if (!File.Exists(EventsFile)) return [];
            return File.ReadLines(EventsFile).TakeLast(MaxEvents).Reverse()
                .Select(l => { try { return JsonSerializer.Deserialize<NightEvent>(l, Json); } catch (JsonException) { return null; } })
                .OfType<NightEvent>().ToList();
        }
        catch (IOException) { return []; }
    }

    public void Dispose()
    {
        _timer?.Dispose();
        AwakeOwners.Want("night", false);
        // Panel kapanınca koruma kalmasın diye silinmez: dosyanın kendi bitiş anı var; panel yeniden açılınca güncellenir.
    }
}

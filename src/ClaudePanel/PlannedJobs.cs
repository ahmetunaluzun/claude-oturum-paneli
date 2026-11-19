using System.Globalization;
using System.Text.Json;

namespace ClaudePanel;

/// <summary>Planlı işin son çalışması. State: waiting | running | done | decision | review | nochange | failed | skipped | missed | merged | discarded.</summary>
public sealed class PlanRun
{
    public long At { get; set; }
    public string State { get; set; } = "running";
    /// <summary>Ayrıntı kodu: quota | insession | nogit | worktree | restart | active | timeout | nostart | conflict … (arayüz çevirir).</summary>
    public string? Code { get; set; }
    public string? Detail { get; set; }
    public string? Summary { get; set; }
    public string? SessionKey { get; set; }
    public double CostUsd { get; set; }
    public long? EndedAt { get; set; }
    // "Düzelt, kontrolüme bırak": ayrı çalışma kopyası ve dalı.
    public string? Root { get; set; }
    public string? Worktree { get; set; }
    public string? Branch { get; set; }
    public string? Base { get; set; }
    public int Commits { get; set; }
    public List<string> Files { get; set; } = [];
}

/// <summary>
/// Kind: session (görünür panel oturumu) | review (ayrı çalışma kopyasında, commit dalda, push yok) | warmup (kota penceresini erken başlat).
/// Repeat: once (Date + Time) | daily | weekdays. Saatler yereldir.
/// </summary>
public sealed class PlanJob
{
    public string Id { get; set; } = "";
    public string Kind { get; set; } = "session";
    public string? Cwd { get; set; }
    public string? Name { get; set; }
    public string? Prompt { get; set; }
    public string? Model { get; set; }
    public string Time { get; set; } = "07:00";
    public string Repeat { get; set; } = "once";
    public string? Date { get; set; }
    public string Lang { get; set; } = "tr";
    public bool Enabled { get; set; } = true;
    public long CreatedAt { get; set; }
    public long? NextAt { get; set; }
    public PlanRun? Last { get; set; }
}

/// <summary>
/// Planlı işler (0.16.0): kullanıcının belirlediği saatte projeye özel istem çalıştırır. Kota tabanları gece modu ayarından gelir;
/// kota ya da projede açık oturum yüzünden bekleyen iş, saatinden en çok <see cref="Grace"/> sonrasına kadar yeniden denenir,
/// sonra "kaçırıldı" sayılır (panel kapalı / bilgisayar uykudaysa da aynı). Panel kendiliğinden push, birleştirme ya da silme yapmaz:
/// "kontrolüme bırak" işinin dalını kullanıcı Takip'te birleştirir ya da atar.
/// </summary>
public sealed partial class PlannedJobs(HostedSessions hosted, ProjectGuard guard, NightMode night, ILogger<PlannedJobs> log) : IDisposable
{
    public static readonly TimeSpan Grace = TimeSpan.FromHours(3), WarmupGrace = TimeSpan.FromHours(1), AwakeAhead = TimeSpan.FromHours(12);
    static readonly TimeSpan TickEvery = TimeSpan.FromSeconds(30);
    public const int MaxJobs = 50, SummaryMax = 1200;
    public static readonly HashSet<string> Kinds = ["session", "review", "warmup"], Repeats = ["once", "daily", "weekdays"];
    static readonly string FilePath = Path.Combine(Handoff.DataDir, "planned.json");
    static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true };

    readonly object _lock = new();
    List<PlanJob> _jobs = [];
    Timer? _timer;

    static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    public void Start()
    {
        lock (_lock)
        {
            _jobs = Load();
            // Panel kapanırken süren iş: oturumu yaşamaz; kopya dalında commit varsa kontrol bekler.
            foreach (var j in _jobs.Where(j => j.Last?.State == "running")) PlanRunner.AfterRestart(j.Last!);
            Save();
        }
        _timer = new Timer(_ => Tick(), null, TimeSpan.FromSeconds(15), TickEvery);
    }

    public List<PlanJob> List() { lock (_lock) return _jobs.Select(Clone).ToList(); }
    public PlanJob? Get(string id) { lock (_lock) return _jobs.FirstOrDefault(j => j.Id == id) is { } j ? Clone(j) : null; }
    static PlanJob Clone(PlanJob j) => JsonSerializer.Deserialize<PlanJob>(JsonSerializer.Serialize(j, Json), Json)!;

    /// <summary>Yeni iş ya da güncelleme (Id varsa). Dönen: hata kodu ya da null.</summary>
    public (PlanJob? Job, string? Error) Upsert(PlanJob input)
    {
        if (!Kinds.Contains(input.Kind) || !Repeats.Contains(input.Repeat)) return (null, "plan");
        if (!TryTime(input.Time, out _)) return (null, "time");
        if (input.Kind != "warmup")
        {
            var err = HostedSessions.Validate(input.Cwd, input.Prompt, input.Model);
            if (err is not null) return (null, err);
            if (string.IsNullOrWhiteSpace(input.Prompt)) return (null, "prompt");
            if (input.Kind == "review" && ProjectRoots.GitRoot(input.Cwd!) is null) return (null, "nogit");
        }
        var next = Next(input, DateTime.Now);
        if (next is null) return (null, input.Repeat == "once" ? "past" : "time");
        lock (_lock)
        {
            var old = input.Id.Length > 0 ? _jobs.FirstOrDefault(j => j.Id == input.Id) : null;
            if (old is null && _jobs.Count >= MaxJobs) return (null, "toomany");
            if (old?.Last?.State == "running") return (null, "planbusy");
            var job = new PlanJob
            {
                Id = old?.Id ?? Guid.NewGuid().ToString("N")[..10], Kind = input.Kind, Time = input.Time, Repeat = input.Repeat,
                Date = input.Repeat == "once" ? input.Date : null, Lang = input.Lang == "en" ? "en" : "tr",
                Cwd = input.Kind == "warmup" ? null : input.Cwd, Prompt = input.Kind == "warmup" ? null : input.Prompt!.Trim(),
                Model = input.Kind == "warmup" ? "haiku" : input.Model, Name = string.IsNullOrWhiteSpace(input.Name) ? null : input.Name.Trim(),
                Enabled = true, CreatedAt = old?.CreatedAt ?? Now(), NextAt = new DateTimeOffset(next.Value).ToUnixTimeMilliseconds(), Last = old?.Last
            };
            if (old is null) _jobs.Add(job); else _jobs[_jobs.IndexOf(old)] = job;
            Save();
            log.LogInformation("Planlı iş kaydedildi {Id} tür={Kind} {Repeat} {Time} klasör={Cwd}", job.Id, job.Kind, job.Repeat, job.Time, job.Cwd);
            return (Clone(job), null);
        }
    }

    public string? Remove(string id)
    {
        lock (_lock)
        {
            var j = _jobs.FirstOrDefault(x => x.Id == id);
            if (j is null) return "noplan";
            if (j.Last?.State is "running" or "review") return "planbusy"; // önce birleştir/at
            _jobs.Remove(j);
            Save();
            return null;
        }
    }

    public string? SetEnabled(string id, bool on)
    {
        lock (_lock)
        {
            var j = _jobs.FirstOrDefault(x => x.Id == id);
            if (j is null) return "noplan";
            if (on) { var n = Next(j, DateTime.Now); if (n is null) return "past"; j.NextAt = new DateTimeOffset(n.Value).ToUnixTimeMilliseconds(); }
            j.Enabled = on;
            Save();
            return null;
        }
    }

    /// <summary>"Şimdi çalıştır": saatini beklemeden bir kez çalışır (tekrarlı işin planı değişmez).</summary>
    public string? RunNow(string id)
    {
        PlanJob job;
        lock (_lock)
        {
            var j = _jobs.FirstOrDefault(x => x.Id == id);
            if (j is null) return "noplan";
            if (j.Last?.State is "running" or "review") return "planbusy";
            job = j;
        }
        var wait = TryRun(job, manual: true);
        if (wait is not null) return wait;
        lock (_lock) Save();
        return null;
    }

    /// <summary>Kontrol bekleyen işin sonucu değişti (birleştirildi / atıldı).</summary>
    public void Update(string id, Action<PlanRun> change)
    {
        lock (_lock)
        {
            if (_jobs.FirstOrDefault(x => x.Id == id)?.Last is not { } run) return;
            change(run);
            Save();
        }
    }

    void Tick()
    {
        if (!Monitor.TryEnter(_lock)) return;
        try
        {
            var now = DateTime.Now;
            var nowMs = Now();
            foreach (var j in _jobs.Where(j => j.Enabled && j.NextAt is { } t && t <= nowMs && j.Last?.State is not ("running" or "review")).ToList())
            {
                var late = TimeSpan.FromMilliseconds(nowMs - j.NextAt!.Value);
                if (late > (j.Kind == "warmup" ? WarmupGrace : Grace))
                {
                    j.Last = new PlanRun { At = j.NextAt.Value, State = "missed", Code = j.Last?.State == "waiting" ? j.Last.Code : null, EndedAt = nowMs };
                    log.LogInformation("Planlı iş kaçırıldı {Id} ({Late} dk geç)", j.Id, (int)late.TotalMinutes);
                    Advance(j, now);
                    continue;
                }
                var wait = TryRun(j, manual: false);
                if (wait is null) Advance(j, now);
                else if (j.Last?.State != "waiting" || j.Last.Code != wait) j.Last = new PlanRun { At = j.NextAt.Value, State = "waiting", Code = wait };
            }
            Save();
            // Bilgisayar planlı işe yakın saatlerde ve iş sürerken uyanık kalır (kapak kapatma yine uyutur).
            var ahead = nowMs + (long)AwakeAhead.TotalMilliseconds;
            AwakeOwners.Want("plans", _jobs.Any(j => j.Last?.State == "running" || (j.Enabled && j.NextAt is { } t && t <= ahead)));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException or JsonException)
        {
            log.LogWarning("Planlı işler turu atlandı: {Msg}", ex.Message);
        }
        finally { Monitor.Exit(_lock); }
    }

    /// <summary>İşi başlatır; başlatamazsa bekleme nedeni (quota | insession). Kalıcı hata durumu Last'a yazılır, null döner.</summary>
    string? TryRun(PlanJob j, bool manual)
    {
        if (QuotaWait() is { } q && j.Kind != "warmup") return q;
        if (j.Kind == "session" && guard.SessionsIn(ProjectRoots.Of(j.Cwd!)).Count > 0) return "insession";
        var run = new PlanRun { At = Now(), State = "running" };
        lock (_lock) j.Last = run;
        log.LogInformation("Planlı iş başlıyor {Id} tür={Kind} elle={Manual}", j.Id, j.Kind, manual);
        var runner = new PlanRunner(hosted, log, j, run, () => { lock (_lock) Save(); });
        _ = Task.Run(runner.Run);
        return null;
    }

    /// <summary>Gece modu kota tabanları: haftalık taban altında ya da 5 saatlik dolu → "quota". Okunamıyorsa engel yok.</summary>
    string? QuotaWait()
    {
        var q = Quota.Read(fetch: true);
        if (q is null) return null;
        var s = night.Settings;
        if (q.Week.Used is { } w && 100 - w < s.WeeklyFloor) return "quota";
        if (q.Five.Used is { } f && f >= s.FiveHourMax) return "quota";
        return null;
    }

    static void Advance(PlanJob j, DateTime now)
    {
        if (j.Repeat == "once") { j.Enabled = false; j.NextAt = null; return; }
        var n = Next(j, now);
        j.NextAt = n is null ? null : new DateTimeOffset(n.Value).ToUnixTimeMilliseconds();
    }

    /// <summary>Sonraki çalışma anı (yerel). Tek seferlikte tarih geçmişse (1 dk pay) null.</summary>
    public static DateTime? Next(PlanJob j, DateTime from)
    {
        if (!TryTime(j.Time, out var time)) return null;
        if (j.Repeat == "once")
        {
            if (!DateTime.TryParseExact(j.Date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d)) return null;
            var at = d.Date + time;
            return at < from.AddMinutes(-1) ? null : at;
        }
        var c = from.Date + time;
        if (c <= from) c = c.AddDays(1);
        if (j.Repeat == "weekdays") while (c.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) c = c.AddDays(1);
        return c;
    }

    static bool TryTime(string? s, out TimeSpan t) =>
        TimeSpan.TryParseExact(s, @"hh\:mm", CultureInfo.InvariantCulture, out t) && t < TimeSpan.FromDays(1);

    static List<PlanJob> Load()
    {
        try { return File.Exists(FilePath) ? JsonSerializer.Deserialize<List<PlanJob>>(File.ReadAllText(FilePath), Json) ?? [] : []; }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            // Okunamayan dosya ezilmesin: kenara alınır (kullanıcının planları kaybolmasın).
            try { File.Copy(FilePath, FilePath + ".bozuk", overwrite: true); } catch (IOException) { }
            return [];
        }
    }

    void Save()
    {
        try
        {
            Directory.CreateDirectory(Handoff.DataDir);
            var tmp = FilePath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(_jobs, Json));
            File.Move(tmp, FilePath, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            log.LogWarning("Planlı işler yazılamadı: {Msg}", ex.Message);
        }
    }

    public void Dispose()
    {
        _timer?.Dispose();
        AwakeOwners.Want("plans", false);
    }
}

/// <summary>Bilgisayarı uyanık tutma isteği birden çok yerden gelir (gece modu, planlı işler); biri istedikçe uyanık kalır.</summary>
public static class AwakeOwners
{
    static readonly HashSet<string> Owners = [];
    public static void Want(string owner, bool on)
    {
        lock (Owners)
        {
            if (on) Owners.Add(owner); else Owners.Remove(owner);
            KeepAwake.Set(Owners.Count > 0);
        }
    }
}

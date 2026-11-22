namespace ClaudePanel;

/// <summary>
/// Proje (çalışma klasörü) başına çalışma süresi, token ve API fiyatıyla tahmini maliyet: ~/.claude/projects altındaki
/// tüm konuşma kayıtları (alt ajanlar dahil). Tarama arka planda, düşük öncelikli iş parçacığında; dosya başına
/// (yol + boyut + değişme zamanı) önbellek, büyüyen dosya kaldığı yerden okunur. Arayüz isteği beklemez: hazır değilse
/// ready:false döner, arayüz birkaç saniye sonra yeniden sorar. Hiçbir dosyaya yazılmaz.
/// Tekilleştirme: aynı yanıt (message.id) bir kayıtta birden çok satırda, ayrıca klasör adı değişince iki proje klasöründe
/// aynı oturum kopyası olarak bulunabiliyor (ölçüldü: 40.580 tekil kimliğin 18.093'ü birden çok dosyada) → kimlik bir kez sayılır.
/// Süre: her kayıtta ardışık iki kayıt arası 5 dakikayı aşmayan aralıklar; projede aralıkların birleşimi (paralel
/// oturum ve alt ajan aynı dakikayı iki kez saymaz).
/// </summary>
public sealed class ProjectCost(ILogger<ProjectCost> log)
{
    static readonly TimeSpan Stale = TimeSpan.FromSeconds(15); // sonraki istek arka planda yeniden tarar (değişmeyen dosya yalnız stat)
    readonly Dictionary<string, CostFile> _files = new(StringComparer.OrdinalIgnoreCase); // yalnız tarama iş parçacığı
    volatile Snapshot? _snap;
    int _running;

    public sealed record ModelRow(string Model, long Input, long Output, long CacheRead, long CacheWrite, double? Cost);
    public sealed record Row(string Cwd, string Name, long ActiveMs, int Sessions, long LastActive, long Input, long Output,
        long CacheRead, long CacheWrite, double Cost, bool CostComplete, bool CostKnown, IReadOnlyList<string> UnknownModels,
        IReadOnlyList<ModelRow> Models);
    public sealed record Snapshot(long ScannedAt, long ScanMs, int Files, Dictionary<string, List<Row>> Periods);

    /// <summary>GET /api/cost yanıtı. Önbellek eskiyse arka planda yeniler (yanıtı bekletmez).</summary>
    public object Get()
    {
        var s = _snap;
        if (s is null || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - s.ScannedAt > Stale.TotalMilliseconds) Kick();
        return new
        {
            ready = s is not null, scanning = Volatile.Read(ref _running) == 1, scannedAt = s?.ScannedAt, scanMs = s?.ScanMs,
            files = s?.Files, source = CostPrices.Source, asOf = CostPrices.AsOf, gapMinutes = CostFile.GapMs / 60_000,
            periods = s?.Periods
        };
    }

    void Kick()
    {
        if (Interlocked.CompareExchange(ref _running, 1, 0) != 0) return;
        new Thread(Run) { IsBackground = true, Priority = ThreadPriority.BelowNormal, Name = "ProjectCost" }.Start();
    }

    void Run()
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            Scan();
            _snap = Compute(sw.ElapsedMilliseconds);
            log.LogInformation("Proje maliyeti tarandı: {Files} kayıt, {Ms} ms", _files.Count, sw.ElapsedMilliseconds);
        }
        // Arka plan iş parçacığında yakalanmayan hata paneli kapatır: beklenmeyen her hata loglanır, son sonuç kalır.
        catch (Exception ex)
        {
            log.LogWarning(ex, "Proje maliyeti taranamadı");
        }
        finally { Volatile.Write(ref _running, 0); }
    }

    void Scan()
    {
        var dir = Path.Combine(Quota.ClaudeDir, "projects");
        if (!Directory.Exists(dir)) { _files.Clear(); return; }
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var projectDir in Directory.EnumerateDirectories(dir))
        foreach (var f in Directory.EnumerateFiles(projectDir, "*.jsonl", SearchOption.AllDirectories))
        {
            seen.Add(f);
            try
            {
                var fi = new FileInfo(f);
                if (!_files.TryGetValue(f, out var a)) _files[f] = a = new CostFile(f, projectDir);
                if (a.Size == fi.Length && a.Mtime == fi.LastWriteTimeUtc) continue;
                a.Advance();
                a.Size = fi.Length;
                a.Mtime = fi.LastWriteTimeUtc;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                log.LogDebug("Maliyet: kayıt okunamadı {Path}: {Msg}", f, ex.Message);
            }
        }
        foreach (var gone in _files.Keys.Where(k => !seen.Contains(k)).ToList()) _files.Remove(gone);
    }

    sealed class Acc(string cwd)
    {
        public readonly string Cwd = cwd;
        public readonly List<CostFile.Msg> Msgs = [];
        public readonly List<(bool Top, List<long[]> Segs)> Files = [];
    }

    Snapshot Compute(long scanMs)
    {
        var dirCwd = _files.Values.Where(f => f.Cwd is not null).GroupBy(f => f.ProjectDir, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.OrderByDescending(f => f.Mtime).First().Cwd!, StringComparer.OrdinalIgnoreCase);
        string? CwdOf(CostFile f) => f.Cwd
            ?? (f.ParentPath is { } p && _files.TryGetValue(p, out var parent) ? parent.Cwd : null)
            ?? dirCwd.GetValueOrDefault(f.ProjectDir);

        var accs = new Dictionary<string, Acc>(StringComparer.OrdinalIgnoreCase);
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var f in _files.Values.OrderBy(f => f.Sub).ThenBy(f => f.Path, StringComparer.Ordinal))
        {
            if (CwdOf(f) is not { } cwd) continue;
            var key = cwd.TrimEnd('\\', '/');
            if (!accs.TryGetValue(key, out var acc)) accs[key] = acc = new Acc(key);
            acc.Files.Add((!f.Sub, f.Segs));
            foreach (var (id, m) in f.Msgs) if (ids.Add(id)) acc.Msgs.Add(m);
        }

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var periods = new Dictionary<string, List<Row>>
        {
            ["7"] = Rows(accs.Values, now - TimeSpan.FromDays(7).Ticks / 10_000),
            ["30"] = Rows(accs.Values, now - TimeSpan.FromDays(30).Ticks / 10_000),
            ["all"] = Rows(accs.Values, 0),
        };
        return new Snapshot(now, scanMs, _files.Count, periods);
    }

    static List<Row> Rows(IEnumerable<Acc> accs, long since) =>
        accs.Select(a => RowOf(a, since)).Where(r => r is not null).Select(r => r!)
            .OrderByDescending(r => r.Cost).ThenByDescending(r => r.Input + r.Output + r.CacheRead + r.CacheWrite).ToList();

    static Row? RowOf(Acc a, long since)
    {
        var msgs = a.Msgs.Where(m => m.Ts >= since).ToList();
        var segs = a.Files.SelectMany(f => f.Segs).Where(s => s[1] >= since).Select(s => (S: Math.Max(s[0], since), E: s[1]))
            .OrderBy(s => s.S).ToList();
        if (msgs.Count == 0 && segs.Count == 0) return null;
        long active = 0, curS = 0, curE = -1;
        foreach (var (s, e) in segs)
        {
            if (s > curE) { if (curE >= curS) active += curE - curS; curS = s; curE = e; }
            else if (e > curE) curE = e;
        }
        if (curE >= curS) active += curE - curS;
        var sessions = a.Files.Count(f => f.Top && f.Segs.Any(s => s[1] >= since));
        var models = msgs.GroupBy(m => m.Model ?? "?").Select(g => new ModelRow(g.Key, g.Sum(m => m.In), g.Sum(m => m.Out),
                g.Sum(m => m.Read), g.Sum(m => m.Write), g.All(m => m.Cost is not null) ? Math.Round(g.Sum(m => m.Cost ?? 0), 4) : null))
            .OrderByDescending(m => m.Cost ?? 0).ThenByDescending(m => m.Input + m.Output + m.CacheRead + m.CacheWrite).ToList();
        var unknown = msgs.Where(m => m.Cost is null).Select(m => m.Model ?? "?").Distinct().ToList();
        var name = Path.GetFileName(a.Cwd) is { Length: > 0 } n ? n : a.Cwd;
        return new Row(a.Cwd, name, active, sessions, segs.Count > 0 ? segs.Max(s => s.E) : msgs.Max(m => m.Ts),
            msgs.Sum(m => m.In), msgs.Sum(m => m.Out), msgs.Sum(m => m.Read), msgs.Sum(m => m.Write),
            Math.Round(msgs.Sum(m => m.Cost ?? 0), 4), unknown.Count == 0, msgs.Any(m => m.Cost is not null), unknown, models);
    }
}

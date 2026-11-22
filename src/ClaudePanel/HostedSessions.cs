using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace ClaudePanel;

public sealed record HostedInfo(string Key, string? SessionId, string Cwd, string? Name, string Status,
    long StartedAt, long StatusSince, string? Model, string? LastError, double CostUsd, string? Task, string? Night);

/// <summary>
/// Panelin kendi içinde çalıştırdığı oturumlar: claude -p --input-format stream-json ile açık kalan süreç.
/// Mesaj stdin'e satır olarak yazılır; durum stdout akışından (init / result) izlenir.
/// </summary>
public sealed partial class HostedSessions(ILogger<HostedSessions> log, ContextWindows windows) : IDisposable
{
    static readonly UTF8Encoding Utf8 = new(false);
    static readonly HashSet<string> Models = ["", "opus", "sonnet", "haiku", "fable"];
    readonly ConcurrentDictionary<string, Hosted> _sessions = new();

    sealed class Hosted
    {
        public required string Key;
        public required Process Proc;
        public required string Cwd;
        public string? Name, Model, SessionId, LastError;
        public string Status = "starting";
        public long StartedAt, StatusSince;
        public double Cost;
        public bool Interrupting;
        public List<string> Commands = [];
        public readonly object WriteLock = new();
        /// <summary>Kaydet/temizle/kapat zinciri: önceki adım bitince (result) sıradaki gönderilir.</summary>
        public readonly Queue<string> Then = new();
        public bool StopWhenDone;
        public string? Task; // "clearing" | "closing" | null
        /// <summary>Son yanıtın metni (gece modu karar/bitti işaretini buradan okur).</summary>
        public string? LastResult;
        /// <summary>Gece modu durumu: "decision" (karar bekliyor) | "done" (iş kalmadı) | null. Kullanıcı yazınca silinir.</summary>
        public string? Night;
        /// <summary>Takip sekmesinin arka plan işi: kart olarak görünmez, açılışta geri getirilmez (FollowJobs.cs).</summary>
        public bool Hidden;
        /// <summary>Son yanıt hata ile bitti.</summary>
        public bool LastFailed;
    }

    /// <summary>Panel ya da Windows yeniden başlarken çalışmakta olan oturuma, geri bağlanınca gönderilir.</summary>
    const string ResumePrompt =
        "Panel ya da bilgisayar yeniden başladı; bu oturumdaki iş yarıda kesildi. Önce son durumu kontrol et " +
        "(git status, yarım kalmış dosya düzenlemesi, NEXT_SESSION.md), sonra kaldığın yerden devam et.";

    /// <summary>/smart-clear komutu olmayan kurulumlarda kayıt adımı.</summary>
    const string SavePrompt =
        "Bu oturumu temizlemeden/kapatmadan önce durumu kaydet: proje kökündeki CLAUDE_MEMORY.md'yi " +
        "(yapılanlar, yarım kalanlar, kararlar) ve NEXT_SESSION.md'yi (sıradaki adımlar, dosya yolları, başlangıç noktası) " +
        "güncelle. " + ScheduledJobs.PromiseRule + " Yarım dosya düzenlemesi bırakma. Başka iş yapma; bitince ne kaydettiğini bir iki cümleyle yaz.";

    /// <summary>Kayıt /smart-clear ile yapılıyorsa (istem bizim değil) verilmiş söz kuralı ayrı kısa mesajla, kayıttan SONRA gönderilir.</summary>
    const string PromisePrompt = ScheduledJobs.PromiseRule + " Başka iş yapma; satır eklediysen ya da sildiysen tek cümleyle söyle, yoksa yalnız \"söz yok\" yaz.";

    public IReadOnlyList<string>? CommandsOf(string key) =>
        _sessions.TryGetValue(key, out var h) ? h.Commands : null;

    /// <summary>Görünen oturumlar (arka plan işleri hariç).</summary>
    public IReadOnlyList<HostedInfo> List() => ListAll(includeHidden: false);

    /// <summary>Arka plan işleri dahil: aynı projede çalışan oturum denetimi için (ProjectGuard).</summary>
    public IReadOnlyList<HostedInfo> ListAll(bool includeHidden = true) => _sessions.Values
        .Where(h => includeHidden || !h.Hidden)
        .Select(h => new HostedInfo(h.Key, h.SessionId, h.Cwd, h.Name, h.Status, h.StartedAt, h.StatusSince,
            h.Model, h.LastError, h.Cost, h.Task, h.Night))
        .OrderBy(h => h.StartedAt).ToList();

    public static string? Validate(string? cwd, string? prompt, string? model)
    {
        if (string.IsNullOrWhiteSpace(cwd) || !Directory.Exists(cwd)) return "folder";
        if (prompt is { Length: > 20_000 }) return "prompt";
        if (model is not null && !Models.Contains(model)) return "model";
        return null;
    }

    /// <summary>Yeni oturum açar; resumeId verilirse o oturumu kaldığı yerden sürdürür.</summary>
    /// <param name="hidden">Arka plan işi: oturum listesinde görünmez, diske yazılmaz.</param>
    public string Start(string cwd, string? prompt, string? model, string? name, string? resumeId, bool hidden = false)
    {
        if (string.IsNullOrWhiteSpace(prompt)) prompt = null;
        var psi = new ProcessStartInfo(Launcher.ClaudeExe())
        {
            WorkingDirectory = cwd,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Utf8,
            StandardErrorEncoding = Utf8,
            StandardInputEncoding = Utf8
        };
        foreach (var a in new[] { "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose" })
            psi.ArgumentList.Add(a);
        if (!string.IsNullOrEmpty(model)) { psi.ArgumentList.Add("--model"); psi.ArgumentList.Add(model); }
        if (!string.IsNullOrWhiteSpace(name)) { psi.ArgumentList.Add("--name"); psi.ArgumentList.Add(name.Trim()); }
        if (resumeId is not null && Guid.TryParse(resumeId, out _)) { psi.ArgumentList.Add("--resume"); psi.ArgumentList.Add(resumeId); }
        // Gece koruması panelle birlikte gelir; ~/.claude/hooks altında betik olmayan bilgisayarda (Mac) da çalışır.
        if (NightGuard.SettingsArg() is { } guard) { psi.ArgumentList.Add("--settings"); psi.ArgumentList.Add(guard); }

        var sw = Stopwatch.StartNew();
        var proc = Process.Start(psi) ?? throw new InvalidOperationException("claude başlatılamadı");
        var startMs = sw.ElapsedMilliseconds;
        // Panel çökse/öldürülse de claude süreci sahipsiz kalmasın (0.4.5: önceki panelin süreci çalışmaya devam ediyordu).
        KillOnPanelExit.Add(proc);
        var now = Now();
        var h = new Hosted
        {
            Key = Guid.NewGuid().ToString("N")[..12], Proc = proc, Cwd = cwd, Name = name, Model = model,
            SessionId = resumeId, StartedAt = now, StatusSince = now, Status = "idle", Hidden = hidden
        };
        _sessions[h.Key] = h;
        Persist();
        _ = Task.Run(() => PumpStdout(h));
        _ = Task.Run(() => PumpStderr(h));
        log.LogInformation("Panel oturumu başladı {Key} klasör={Cwd} model={Model} resume={Resume}", h.Key, cwd, model, resumeId);
        if (!string.IsNullOrWhiteSpace(prompt)) Send(h.Key, prompt);
        // Başlatma süresi dosya loguna: yanıtın geciktiği durumda nedeni (süreç açılışı mı) ölçülebilsin.
        RemoteLog.Info($"Panel oturumu başlatıldı {h.Key}: süreç açılışı {startMs} ms, toplam {sw.ElapsedMilliseconds} ms, klasör {cwd}");
        return h.Key;
    }

    /// <param name="night">true: gece modu gönderdi; kullanıcının yazdığı mesaj gece durumunu (karar bekliyor) siler.</param>
    public bool Send(string key, string text, bool night = false)
    {
        if (!_sessions.TryGetValue(key, out var h) || h.Proc.HasExited) return false;
        if (!night) h.Night = null;
        var line = JsonSerializer.Serialize(new
        {
            type = "user",
            message = new { role = "user", content = text }
        });
        lock (h.WriteLock)
        {
            h.Proc.StandardInput.WriteLine(line);
            h.Proc.StandardInput.Flush();
        }
        h.LastError = null;
        SetStatus(h, "busy");
        return true;
    }

    /// <summary>
    /// Oturumu kaydettirir; ardından close ise kapatır, değilse /clear + "devam" ile temiz bağlamda sürdürür
    /// (yeni bağlam NEXT_SESSION.md'den devam eder). Oturum çalışıyorsa zincir o iş bitince başlar.
    /// </summary>
    public bool Wrap(string key, bool close)
    {
        if (!_sessions.TryGetValue(key, out var h) || h.Proc.HasExited) return false;
        var save = h.Commands.Contains("smart-clear") ? "/smart-clear" : SavePrompt;
        lock (h.Then)
        {
            h.Then.Clear();
            h.Then.Enqueue(save);
            if (save != SavePrompt) h.Then.Enqueue(PromisePrompt);
            if (!close) { h.Then.Enqueue("/clear"); h.Then.Enqueue("devam"); }
            h.StopWhenDone = close;
            h.Task = close ? "closing" : "clearing";
        }
        if (h.Status == "idle") Advance(h);
        return true;
    }

    /// <summary>Zincirin sıradaki adımı; adım kalmadıysa kapatır ya da zinciri bitirir.</summary>
    void Advance(Hosted h)
    {
        string? next = null;
        var stop = false;
        lock (h.Then)
        {
            if (h.Task is null) return;
            if (h.Then.Count > 0) next = h.Then.Dequeue();
            else if (h.StopWhenDone) stop = true;
            else h.Task = null;
        }
        if (next is not null) Send(h.Key, next);
        else if (stop) _ = System.Threading.Tasks.Task.Run(() => Stop(h.Key));
    }

    /// <summary>Mesajı iş bitince gönderir (oturum boştaysa hemen). Kartta "iş bitince: devam et" olarak görünür.</summary>
    public bool SendWhenDone(string key, string text)
    {
        if (!_sessions.TryGetValue(key, out var h) || h.Proc.HasExited) return false;
        lock (h.Then)
        {
            h.Then.Clear();
            h.Then.Enqueue(text);
            h.StopWhenDone = false;
            h.Task = "continuing";
        }
        if (h.Status == "idle") Advance(h);
        return true;
    }

    /// <summary>Bekleyen "iş bitince" zincirini iptal eder (çalışan iş sürer).</summary>
    public bool CancelTask(string key)
    {
        if (!_sessions.TryGetValue(key, out var h)) return false;
        CancelChain(h);
        return true;
    }

    void CancelChain(Hosted h)
    {
        lock (h.Then) { h.Then.Clear(); h.StopWhenDone = false; h.Task = null; }
    }

    /// <summary>Çalışan işi keser (oturum açık kalır).</summary>
    public bool Interrupt(string key)
    {
        if (!_sessions.TryGetValue(key, out var h) || h.Proc.HasExited) return false;
        var line = JsonSerializer.Serialize(new
        {
            type = "control_request",
            request_id = Guid.NewGuid().ToString("N"),
            request = new { subtype = "interrupt" }
        });
        lock (h.WriteLock)
        {
            h.Proc.StandardInput.WriteLine(line);
            h.Proc.StandardInput.Flush();
        }
        h.Interrupting = true;
        CancelChain(h); // kullanıcı durdurdu: kaydet/temizle zinciri de durur
        return true;
    }

    /// <summary>Oturumu kapatır (konuşma kaydı diskte kalır, sonra sürdürülebilir).</summary>
    public bool Stop(string key) => Stop(key, forget: true);

    /// <param name="forget">true: kullanıcı kapattı, açılışta geri getirilmez. false: panel kapanıyor, listede kalır.</param>
    bool Stop(string key, bool forget)
    {
        if (!_sessions.TryRemove(key, out var h)) return false;
        if (forget) Persist();
        try
        {
            h.Proc.StandardInput.Close();
            if (!h.Proc.WaitForExit(3000)) h.Proc.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException) { /* zaten kapanmış */ }
        h.Proc.Dispose();
        return true;
    }

    async Task PumpStdout(Hosted h)
    {
        try
        {
            string? line;
            while ((line = await h.Proc.StandardOutput.ReadLineAsync()) is not null)
                Handle(h, line);
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException)
        {
            log.LogDebug("Akış kapandı {Key}: {Msg}", h.Key, ex.Message);
        }
        SetStatus(h, "ended");
    }

    async Task PumpStderr(Hosted h)
    {
        try
        {
            string? line;
            while ((line = await h.Proc.StandardError.ReadLineAsync()) is not null)
                if (!string.IsNullOrWhiteSpace(line)) h.LastError = line.Length > 400 ? line[..400] : line;
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException) { }
    }

    void Handle(Hosted h, string line)
    {
        try
        {
            using var doc = JsonDocument.Parse(line);
            var r = doc.RootElement;
            var type = r.TryGetProperty("type", out var t) ? t.GetString() : null;
            if (r.TryGetProperty("session_id", out var sid) && sid.ValueKind == JsonValueKind.String
                && sid.GetString() != h.SessionId)
            {
                h.SessionId = sid.GetString();
                Persist();
            }
            if (type == "system" && r.TryGetProperty("model", out var m) && m.ValueKind == JsonValueKind.String)
                h.Model = m.GetString();
            // Oturumun kullanabildiği / komutları (init olayında gelir): panelde "/" listesi için
            if (type == "system" && r.TryGetProperty("slash_commands", out var sc) && sc.ValueKind == JsonValueKind.Array)
                h.Commands = sc.EnumerateArray().Select(x => x.ValueKind == JsonValueKind.String ? x.GetString()
                    : x.TryGetProperty("name", out var n) ? n.GetString() : null).OfType<string>().ToList();
            if (type == "result")
            {
                if (r.TryGetProperty("total_cost_usd", out var cost) && cost.ValueKind == JsonValueKind.Number)
                    h.Cost = cost.GetDouble();
                windows.LearnFromResult(h.SessionId, r);
                if (r.TryGetProperty("result", out var text) && text.ValueKind == JsonValueKind.String)
                    h.LastResult = text.GetString() is { Length: > 4000 } lr ? lr[..4000] : text.GetString();
                // Kullanıcının durdurduğu iş hata sayılmaz.
                var failed = false;
                h.LastFailed = false;
                if (h.Interrupting) h.Interrupting = false;
                else if (r.TryGetProperty("is_error", out var err) && err.ValueKind == JsonValueKind.True)
                {
                    h.LastError = r.TryGetProperty("result", out var res) ? res.ToString() : "error";
                    failed = true;
                    h.LastFailed = true;
                }
                SetStatus(h, "idle");
                // Kayıt başarısızsa oturum kapatılmaz/temizlenmez; hata kartta görünür.
                if (failed) CancelChain(h);
                else Advance(h);
            }
        }
        catch (JsonException)
        {
            // JSON olmayan satır: yok say (ör. uyarı metni)
        }
    }

    void SetStatus(Hosted h, string status)
    {
        if (h.Status == status) return;
        var wasBusy = h.Status == "busy";
        h.Status = status;
        h.StatusSince = Now();
        // Çalışıyor bilgisi diskte dursun: Windows yeniden başlarsa yarıda kalan iş açılışta sürdürülür.
        if (wasBusy != (status == "busy") && status != "ended") Persist();
    }

    /// <summary>Oturum hâlâ listede mi (kapatılmadı).</summary>
    public bool Has(string key) => _sessions.ContainsKey(key);

    public bool IsHidden(string key) => _sessions.TryGetValue(key, out var h) && h.Hidden;

    /// <summary>Arka plan işinin izlediği durum: oturum yoksa null.</summary>
    public (string Status, string? LastResult, bool Failed, string? LastError)? Peek(string key) =>
        _sessions.TryGetValue(key, out var h) ? (h.Status, h.LastResult, h.LastFailed, h.LastError) : null;

    /// <summary>Arka plan işini görünen oturuma çevirir (kullanıcının kararı gerekiyor); bundan sonra açılışta da geri gelir.</summary>
    public bool Unhide(string key)
    {
        if (!_sessions.TryGetValue(key, out var h)) return false;
        h.Hidden = false;
        Persist();
        return true;
    }

    /// <summary>Gece modunun okuduğu son yanıt metni.</summary>
    public string? LastResultOf(string key) => _sessions.TryGetValue(key, out var h) ? h.LastResult : null;

    public void SetNight(string key, string? state)
    {
        if (_sessions.TryGetValue(key, out var h)) h.Night = state;
    }

    static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    // ---- Panel yeniden açılınca oturumları geri getirme ----
    // CLAUDE_PANEL_DATA: test kopyası canlı panelin oturum listesine dokunmasın diye ayrı klasör.
    static readonly string StateFile = Path.Combine(
        Environment.GetEnvironmentVariable("CLAUDE_PANEL_DATA") is { Length: > 0 } d ? d
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ClaudePanel"),
        "hosted.json");
    readonly object _persistLock = new();

    /// <param name="Busy">Kayıt anında çalışıyordu (eski dosyalarda yok → false).</param>
    sealed record Saved(string SessionId, string Cwd, string? Name, string? Model, bool Busy = false);
    volatile bool _closing; // panel kapanıyor: listeyi artık yeniden yazma (oturumlar tek tek düşerken liste boşalmasın)

    /// <summary>Açık panel oturumlarının listesini diske yazar (oturum kimliği belli olanlar).</summary>
    void Persist()
    {
        if (_closing) return;
        var list = _sessions.Values.Where(h => h.SessionId is not null && !h.Hidden)
            .Select(h => new Saved(h.SessionId!, h.Cwd, h.Name, h.Model, h.Status == "busy"))
            .Concat(_pending) // henüz bağlanamamış olanlar da listede kalır
            .GroupBy(s => s.SessionId).Select(g => g.First()).ToList();
        lock (_persistLock)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(StateFile)!);
                var tmp = StateFile + ".tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(list));
                File.Move(tmp, StateFile, overwrite: true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                log.LogWarning("Panel oturum listesi yazılamadı: {Msg}", ex.Message);
            }
        }
    }

    /// <summary>Panel açılışında, kapanışta açık olan oturumları kaldıkları yerden yeniden bağlar.</summary>
    public int Restore()
    {
        if (!File.Exists(StateFile)) return 0;
        List<Saved>? saved;
        try { saved = JsonSerializer.Deserialize<List<Saved>>(File.ReadAllText(StateFile)); }
        catch (Exception ex) when (ex is IOException or JsonException)
        {
            log.LogWarning("Panel oturum listesi okunamadı: {Msg}", ex.Message);
            return 0;
        }
        _pending = (saved ?? []).Where(s => Guid.TryParse(s.SessionId, out _) && Directory.Exists(s.Cwd)).ToList();
        var n = RestorePending();
        // Başka bir süreçte hâlâ açık olanlar beklemede kalır; o süreç bitince bağlanır (iki süreç aynı konuşmaya yazmasın).
        if (_pending.Count > 0)
            _retry = new Timer(_ => RestorePending(), null, TimeSpan.FromSeconds(15), TimeSpan.FromSeconds(15));
        return n;
    }

    List<Saved> _pending = [];
    Timer? _retry;

    int RestorePending()
    {
        var n = 0;
        lock (_persistLock)
        {
            var running = RunningClaude();
            foreach (var s in _pending.ToList())
            {
                if (_sessions.Values.Any(h => h.SessionId == s.SessionId)) { _pending.Remove(s); continue; }
                var other = running.Where(r => r.CommandLine.Contains(s.SessionId, StringComparison.OrdinalIgnoreCase)).ToList();
                // Önceki panelin sahipsiz kalan süreci: çıktısı hiçbir yere gitmiyor, kimse ona yazamıyor → kapat, biz bağlanalım.
                foreach (var r in other.Where(r => r.IsOrphanPanelProcess))
                {
                    log.LogWarning("Önceki panelden sahipsiz kalan oturum süreci kapatılıyor: PID {Pid}, oturum {Sid}", r.Pid, s.SessionId);
                    try { using var op = Process.GetProcessById(r.Pid); op.Kill(entireProcessTree: true); op.WaitForExit(5000); }
                    catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
                    { log.LogDebug("Sahipsiz süreç kapatılamadı {Pid}: {Msg}", r.Pid, ex.Message); }
                }
                if (other.Any(r => !r.IsOrphanPanelProcess)) continue;
                _pending.Remove(s);
                var model = s.Model is { } m && (Models.Contains(m) || System.Text.RegularExpressions.Regex.IsMatch(m, "^claude-[a-z0-9.-]+$")) ? m : null;
                Start(s.Cwd, s.Busy ? ResumePrompt : null, model, s.Name, s.SessionId);
                if (s.Busy) log.LogInformation("Yarıda kalan iş sürdürülüyor: oturum {Sid} klasör={Cwd}", s.SessionId, s.Cwd);
                n++;
            }
            if (_pending.Count == 0) { _retry?.Dispose(); _retry = null; }
        }
        if (n > 0) log.LogInformation("Panel oturumları geri getirildi: {N}, bekleyen: {P}", n, _pending.Count);
        return n;
    }

    /// <summary>Geri getirilmeyi bekleyen oturumlar (arayüzde gösterilir).</summary>
    public int PendingCount => _pending.Count;

    /// <summary>Panel kapanırken oturumlar kapatılır ama listede kalır; açılışta geri gelir.</summary>
    public void Dispose()
    {
        Persist();
        _closing = true;
        foreach (var key in _sessions.Keys.ToList()) Stop(key, forget: false);
    }

    public bool AnyBusy => _sessions.Values.Any(h => h.Status == "busy");

    /// <summary>Çalışan panel oturumlarının adları (ad yoksa klasör adı); yeniden başlatma reddinde gösterilir.</summary>
    public IReadOnlyList<string> BusyNames => _sessions.Values.Where(h => h.Status == "busy")
        .Select(h => h.Name is { Length: > 0 } n ? n : Path.GetFileName(h.Cwd.TrimEnd('\\', '/'))).ToList();
}

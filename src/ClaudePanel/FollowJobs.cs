using System.Collections.Concurrent;

namespace ClaudePanel;

/// <summary>
/// Bir işin tek deposu (Kind "git") ya da tek kütüğü (Kind "ledger": Root = kütük dosyasının yolu).
/// State: "queued" | "committing" | "checking" | "pushing" | "closing" | "done" | "failed" | "decision" | "skipped".
/// </summary>
public sealed class FollowJobItem
{
    public required string Root { get; init; }
    public required string Name { get; init; }
    public bool Commit { get; init; }
    public bool Push { get; init; }
    public string Kind { get; init; } = "git";
    /// <summary>Kütük işinde: Drive'a yüklendiği bildirilen dosyalar.</summary>
    public IReadOnlyList<string> Files { get; init; } = [];
    public string State { get; set; } = "queued";
    /// <summary>Sonuç kodu: "ok" | "secret" | "rejected" | "auth" | "timeout" | "noremote" | "nothing" | "insession" | "busy" | "nogit" | "failed" | "decision" | "unchanged".</summary>
    public string? Code { get; set; }
    public int Committed { get; set; }
    public int Pushed { get; set; }
    public IReadOnlyList<SecretFinding> Findings { get; set; } = [];
    public string? Detail { get; set; }
    /// <summary>Commit oturumunun son yanıtı (işaret satırı atılmış, kısaltılmış).</summary>
    public string? Summary { get; set; }
    /// <summary>Karar gerekince görünür hâle getirilen oturumun anahtarı.</summary>
    public string? SessionKey { get; set; }
    public long UpdatedAt { get; set; }
}

public sealed record FollowJob(string Id, long CreatedAt, IReadOnlyList<FollowJobItem> Items, string? Lang)
{
    public bool Active => Items.Any(i => i.State is "queued" or "committing" or "checking" or "pushing" or "closing");
}

/// <summary>
/// Takip sekmesinden başlatılan commit / gönder işleri. Oturum kartı olarak GÖRÜNMEZ:
/// - Gönder: panel doğrudan `git push` yapar (claude yok); önce gönderilecek commit'ler gizli bilgi için denetlenir.
/// - Commit et: gizli panel oturumu (HostedSessions hidden) değişiklikleri commit eder; yanıtının son satırı
///   [PANEL-TAMAM] ise oturum kapatılır, [PANEL-KARAR] / hata / belirsizlikte oturum görünür yapılır ("Kararın gerekiyor").
/// Tek işçi: işler ve depolar sırayla işlenir; aynı depoya ikinci iş kuyruğa alınmaz.
/// </summary>
public sealed class FollowJobs(HostedSessions hosted, ProjectGuard guard, FollowUp followUp, ILogger<FollowJobs> log)
{
    public const string DoneMark = "[PANEL-TAMAM]", DecisionMark = "[PANEL-KARAR]";
    static readonly TimeSpan CommitTimeout = TimeSpan.FromMinutes(15), KeepFinished = TimeSpan.FromMinutes(30);
    const int SummaryMax = 600;
    readonly List<FollowJob> _jobs = [];
    readonly BlockingCollection<FollowJob> _queue = [];
    readonly object _lock = new();
    int _started;

    static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    static string CommitPrompt(string? lang) => lang == "en"
        ? "Review the uncommitted changes in this repository and commit the relevant files with meaningful messages. " +
          "Do not add files that contain secrets (passwords, tokens, .env, .claude/settings.local.json). Do not push; do nothing else. " +
          $"If everything went fine, write only {DoneMark} on the LAST line of your reply. If the user's decision is needed " +
          "(possible secret, conflict, unclear what to commit), force nothing: explain briefly and write only " +
          $"{DecisionMark} on the LAST line."
        : "Bu depodaki commit'lenmemiş değişiklikleri incele ve ilgili dosyaları anlamlı mesajlarla commit et. " +
          "Gizli bilgi içeren dosyayı (parola, token, .env, .claude/settings.local.json) ekleme. Push etme; başka iş yapma. " +
          $"Her şey yolundaysa yanıtının SON satırına yalnız {DoneMark} yaz. Kullanıcının kararı gerekiyorsa " +
          "(gizli bilgi şüphesi, çakışma, neyin commit edileceği belirsiz) hiçbir şeyi zorlama: nedenini kısaca açıkla ve " +
          $"SON satıra yalnız {DecisionMark} yaz.";

    public IReadOnlyList<FollowJob> List()
    {
        lock (_lock)
        {
            var cutoff = Now() - (long)KeepFinished.TotalMilliseconds;
            _jobs.RemoveAll(j => !j.Active && j.Items.All(i => i.UpdatedAt < cutoff));
            return _jobs.ToList();
        }
    }

    /// <summary>Bu depoda süren ya da sırada bekleyen iş var mı.</summary>
    public bool ActiveIn(string root)
    {
        lock (_lock) return _jobs.Any(j => j.Items.Any(i => ProjectRoots.Same(i.Root, root) && i.State is "queued" or "committing" or "checking" or "pushing" or "closing"));
    }

    /// <summary>İşi kuyruğa alır. Depolardan biri için zaten iş varsa o depo işe girmez; hiç depo kalmazsa null.</summary>
    public FollowJob? Enqueue(IEnumerable<(string Root, string Name, bool Commit, bool Push)> repos, string? lang)
    {
        FollowJob job;
        lock (_lock)
        {
            var items = repos.Where(r => !_jobs.Any(j => j.Items.Any(i => ProjectRoots.Same(i.Root, r.Root) && i.State is "queued" or "committing" or "checking" or "pushing" or "closing")))
                .GroupBy(r => r.Root, StringComparer.OrdinalIgnoreCase).Select(g => g.First())
                .Select(r => new FollowJobItem { Root = r.Root, Name = r.Name, Commit = r.Commit, Push = r.Push, UpdatedAt = Now() }).ToList();
            if (items.Count == 0) return null;
            job = new FollowJob(Guid.NewGuid().ToString("N")[..10], Now(), items, lang == "en" ? "en" : "tr");
            _jobs.Add(job);
        }
        Start(job);
        return job;
    }

    /// <summary>Kütüğü kapat işini kuyruğa alır; o kütük için zaten iş varsa null.</summary>
    public FollowJob? EnqueueLedger(string ledger, string name, IReadOnlyList<string> files, string? lang)
    {
        FollowJob job;
        lock (_lock)
        {
            if (ActiveIn(ledger)) return null;
            job = new FollowJob(Guid.NewGuid().ToString("N")[..10], Now(),
                [new FollowJobItem { Root = ledger, Name = name, Kind = "ledger", Files = files, UpdatedAt = Now() }], lang == "en" ? "en" : "tr");
            _jobs.Add(job);
        }
        Start(job);
        return job;
    }

    void Start(FollowJob job)
    {
        _queue.Add(job);
        if (Interlocked.Exchange(ref _started, 1) == 0) new Thread(Worker) { IsBackground = true, Name = "takip-isleri" }.Start();
    }

    void Worker()
    {
        foreach (var job in _queue.GetConsumingEnumerable())
        {
            foreach (var item in job.Items)
            {
                try { RunItem(item, job.Lang); }
                catch (Exception ex) when (ex is IOException or InvalidOperationException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
                {
                    log.LogWarning("Takip işi yarıda kaldı ({Root}): {Msg}", item.Root, ex.Message);
                    Finish(item, "failed", ex is System.ComponentModel.Win32Exception ? "nogit" : "failed");
                }
            }
            followUp.Refresh(); // depo durumu yeniden okunsun
        }
    }

    static void Set(FollowJobItem item, string state) { item.State = state; item.UpdatedAt = Now(); }
    static void Finish(FollowJobItem item, string state, string code) { item.Code = code; Set(item, state); }

    void RunItem(FollowJobItem item, string? lang)
    {
        if (item.Kind == "ledger") { LedgerStep(item, lang); return; }
        var before = GitOps.Status(item.Root);
        if (before is null) { Finish(item, "failed", "failed"); return; }
        var others = guard.SessionsIn(item.Root);
        // Açık oturumu olan projede arka plan işi ikinci oturum olurdu; yalnız gönderme, kimse çalışmıyorsa yapılır.
        if (others.Any(s => s.Status == "busy")) { Finish(item, "skipped", "busy"); return; }

        if (item.Commit && before.Value.Dirty > 0)
        {
            if (others.Count > 0) { Finish(item, "skipped", "insession"); return; }
            if (!CommitStep(item, before.Value.Head, lang)) return;
        }
        if (!item.Push) { Finish(item, "done", "ok"); return; }

        var now = GitOps.Status(item.Root);
        if (now is null) { Finish(item, "failed", "failed"); return; }
        if (!now.Value.HasRemote) // uzak depo yok: commit yapıldıysa iş tamam, yalnız gönderme istendiyse hata
        {
            if (item.Commit) Finish(item, "done", "ok"); else Finish(item, "failed", "noremote");
            return;
        }
        Set(item, "checking");
        var check = GitOps.PushCheck(item.Root);
        if (check.Findings.Count > 0)
        {
            item.Findings = check.Findings;
            RemoteLog.Warn($"Takip: gönderim durduruldu, gizli bilgi denetimi {check.Findings.Count} bulgu verdi ({item.Root})"); // değer yazılmaz
            Finish(item, "failed", "secret");
            return;
        }
        Set(item, "pushing");
        var push = GitOps.Push(item.Root);
        item.Pushed = push.Pushed;
        item.Findings = push.Findings;
        item.Detail = push.Detail;
        RemoteLog.Info($"Takip: git push {push.Code}, {push.Pushed} commit ({item.Root})");
        Finish(item, push.Ok || push.Code == "nothing" ? "done" : "failed", push.Code);
    }

    /// <summary>Gizli oturumla commit. true: commit tamam, sıradaki adıma geçilebilir.</summary>
    bool CommitStep(FollowJobItem item, string headBefore, string? lang)
    {
        Set(item, "committing");
        return HiddenStep(item, item.Root, CommitPrompt(lang), $"Takip: commit · {item.Name}", () => item.Committed = GitOps.CommitsSince(item.Root, headBefore));
    }

    /// <summary>
    /// Kütüğü kapat: gizli oturum kütükte bildirilen dosyaları "yüklendi" olarak işler. Panel kütüğe kendisi yazmaz.
    /// Oturum "tamam" dese de kütük değişmediyse iş başarısız sayılır (işaret satırı kanıt değildir).
    /// </summary>
    void LedgerStep(FollowJobItem item, string? lang)
    {
        var dir = Path.GetDirectoryName(item.Root)!;
        if (!File.Exists(item.Root)) { Finish(item, "failed", "failed"); return; }
        var others = guard.SessionsIn(ProjectRoots.Of(dir));
        if (others.Count > 0) { Finish(item, "skipped", others.Any(s => s.Status == "busy") ? "busy" : "insession"); return; }
        var before = File.ReadAllText(item.Root);
        Set(item, "closing");
        if (!HiddenStep(item, dir, LedgerPrompt(item.Files, lang), $"Takip: kütük · {item.Name}", null)) return;
        if (File.ReadAllText(item.Root) == before) { Finish(item, "failed", "unchanged"); return; }
        RemoteLog.Info($"Takip: kütük güncellendi, {item.Files.Count} dosya ({item.Root})");
        Finish(item, "done", "ok");
    }

    static string LedgerPrompt(IReadOnlyList<string> files, string? lang)
    {
        var list = string.Join("\n", files.Select(f => "- " + f));
        var day = DateTime.Now.ToString("dd.MM.yyyy");
        return lang == "en"
            ? $"In the {DriveLedger.FileName} file in this folder, the files below are listed as still to be uploaded to Drive (open). " +
              $"The user marked them as uploaded in the panel today ({day}):\n{list}\n" +
              "Update the ledger accordingly, following the ledger's own way of closing entries (for example the heading's open marker replaced by " +
              "the closed marker with the date and a note that the user confirmed the upload). If only some files of a section were uploaded, " +
              "record those as closed and leave the rest open. Change nothing else in the ledger, touch no other file, do not commit or push. " +
              $"If everything went fine, write only {DoneMark} on the LAST line of your reply. If the user's decision is needed, change nothing: " +
              $"explain briefly and write only {DecisionMark} on the LAST line."
            : $"Bu klasördeki {DriveLedger.FileName} dosyasında aşağıdaki dosyalar Drive'a yüklenecek (AÇIK) olarak duruyor. " +
              $"Kullanıcı bunları bugün ({day}) panelde \"Yükledim\" diye işaretledi:\n{list}\n" +
              "Kütüğü buna göre güncelle; kütüğün kendi kapatma biçimine uy (örneğin başlıktaki AÇIK yerine KAPATILDI + tarih + " +
              "kullanıcının yüklediğini bildirdiği notu). Bir bölümdeki dosyaların yalnız bir kısmı yüklendiyse yüklenenleri kapatılmış olarak " +
              "kaydet, kalanları AÇIK bırak. Kütükte başka hiçbir yeri değiştirme, başka dosyaya dokunma, commit ya da push yapma. " +
              $"Her şey yolundaysa yanıtının SON satırına yalnız {DoneMark} yaz. Kullanıcının kararı gerekiyorsa hiçbir şeyi değiştirme: " +
              $"nedenini kısaca açıkla ve SON satıra yalnız {DecisionMark} yaz.";
    }

    /// <summary>Gizli oturumda tek istem çalıştırır. true: oturum işaret satırıyla "tamam" dedi ve kapatıldı.</summary>
    bool HiddenStep(FollowJobItem item, string cwd, string prompt, string title, Action? afterReply)
    {
        var key = hosted.Start(cwd, prompt, null, title, null, hidden: true);
        var deadline = DateTime.UtcNow + CommitTimeout;
        (string Status, string? LastResult, bool Failed, string? LastError)? st;
        while (true)
        {
            Thread.Sleep(400);
            st = hosted.Peek(key);
            if (st is null || st.Value.Status != "busy" || DateTime.UtcNow > deadline) break;
        }
        afterReply?.Invoke();
        var text = st?.LastResult ?? "";
        item.Summary = Shorten(text);
        var done = st is { Status: "idle", Failed: false } && LastLine(text).Contains(DoneMark, StringComparison.Ordinal);
        if (done)
        {
            hosted.Stop(key);
            return true;
        }
        // Karar, hata, zaman aşımı ya da işaretsiz yanıt: oturum görünür olur, kullanıcı konuşmayı açıp karar verir.
        if (st is null || st.Value.Status == "ended")
        {
            if (st is not null) hosted.Stop(key);
            item.Detail = GitOps.Scrub(st?.LastError ?? "");
            Finish(item, "failed", "failed");
            return false;
        }
        hosted.Unhide(key);
        item.SessionKey = key;
        Finish(item, "decision", "decision");
        return false;
    }

    static string LastLine(string s) => s.Split('\n').Select(l => l.Trim()).LastOrDefault(l => l.Length > 0) ?? "";

    static string Shorten(string s)
    {
        s = s.Replace(DoneMark, "").Replace(DecisionMark, "").Trim();
        return s.Length > SummaryMax ? s[..SummaryMax].TrimEnd() + "…" : s;
    }
}

using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace ClaudePanel;

/// <param name="Repo">"sahip/depo".</param>
/// <param name="LastBy">Son sözü söyleyen (yorum yoksa açan); son yorum okunamadıysa null.</param>
/// <param name="Waiting">Cevap bekliyor: son söz kullanıcıda değil.</param>
/// <param name="Root">Deponun bilinen yerel klasörü (origin adresi eşleşen git kökü); yoksa null. Okurken doldurulur.</param>
public sealed record GhItem(string Repo, int Number, string Title, string Author, int Comments, long UpdatedAt, bool Pr, string Url,
    string? LastBy, bool Waiting, string? Root = null);

/// <param name="State">"off" | "pending" (henüz denenmedi) | "nogh" | "noauth" | "failed" (hiç alınamadı) | "ok".</param>
/// <param name="CheckedAt">Listenin alındığı an (Unix ms); hiç alınmadıysa 0.</param>
/// <param name="TriedAt">Son deneme (Unix ms).</param>
/// <param name="Stale">Son deneme başarısız: liste son bilinen durumdur ("alamadım", "boş liste" değil).</param>
public sealed record GhSnapshot(string State, string? Login, IReadOnlyList<GhItem> Items, long CheckedAt, long TriedAt, bool Stale, bool Fetching)
{
    public static readonly GhSnapshot Off = new("off", null, [], 0, 0, false, false);
}

/// <summary>
/// Takip → GitHub: kullanıcının kendi depolarındaki açık issue ve PR'lar, GitHub CLI (`gh`) ile. YALNIZ OKUR: `gh api` GET çağrıları
/// (user, search/issues, issues/N/comments); GitHub'a hiçbir şey yazmaz, ek giriş/anahtar istemez (gh'nin kendi girişi kullanılır,
/// anahtar okunmaz ve loglanmaz). Ağa <see cref="Every"/> aralıkla çıkılır (panel penceresi kapalıyken de: bildirim için);
/// Takip taraması bunu tetiklemez. Son yorumcu yalnız değişen (updated_at) öğe için sorulur. Alınamazsa son bilinen liste kalır.
/// Yeni "cevap bekliyor" öğesi bir kez sistem bildirimi verir (ilk denetimde var olanlar için tek toplu bildirim).
/// </summary>
public sealed partial class GitHubWatch(ILogger<GitHubWatch> log)
{
    static readonly string StateFile = Path.Combine(Handoff.DataDir, "github-watch.json");
    static readonly TimeSpan Every = TimeSpan.FromMinutes(15), RetryAfter = TimeSpan.FromMinutes(5), TickEvery = TimeSpan.FromMinutes(1);
    const int TimeoutMs = 15_000, FirstTickMs = 4000, MaxItems = 50, TitleMax = 200;

    /// <param name="Fail">Son denemenin sonucu: "" (başarılı) | "nogh" | "noauth" | "net".</param>
    sealed record Saved(bool Enabled = true, string? Login = null, long TriedAt = 0, long OkAt = 0, string Fail = "", List<GhItem>? Items = null);

    volatile Saved _s = Load();
    readonly object _gate = new();
    int _running, _force;
    System.Threading.Timer? _timer;

    /// <summary>Sistem bildirimi (başlık, metin); Program.cs tepsiye bağlar.</summary>
    public Action<string, string>? Notify { get; set; }

    public bool Enabled => _s.Enabled;

    public void Start() => _timer = new System.Threading.Timer(_ => Tick(), null, FirstTickMs, (int)TickEvery.TotalMilliseconds);

    /// <summary>Aç/kapat (kalıcı). Açılınca hemen denetlenir.</summary>
    public void SetEnabled(bool on)
    {
        Update(s => s with { Enabled = on });
        if (on) Poke();
    }

    /// <summary>Kullanıcı "Yenile"ye bastı: süre dolmasa da şimdi denetle.</summary>
    public void Poke()
    {
        Interlocked.Exchange(ref _force, 1);
        Tick();
    }

    /// <param name="roots">"sahip/depo" (küçük harf) → yerel git kökü; satırdaki "Oturumda ele al" için.</param>
    public GhSnapshot Snapshot(IReadOnlyDictionary<string, string>? roots = null)
    {
        var s = _s;
        if (!s.Enabled) return GhSnapshot.Off;
        var fetching = _running == 1;
        if (s.Fail is "nogh" or "noauth") return new(s.Fail, s.Login, [], 0, s.TriedAt, false, fetching);
        if (s.OkAt == 0) return new(s.TriedAt == 0 ? "pending" : "failed", s.Login, [], 0, s.TriedAt, false, fetching);
        var items = (s.Items ?? []).Select(i => roots is not null && roots.TryGetValue(i.Repo.ToLowerInvariant(), out var r) ? i with { Root = r } : i with { Root = null }).ToList();
        return new("ok", s.Login, items, s.OkAt, s.TriedAt, s.Fail.Length > 0, fetching);
    }

    void Tick()
    {
        var s = _s;
        if (!s.Enabled) return;
        var forced = Interlocked.Exchange(ref _force, 0) == 1;
        var wait = s.Fail.Length == 0 ? Every : RetryAfter;
        if (!forced && Now() - s.TriedAt < wait.TotalMilliseconds) return;
        if (Interlocked.Exchange(ref _running, 1) == 1) { if (forced) Interlocked.Exchange(ref _force, 1); return; }
        _ = Task.Run(() =>
        {
            try { Fetch(); }
            catch (Exception ex) when (ex is IOException or InvalidOperationException or JsonException or AggregateException)
            {
                log.LogWarning("GitHub denetimi yarıda kaldı: {Msg}", ex.Message);
                Update(s => s with { TriedAt = Now(), Fail = "net" });
            }
            finally { Interlocked.Exchange(ref _running, 0); }
        });
    }

    void Fetch()
    {
        var prev = _s;
        var now = Now();
        if (FindExe() is not { } gh) { Fail(now, "nogh", "gh bulunamadı"); return; }
        if (Run(gh, "api", "user") is not { } u) { Fail(now, "nogh", "gh çalıştırılamadı"); return; }
        var login = u.Code == 0 && JsonNode.Parse(u.Out)?["login"] is JsonValue lv && lv.TryGetValue<string>(out var l) && LoginRx().IsMatch(l) ? l : null;
        if (login is null) { Fail(now, u.Code == 0 ? "net" : Why(u), FirstLine(u.Err)); return; }
        // Yalnız kullanıcının kendi depoları (user:<giriş>); kuruluş depoları kapsam dışı.
        var r = Run(gh, "api", "-X", "GET", "search/issues", "-f", $"q=user:{login} is:open", "-f", $"per_page={MaxItems}", "-f", "sort=updated", "-f", "order=desc");
        if (r is not { Code: 0 } ok || JsonNode.Parse(ok.Out)?["items"] is not JsonArray arr)
        {
            Fail(now, r is { } bad ? Why(bad) : "nogh", r is { } b2 ? FirstLine(b2.Err) : "gh çalıştırılamadı");
            return;
        }
        var old = (prev.Items ?? []).ToDictionary(Key, StringComparer.OrdinalIgnoreCase);
        var sameUser = string.Equals(prev.Login, login, StringComparison.OrdinalIgnoreCase);
        var items = new List<GhItem>();
        foreach (var node in arr)
        {
            // Kayıt başına: tek bozuk öğe listeyi düşürmesin.
            try { if (Parse(node, gh, login, sameUser ? old : null) is { } it) items.Add(it); }
            catch (Exception ex) when (ex is InvalidOperationException or FormatException or JsonException)
            {
                log.LogDebug("GitHub öğesi okunamadı: {Msg}", ex.Message);
            }
        }
        Update(s => s with { Login = login, TriedAt = now, OkAt = now, Fail = "", Items = items });
        log.LogInformation("GitHub denetlendi: {N} açık öğe, {W} cevap bekliyor", items.Count, items.Count(i => i.Waiting));
        Announce(items, sameUser ? old : [], first: prev.OkAt == 0);
    }

    GhItem? Parse(JsonNode? n, string gh, string login, Dictionary<string, GhItem>? old)
    {
        if (n is null) return null;
        var repo = ApiRepo(n["repository_url"]?.GetValue<string>());
        var number = n["number"]?.GetValue<int>() ?? 0;
        var author = n["user"]?["login"]?.GetValue<string>();
        if (repo is null || number <= 0 || author is null) return null;
        var title = n["title"]?.GetValue<string>() ?? "";
        if (title.Length > TitleMax) title = title[..TitleMax] + "…";
        var comments = n["comments"]?.GetValue<int>() ?? 0;
        var updated = DateTimeOffset.Parse(n["updated_at"]!.GetValue<string>(), CultureInfo.InvariantCulture).ToUnixTimeMilliseconds();
        var pr = n["pull_request"] is not null;
        // Bağlantı arayüzde tıklanır: yalnız github.com adresi; değilse depodan kurulur.
        var url = n["html_url"]?.GetValue<string>() is { } h && h.StartsWith("https://github.com/", StringComparison.Ordinal) ? h
            : $"https://github.com/{repo}/{(pr ? "pull" : "issues")}/{number}";
        var was = old?.GetValueOrDefault($"{repo}#{number}");
        string? lastBy;
        if (comments == 0) lastBy = author;
        else if (was is { LastBy: not null } && was.UpdatedAt == updated && was.Comments == comments) lastBy = was.LastBy; // değişmedi: yeniden sorulmaz
        else lastBy = LastCommenter(gh, repo, number, comments);
        var mine = (string who) => string.Equals(who, login, StringComparison.OrdinalIgnoreCase);
        // Son yorum okunamadıysa önceki bilinen durum; o da yoksa açana göre.
        var waiting = lastBy is not null ? !mine(lastBy) : was?.Waiting ?? !mine(author);
        return new GhItem(repo, number, title, author, comments, updated, pr, url, lastBy, waiting);
    }

    /// <summary>Son yorumu yazan: tek öğelik son sayfa (per_page=1, page=yorum sayısı).</summary>
    string? LastCommenter(string gh, string repo, int number, int comments)
    {
        var r = Run(gh, "api", "-X", "GET", $"repos/{repo}/issues/{number}/comments", "-f", "per_page=1", "-f", $"page={comments}");
        if (r is not { Code: 0 } ok) return null;
        try { return JsonNode.Parse(ok.Out) is JsonArray { Count: > 0 } a ? a[^1]?["user"]?["login"]?.GetValue<string>() : null; }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException) { return null; }
    }

    /// <summary>Yeni "cevap bekliyor" öğeleri için bir kez bildirim; ilk denetimde ve birden çok öğede tek toplu bildirim.</summary>
    void Announce(List<GhItem> items, Dictionary<string, GhItem> old, bool first)
    {
        var fresh = items.Where(i => i.Waiting && !(old.GetValueOrDefault(Key(i))?.Waiting ?? false)).ToList();
        if (fresh.Count == 0) return;
        var (title, text) = fresh.Count == 1 && !first
            ? ($"GitHub: {fresh[0].Repo} #{fresh[0].Number} cevap bekliyor", $"{fresh[0].LastBy ?? fresh[0].Author}: {fresh[0].Title}")
            : ($"GitHub: {fresh.Count} öğe cevap bekliyor", string.Join(", ", fresh.Take(4).Select(i => $"{i.Repo.Split('/')[^1]} #{i.Number}")) + (fresh.Count > 4 ? "…" : ""));
        RemoteLog.Info($"GitHub bildirimi: {string.Join(", ", fresh.Select(Key))}");
        Notify?.Invoke(title, text);
    }

    void Fail(long now, string why, string detail)
    {
        // Son bilinen liste silinmez: "alamadım" boş liste değildir.
        log.LogInformation("GitHub denetlenemedi ({Why}): {Detail}", why, detail);
        Update(s => s with { TriedAt = now, Fail = why });
    }

    static string Key(GhItem i) => $"{i.Repo}#{i.Number}";
    static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    static string FirstLine(string s) => s.Split('\n').Select(x => x.Trim()).FirstOrDefault(x => x.Length > 0) is { } f ? f.Length > 200 ? f[..200] : f : "";

    /// <summary>gh çıkış kodu 4 = giriş gerekli.</summary>
    static string Why((int Code, string Out, string Err) r) =>
        r.Code == 4 || r.Err.Contains("gh auth login", StringComparison.OrdinalIgnoreCase) || r.Err.Contains("HTTP 401", StringComparison.Ordinal) ? "noauth" : "net";

    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9-]{0,38}$")] private static partial Regex LoginRx();
    [GeneratedRegex(@"github\.com[:/]([\w.-]+)/([\w.-]+?)(?:\.git)?/?$", RegexOptions.IgnoreCase)] private static partial Regex RepoRx();

    const string ApiRepos = "https://api.github.com/repos/";
    [GeneratedRegex(@"^[\w.-]+/[\w.-]+$")] private static partial Regex RepoNameRx();

    /// <summary>Arama sonucundaki repository_url → "sahip/depo".</summary>
    static string? ApiRepo(string? url) =>
        url is not null && url.StartsWith(ApiRepos, StringComparison.Ordinal) && RepoNameRx().IsMatch(url[ApiRepos.Length..]) ? url[ApiRepos.Length..] : null;

    /// <summary>GitHub adresinden (https ya da ssh uzak adresi) "sahip/depo"; GitHub değilse null.</summary>
    public static string? RepoOf(string? url) =>
        url is not null && RepoRx().Match(url.Trim()) is { Success: true } m ? $"{m.Groups[1].Value}/{m.Groups[2].Value}" : null;

    /// <summary>gh'nin yolu. Finder'dan açılan uygulamanın PATH'i kısadır; bilinen kurulum yerlerine önce bakılır.</summary>
    static string? FindExe()
    {
        // Test: gerçek gh yerine sahte betik (CLAUDE_PANEL_GH_EXE); dosya yoksa "gh kurulu değil" durumu.
        if (Environment.GetEnvironmentVariable("CLAUDE_PANEL_GH_EXE") is { Length: > 0 } fake) return File.Exists(fake) ? fake : null;
        string[] known = OperatingSystem.IsWindows()
            ? [Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "GitHub CLI", "gh.exe")]
            : ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];
        foreach (var k in known) if (File.Exists(k)) return k;
        var exe = OperatingSystem.IsWindows() ? "gh.exe" : "gh";
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            if (dir.Trim().Length == 0) continue;
            var f = Path.Combine(dir.Trim(), exe);
            if (File.Exists(f)) return f;
        }
        return null;
    }

    /// <summary>gh'yi pencere açmadan, kabuktan geçirmeden çalıştırır. Başlatılamazsa null; zaman aşımı/hata → kod -1.</summary>
    (int Code, string Out, string Err)? Run(string exe, params string[] args)
    {
        var psi = new ProcessStartInfo(exe)
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        psi.Environment["GH_PROMPT_DISABLED"] = "1";
        psi.Environment["GH_NO_UPDATE_NOTIFIER"] = "1";
        psi.Environment["NO_COLOR"] = "1";
        try
        {
            using var p = Process.Start(psi);
            if (p is null) return null;
            p.StandardInput.Close(); // soru sorarsa beklemesin
            var o = p.StandardOutput.ReadToEndAsync();
            var e = p.StandardError.ReadToEndAsync();
            if (!p.WaitForExit(TimeoutMs) || !Task.WaitAll([o, e], 2000))
            {
                p.Kill(entireProcessTree: true);
                return (-1, "", "zaman aşımı");
            }
            return (p.ExitCode, o.Result, e.Result);
        }
        catch (Win32Exception) { return null; }
        catch (Exception ex) when (ex is InvalidOperationException or IOException or AggregateException) { return (-1, "", ex.Message); }
    }

    /// <summary>Durumu değiştirir ve yazar. Ayar değişikliği ile süren denetim birbirinin yazdığını ezmesin diye tek kilitte.</summary>
    void Update(Func<Saved, Saved> change)
    {
        lock (_gate) Save(_s = change(_s));
    }

    void Save(Saved s)
    {
        try
        {
            Directory.CreateDirectory(Handoff.DataDir);
            var tmp = StateFile + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(s));
            File.Move(tmp, StateFile, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            log.LogDebug("GitHub durumu yazılamadı: {Msg}", ex.Message);
        }
    }

    /// <summary>
    /// Varsayılan açık. Ayrı veri klasörüyle çalışan kopyada (CLAUDE_PANEL_DATA: testler) sahte gh verilmediyse varsayılan kapalı:
    /// test kopyaları kullanıcının gerçek GitHub hesabını sorgulamasın, ekranına bildirim düşürmesin. Ayarlar'dan açılabilir.
    /// </summary>
    static bool DefaultOn => Environment.GetEnvironmentVariable("CLAUDE_PANEL_DATA") is not { Length: > 0 }
        || Environment.GetEnvironmentVariable("CLAUDE_PANEL_GH_EXE") is { Length: > 0 };

    static Saved Load()
    {
        try { return File.Exists(StateFile) ? JsonSerializer.Deserialize<Saved>(File.ReadAllText(StateFile)) ?? new(DefaultOn) : new(DefaultOn); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { return new(DefaultOn); }
    }
}

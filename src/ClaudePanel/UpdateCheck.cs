using System.ComponentModel;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ClaudePanel;

/// <param name="State">"ok" | "unknown" (denetlenemedi: ağ yok, sürüm okunamadı).</param>
public sealed record UpdateItem(string State, string? Current, string? Latest, bool Newer, string? Url)
{
    public static UpdateItem Of(string? current, string? latest, string? url = null)
    {
        if (UpdateCheck.Parse(current) is not { } c || UpdateCheck.Parse(latest) is not { } l) return new("unknown", current, latest, false, url);
        return new("ok", current, latest, l > c, url);
    }
}

public sealed record UpdateInfo(UpdateItem Panel, UpdateItem Claude)
{
    public static readonly UpdateInfo Unknown = new(new("unknown", null, null, false, null), new("unknown", null, null, false, null));
}

/// <summary>
/// Güncelleme denetimi: panelin son GitHub sürümü ve Claude Code'un npm'deki son sürümü. Yalnız bilgi verir, indirmez/kurmaz
/// (Claude Code'u <see cref="ClaudeUpdater"/> günceller).
/// Ağa en çok 6 saatte bir çıkılır (başarısız denemeden sonra 1 saat beklenir); sonuç panel veri klasöründe durur,
/// panel yeniden açılınca tekrar sorulmaz. Kimlik gönderilmez.
/// </summary>
public sealed class UpdateCheck(ILogger<UpdateCheck> log)
{
    const string PanelRepo = "https://github.com/ahmetunaluzun/claude-oturum-paneli";
    const string PanelApi = "https://api.github.com/repos/ahmetunaluzun/claude-oturum-paneli/releases/latest";
    const string ClaudeApi = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";
    static readonly string CacheFile = Path.Combine(Handoff.DataDir, "update-check.json");
    static readonly TimeSpan CheckEvery = TimeSpan.FromHours(6), RetryAfter = TimeSpan.FromHours(1), LocalEvery = TimeSpan.FromHours(1);
    const int ClaudeTimeoutMs = 8000;

    /// <param name="PanelAt">Son deneme zamanı (Unix sn); başarısız denemede de yazılır.</param>
    sealed record Cache(long PanelAt = 0, bool PanelOk = false, string? PanelLatest = null, string? PanelUrl = null,
        long ClaudeAt = 0, bool ClaudeOk = false, string? ClaudeLatest = null);

    string? _localClaude;
    DateTime _localAt;

    public async Task<UpdateInfo> Check()
    {
        var c = Load();
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var changed = false;
        if (Due(c.PanelAt, c.PanelOk, now))
        {
            var (ok, tag, url) = await FetchPanel();
            // Yanıt gelmediyse eldeki son bilinen sürüm silinmez.
            c = ok ? c with { PanelAt = now, PanelOk = true, PanelLatest = tag, PanelUrl = url } : c with { PanelAt = now, PanelOk = false };
            changed = true;
        }
        if (Due(c.ClaudeAt, c.ClaudeOk, now))
        {
            var v = await FetchJson(ClaudeApi) is { } o && o["version"] is JsonValue jv && jv.TryGetValue<string>(out var s) ? s : null;
            c = v is not null ? c with { ClaudeAt = now, ClaudeOk = true, ClaudeLatest = v } : c with { ClaudeAt = now, ClaudeOk = false };
            changed = true;
        }
        if (changed) Save(c);
        var mine = Handoff.Mine.ToString(3);
        return new UpdateInfo(
            c.PanelLatest is null && c.PanelOk ? new("ok", mine, null, false, null) // henüz yayınlanmış sürüm yok
                : UpdateItem.Of(mine, c.PanelLatest?.TrimStart('v', 'V'), c.PanelUrl ?? PanelRepo + "/releases/latest"), // etiket "v0.11.0"
            UpdateItem.Of(LocalClaude(), c.ClaudeLatest));
    }

    static bool Due(long at, bool ok, long now) => now - at > (ok ? CheckEvery : RetryAfter).TotalSeconds;

    async Task<(bool Ok, string? Tag, string? Url)> FetchPanel()
    {
        var (o, status) = await FetchJsonStatus(PanelApi);
        if (status == 404) return (true, null, null); // depoda sürüm yok
        if (o?["tag_name"] is not JsonValue tv || !tv.TryGetValue<string>(out var tag) || Parse(tag) is null) return (false, null, null);
        // Bağlantı arayüzde tıklanır: yalnız kendi depomuzun adresi kabul edilir.
        var url = o["html_url"] is JsonValue uv && uv.TryGetValue<string>(out var u) && u.StartsWith(PanelRepo + "/", StringComparison.Ordinal) ? u : null;
        return (true, tag, url);
    }

    async Task<JsonNode?> FetchJson(string url) => (await FetchJsonStatus(url)).Node;

    async Task<(JsonNode? Node, int Status)> FetchJsonStatus(string url)
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(8) };
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.TryAddWithoutValidation("User-Agent", $"claude-oturum-paneli/{Handoff.Mine.ToString(3)}");
            req.Headers.TryAddWithoutValidation("Accept", "application/json");
            using var resp = await http.SendAsync(req);
            if (!resp.IsSuccessStatusCode) return (null, (int)resp.StatusCode);
            return (JsonNode.Parse(await resp.Content.ReadAsStringAsync()), 200);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException or IOException)
        {
            log.LogDebug("Güncelleme denetlenemedi {Url}: {Msg}", url, ex.Message);
            return (null, 0);
        }
    }

    /// <summary>Güncellemeden sonra kurulu sürüm bir sonraki denetimde yeniden okunur.</summary>
    public void ForgetLocal() => _localAt = default;

    /// <summary>Kurulu Claude Code sürümü (`claude --version`, saatte bir); okunamazsa null.</summary>
    string? LocalClaude()
    {
        if (DateTime.UtcNow - _localAt < LocalEvery) return _localClaude;
        _localAt = DateTime.UtcNow;
        try
        {
            var psi = new ProcessStartInfo(Launcher.ClaudeExe())
            {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
            };
            psi.ArgumentList.Add("--version");
            using var p = Process.Start(psi);
            if (p is null) return _localClaude = null;
            p.ErrorDataReceived += (_, _) => { };
            p.BeginErrorReadLine();
            var read = p.StandardOutput.ReadToEndAsync();
            if (!p.WaitForExit(ClaudeTimeoutMs) || !read.Wait(1000)) { p.Kill(entireProcessTree: true); return _localClaude = null; }
            // "2.1.5 (Claude Code)"
            var first = read.Result.Trim().Split(' ', '\n')[0].Trim();
            return _localClaude = Parse(first) is null ? null : first;
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException or IOException or AggregateException)
        {
            log.LogDebug("claude --version okunamadı: {Msg}", ex.Message);
            return _localClaude = null;
        }
    }

    /// <summary>"v0.11.0", "2.1.5-beta.1" → sürüm; ayrıştırılamazsa null.</summary>
    public static Version? Parse(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        var core = s.Trim().TrimStart('v', 'V').Split('-', '+', ' ')[0];
        return Version.TryParse(core, out var v) && v.Build >= 0 ? new Version(v.Major, v.Minor, v.Build) : null;
    }

    static Cache Load()
    {
        try { return File.Exists(CacheFile) ? JsonSerializer.Deserialize<Cache>(File.ReadAllText(CacheFile)) ?? new() : new(); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { return new(); }
    }

    void Save(Cache c)
    {
        try
        {
            Directory.CreateDirectory(Handoff.DataDir);
            var tmp = CacheFile + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(c));
            File.Move(tmp, CacheFile, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            log.LogDebug("Güncelleme önbelleği yazılamadı: {Msg}", ex.Message);
        }
    }
}

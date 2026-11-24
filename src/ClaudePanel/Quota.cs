using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ClaudePanel;

public sealed record QuotaWindow(double? Used, DateTimeOffset? ResetsAt)
{
    /// <summary>Kalan yüzde. Sıfırlanma saati geçtiyse önbellek bayattır, kota yenilenmiştir: 100.</summary>
    public double? Left => ResetsAt is { } r && r <= DateTimeOffset.UtcNow ? 100 : Used is { } u ? Math.Max(0, 100 - u) : null;
}

public sealed record QuotaInfo(QuotaWindow Five, QuotaWindow Week);

/// <summary>
/// Claude kota bilgisi (5 saatlik + haftalık). ~/.claude/usage-cache.json önbelleğini okur; 5 dakikadan eskiyse
/// Anthropic kullanım API'sinden yeniler ve önbelleğe yazar (aynı biçim: kullanıcının kendi statusline betiği de okuyabilir).
/// Token: ~/.claude/.credentials.json (Windows/Linux) ya da macOS Anahtar Zinciri ("Claude Code-credentials").
/// Panel, --statusline ve --quota-guard aynı kodu kullanır; başarısız yenileme 3 dakika tekrar denenmez (süreçler arası).
/// </summary>
public static class Quota
{
    /// <summary>~/.claude. Testte CLAUDE_PANEL_CLAUDE_DIR ile başka klasör verilir (gerçek ayar ve önbelleğe dokunulmaz).</summary>
    public static readonly string ClaudeDir = Environment.GetEnvironmentVariable("CLAUDE_PANEL_CLAUDE_DIR") is { Length: > 0 } d ? d
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude");
    public static readonly string CacheFile = Path.Combine(ClaudeDir, "usage-cache.json");

    /// <summary>
    /// Bu sürecin hesabı: claude'un çağırdığı --statusline / --quota-guard, oturumun CLAUDE_CONFIG_DIR'ini miras alır
    /// (ek hesapta o hesabın kotası gösterilir). Test klasörü verilmişse o kazanır.
    /// </summary>
    public static string CurrentDir =>
        Environment.GetEnvironmentVariable("CLAUDE_PANEL_CLAUDE_DIR") is not { Length: > 0 }
        && Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR") is { Length: > 0 } c ? c : ClaudeDir;

    static string Trim(string dir) => Path.GetFullPath(dir).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

    static bool IsDefault(string dir) => string.Equals(Trim(dir), Trim(ClaudeDir), StringComparison.OrdinalIgnoreCase);

    /// <summary>Başarısız yenileme işareti hesap başına (bir hesabın token hatası ötekini 3 dk bekletmesin).</summary>
    static string FailFileOf(string dir) => Path.Combine(Handoff.DataDir,
        IsDefault(dir) ? "usage-fetch-failed" : "usage-fetch-failed-" + Path.GetFileName(Trim(dir)));
    const int StaleAfterSec = 300;
    static readonly TimeSpan RetryAfter = TimeSpan.FromMinutes(3);
    static readonly object FetchLock = new();

    /// <summary>Önbellek yaşı (sn); önbellek yoksa null.</summary>
    public static double? CacheAge(JsonNode? root) =>
        root?["_cached_at"] is JsonValue v && v.TryGetValue<double>(out var at) ? DateTimeOffset.UtcNow.ToUnixTimeSeconds() - at : null;

    /// <summary>Kota; okunamıyorsa null. <paramref name="fetch"/> false ise yalnız önbellek okunur.</summary>
    public static QuotaInfo? Read(bool fetch = true, Action<string>? log = null) => Read(ClaudeDir, fetch, log);

    /// <summary>Verilen hesap klasörünün kotası (Accounts.cs); okunamıyorsa null.</summary>
    public static QuotaInfo? Read(string dir, bool fetch = true, Action<string>? log = null)
    {
        var root = ReadCache(dir);
        if (fetch && (CacheAge(root) is not { } age || age > StaleAfterSec)) root = Fetch(dir, log) ?? root;
        return root is null ? null : Parse(root);
    }

    public static JsonNode? ReadCache() => ReadCache(ClaudeDir);

    public static JsonNode? ReadCache(string dir)
    {
        var file = Path.Combine(dir, "usage-cache.json");
        try { return File.Exists(file) ? JsonNode.Parse(File.ReadAllText(file)) : null; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { return null; }
    }

    public static QuotaInfo Parse(JsonNode root)
    {
        static QuotaWindow Win(JsonNode? w)
        {
            double? used = w?["utilization"] is JsonValue v && v.TryGetValue<double>(out var d) ? d : null;
            DateTimeOffset? reset = w?["resets_at"] is JsonValue s && s.TryGetValue<string>(out var str)
                && DateTimeOffset.TryParse(str, CultureInfo.InvariantCulture, DateTimeStyles.None, out var r) ? r : null;
            return new(used, reset);
        }
        return new(Win(root["five_hour"]), Win(root["seven_day"]));
    }

    /// <summary>API'den çeker, önbelleğe yazar. Son başarısız denemeden bu yana 3 dakika geçmediyse denemez.</summary>
    static JsonNode? Fetch(string dir, Action<string>? log)
    {
        var cacheFile = Path.Combine(dir, "usage-cache.json");
        var failFile = FailFileOf(dir);
        lock (FetchLock)
        {
            try
            {
                if (File.Exists(failFile) && DateTime.UtcNow - File.GetLastWriteTimeUtc(failFile) < RetryAfter) return null;
                // Başka süreç az önce yenilediyse onu kullan
                if (ReadCache(dir) is { } fresh && CacheAge(fresh) is { } a && a <= StaleAfterSec) return fresh;
                var token = AccessToken(dir);
                if (string.IsNullOrEmpty(token)) { MarkFailed(failFile); log?.Invoke("Kota: token bulunamadı"); return null; }
                using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(8) };
                using var req = new HttpRequestMessage(HttpMethod.Get, "https://api.anthropic.com/api/oauth/usage");
                req.Headers.Authorization = new("Bearer", token);
                req.Headers.Add("anthropic-beta", "oauth-2025-04-20");
                using var resp = http.Send(req);
                if (!resp.IsSuccessStatusCode)
                {
                    MarkFailed(failFile);
                    log?.Invoke($"Kota okunamadı: HTTP {(int)resp.StatusCode}");
                    return null;
                }
                if (JsonNode.Parse(resp.Content.ReadAsStream()) is not JsonObject obj) { MarkFailed(failFile); return null; }
                obj["_cached_at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;
                Directory.CreateDirectory(dir);
                var tmp = cacheFile + $".{Environment.ProcessId}.tmp";
                File.WriteAllText(tmp, obj.ToJsonString());
                File.Move(tmp, cacheFile, overwrite: true);
                if (File.Exists(failFile)) File.Delete(failFile);
                return obj;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException
                                           or HttpRequestException or TaskCanceledException or InvalidOperationException)
            {
                MarkFailed(failFile);
                log?.Invoke($"Kota yenilenemedi: {ex.Message}");
                return null;
            }
        }
    }

    static void MarkFailed(string failFile)
    {
        try
        {
            Directory.CreateDirectory(Handoff.DataDir);
            File.WriteAllText(failFile, DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }

    /// <summary>Claude Code'un OAuth kimliği (claudeAiOauth nesnesi); bulunamazsa null.</summary>
    public static JsonNode? Credentials() => Credentials(ClaudeDir);

    /// <summary>Hesap klasörünün kimliği. macOS'ta Anahtar Zinciri yalnız varsayılan hesap için okunur.</summary>
    public static JsonNode? Credentials(string dir)
    {
        try
        {
            var file = Path.Combine(dir, ".credentials.json");
            if (File.Exists(file)) return JsonNode.Parse(File.ReadAllText(file))?["claudeAiOauth"];
            if (OperatingSystem.IsMacOS() && IsDefault(dir) && Keychain() is { Length: > 0 } json) return JsonNode.Parse(json)?["claudeAiOauth"];
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { }
        return null;
    }

    static string? AccessToken(string dir) => Credentials(dir)?["accessToken"] is JsonValue v && v.TryGetValue<string>(out var t) ? t : null;

    /// <summary>macOS: Claude Code kimliği dosyada değil Anahtar Zinciri'nde.</summary>
    static string? Keychain()
    {
        try
        {
            var psi = new ProcessStartInfo("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"])
            {
                RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false
            };
            using var p = Process.Start(psi);
            if (p is null) return null;
            var output = p.StandardOutput.ReadToEndAsync();
            if (!p.WaitForExit(5000)) { try { p.Kill(); } catch (InvalidOperationException) { } return null; }
            return p.ExitCode == 0 ? output.Result.Trim() : null;
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException) { return null; }
    }

    /// <summary>Plan adı (Max5x, Max20x, Pro...) ya da null.</summary>
    public static string? Plan() => Plan(ClaudeDir);

    public static string? Plan(string dir)
    {
        var c = Credentials(dir);
        var tier = c?["rateLimitTier"] is JsonValue t && t.TryGetValue<string>(out var ts) ? ts : "";
        if (tier.Contains("20x", StringComparison.Ordinal)) return "Max20x";
        if (tier.Contains("5x", StringComparison.Ordinal)) return "Max5x";
        var sub = c?["subscriptionType"] is JsonValue s && s.TryGetValue<string>(out var ss) ? ss : null;
        return string.IsNullOrEmpty(sub) ? null : char.ToUpperInvariant(sub[0]) + sub[1..];
    }

    /// <summary>Kalan süre: "1sa53dk" / "2g4sa" (tr), "1h53m" / "2d4h" (en). Geçmişse boş.</summary>
    public static string Remaining(DateTimeOffset? at, bool tr)
    {
        if (at is null) return "";
        var min = (int)Math.Floor((at.Value - DateTimeOffset.UtcNow).TotalMinutes);
        if (min < 0) return "";
        int d = min / 1440, h = min % 1440 / 60, m = min % 60;
        string D = tr ? "g" : "d", H = tr ? "sa" : "h", M = tr ? "dk" : "m";
        return d > 0 ? $"{d}{D}{h}{H}" : h > 0 ? $"{h}{H}{m}{M}" : $"{m}{M}";
    }

    /// <summary>Sıfırlanma saati yerel: bugünse "18:30", yarınsa "yarın 08:00", sonra "21 Kas".</summary>
    public static string ResetLabel(DateTimeOffset? at, bool tr)
    {
        if (at is null) return "";
        var local = at.Value.ToLocalTime();
        var today = DateTimeOffset.Now.Date;
        var culture = CultureInfo.GetCultureInfo(tr ? "tr-TR" : "en-US");
        if (local.Date == today) return local.ToString("HH:mm", culture);
        if (local.Date == today.AddDays(1)) return (tr ? "yarın " : "tomorrow ") + local.ToString("HH:mm", culture);
        return local.ToString("d MMM", culture);
    }

    public static bool TurkishUi =>
        CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "tr" || CultureInfo.CurrentCulture.TwoLetterISOLanguageName == "tr";
}

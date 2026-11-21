using System.Diagnostics;
using System.Text.Json;

namespace ClaudePanel;

/// <summary>Claude Code'un ~/.claude/sessions/*.json dosyalarından canlı oturumları okur.</summary>
public sealed class SessionStore(ILogger<SessionStore> log)
{
    static readonly string ClaudeDir = Quota.ClaudeDir;
    static readonly string SessionsDir = Path.Combine(ClaudeDir, "sessions");
    static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

    public IReadOnlyList<SessionInfo> List()
    {
        var result = new List<SessionInfo>();
        if (!Directory.Exists(SessionsDir)) return result;

        foreach (var file in Directory.EnumerateFiles(SessionsDir, "*.json"))
        {
            try
            {
                var raw = JsonSerializer.Deserialize<RawSession>(File.ReadAllText(file), Json);
                if (raw is null || raw.Pid <= 0 || !IsAlive(raw.Pid, raw.ProcStart)) continue;
                result.Add(new SessionInfo(
                    raw.Pid, raw.SessionId ?? "", raw.Name ?? Path.GetFileName(raw.Cwd ?? ""),
                    raw.Cwd ?? "", raw.Kind ?? "interactive", raw.Status ?? "unknown",
                    raw.StartedAt, raw.StatusUpdatedAt ?? raw.UpdatedAt ?? raw.StartedAt,
                    raw.Version ?? "", raw.NameSource == "derived" ? null : raw.Name,
                    raw.Entrypoint, raw.Status == "waiting" ? raw.WaitingFor ?? "" : null));
            }
            catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
            {
                // Kayıt başına yakala: tek bozuk dosya listeyi düşürmesin.
                log.LogDebug("Oturum dosyası okunamadı {File}: {Msg}", file, ex.Message);
            }
        }
        return result.OrderBy(s => s.StartedAt).ToList();
    }

    /// <summary>PID hâlâ aynı süreç mi (PID yeniden kullanımına karşı başlangıç zamanıyla doğrular).</summary>
    static bool IsAlive(int pid, string? procStart)
    {
        try
        {
            using var p = Process.GetProcessById(pid);
            if (p.HasExited) return false;
            if (long.TryParse(procStart, out var ft))
                return Math.Abs(p.StartTime.ToFileTimeUtc() - ft) < 20_000_000; // 2 sn tolerans
            return true;
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException
                                       or System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }

    /// <summary>Statusline'ın yazdığı kota önbelleği (varsa). Yoksa null.</summary>
    /// <param name="refresh">Önbellek 5 dakikadan eskiyse çağrılır (yenileme arka planda yapılır).</param>
    public JsonElement? Usage(Action? refresh = null)
    {
        var path = Path.Combine(ClaudeDir, "usage-cache.json");
        if (!File.Exists(path)) { refresh?.Invoke(); return null; }
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            var r = doc.RootElement;
            var cachedAt = r.TryGetProperty("_cached_at", out var ca) && ca.ValueKind == JsonValueKind.Number ? ca.GetDouble() : 0;
            if (DateTimeOffset.UtcNow.ToUnixTimeSeconds() - cachedAt > 300) refresh?.Invoke();
            var o = new Dictionary<string, object?>();
            foreach (var key in new[] { "five_hour", "seven_day" })
                if (r.TryGetProperty(key, out var w) && w.ValueKind == JsonValueKind.Object)
                    o[key] = new
                    {
                        used = w.TryGetProperty("utilization", out var u) && u.ValueKind == JsonValueKind.Number ? u.GetDouble() : (double?)null,
                        resetsAt = w.TryGetProperty("resets_at", out var ra) ? ra.GetString() : null
                    };
            return JsonSerializer.SerializeToElement(o);
        }
        catch (Exception ex) when (ex is IOException or JsonException)
        {
            return null;
        }
    }

    sealed class RawSession
    {
        public int Pid { get; set; }
        public string? SessionId { get; set; }
        public string? Cwd { get; set; }
        public long StartedAt { get; set; }
        public string? ProcStart { get; set; }
        public string? Version { get; set; }
        public string? Kind { get; set; }
        public string? Name { get; set; }
        public string? NameSource { get; set; }
        public string? Status { get; set; }
        public long? UpdatedAt { get; set; }
        public long? StatusUpdatedAt { get; set; }
        public string? Entrypoint { get; set; }  // cli, claude-vscode, claude-desktop, sdk-cli...
        public string? WaitingFor { get; set; }  // status "waiting" iken: "dialog open", "input needed"...
    }
}

public sealed record SessionInfo(
    int Pid, string SessionId, string Name, string Cwd, string Kind, string Status,
    long StartedAt, long StatusSince, string Version, string? CustomName,
    string? Entrypoint = null, string? WaitingFor = null);

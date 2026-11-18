using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace ClaudePanel;

/// <summary>
/// Gece modu koruması, panelin içinde: panelin başlattığı her claude oturumuna `--settings` ile PreToolUse hook'u verilir;
/// hook `ClaudePanel --night-guard` olarak çalışır, night-guard.json'daki gece oturumlarında dışarıya giden / para
/// harcatan / geri alınamaz işlemleri engeller (exit 2). Böylece koruma ~/.claude/hooks altındaki betiğe bağlı kalmaz (Mac).
/// Desenler ~/.claude/hooks/gece-modu-koruma.py ile aynıdır; o betik bu bilgisayarda kayıtlıysa ikinci kez eklenmez.
/// </summary>
public static class NightGuard
{
    public const string Arg = "--night-guard";

    static readonly (Regex Re, string Name)[] Commands =
    [
        (R(@"\bgit\b[^\n|;&]*\bpush\b"), "git push"),
        (R(@"\bgh\s+(pr\s+(create|merge|close|comment|review)|release\s+create|repo\s+(create|edit|delete|rename)|gist\s+create|issue\s+(create|comment|close))\b"), "GitHub'a yazma (gh)"),
        (R(@"\bgh\s+api\b.*(-X|--method)\s*(POST|PATCH|PUT|DELETE)"), "GitHub API yazma"),
        (R(@"\b(npm|pnpm|yarn)\s+publish\b"), "paket yayını"),
        (R(@"\bdotnet\s+nuget\s+push\b|\btwine\s+upload\b"), "paket yayını"),
        (R(@"\bvercel\b.*(--prod\b|\bdeploy\b|\bpromote\b)|\bfirebase\s+deploy\b|\bwrangler\s+(deploy|publish)\b|\bnetlify\s+deploy\b"), "yayına alma (deploy)"),
        (R(@"\bhiggsfield\b"), "kredi harcayan üretim (Higgsfield)"),
        (R(@"\bSend-MailMessage\b|\bsmtplib\b"), "mail gönderme"),
        (R(@"\bgit\b[^\n|;&]*\b(reset\s+--hard|push\s+--force|filter-branch|filter-repo)\b|\bgit\b[^\n|;&]*\brebase\b"), "git geçmişini değiştirme"),
    ];

    /// <summary>MCP araçlarında yalnız okuma serbest.</summary>
    static readonly string[] ReadVerbs = ["get", "list", "search", "read", "query", "guide", "download", "count", "aggregate",
        "filter", "web_fetch", "resolve", "inspect", "check", "fetch", "suggest"];
    static readonly string[] FreeMcp = ["mcp__rea__"]; // yerel analiz, dışarı gitmez

    static Regex R(string p) => new(p, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>İşlem engellenecekse nedeni, değilse null.</summary>
    public static string? BlockReason(string tool, JsonNode? input)
    {
        if (tool is "Bash" or "PowerShell")
        {
            var cmd = input?["command"]?.GetValue<string>() ?? "";
            foreach (var (re, name) in Commands) if (re.IsMatch(cmd)) return name;
            return null;
        }
        if (tool.StartsWith("mcp__", StringComparison.Ordinal) && !FreeMcp.Any(f => tool.StartsWith(f, StringComparison.Ordinal)))
        {
            var verb = tool[(tool.LastIndexOf("__", StringComparison.Ordinal) + 2)..].ToLowerInvariant();
            if (!ReadVerbs.Any(v => verb.StartsWith(v, StringComparison.Ordinal))) return $"dış servise yazma ({tool})";
        }
        return null;
    }

    static bool IsNightSession(string sessionId)
    {
        try
        {
            var g = JsonNode.Parse(File.ReadAllText(NightMode.GuardFile));
            var until = g?["until"]?.GetValue<double>() ?? 0;
            return until > DateTimeOffset.UtcNow.ToUnixTimeSeconds()
                   && (g?["sessions"]?.AsArray().Any(s => s?.GetValue<string>() == sessionId) ?? false);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or FormatException)
        {
            return false;
        }
    }

    /// <summary>Hook olarak çalıştırılınca (ClaudePanel --night-guard): stdin'deki olayı okur, engellenecekse exit 2.</summary>
    public static int RunHook()
    {
        if (!File.Exists(NightMode.GuardFile)) return 0;
        JsonNode? ev;
        try { ev = JsonNode.Parse(Console.In.ReadToEnd()); }
        catch (JsonException) { return 0; }
        var session = ev?["session_id"]?.GetValue<string>() ?? "";
        if (!IsNightSession(session)) return 0;
        var reason = BlockReason(ev?["tool_name"]?.GetValue<string>() ?? "", ev?["tool_input"]);
        if (reason is null) return 0;
        var msg = $"Gece modu: {reason} engellendi; kullanıcı uyuyor ve bu işlem onun kararı. Bunu yapma, sabaha bırak. " +
                  "Yapabileceğin yerel iş varsa sürdür; yoksa yanıtının İLK satırına [KARAR-BEKLIYOR] yaz ve " +
                  "neyi neden yapmak istediğini kısaca açıkla.\n";
        using var err = Console.OpenStandardError();
        err.Write(Encoding.UTF8.GetBytes(msg)); // Windows konsol kod sayfasına bakmadan UTF-8 (Claude Code UTF-8 okur)
        return 2;
    }

    /// <summary>
    /// Panelin başlattığı claude'a verilecek `--settings` JSON'u (gece koruması + kota koruması hook'ları); gerek yoksa null.
    /// Kullanıcının ~/.claude/settings.json'unda aynı iş için hook zaten kayıtlıysa (gece-modu-koruma, quota-guard —
    /// Ayarlar'dan açılan panel kota koruması da "--quota-guard" içerir) iki kez çalışmasın diye o hook eklenmez.
    /// </summary>
    public static string? SettingsArg()
    {
        var userSettings = Path.Combine(Quota.ClaudeDir, "settings.json");
        var text = "";
        try { if (File.Exists(userSettings)) text = File.ReadAllText(userSettings); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        var exe = PanelExe();
        if (exe is null) return null;
        var pre = new JsonArray();
        if (!text.Contains("gece-modu-koruma", StringComparison.Ordinal))
            pre.Add(new JsonObject
            {
                ["matcher"] = "Bash|PowerShell|mcp__.*",
                ["hooks"] = new JsonArray(new JsonObject
                {
                    ["type"] = "command",
                    ["command"] = $"\"{exe}\" {Arg}",
                    ["timeout"] = 15
                })
            });
        if (!text.Contains("quota-guard", StringComparison.OrdinalIgnoreCase))
            pre.Add(QuotaSetup.GuardEntry($"\"{exe}\" {QuotaCli.GuardArg}"));
        if (pre.Count == 0) return null;
        return new JsonObject { ["hooks"] = new JsonObject { ["PreToolUse"] = pre } }.ToJsonString();
    }

    /// <summary>Panelin kalıcı yolu. Yayın sırasında çalışan exe .old.exe olarak yeniden adlandırılır; hook asıl adı göstermeli.</summary>
    public static string? PanelExe()
    {
        var p = Environment.ProcessPath;
        if (string.IsNullOrEmpty(p) || p.Contains('"')) return null;
        if (p.EndsWith(".old.exe", StringComparison.OrdinalIgnoreCase)) p = p[..^".old.exe".Length] + ".exe";
        // dotnet run ile (dotnet.exe) çalışıyorsa hook olarak kullanılamaz
        return Path.GetFileNameWithoutExtension(p).Equals("dotnet", StringComparison.OrdinalIgnoreCase) ? null : p;
    }
}

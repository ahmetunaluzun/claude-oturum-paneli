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
/// EN İYİ ÇABA: komut metnine bakan bir yasak listesidir; her yazma yolunu yakalayamaz (ör. betik dosyasının içindeki
/// HTTP isteği, kodlanmış/değişkene bölünmüş komut). Asıl koruma Claude Code izin ayarlarıdır (permissions deny/ask).
/// Test: tools/night_guard_test.py (örnekler tools/night_guard_cases.json, Python kancasıyla ortak).
/// </summary>
public static class NightGuard
{
    public const string Arg = "--night-guard";

    /// <summary>Komutun başı: satır/zincir başı, ortam değişkeni atamaları, sudo/env/... ön ekleri, isteğe bağlı (tırnaklı) yol.</summary>
    const string CmdStart = @"(?:^|[;&|({\n])\s*(?:\w+=\S*\s+)*(?:(?:sudo|env|exec|nohup|time|command|xargs|timeout\s+\S+)\s+(?:-\S+\s+)*)*" +
                            @"(?:""[^""\n]*[\\/]|'[^'\n]*[\\/]|[^\s;&|""']*[\\/])?[""']?";
    const string WriteVerb = "(?:POST|PUT|PATCH|DELETE)";
    /// <summary>curl'de argüman almayan kısa seçenekler (kümede -d/-F/-T/-X'ten önce gelebilir). Büyük/küçük harf duyarlı.</summary>
    const string CurlNoArg = "[sSfLkiIvgjJnNOpqRZ0-9]*";

    static readonly (Regex Re, string Name)[] Commands =
    [
        (R(@"\bgit\b[^\n|;&]*\bpush\b"), "git push"),
        (R(@"\bgh\s+(pr\s+(create|merge|close|comment|review|edit|ready|reopen|lock|unlock)|issue\s+(create|comment|close|edit|reopen|delete|transfer|lock|unlock|pin|unpin|develop)|release\s+(create|upload|delete|edit)|repo\s+(create|edit|delete|rename|fork|archive|unarchive|sync)|gist\s+(create|edit|delete)|label\s+(create|edit|delete|clone)|(secret|variable)\s+(set|delete)|workflow\s+(run|enable|disable)|run\s+(rerun|cancel|delete)|cache\s+delete)\b"), "GitHub'a yazma (gh)"),
        // gh api: yöntem açıkça yazılmışsa (-X POST, -XPOST, --method=POST, --method POST)
        (R(@"\bgh\s+api\b[^\n|;&]*?\s(?:-X\s*|--method(?:\s+|=))['""]?" + WriteVerb + @"\b"), "GitHub API yazma"),
        // gh api: alan/gövde verilince gh varsayılan olarak POST yapar. -X GET ile ve mutation içermeyen graphql sorgusu serbest.
        (R(@"\bgh\s+api(?=\s)(?!\s+graphql\b(?![^\n|;&]*(?:\bmutation\b|--input)))(?![^\n|;&]*\s(?:-X\s*|--method(?:\s+|=))['""]?GET\b)" +
           @"[^\n|;&]*?\s(?:-[fF]|--field\b|--raw-field\b|--input\b)"), "GitHub API yazma"),
        // curl: yazma yöntemi ya da veri/dosya gönderme (-d, --data*, --json, -F, --form*, -T, --upload-file)
        (R(@"\bcurl(?:\.exe)?[""']?(?:\s[^\n|;&]*?)?\s(?:(?-i:-" + CurlNoArg + @"X)\s*['""]?" + WriteVerb + @"\b|--request(?:\s+|=)['""]?" + WriteVerb + @"\b|" +
           @"(?-i:-" + CurlNoArg + @"[dFT])|--(?:data(?:-\w+)?|json|form(?:-string)?|upload-file)\b)"), "HTTP ile veri gönderme (curl)"),
        (R(@"\bwget(?:\.exe)?[""']?(?:\s[^\n|;&]*?)?\s--(?:post-data|post-file|body-data|body-file|method(?:\s+|=)['""]?" + WriteVerb + @"\b)"), "HTTP ile veri gönderme (wget)"),
        (R(@"\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm|curl|wget)\b(?:\s[^\n|;&]*?)?\s-(?:Me\w*(?:\s+|:)['""]?" + WriteVerb + @"\b|Bo\w*\b|InF\w*\b|Form\b)"), "HTTP ile veri gönderme (PowerShell)"),
        // Betik içinden HTTP yazma (python -c, node -e, heredoc): requests/httpx/axios..., method: 'POST', urllib veri, .NET Upload*/PostAsync
        (R(@"\b(?:requests|httpx|aiohttp|axios|session|sess|client|got|ky|superagent|needle|urllib3)\.(?:post|put|patch|delete)\s*\("), "betikten HTTP yazma"),
        (R(@"\bmethod\s*[:=]\s*\\?['""`]?" + WriteVerb + @"\b"), "betikten HTTP yazma"),
        (R(@"\b(?:Request|urlopen)\s*\((?:[^()]|\([^()]*\))*?\bdata\s*="), "betikten HTTP yazma"),
        (R(@"\b(?:Request|urlopen)\s*\(\s*(?:[^,()]|\([^()]*\))+,\s*(?!(?:headers|method|origin_req_host|unverifiable|timeout|context|cafile|capath|cadefault)\s*=)[^\s)]"), "betikten HTTP yazma"),
        (R(@"\b(?:Upload(?:String|Data|File|Values)\w*|(?:Post|Put|Patch|Delete)(?:AsJson)?Async)\s*\("), "betikten HTTP yazma"),
        // Uzak sunucu: ssh/scp/sftp/ssh-copy-id komut olarak (ssh-keygen, ~/.ssh yolu, "grep ssh" serbest); rsync yalnız uzak hedefle
        (R(CmdStart + @"(?:ssh|scp|sftp|ssh-copy-id)(?:\.exe)?[""']?(?=\s|$)"), "uzak sunucuya bağlanma (ssh/scp/sftp)"),
        (R(CmdStart + @"rsync(?:\.exe)?[""']?\s(?:[^\n|;&]*\s)?['""]?[^\s:'""=]{2,}:"), "uzak sunucuya kopyalama (rsync)"),
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
            var cmd = Str(input?["command"]);
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

    static string Str(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : "";

    /// <summary>
    /// Bu oturum gece oturumu mu: true/false; koruma dosyası VAR ama okunamıyor ya da bozuksa null (belirlenemedi).
    /// Panel dosyayı geçici dosya + taşıma ile yazar; taşıma anına denk gelen okuma kısa aralıkla yeniden denenir.
    /// </summary>
    static bool? IsNightSession(string sessionId)
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                if (JsonNode.Parse(File.ReadAllText(NightMode.GuardFile)) is not JsonObject g) return null;
                if (g["until"] is not JsonValue u || !u.TryGetValue<double>(out var until)) return null;
                if (g["sessions"] is not JsonArray sessions) return null;
                return until > DateTimeOffset.UtcNow.ToUnixTimeSeconds()
                       && sessions.Any(s => s is JsonValue v && v.TryGetValue<string>(out var id) && id == sessionId);
            }
            catch (FileNotFoundException) { return false; } // varlık denetiminden sonra silindi: gece modu kapandı
            catch (DirectoryNotFoundException) { return false; }
            catch (IOException) when (attempt < 3) { Thread.Sleep(50); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
            {
                return null;
            }
        }
    }

    /// <summary>
    /// Hook olarak çalıştırılınca (ClaudePanel --night-guard): stdin'deki olayı okur, engellenecekse exit 2 (mesaj stderr'e).
    /// Koruma dosyası yoksa gece modu kapalıdır, her şey serbest. Dosya var ama okunamıyor/bozuksa oturumun gece oturumu
    /// olup olmadığı bilinemez: riskli işlem güvenli tarafta kalınarak engellenir (fail-closed).
    /// </summary>
    public static int RunHook()
    {
        if (!File.Exists(NightMode.GuardFile)) return 0;
        JsonNode? ev;
        try { ev = JsonNode.Parse(Console.In.ReadToEnd()); }
        catch (JsonException) { return 0; }
        var reason = BlockReason(Str(ev?["tool_name"]), ev?["tool_input"]);
        if (reason is null) return 0;
        var night = IsNightSession(Str(ev?["session_id"]));
        if (night == false) return 0;
        var msg = night is null
            ? $"Gece modu: koruma dosyası ({NightMode.GuardFile}) okunamadı, bu oturumun gece oturumu olup olmadığı " +
              $"belirlenemedi; güvenli tarafta kalınarak {reason} engellendi. Bunu yapma, kullanıcıya bildir.\n"
            : $"Gece modu: {reason} engellendi; kullanıcı uyuyor ve bu işlem onun kararı. Bunu yapma, sabaha bırak. " +
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
        // Aynı projede başka oturum çalışırken dosya yazma / git commit-push bekletilir (ProjectGuard.cs).
        if (!text.Contains("project-guard", StringComparison.OrdinalIgnoreCase))
            pre.Add(new JsonObject
            {
                ["matcher"] = "Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell",
                ["hooks"] = new JsonArray(new JsonObject
                {
                    ["type"] = "command",
                    ["command"] = $"\"{exe}\" {ProjectGuard.Arg}",
                    ["timeout"] = 15
                })
            });
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

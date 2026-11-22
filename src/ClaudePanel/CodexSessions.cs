using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ClaudePanel;

/// <summary>
/// Codex CLI oturumlarını salt okuma olarak tarar (issue #1 madde 8).
/// Biçim: docs/codex-yerel-bicim.md (codex-cli 0.171.0'da ölçüldü). Biçim sık değişiyor: her alan isteğe bağlı okunur,
/// ayrıştırılamayan satır ve bilinmeyen tür atlanır, ilk satır session_meta değilse dosya atlanır.
/// Kilit dosyası (thread-writer-locks/&lt;id&gt;.lock) ASLA kilitlenmeye çalışılmaz: Codex'in yazmasını bozabilir.
/// </summary>
public static class CodexSessions
{
    public const string ScanArg = "--codex-scan";
    const int MaxFiles = 200;
    static readonly TimeSpan LiveWindow = TimeSpan.FromMinutes(10);

    /// <summary>
    /// Codex kökü. Uydurma ortamda (CLAUDE_PANEL_CLAUDE_DIR verilmiş: test, ekran görüntüsü) gerçek ~/.codex OKUNMAZ
    /// (OsTasks deseni); orada yalnız CLAUDE_PANEL_CODEX_HOME sayılır, verilmemişse null (Codex yok).
    /// </summary>
    public static string? Home =>
        Environment.GetEnvironmentVariable("CLAUDE_PANEL_CODEX_HOME") is { Length: > 0 } p ? p
        : Environment.GetEnvironmentVariable("CLAUDE_PANEL_CLAUDE_DIR") is { Length: > 0 } ? null
        : Environment.GetEnvironmentVariable("CODEX_HOME") is { Length: > 0 } c ? c
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");

    /// <summary>Codex kurulu mu (kök klasör var mı). Panel bu klasöre hiçbir şey yazmaz.</summary>
    public static bool Installed => Home is { } h && Directory.Exists(h);

    public sealed record RateWindow(double UsedPercent, int WindowMinutes, long? ResetsAt);

    public sealed record CodexSession(
        string Id, string Cwd, string Source, string? Model, string? CliVersion, string? Title,
        string? LastAssistant, DateTimeOffset Started, DateTimeOffset Updated, string State,
        string File, string? PlanType, RateWindow? Primary, RateWindow? Secondary);

    /// <summary>Son <paramref name="days"/> günün oturumları, en yeni önce. Codex kurulu değilse boş liste.</summary>
    public static List<CodexSession> Scan(int days = 14)
    {
        var list = new List<CodexSession>();
        if (Home is not { } home) return list;
        var root = Path.Combine(home, "sessions");
        if (!Directory.Exists(root)) return list;
        var since = DateTime.Now.AddDays(-days);
        IEnumerable<FileInfo> files;
        try
        {
            files = new DirectoryInfo(root).EnumerateFiles("rollout-*.jsonl", SearchOption.AllDirectories)
                .Where(f => f.LastWriteTime >= since).OrderByDescending(f => f.LastWriteTime).Take(MaxFiles).ToList();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return list; }
        foreach (var f in files)
            if (Cached(f) is { } c) list.Add(c.S with { State = StateOf(home, c.S, c.LastTurn) });
        // Listeden düşen dosyaların önbelleği atılır (bellek dosya sayısıyla sınırlı kalır).
        var seen = files.Select(f => f.FullName).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var k in Cache.Keys) if (!seen.Contains(k)) Cache.TryRemove(k, out _);
        return list;
    }

    // Ayrıştırılmış dosya: boyut + son yazma zamanı değişmedikçe yeniden okunmaz (panel birkaç saniyede bir tarar).
    // Geçersiz dosya da (P null) saklanır; dosya değişince yeniden denenir.
    sealed record Parsed(CodexSession S, string? LastTurn);
    static readonly System.Collections.Concurrent.ConcurrentDictionary<string, (long Len, DateTime Mtime, Parsed? P)> Cache =
        new(StringComparer.OrdinalIgnoreCase);

    static Parsed? Cached(FileInfo f)
    {
        if (Cache.TryGetValue(f.FullName, out var c) && c.Len == f.Length && c.Mtime == f.LastWriteTimeUtc) return c.P;
        var p = Read(f);
        Cache[f.FullName] = (f.Length, f.LastWriteTimeUtc, p);
        return p;
    }

    // Kilit dosyası canlı yazar olmadan da kalabilir; tek başına yetmez, son yazma zamanıyla birlikte bakılır.
    static string StateOf(string home, CodexSession s, string? lastTurn)
    {
        var locked = File.Exists(Path.Combine(home, "thread-writer-locks", s.Id + ".lock"));
        var recent = DateTimeOffset.Now - s.Updated < LiveWindow;
        return locked && recent ? (lastTurn == "started" ? "working" : "open") : "ended";
    }

    static Parsed? Read(FileInfo f)
    {
        if (Lines(f.FullName) is not { Count: > 0 } lines) return null;
        var first = Parse(lines[0]);
        if (first?["type"]?.GetValue<string>() != "session_meta" || first["payload"] is not JsonObject meta) return null;

        var id = Str(meta, "session_id") ?? Str(meta, "id");
        if (string.IsNullOrEmpty(id)) return null;
        string? model = null, title = null, lastAsst = null, plan = null, lastTurn = null;
        RateWindow? prim = null, sec = null;
        foreach (var raw in lines.Skip(1))
        {
            if (Parse(raw) is not { } o || o["payload"] is not JsonObject p) continue;
            switch (Str(o, "type"))
            {
                case "turn_context": model = Str(p, "model") ?? model; break;
                case "response_item" when Str(p, "type") == "message":
                    var text = Text(p["content"]);
                    if (text is null) break;
                    if (Str(p, "role") == "user" && title is null && !text.TrimStart().StartsWith('<')) title = text;
                    else if (Str(p, "role") == "assistant") lastAsst = text;
                    break;
                case "event_msg":
                    var et = Str(p, "type");
                    if (et is "task_started" or "turn_started") lastTurn = "started";
                    else if (et is "task_complete" or "turn_complete" or "turn_aborted") lastTurn = "done";
                    else if (et == "token_count" && p["rate_limits"] is JsonObject rl
                             && (Str(rl, "limit_id") is null or "codex"))
                    {
                        plan = Str(rl, "plan_type") ?? plan;
                        prim = Window(rl["primary"]) ?? prim;
                        sec = Window(rl["secondary"]);
                    }
                    break;
            }
        }
        var started = DateTimeOffset.TryParse(Str(meta, "timestamp"), CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal, out var t) ? t : new DateTimeOffset(f.CreationTime);
        var updated = new DateTimeOffset(f.LastWriteTime);
        var s = new CodexSession(id, Str(meta, "cwd") ?? "", Str(meta, "source") ?? "unknown", model, Str(meta, "cli_version"),
            Short(title, 120), Short(lastAsst, 300), started, updated, "ended", f.FullName, plan, prim, sec);
        return new Parsed(s, lastTurn);
    }

    public sealed record CodexItem(string Id, string Kind, string Text, long? Ts);
    sealed record TranscriptCache(string File, long Len, DateTime Mtime, List<CodexItem> Items);
    static volatile TranscriptCache? transcript; // okuma görünümü 1,5 sn'de bir sorar; dosya değişmedikçe yeniden ayrıştırılmaz

    /// <summary>
    /// Okuma görünümü: kullanıcı ve asistan mesajları (developer mesajı ve "&lt;" ile başlayan enjekte ortam metni hariç).
    /// Dosya yolu istemciden ALINMAZ: kimlik taramadaki oturuma eşlenir; bulunamazsa null.
    /// </summary>
    public static List<CodexItem>? ReadTranscript(string id, int limit = 250)
    {
        if (Scan().FirstOrDefault(s => s.Id == id) is not { } s) return null;
        var fi = new FileInfo(s.File);
        if (transcript is { } c && c.File == fi.FullName && c.Len == fi.Length && c.Mtime == fi.LastWriteTimeUtc)
            return c.Items.TakeLast(limit).ToList();
        if (Lines(s.File) is not { } lines) return null;
        List<CodexItem> items = [], events = [];
        for (var i = 1; i < lines.Count; i++)
        {
            if (Parse(lines[i]) is not { } o || o["payload"] is not JsonObject p) continue;
            long? ts = DateTimeOffset.TryParse(Str(o, "timestamp"), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal,
                out var t) ? t.ToUnixTimeMilliseconds() : null;
            var type = Str(o, "type");
            if (type == "response_item" && Str(p, "type") == "message" && Str(p, "role") is "user" or "assistant")
            {
                var text = Text(p["content"]);
                var kind = Str(p, "role")!;
                if (string.IsNullOrWhiteSpace(text) || (kind == "user" && text.TrimStart().StartsWith('<'))) continue;
                items.Add(new CodexItem("c" + i, kind, text.Trim(), ts));
            }
            // Eski kalıcılık modu: mesajlar yalnız olay olarak (docs/codex-yerel-bicim.md); response_item yoksa bunlar kullanılır.
            else if (type == "event_msg" && Str(p, "type") is "user_message" or "agent_message"
                     && Str(p, "message") is { Length: > 0 } m && !(Str(p, "type") == "user_message" && m.TrimStart().StartsWith('<')))
                events.Add(new CodexItem("e" + i, Str(p, "type") == "user_message" ? "user" : "assistant", m.Trim(), ts));
        }
        var list = items.Count > 0 ? items : events;
        transcript = new TranscriptCache(fi.FullName, fi.Length, fi.LastWriteTimeUtc, list);
        return list.TakeLast(limit).ToList();
    }

    // Codex yazarken de okunabilsin: paylaşımlı açılır, kilit alınmaz. Boş satırlar atlanır.
    static List<string>? Lines(string path)
    {
        try
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var sr = new StreamReader(fs);
            var lines = new List<string>();
            while (sr.ReadLine() is { } l) if (l.Length > 0) lines.Add(l);
            return lines;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return null; }
    }

    static JsonNode? Parse(string line)
    {
        try { return JsonNode.Parse(line); }
        catch (JsonException) { return null; } // yarım yazılmış son satır
    }

    static string? Str(JsonNode? n, string key) =>
        n is JsonObject o && o[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    static string? Text(JsonNode? content)
    {
        if (content is JsonValue v && v.TryGetValue<string>(out var s)) return s;
        if (content is not JsonArray a) return null;
        var parts = a.Select(x => Str(x, "text")).Where(x => !string.IsNullOrEmpty(x)).ToList();
        return parts.Count == 0 ? null : string.Join("\n", parts);
    }

    static RateWindow? Window(JsonNode? n)
    {
        if (n is not JsonObject o) return null;
        double used = o["used_percent"] is JsonValue u && u.TryGetValue<double>(out var d) ? d : 0;
        int win = o["window_minutes"] is JsonValue w && w.TryGetValue<int>(out var i) ? i : 0;
        long? reset = o["resets_at"] is JsonValue r && r.TryGetValue<long>(out var l) ? l : null;
        return new RateWindow(used, win, reset);
    }

    static string? Short(string? s, int max) =>
        s is null ? null : (s = s.Trim()).Length <= max ? s : s[..max].TrimEnd() + "…";

    /// <summary>Test/teşhis: taramayı JSON olarak yazar (`ClaudePanel --codex-scan [gün]`).</summary>
    public static int RunScan(string[] args)
    {
        var days = args.Length > 1 && int.TryParse(args[1], out var d) ? d : 14;
        var opts = new JsonSerializerOptions { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        Console.WriteLine(JsonSerializer.Serialize(new { home = Home, sessions = Scan(days) }, opts));
        return 0;
    }
}

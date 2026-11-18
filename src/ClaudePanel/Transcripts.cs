using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;

namespace ClaudePanel;

/// <summary>Bir konuşma kaydındaki gösterilebilir öğe.</summary>
public sealed record TranscriptItem(string Id, string Kind, string Text, string? Tool, long Ts);

/// <summary>Son oturumlar listesindeki satır.</summary>
public sealed record RecentSession(string SessionId, string Cwd, string Title, long UpdatedAt, long SizeKb);

/// <summary>
/// ~/.claude/projects/*/&lt;oturum&gt;.jsonl konuşma kayıtlarını okur. Dosya büyüdükçe yalnız eklenen kısım ayrıştırılır.
/// </summary>
public sealed class Transcripts(ILogger<Transcripts> log)
{
    static readonly string ProjectsDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude", "projects");
    const int MaxItems = 400;
    const int MaxText = 6000;

    sealed class Cache
    {
        public long Offset;
        public readonly List<TranscriptItem> Items = new();
        public string? Title;
        public string? Cwd;
        // Oturum istatistikleri (kart ve konuşma başlığı için)
        public string? Model, LastText, LastTool, LastToolName, CurMsgId;
        public long CtxTokens, InTok, OutTok, CacheRead, CacheWrite;
        public long CurIn, CurOut, CurRead, CurWrite;
        public int Turns, Compactions;
        public bool LastIsTool;
    }

    /// <summary>Kart ve konuşma başlığında gösterilen oturum özeti (konuşma kaydından).</summary>
    public sealed record SessionStats(string? Model, long CtxTokens, long InTok, long OutTok, long CacheRead,
        long CacheWrite, int Turns, int Compactions, string? LastText, string? LastTool, string? LastToolName, bool LastIsTool);

    /// <summary>Kaydı sondan ilerletir (önbellekli) ve özetini verir; kayıt yoksa null.</summary>
    public SessionStats? Stats(string sessionId)
    {
        var path = PathOf(sessionId);
        if (path is null) return null;
        var c = _cache.GetOrAdd(path, _ => new Cache());
        lock (c)
        {
            Advance(path, c);
            return new SessionStats(c.Model, c.CtxTokens, c.InTok + c.CurIn, c.OutTok + c.CurOut,
                c.CacheRead + c.CurRead, c.CacheWrite + c.CurWrite, c.Turns, c.Compactions,
                c.LastText, c.LastTool, c.LastToolName, c.LastIsTool);
        }
    }

    readonly ConcurrentDictionary<string, string> _paths = new();
    readonly ConcurrentDictionary<string, Cache> _cache = new();

    public string? PathOf(string sessionId)
    {
        if (!Guid.TryParse(sessionId, out _) || !Directory.Exists(ProjectsDir)) return null;
        // Liste birkaç saniyede bir tüm oturumlar için sorar: bulunan yol önbellekte (dosya silinmediyse).
        if (_paths.TryGetValue(sessionId, out var known) && File.Exists(known)) return known;
        foreach (var dir in Directory.EnumerateDirectories(ProjectsDir))
        {
            var f = Path.Combine(dir, sessionId + ".jsonl");
            if (File.Exists(f)) return _paths[sessionId] = f;
        }
        return null;
    }

    public (IReadOnlyList<TranscriptItem> Items, string? Title, string? Cwd) Read(string sessionId, int limit = 200)
    {
        var path = PathOf(sessionId);
        if (path is null) return ([], null, null);
        var c = _cache.GetOrAdd(path, _ => new Cache());
        lock (c)
        {
            Advance(path, c);
            var items = c.Items.Count > limit ? c.Items.GetRange(c.Items.Count - limit, limit) : c.Items.ToList();
            return (items, c.Title, c.Cwd);
        }
    }

    /// <summary>Son N gün içinde güncellenen oturumlar (en yeni üstte).</summary>
    public IReadOnlyList<RecentSession> Recent(int days = 14, int max = 40)
    {
        if (!Directory.Exists(ProjectsDir)) return [];
        var since = DateTime.UtcNow.AddDays(-days);
        var files = Directory.EnumerateDirectories(ProjectsDir)
            .SelectMany(d => Directory.EnumerateFiles(d, "*.jsonl"))
            .Select(f => new FileInfo(f))
            .Where(f => f.LastWriteTimeUtc >= since && Guid.TryParse(Path.GetFileNameWithoutExtension(f.Name), out _))
            .OrderByDescending(f => f.LastWriteTimeUtc)
            .Take(max * 2);

        var list = new List<RecentSession>();
        foreach (var f in files)
        {
            var c = _cache.GetOrAdd(f.FullName, _ => new Cache());
            lock (c) { Advance(f.FullName, c); }
            if (c.Cwd is null || c.Items.Count(i => i.Kind == "user") == 0) continue; // boş/yan oturum
            list.Add(new RecentSession(Path.GetFileNameWithoutExtension(f.Name), c.Cwd,
                c.Title ?? c.Items.First(i => i.Kind == "user").Text.Split('\n')[0],
                new DateTimeOffset(f.LastWriteTimeUtc).ToUnixTimeMilliseconds(), f.Length / 1024));
            if (list.Count >= max) break;
        }
        return list;
    }

    public sealed record ProjectInfo(string Cwd, string Name, int Sessions, long LastUsed);
    readonly ConcurrentDictionary<string, string?> _cwdOfDir = new();

    /// <summary>Claude'un çalıştığı tüm proje klasörleri (en son kullanılan üstte). Silinmiş ve geçici klasörler atlanır.</summary>
    public IReadOnlyList<ProjectInfo> Projects()
    {
        if (!Directory.Exists(ProjectsDir)) return [];
        var temp = Path.GetTempPath().TrimEnd('\\');
        var list = new List<ProjectInfo>();
        foreach (var dir in Directory.EnumerateDirectories(ProjectsDir))
        {
            var files = new DirectoryInfo(dir).GetFiles("*.jsonl");
            if (files.Length == 0) continue;
            var newest = files.MaxBy(f => f.LastWriteTimeUtc)!;
            var cwd = _cwdOfDir.GetOrAdd(dir, _ => FirstCwd(files.OrderByDescending(f => f.LastWriteTimeUtc).Take(3)));
            if (cwd is null || !Directory.Exists(cwd) || cwd.StartsWith(temp, StringComparison.OrdinalIgnoreCase)) continue;
            list.Add(new ProjectInfo(cwd, Path.GetFileName(cwd.TrimEnd('\\', '/')) is { Length: > 0 } n ? n : cwd,
                files.Length, new DateTimeOffset(newest.LastWriteTimeUtc).ToUnixTimeMilliseconds()));
        }
        return list.GroupBy(p => p.Cwd, StringComparer.OrdinalIgnoreCase)
            .Select(g => g.OrderByDescending(p => p.LastUsed).First() with { Sessions = g.Sum(p => p.Sessions) })
            .OrderByDescending(p => p.LastUsed).ToList();
    }

    /// <summary>Kaydın ilk satırlarından çalışma klasörünü okur (dosyanın tamamı okunmaz).</summary>
    static string? FirstCwd(IEnumerable<FileInfo> files)
    {
        foreach (var f in files)
        {
            try
            {
                using var fs = new FileStream(f.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var r = new StreamReader(fs, new UTF8Encoding(false));
                for (var i = 0; i < 60 && r.ReadLine() is { } line; i++)
                {
                    var at = line.IndexOf("\"cwd\":\"", StringComparison.Ordinal);
                    if (at < 0) continue;
                    using var doc = JsonDocument.Parse(line);
                    return Str(doc.RootElement, "cwd");
                }
            }
            catch (Exception ex) when (ex is IOException or JsonException) { /* sonraki dosya */ }
        }
        return null;
    }

    void Advance(string path, Cache c)
    {
        try
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            if (fs.Length < c.Offset) { c.Offset = 0; c.Items.Clear(); } // dosya yeniden yazılmış
            if (fs.Length == c.Offset) return;
            fs.Seek(c.Offset, SeekOrigin.Begin);
            using var reader = new StreamReader(fs, new UTF8Encoding(false));
            var chunk = reader.ReadToEnd();
            var lastNl = chunk.LastIndexOf('\n');
            if (lastNl < 0) return; // satır henüz tamamlanmadı
            var complete = chunk[..(lastNl + 1)];
            c.Offset += Encoding.UTF8.GetByteCount(complete);
            foreach (var line in complete.Split('\n'))
                if (line.Length > 2) ParseLine(line, c);
            if (c.Items.Count > MaxItems * 2) c.Items.RemoveRange(0, c.Items.Count - MaxItems);
        }
        catch (IOException ex)
        {
            log.LogDebug("Kayıt okunamadı {Path}: {Msg}", path, ex.Message);
        }
    }

    static void ParseLine(string line, Cache c)
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(line); }
        catch (JsonException) { return; } // tek bozuk satır kaydı düşürmesin
        using (doc)
        {
            var r = doc.RootElement;
            var type = Str(r, "type");
            if (type == "ai-title") { c.Title = Str(r, "title") ?? Str(r, "aiTitle") ?? c.Title; return; }
            if (type == "system" && Str(r, "subtype") == "compact_boundary") { c.Compactions++; return; }
            if (type is not ("user" or "assistant")) return;
            if (r.TryGetProperty("isSidechain", out var sc) && sc.ValueKind == JsonValueKind.True) return;
            if (type == "assistant") CountUsage(r, c);
            if (r.TryGetProperty("isMeta", out var meta) && meta.ValueKind == JsonValueKind.True) return;
            c.Cwd ??= Str(r, "cwd");
            var id = Str(r, "uuid") ?? Guid.NewGuid().ToString();
            var ts = DateTimeOffset.TryParse(Str(r, "timestamp"), out var dt) ? dt.ToUnixTimeMilliseconds() : 0;
            if (!r.TryGetProperty("message", out var msg) || !msg.TryGetProperty("content", out var content)) return;

            if (content.ValueKind == JsonValueKind.String)
            {
                AddText(c, id, type, content.GetString(), ts);
                return;
            }
            if (content.ValueKind != JsonValueKind.Array) return;
            var n = 0;
            foreach (var block in content.EnumerateArray())
            {
                var bt = Str(block, "type");
                var bid = $"{id}:{n++}";
                if (bt == "text") AddText(c, bid, type, Str(block, "text"), ts);
                else if (bt == "tool_use")
                {
                    var summary = ToolSummary(block);
                    c.Items.Add(new TranscriptItem(bid, "tool", summary, Str(block, "name"), ts));
                    c.LastTool = summary;
                    c.LastToolName = Str(block, "name");
                    c.LastIsTool = true;
                }
            }
        }
    }

    /// <summary>
    /// Bir yanıt birden çok satıra bölünür, hepsi aynı message.id ve kullanım bilgisini taşır: kimlik değişince
    /// öncekini toplama ekler (çift sayım yok). Bağlam = son yanıtın girdi + önbellek + çıktı tokenı.
    /// </summary>
    static void CountUsage(JsonElement r, Cache c)
    {
        if (!r.TryGetProperty("message", out var msg) || msg.ValueKind != JsonValueKind.Object) return;
        if (Str(msg, "model") is { } model && model.StartsWith("claude-")) c.Model = model;
        if (!msg.TryGetProperty("usage", out var u) || u.ValueKind != JsonValueKind.Object) return;
        var id = Str(msg, "id");
        if (id != c.CurMsgId)
        {
            c.InTok += c.CurIn; c.OutTok += c.CurOut; c.CacheRead += c.CurRead; c.CacheWrite += c.CurWrite;
            c.CurMsgId = id;
        }
        c.CurIn = Num(u, "input_tokens"); c.CurOut = Num(u, "output_tokens");
        c.CurRead = Num(u, "cache_read_input_tokens"); c.CurWrite = Num(u, "cache_creation_input_tokens");
        c.CtxTokens = c.CurIn + c.CurRead + c.CurWrite + c.CurOut;
    }

    static long Num(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n) ? n : 0;

    static void AddText(Cache c, string id, string kind, string? text, long ts)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        var t = text.Trim();
        // Sistem/komut ekleri (<command-name>, <system-reminder> ...) sohbet değildir.
        if (kind == "user" && t.StartsWith('<')) return;
        if (t.Length > MaxText) t = t[..MaxText] + " …";
        c.Items.Add(new TranscriptItem(id, kind, t, null, ts));
        if (kind == "user") { c.Turns++; c.LastIsTool = false; }
        else { c.LastText = t.Length > 400 ? t[^400..] : t; c.LastIsTool = false; }
    }

    static string ToolSummary(JsonElement block)
    {
        if (!block.TryGetProperty("input", out var input) || input.ValueKind != JsonValueKind.Object) return "";
        foreach (var key in new[] { "description", "command", "file_path", "pattern", "url", "query", "prompt", "skill" })
        {
            var v = Str(input, key);
            if (!string.IsNullOrWhiteSpace(v)) return v.Length > 220 ? v[..220] + " …" : v;
        }
        return "";
    }

    static string? Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() : null;
}

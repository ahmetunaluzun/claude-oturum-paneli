using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;

namespace ClaudePanel;

/// <summary>Açık bir oturumdaki tekrarlı iş (Takip → Zamanlanmış işler).</summary>
/// <param name="Type">"cron" (CronCreate) | "wakeup" (ScheduleWakeup zinciri; /loop da bunu kullanır).</param>
/// <param name="Key">Panel oturumunun anahtarı; terminal oturumunda null (panel ona mesaj gönderemez).</param>
/// <param name="Schedule">cron ifadesi (cron) ya da /loop komutunun argümanı (wakeup; yoksa null).</param>
/// <param name="DelaySeconds">Son ScheduleWakeup gecikmesi; cron'da null.</param>
/// <param name="Tokens">Başlangıçtan beri oturumun işlediği yeni token (girdi + çıktı + önbelleğe yazılan; önbellekten okunan sayılmaz).</param>
/// <param name="NoopStreak">Sondaki ardışık "bir şey değişmedi" (noop: true) tur sayısı.</param>
public sealed record LoopInfo(string Id, string Type, string SessionId, string? Key, int? Pid, string Name, string Cwd, string Root,
    string? Schedule, bool Recurring, int? DelaySeconds, string Prompt, long StartedAt, long LastAt, long Tokens, int Runs, int NoopStreak);

/// <summary>
/// Açık oturumların konuşma kayıtlarından /loop, CronCreate ve ScheduleWakeup çağrılarını bulur. Kayıt artımlı okunur
/// (yalnız eklenen kısım). Araç adları Claude Code belgesinde geçer; parametre adları (cron, prompt, recurring; delaySeconds,
/// reason, prompt, noop, stop) belgede YOK: bu bilgisayarın kayıtlarında görülen adlardır (saha tespiti). Tanınmayan alan
/// yok sayılır, uydurulmaz. Panel hiçbir şeyi kendiliğinden durdurmaz; yalnız listeler.
/// </summary>
public sealed class LoopScan(Transcripts transcripts)
{
    /// <summary>Uyanma saati geçtikten sonra zincirin "sürüyor" sayıldığı süre (oturum meşgulse tur gecikir).</summary>
    static readonly TimeSpan WakeGrace = TimeSpan.FromMinutes(10);
    /// <summary>Belge: yinelenen görev 7 gün sonra kendini siler.</summary>
    static readonly TimeSpan CronLife = TimeSpan.FromDays(7);
    const int PromptMax = 200;

    sealed class Cron
    {
        public required string ToolId, Expr, Prompt;
        public bool Recurring;
        public long At, TokAt;
        public string Result = "";
    }

    sealed class Cache
    {
        public long Offset;
        public long Tok, CurTok;
        public string? CurMsgId;
        public readonly List<Cron> Crons = [];
        // ScheduleWakeup zinciri
        public bool Chain;
        public long ChainAt, ChainTokAt, WakeAt;
        public int Delay, Runs, Noops;
        public string WakePrompt = "";
        public string? LoopArgs;
        public long LoopArgsAt;
    }

    readonly ConcurrentDictionary<string, Cache> _cache = new();

    public sealed record OpenSession(string SessionId, string? Key, int? Pid, string Name, string Cwd);

    public List<LoopInfo> Scan(IEnumerable<OpenSession> sessions)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var list = new List<LoopInfo>();
        foreach (var s in sessions.GroupBy(x => x.SessionId).Select(g => g.OrderBy(x => x.Key is null).First()))
        {
            if (transcripts.PathOf(s.SessionId) is not { } path) continue;
            var c = _cache.GetOrAdd(path, _ => new Cache());
            lock (c)
            {
                Advance(path, c);
                var total = c.Tok + c.CurTok;
                var root = ProjectRoots.Of(s.Cwd);
                foreach (var cr in c.Crons)
                {
                    if (cr.At < now - CronLife.TotalMilliseconds) continue;
                    list.Add(new LoopInfo($"cron:{s.SessionId}:{cr.ToolId}", "cron", s.SessionId, s.Key, s.Pid, s.Name, s.Cwd, root,
                        cr.Expr, cr.Recurring, null, cr.Prompt, cr.At, cr.At, total - cr.TokAt, 0, 0));
                }
                if (c.Chain && c.WakeAt + c.Delay * 1000L + WakeGrace.TotalMilliseconds > now)
                    list.Add(new LoopInfo($"wake:{s.SessionId}", "wakeup", s.SessionId, s.Key, s.Pid, s.Name, s.Cwd, root,
                        c.LoopArgs, true, c.Delay, c.WakePrompt, c.ChainAt, c.WakeAt, total - c.ChainTokAt, c.Runs, c.Noops));
            }
        }
        if (_cache.Count > 300) _cache.Clear();
        return list;
    }

    static void Advance(string path, Cache c)
    {
        try
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            if (fs.Length < c.Offset) { c.Offset = 0; c.Crons.Clear(); c.Chain = false; c.Tok = c.CurTok = 0; c.CurMsgId = null; c.LoopArgs = null; }
            if (fs.Length == c.Offset) return;
            fs.Seek(c.Offset, SeekOrigin.Begin);
            using var reader = new StreamReader(fs, new UTF8Encoding(false));
            var chunk = reader.ReadToEnd();
            var lastNl = chunk.LastIndexOf('\n');
            if (lastNl < 0) return;
            var complete = chunk[..(lastNl + 1)];
            c.Offset += Encoding.UTF8.GetByteCount(complete);
            foreach (var line in complete.Split('\n'))
                if (line.Length > 2) ParseLine(line, c);
        }
        catch (IOException) { /* kayıt şu an okunamıyor: eldeki durum kalır */ }
    }

    /// <summary>Tek satır; testte doğrudan çağrılabilsin diye ayrı.</summary>
    static void ParseLine(string line, Cache c)
    {
        // Hızlı eleme: kullanım bilgisi ya da ilgili araç/komut geçmeyen satır ayrıştırılmaz.
        var relevant = line.Contains("\"usage\"", StringComparison.Ordinal) || line.Contains("ScheduleWakeup", StringComparison.Ordinal)
            || line.Contains("Cron", StringComparison.Ordinal) || line.Contains("/loop", StringComparison.Ordinal) || line.Contains("tool_result", StringComparison.Ordinal);
        if (!relevant) return;
        JsonDocument doc;
        try { doc = JsonDocument.Parse(line); }
        catch (JsonException) { return; }
        using (doc)
        {
            var r = doc.RootElement;
            var type = Str(r, "type");
            if (type is not ("user" or "assistant")) return;
            if (r.TryGetProperty("isSidechain", out var sc) && sc.ValueKind == JsonValueKind.True) return;
            var ts = DateTimeOffset.TryParse(Str(r, "timestamp"), out var dt) ? dt.ToUnixTimeMilliseconds() : 0;
            if (!r.TryGetProperty("message", out var msg) || msg.ValueKind != JsonValueKind.Object) return;
            if (type == "assistant") CountUsage(msg, c);
            if (!msg.TryGetProperty("content", out var content)) return;
            if (content.ValueKind == JsonValueKind.String) { if (type == "user") LoopCommand(content.GetString(), ts, c); return; }
            if (content.ValueKind != JsonValueKind.Array) return;
            foreach (var block in content.EnumerateArray())
            {
                var bt = Str(block, "type");
                if (type == "user" && bt == "text") LoopCommand(Str(block, "text"), ts, c);
                else if (type == "user" && bt == "tool_result") ToolResult(block, c);
                else if (type == "assistant" && bt == "tool_use") ToolUse(block, ts, c);
            }
        }
    }

    /// <summary>/loop komutu: "&lt;command-name&gt;/loop&lt;/command-name&gt; … &lt;command-args&gt;5m /foo&lt;/command-args&gt;".</summary>
    static void LoopCommand(string? text, long ts, Cache c)
    {
        if (text is null || !text.Contains("<command-name>/loop</command-name>", StringComparison.Ordinal)) return;
        var a = text.IndexOf("<command-args>", StringComparison.Ordinal);
        var b = text.IndexOf("</command-args>", StringComparison.Ordinal);
        c.LoopArgs = a >= 0 && b > a ? Shorten(text[(a + 14)..b]) : "";
        c.LoopArgsAt = ts;
        c.Chain = false; // yeni /loop: önceki zincir bitti sayılır, ilk ScheduleWakeup yenisini başlatır
    }

    static void ToolUse(JsonElement block, long ts, Cache c)
    {
        var name = Str(block, "name");
        if (!block.TryGetProperty("input", out var input) || input.ValueKind != JsonValueKind.Object) return;
        var total = c.Tok + c.CurTok;
        if (name == "CronCreate" && Str(input, "cron") is { Length: > 0 } expr)
        {
            c.Crons.Add(new Cron
            {
                ToolId = Str(block, "id") ?? Guid.NewGuid().ToString("N"), Expr = expr, Prompt = Shorten(Str(input, "prompt") ?? ""),
                Recurring = !input.TryGetProperty("recurring", out var rec) || rec.ValueKind != JsonValueKind.False, At = ts, TokAt = total
            });
        }
        else if (name == "CronDelete")
        {
            // Silinen görevin kimliği, CronCreate sonucunun metninde geçen değerle eşleştirilir (sonuç biçimi belgesiz).
            var ids = input.EnumerateObject().Where(p => p.Value.ValueKind == JsonValueKind.String).Select(p => p.Value.GetString()!).Where(v => v.Length >= 4).ToList();
            c.Crons.RemoveAll(cr => ids.Any(id => cr.Result.Contains(id, StringComparison.Ordinal)));
        }
        else if (name == "ScheduleWakeup")
        {
            if (input.TryGetProperty("stop", out var stop) && stop.ValueKind == JsonValueKind.True) { c.Chain = false; return; }
            if (!input.TryGetProperty("delaySeconds", out var d) || !d.TryGetInt32(out var delay)) return;
            if (!c.Chain)
            {
                c.Chain = true; c.ChainAt = ts; c.ChainTokAt = total; c.Runs = 0; c.Noops = 0;
                if (c.LoopArgs is not null && c.LoopArgsAt > 0 && ts - c.LoopArgsAt > 3_600_000 * 24) c.LoopArgs = null; // eski /loop bu zincirin değil
            }
            c.Runs++;
            var noop = input.TryGetProperty("noop", out var n) && n.ValueKind == JsonValueKind.True;
            c.Noops = noop ? c.Noops + 1 : 0;
            c.Delay = delay; c.WakeAt = ts;
            c.WakePrompt = Shorten(Str(input, "reason") ?? Str(input, "prompt") ?? "");
        }
    }

    static void ToolResult(JsonElement block, Cache c)
    {
        if (c.Crons.Count == 0 || Str(block, "tool_use_id") is not { } id) return;
        if (c.Crons.FirstOrDefault(cr => cr.ToolId == id) is not { } cron) return;
        if (!block.TryGetProperty("content", out var content)) return;
        cron.Result = content.ValueKind == JsonValueKind.String ? content.GetString() ?? "" : content.GetRawText();
        // Görev oluşturulamadıysa (is_error) listede durmaz.
        if (block.TryGetProperty("is_error", out var err) && err.ValueKind == JsonValueKind.True) c.Crons.Remove(cron);
    }

    static void CountUsage(JsonElement msg, Cache c)
    {
        if (!msg.TryGetProperty("usage", out var u) || u.ValueKind != JsonValueKind.Object) return;
        var id = Str(msg, "id");
        if (id != c.CurMsgId) { c.Tok += c.CurTok; c.CurMsgId = id; }
        c.CurTok = Num(u, "input_tokens") + Num(u, "output_tokens") + Num(u, "cache_creation_input_tokens");
    }

    static string Shorten(string s)
    {
        s = string.Join(' ', s.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return s.Length > PromptMax ? s[..(PromptMax - 1)].TrimEnd() + "…" : s;
    }

    static long Num(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n) ? n : 0;

    static string? Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
}

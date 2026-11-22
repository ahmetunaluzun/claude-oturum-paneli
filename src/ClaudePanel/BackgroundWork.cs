using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ClaudePanel;

/// <param name="Kind">"agent" (arka plan alt ajanı) | "bash" (arka plan komutu).</param>
/// <param name="Stale">Bitiş bildirimi yok ve uzun süredir hiçbir iz yok: takılmış olabilir (bitti sayılmaz).</param>
public sealed record BgJob(string Kind, string Label, long Since, bool Stale);

/// <summary>Bir panel oturumunun arka plan işi; yeniden başlatma/kapatma uyarısında oturum adıyla birlikte gösterilir.</summary>
public sealed record BgJobOf(string Session, BgJob Job);

/// <summary>
/// "Boşta" görünen bir oturumun arka planda iş taşıyıp taşımadığını konuşma kaydından (ana jsonl) çıkarır: oturum kullanıcıya cevabını
/// bitirince "idle" olur ama içinde arka planda çalışan alt ajan (Agent) ya da arka plan komutu (Bash run_in_background) sürebilir;
/// yeniden başlatma/kapatma onu keser. Gerçek kayıt biçimi (22.11.2026'da bu bilgisayardaki kayıtlardan doğrulandı):
///   Başlangıç: kullanıcı satırı, toolUseResult.isAsync=true + agentId (alt ajan; run_in_background bayrağı olmasa da)
///              ya da toolUseResult.backgroundTaskId (komut; komutun açıklaması önceki asistan satırındaki tool_use girdisinde).
///   Bitiş:     "&lt;task-notification&gt;&lt;task-id&gt;…&lt;/task-id&gt;…&lt;status&gt;completed|failed|killed|stopped&lt;/status&gt;" (kullanıcı ve kuyruk satırları);
///              task-id = agentId / backgroundTaskId.
/// Ek güvence: &lt;oturum&gt;/subagents/agent-&lt;kimlik&gt;.jsonl son <see cref="ActiveWithin"/> içinde yazıldıysa o alt ajan çalışıyor sayılır
/// (bildirim biçimi değişse de); <see cref="StaleAfter"/> boyunca hiç iz yoksa "takılmış olabilir" (bitti sayılmaz, uyarıda gösterilir).
/// Kayıt artımlı okunur (yalnız eklenen kısım); yalnız anahtar sözcük içeren satırlar ayrıştırılır. Yalnız okur, içerik dışarı verilmez
/// (etiket: alt ajanın kısa açıklaması / komutun açıklaması, en çok <see cref="LabelMax"/> karakter).
/// </summary>
public sealed partial class BackgroundWork(Transcripts transcripts, ILogger<BackgroundWork> log)
{
    public static readonly TimeSpan ActiveWithin = TimeSpan.FromMinutes(2), StaleAfter = TimeSpan.FromHours(6);
    const int LabelMax = 80, UsesMax = 200;

    sealed record Open(string Kind, string Label, long Since);

    sealed class Cache
    {
        public long Offset;
        public readonly Dictionary<string, Open> Jobs = new();
        public readonly HashSet<string> Done = new(), SeenAgents = new();
        public readonly Dictionary<string, string> BashUses = new(); // tool_use kimliği → açıklama (arka plan komutları)
    }

    readonly ConcurrentDictionary<string, Cache> _cache = new();

    /// <summary>Oturumun şu an süren arka plan işleri (kayıt yoksa ya da iş yoksa boş).</summary>
    public IReadOnlyList<BgJob> Of(string? sessionId)
    {
        if (sessionId is null || transcripts.PathOf(sessionId) is not { } path) return [];
        var c = _cache.GetOrAdd(path, _ => new Cache());
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var dir = Path.Combine(Path.GetDirectoryName(path)!, sessionId, "subagents");
        lock (c)
        {
            Advance(path, c);
            var res = new List<BgJob>();
            foreach (var (id, j) in c.Jobs)
            {
                var last = j.Since;
                if (j.Kind == "agent" && LastWrite(Path.Combine(dir, $"agent-{id}.jsonl")) is { } w) last = Math.Max(last, w);
                res.Add(new BgJob(j.Kind, j.Label, j.Since, now - last > StaleAfter.TotalMilliseconds));
            }
            // Bildirimi/başlangıcı görülmemiş ama az önce yazılan alt ajan kaydı: çalışıyor say.
            if (Directory.Exists(dir))
            {
                try
                {
                    foreach (var f in new DirectoryInfo(dir).EnumerateFiles("agent-*.jsonl"))
                    {
                        var id = f.Name[6..^6];
                        var w = new DateTimeOffset(f.LastWriteTimeUtc).ToUnixTimeMilliseconds();
                        if (now - w > ActiveWithin.TotalMilliseconds || c.Jobs.ContainsKey(id) || c.Done.Contains(id) || c.SeenAgents.Contains(id)) continue;
                        res.Add(new BgJob("agent", "", new DateTimeOffset(f.CreationTimeUtc).ToUnixTimeMilliseconds(), false));
                    }
                }
                catch (IOException ex) { log.LogDebug("Alt ajan klasörü okunamadı: {Msg}", ex.Message); }
            }
            return res.OrderBy(j => j.Since).ToList();
        }
    }

    static long? LastWrite(string file)
    {
        try { return File.Exists(file) ? new DateTimeOffset(File.GetLastWriteTimeUtc(file)).ToUnixTimeMilliseconds() : null; }
        catch (IOException) { return null; }
    }

    // ---- Kayıt okuma (artımlı) ----

    void Advance(string path, Cache c)
    {
        try
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            if (fs.Length < c.Offset) { c.Offset = 0; c.Jobs.Clear(); c.Done.Clear(); c.SeenAgents.Clear(); c.BashUses.Clear(); } // yeniden yazılmış
            if (fs.Length == c.Offset) return;
            fs.Seek(c.Offset, SeekOrigin.Begin);
            var buf = new byte[1 << 20];
            using var line = new MemoryStream();
            int n;
            while ((n = fs.Read(buf, 0, buf.Length)) > 0)
            {
                var start = 0;
                for (var i = 0; i < n; i++)
                {
                    if (buf[i] != (byte)'\n') continue;
                    line.Write(buf, start, i - start);
                    Handle(c, Encoding.UTF8.GetString(line.GetBuffer(), 0, (int)line.Length));
                    line.SetLength(0);
                    start = i + 1;
                }
                line.Write(buf, start, n - start);
            }
            c.Offset = fs.Position - line.Length; // tamamlanmamış son satır bir sonraki okumada
        }
        catch (IOException ex) { log.LogDebug("Arka plan işleri için kayıt okunamadı {Path}: {Msg}", path, ex.Message); }
    }

    [GeneratedRegex(@"<task-notification>(.*?)</task-notification>", RegexOptions.Singleline)] private static partial Regex NotifRx();
    [GeneratedRegex(@"<task-id>([^<]*)</task-id>")] private static partial Regex TaskIdRx();
    [GeneratedRegex(@"<status>([^<]*)</status>")] private static partial Regex StatusRx();

    static bool Terminal(string s) => s is "completed" or "failed" or "killed" or "stopped";

    void Handle(Cache c, string line)
    {
        if (line.Length < 20) return;
        if (line.Contains("task-notification", StringComparison.Ordinal)) Notified(c, line);
        if (line.Contains("\"toolUseResult\"", StringComparison.Ordinal)
            && (line.Contains("\"agentId\"", StringComparison.Ordinal) || line.Contains("\"backgroundTaskId\"", StringComparison.Ordinal))) Launched(c, line);
        else if (line.Contains("\"run_in_background\"", StringComparison.Ordinal)) BashUse(c, line);
    }

    /// <summary>Bitiş bildirimleri (bir satırda birden çok olabilir; "<" biçimli kaçış da çözülür).</summary>
    static void Notified(Cache c, string line)
    {
        var text = line.Contains("\\u003c", StringComparison.Ordinal) ? line.Replace("\\u003c", "<").Replace("\\u003e", ">") : line;
        foreach (Match m in NotifRx().Matches(text))
        {
            var id = TaskIdRx().Match(m.Groups[1].Value) is { Success: true } a ? a.Groups[1].Value.Trim() : "";
            var st = StatusRx().Match(m.Groups[1].Value) is { Success: true } b ? b.Groups[1].Value.Trim() : "";
            if (id.Length == 0 || !Terminal(st)) continue;
            c.Jobs.Remove(id);
            c.Done.Add(id);
        }
    }

    static void Launched(Cache c, string line)
    {
        try
        {
            using var doc = JsonDocument.Parse(line);
            var r = doc.RootElement;
            if (!r.TryGetProperty("toolUseResult", out var res) || res.ValueKind != JsonValueKind.Object) return;
            var since = DateTimeOffset.TryParse(Str(r, "timestamp"), out var dt) ? dt.ToUnixTimeMilliseconds() : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (Str(res, "agentId") is { Length: > 0 } agent)
            {
                c.SeenAgents.Add(agent);
                var isAsync = res.TryGetProperty("isAsync", out var ia) && ia.ValueKind == JsonValueKind.True;
                if (isAsync && !c.Done.Contains(agent)) c.Jobs[agent] = new Open("agent", Clip(Str(res, "description")), since);
            }
            else if (Str(res, "backgroundTaskId") is { Length: > 0 } task && !c.Done.Contains(task))
            {
                var label = "";
                if (r.TryGetProperty("message", out var msg) && msg.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array)
                    foreach (var b in content.EnumerateArray())
                        if (Str(b, "tool_use_id") is { } tid && c.BashUses.Remove(tid, out var l)) label = l;
                c.Jobs[task] = new Open("bash", label, since);
            }
        }
        catch (JsonException) { /* tek bozuk satır */ }
    }

    /// <summary>Asistan satırındaki arka plan komutu çağrısı: sonuç satırı açıklamayı taşımadığı için burada saklanır.</summary>
    static void BashUse(Cache c, string line)
    {
        if (!line.Contains("\"Bash\"", StringComparison.Ordinal)) return;
        try
        {
            using var doc = JsonDocument.Parse(line);
            if (!doc.RootElement.TryGetProperty("message", out var msg) || !msg.TryGetProperty("content", out var content) || content.ValueKind != JsonValueKind.Array) return;
            foreach (var b in content.EnumerateArray())
            {
                if (Str(b, "type") != "tool_use" || Str(b, "name") != "Bash" || !b.TryGetProperty("input", out var input)) continue;
                if (!input.TryGetProperty("run_in_background", out var bg) || bg.ValueKind != JsonValueKind.True || Str(b, "id") is not { } id) continue;
                if (c.BashUses.Count > UsesMax) c.BashUses.Clear();
                c.BashUses[id] = Clip(Str(input, "description") ?? Str(input, "command"));
            }
        }
        catch (JsonException) { /* tek bozuk satır */ }
    }

    static string Clip(string? s)
    {
        var t = (s ?? "").Replace('\r', ' ').Replace('\n', ' ').Trim();
        return t.Length > LabelMax ? t[..LabelMax] + "…" : t;
    }

    static string? Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
}

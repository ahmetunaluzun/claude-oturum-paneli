using System.Buffers;
using System.Text.Json;

namespace ClaudePanel;

/// <summary>
/// Proje maliyeti için tek konuşma kaydının (ana oturum ya da subagents/ altındaki alt ajan) birikimi. Dosya yalnız sona
/// eklenerek büyür: kaldığı yerden (Offset) okunur; küçülmüşse baştan. Satır JSON'u Utf8JsonReader ile yalnız üst düzey
/// alanlar ve message.id/model/usage için gezilir (içerik dizileri atlanır); 3,7 GB kayıtta tam ayrıştırma pahalı.
/// </summary>
public sealed class CostFile(string path, string projectDir)
{
    public const long GapMs = 5 * 60_000; // ardışık iki kayıt arası bundan uzunsa boşluk çalışma sayılmaz

    public sealed class Msg
    {
        public long Ts;
        public string? Model;
        public long In, Out, Read, Write;
        public double? Cost; // null: fiyatı bilinmiyor
    }

    public readonly string Path = path;
    public readonly string ProjectDir = projectDir;
    public readonly bool Sub = path.Contains($"{System.IO.Path.DirectorySeparatorChar}subagents{System.IO.Path.DirectorySeparatorChar}");
    public long Size = -1, Offset;
    public DateTime Mtime;
    public string? Cwd;
    public readonly List<long[]> Segs = []; // [başlangıç, bitiş] ms; dosya içinde 5 dk'dan kısa aralıklarla birleşir
    public readonly Dictionary<string, Msg> Msgs = new(StringComparer.Ordinal); // message.id → son satırın kullanımı

    /// <summary>Alt ajan kaydının ana oturum dosyası: projects/&lt;proje&gt;/&lt;oturum&gt;/subagents/x.jsonl → projects/&lt;proje&gt;/&lt;oturum&gt;.jsonl</summary>
    public string? ParentPath => Sub && System.IO.Path.GetDirectoryName(System.IO.Path.GetDirectoryName(Path)) is { } sessionDir
        ? sessionDir + ".jsonl" : null;

    void Reset() { Offset = 0; Cwd = null; Segs.Clear(); Msgs.Clear(); }

    /// <summary>Dosyayı kaldığı yerden okur. Yarım kalan son satır bir sonraki okumaya bırakılır.</summary>
    public void Advance()
    {
        using var fs = new FileStream(Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16);
        if (fs.Length < Offset) Reset();
        if (fs.Length == Offset) return;
        fs.Seek(Offset, SeekOrigin.Begin);
        var buf = ArrayPool<byte>.Shared.Rent(1 << 20);
        var len = 0;
        try
        {
            while (true)
            {
                if (len == buf.Length)
                {
                    var bigger = ArrayPool<byte>.Shared.Rent(buf.Length * 2);
                    Buffer.BlockCopy(buf, 0, bigger, 0, len);
                    ArrayPool<byte>.Shared.Return(buf);
                    buf = bigger;
                }
                var n = fs.Read(buf, len, buf.Length - len);
                if (n == 0) break;
                len += n;
                var start = 0;
                while (true)
                {
                    var nl = buf.AsSpan(start, len - start).IndexOf((byte)'\n');
                    if (nl < 0) break;
                    if (nl > 2) Line(buf.AsSpan(start, nl));
                    start += nl + 1;
                }
                Offset += start;
                Buffer.BlockCopy(buf, start, buf, 0, len - start);
                len -= start;
            }
        }
        finally { ArrayPool<byte>.Shared.Return(buf); }
    }

    struct Usage
    {
        public string? Id, Model, Speed, Geo;
        public long In, Out, Read, Write, W5, W1h, Search;
        public bool Has, HasSplit;
    }

    void Line(ReadOnlySpan<byte> s)
    {
        var r = new Utf8JsonReader(s);
        string? type = null, cwd = null;
        long ts = 0;
        var u = new Usage();
        try
        {
            if (!r.Read() || r.TokenType != JsonTokenType.StartObject) return;
            while (r.Read() && r.TokenType == JsonTokenType.PropertyName)
            {
                if (r.ValueTextEquals("type"u8)) { r.Read(); type = r.TokenType == JsonTokenType.String ? r.GetString() : null; }
                else if (r.ValueTextEquals("timestamp"u8))
                {
                    r.Read();
                    if (r.TokenType == JsonTokenType.String && r.TryGetDateTimeOffset(out var d)) ts = d.ToUnixTimeMilliseconds();
                }
                else if (Cwd is null && r.ValueTextEquals("cwd"u8)) { r.Read(); cwd = r.TokenType == JsonTokenType.String ? r.GetString() : null; }
                else if (r.ValueTextEquals("message"u8))
                {
                    r.Read();
                    if (r.TokenType == JsonTokenType.StartObject) ReadMessage(ref r, ref u); else r.Skip();
                }
                else { r.Read(); r.Skip(); }
            }
        }
        catch (JsonException) { return; } // tek bozuk satır dosyayı düşürmesin
        if (type is not ("user" or "assistant")) return;
        if (Cwd is null && !string.IsNullOrEmpty(cwd)) Cwd = cwd;
        if (ts > 0) AddTs(ts);
        if (type == "assistant" && u.Has && u.Id is { } id) Add(id, ts, u);
    }

    static void ReadMessage(ref Utf8JsonReader r, ref Usage u)
    {
        while (r.Read() && r.TokenType == JsonTokenType.PropertyName)
        {
            if (r.ValueTextEquals("id"u8)) { r.Read(); u.Id = r.TokenType == JsonTokenType.String ? r.GetString() : null; }
            else if (r.ValueTextEquals("model"u8)) { r.Read(); u.Model = r.TokenType == JsonTokenType.String ? r.GetString() : null; }
            else if (r.ValueTextEquals("usage"u8))
            {
                r.Read();
                if (r.TokenType == JsonTokenType.StartObject) { u.Has = true; ReadUsage(ref r, ref u); } else r.Skip();
            }
            else { r.Read(); r.Skip(); }
        }
    }

    static void ReadUsage(ref Utf8JsonReader r, ref Usage u)
    {
        while (r.Read() && r.TokenType == JsonTokenType.PropertyName)
        {
            if (r.ValueTextEquals("input_tokens"u8)) u.In = Num(ref r);
            else if (r.ValueTextEquals("output_tokens"u8)) u.Out = Num(ref r);
            else if (r.ValueTextEquals("cache_read_input_tokens"u8)) u.Read = Num(ref r);
            else if (r.ValueTextEquals("cache_creation_input_tokens"u8)) u.Write = Num(ref r);
            else if (r.ValueTextEquals("speed"u8)) { r.Read(); u.Speed = r.TokenType == JsonTokenType.String ? r.GetString() : null; }
            else if (r.ValueTextEquals("inference_geo"u8)) { r.Read(); u.Geo = r.TokenType == JsonTokenType.String ? r.GetString() : null; }
            else if (r.ValueTextEquals("cache_creation"u8) || r.ValueTextEquals("server_tool_use"u8))
            {
                r.Read();
                if (r.TokenType != JsonTokenType.StartObject) { r.Skip(); continue; }
                while (r.Read() && r.TokenType == JsonTokenType.PropertyName)
                {
                    if (r.ValueTextEquals("ephemeral_5m_input_tokens"u8)) { u.W5 = Num(ref r); u.HasSplit = true; }
                    else if (r.ValueTextEquals("ephemeral_1h_input_tokens"u8)) { u.W1h = Num(ref r); u.HasSplit = true; }
                    else if (r.ValueTextEquals("web_search_requests"u8)) u.Search = Num(ref r);
                    else { r.Read(); r.Skip(); }
                }
            }
            else { r.Read(); r.Skip(); }
        }
    }

    static long Num(ref Utf8JsonReader r)
    {
        r.Read();
        return r.TokenType == JsonTokenType.Number && r.TryGetInt64(out var n) ? n : 0;
    }

    void Add(string id, long ts, Usage u)
    {
        if (u.In + u.Out + u.Read + u.Write == 0) return; // "<synthetic>" vb.: kullanım yok
        // 5 dk / 1 saat ayrımı yoksa önbelleğe yazmanın tamamı 5 dakikalık sayılır (düşük olan fiyat).
        var (w5, w1h) = u.HasSplit && u.W5 + u.W1h > 0 ? (u.W5, u.W1h) : (u.Write, 0L);
        Msgs[id] = new Msg
        {
            Ts = ts, Model = u.Model, In = u.In, Out = u.Out, Read = u.Read, Write = u.Write,
            Cost = CostPrices.Cost(u.Model, u.In, u.Out, u.Read, w5, w1h, u.Speed == "fast", u.Geo == "us", u.Search)
        };
    }

    void AddTs(long ts)
    {
        var cur = Segs.Count > 0 ? Segs[^1] : null;
        if (cur is null || ts > cur[1] + GapMs || ts < cur[0] - GapMs) { Segs.Add([ts, ts]); return; }
        if (ts < cur[0]) cur[0] = ts;
        if (ts > cur[1]) cur[1] = ts;
    }
}

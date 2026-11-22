using System.Globalization;
using System.Net.Security;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;

namespace ClaudePanel;

/// <param name="kind">"auth" | "disabled" | "domain" | "net" | "tls" | "proto".</param>
public sealed class ImapException(string kind, string message) : Exception(message)
{
    public string Kind => kind;
}

/// <summary>Bir sunucu yanıtı: metin ve içindeki literal'lar (metinde \u0001&lt;sıra&gt;\u0002 yer tutucusu).</summary>
sealed record ImapResp(string Text, List<string> Lits);

/// <summary>
/// En küçük IMAP istemcisi (RFC 3501): yalnız bağlan, LOGIN, CAPABILITY, LIST, EXAMINE (salt okunur), UID SEARCH, UID FETCH, LOGOUT.
/// Yazma komutu (STORE, COPY, EXPUNGE, APPEND, SELECT) bu sınıfta yoktur; hiçbir mail okundu işaretlenmez, taşınmaz, silinmez.
/// Parola yalnız LOGIN komutuna gider; hiçbir yere yazılmaz, hata metnine girmez.
/// </summary>
sealed partial class ImapClient : IDisposable
{
    readonly TcpClient _tcp;
    readonly Stream _s;
    readonly byte[] _buf = new byte[16384];
    int _pos, _len, _tag;

    ImapClient(TcpClient tcp, Stream s) { _tcp = tcp; _s = s; }

    [GeneratedRegex(@"\{(\d+)\+?\}$")] private static partial Regex LiteralRx();
    [GeneratedRegex(@"^\* \d+ FETCH ")] private static partial Regex FetchRx();

    /// <param name="anyCert">Yalnız test: kendi imzalı sertifikayı kabul eder (ImapProvider yalnız yerel sahte sunucuda açar).</param>
    public static async Task<ImapClient> Connect(string host, int port, bool anyCert, CancellationToken ct)
    {
        var tcp = new TcpClient();
        try
        {
            using var to = CancellationTokenSource.CreateLinkedTokenSource(ct);
            to.CancelAfter(TimeSpan.FromSeconds(15));
            await tcp.ConnectAsync(host, port, to.Token);
            var ssl = new SslStream(tcp.GetStream(), false, anyCert ? (_, _, _, _) => true : null);
            await ssl.AuthenticateAsClientAsync(host);
            var c = new ImapClient(tcp, ssl);
            ct.Register(c.Dispose); // iptal/zaman aşımı: bekleyen okumayı kes
            var greet = await c.ReadResp(to.Token);
            if (!greet.Text.StartsWith("* OK", StringComparison.OrdinalIgnoreCase)) throw new ImapException(Classify(greet.Text, "net"), "karşılama: " + Brief(greet.Text));
            return c;
        }
        catch (System.Security.Authentication.AuthenticationException) { tcp.Dispose(); throw new ImapException("tls", "TLS doğrulanamadı"); }
        catch (Exception ex) when (ex is SocketException or IOException or ObjectDisposedException or OperationCanceledException)
        {
            tcp.Dispose();
            throw new ImapException("net", "bağlanılamadı");
        }
    }

    public void Dispose() { try { _tcp.Dispose(); } catch (ObjectDisposedException) { } }

    // ---- Komutlar ----

    public async Task Login(string user, string pass, CancellationToken ct)
    {
        var (status, text, _) = await Run($"LOGIN {Quote(user)} {Quote(pass)}", ct);
        if (status != "OK") throw new ImapException(Classify(text, "auth"), "giriş reddedildi: " + Brief(text));
    }

    public async Task<HashSet<string>> Capability(CancellationToken ct)
    {
        var (_, _, un) = await Run("CAPABILITY", ct);
        return un.Select(r => r.Text).Where(t => t.StartsWith("* CAPABILITY ", StringComparison.OrdinalIgnoreCase))
            .SelectMany(t => t[13..].Split(' ', StringSplitOptions.RemoveEmptyEntries)).Select(x => x.ToUpperInvariant()).ToHashSet();
    }

    /// <summary>LIST "" "*": (öznitelikler, ad) — ad sunucunun yazdığı gibi kalır (geri gönderilirken değişmez).</summary>
    public async Task<List<(string[] Attrs, string Name)>> List(CancellationToken ct)
    {
        var (_, _, un) = await Run("LIST \"\" \"*\"", ct);
        var res = new List<(string[], string)>();
        foreach (var r in un)
        {
            if (!r.Text.StartsWith("* LIST ", StringComparison.OrdinalIgnoreCase)) continue;
            var i = 7;
            if (Value(r.Text, ref i, r.Lits) is not List<object> attrs) continue;
            Value(r.Text, ref i, r.Lits); // ayırıcı
            if (Value(r.Text, ref i, r.Lits) is string name) res.Add((attrs.OfType<string>().ToArray(), name));
        }
        return res;
    }

    /// <summary>STATUS "klasör" (UNSEEN): okunmamış ileti sayısı (klasörü açmaz, hiçbir şeyi değiştirmez). Alınamazsa null.</summary>
    public async Task<int?> Unseen(string mailbox, CancellationToken ct)
    {
        var (status, _, un) = await Run("STATUS " + Quote(mailbox) + " (UNSEEN)", ct);
        if (status != "OK") return null;
        var m = un.Select(r => UnseenRx().Match(r.Text)).FirstOrDefault(x => x.Success);
        return m is not null && int.TryParse(m.Groups[1].Value, out var n) ? n : null;
    }

    [GeneratedRegex(@"UNSEEN (\d+)")] private static partial Regex UnseenRx();

    /// <summary>EXAMINE: salt okunur açar (SELECT'in aksine bayrak değiştirmeye izin vermez).</summary>
    public async Task Examine(string mailbox, CancellationToken ct)
    {
        var (status, text, _) = await Run("EXAMINE " + Quote(mailbox), ct);
        if (status != "OK") throw new ImapException("proto", "klasör açılamadı: " + Brief(text));
    }

    public async Task<List<long>> UidSearchSince(DateTime day, CancellationToken ct)
    {
        var (status, text, un) = await Run("UID SEARCH SINCE " + day.ToString("dd-MMM-yyyy", CultureInfo.InvariantCulture), ct);
        if (status != "OK") throw new ImapException("proto", "arama: " + Brief(text));
        return un.Where(r => r.Text.StartsWith("* SEARCH", StringComparison.OrdinalIgnoreCase))
            .SelectMany(r => r.Text[8..].Split(' ', StringSplitOptions.RemoveEmptyEntries)).Select(x => long.TryParse(x, out var n) ? n : 0).Where(n => n > 0).OrderBy(n => n).ToList();
    }

    /// <summary>UID FETCH: her ileti için anahtar (büyük harf) → değer sözlüğü. Başlık literal'i "BODY[HEADER.FIELDS …]" anahtarındadır.</summary>
    public async Task<List<Dictionary<string, object>>> UidFetch(IEnumerable<long> uids, string items, CancellationToken ct)
    {
        var (status, text, un) = await Run($"UID FETCH {string.Join(',', uids)} ({items})", ct);
        if (status != "OK") throw new ImapException("proto", "getirme: " + Brief(text));
        var res = new List<Dictionary<string, object>>();
        foreach (var r in un)
        {
            var m = FetchRx().Match(r.Text);
            if (!m.Success) continue;
            var i = m.Length;
            if (Value(r.Text, ref i, r.Lits) is not List<object> list) continue;
            var d = new Dictionary<string, object>();
            for (var k = 0; k + 1 < list.Count; k += 2) if (list[k] is string key) d[key.ToUpperInvariant()] = list[k + 1];
            res.Add(d);
        }
        return res;
    }

    public async Task Logout()
    {
        try { using var c = new CancellationTokenSource(2000); await Run("LOGOUT", c.Token); }
        catch (Exception ex) when (ex is ImapException or IOException or ObjectDisposedException or OperationCanceledException) { }
    }

    // ---- Protokol ----

    async Task<(string Status, string Text, List<ImapResp> Untagged)> Run(string cmd, CancellationToken ct)
    {
        var tag = "A" + (++_tag);
        try
        {
            await _s.WriteAsync(Encoding.ASCII.GetBytes($"{tag} {cmd}\r\n"), ct);
            await _s.FlushAsync(ct);
            var un = new List<ImapResp>();
            while (true)
            {
                var r = await ReadResp(ct);
                if (r.Text.StartsWith(tag + " ", StringComparison.Ordinal))
                {
                    var rest = r.Text[(tag.Length + 1)..];
                    var sp = rest.IndexOf(' ');
                    return ((sp < 0 ? rest : rest[..sp]).ToUpperInvariant(), sp < 0 ? "" : rest[(sp + 1)..], un);
                }
                if (r.Text.StartsWith("* BYE", StringComparison.OrdinalIgnoreCase) && cmd != "LOGOUT") throw new ImapException(Classify(r.Text, "net"), "sunucu bağlantıyı kapattı: " + Brief(r.Text));
                un.Add(r);
            }
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException or OperationCanceledException or SocketException)
        {
            throw new ImapException("net", "bağlantı koptu");
        }
    }

    /// <summary>Bir yanıtı okur: satır sonu "{n}" ise n bayt literal okuyup satıra devam eder.</summary>
    async Task<ImapResp> ReadResp(CancellationToken ct)
    {
        var text = new StringBuilder();
        var lits = new List<string>();
        while (true)
        {
            var line = await ReadLine(ct);
            var m = LiteralRx().Match(line);
            if (!m.Success) { text.Append(line); return new ImapResp(text.ToString(), lits); }
            var n = int.Parse(m.Groups[1].Value);
            if (n > 1_000_000) throw new ImapException("proto", "literal çok büyük");
            text.Append(line[..m.Index]).Append('\u0001').Append(lits.Count).Append('\u0002');
            var data = new byte[n];
            for (var got = 0; got < n;)
            {
                if (_pos == _len) await Fill(ct);
                var take = Math.Min(n - got, _len - _pos);
                Buffer.BlockCopy(_buf, _pos, data, got, take);
                _pos += take; got += take;
            }
            lits.Add(Encoding.UTF8.GetString(data));
        }
    }

    async Task<string> ReadLine(CancellationToken ct)
    {
        var bytes = new List<byte>();
        while (true)
        {
            if (_pos == _len) await Fill(ct);
            var b = _buf[_pos++];
            if (b == '\n') break;
            bytes.Add(b);
            if (bytes.Count > 100_000) throw new ImapException("proto", "satır çok uzun");
        }
        if (bytes.Count > 0 && bytes[^1] == '\r') bytes.RemoveAt(bytes.Count - 1);
        return Encoding.UTF8.GetString(bytes.ToArray());
    }

    async Task Fill(CancellationToken ct)
    {
        _len = await _s.ReadAsync(_buf, ct);
        _pos = 0;
        if (_len == 0) throw new IOException("bağlantı kapandı");
    }

    // ---- Ayrıştırma ----

    /// <summary>Bir değer: liste (List&lt;object&gt;) ya da metin (tırnaklı, literal, atom). NIL → "NIL".</summary>
    internal static object? Value(string s, ref int i, List<string> lits)
    {
        while (i < s.Length && s[i] == ' ') i++;
        if (i >= s.Length) return null;
        if (s[i] == '(')
        {
            i++;
            var list = new List<object>();
            while (true)
            {
                while (i < s.Length && s[i] == ' ') i++;
                if (i >= s.Length) return list;
                if (s[i] == ')') { i++; return list; }
                if (Value(s, ref i, lits) is { } v) list.Add(v);
            }
        }
        if (s[i] == '"')
        {
            var sb = new StringBuilder();
            i++;
            while (i < s.Length && s[i] != '"') { if (s[i] == '\\' && i + 1 < s.Length) i++; sb.Append(s[i++]); }
            i++;
            return sb.ToString();
        }
        if (s[i] == '\u0001')
        {
            var end = s.IndexOf('\u0002', i);
            var idx = int.Parse(s[(i + 1)..end]);
            i = end + 1;
            return lits[idx];
        }
        var start = i;
        while (i < s.Length && s[i] != ' ' && s[i] != ')' && s[i] != '(')
        {
            if (s[i] == '[') { var close = s.IndexOf(']', i); i = close < 0 ? s.Length : close + 1; continue; }
            i++;
        }
        return s[start..i];
    }

    static string Quote(string s) => "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";

    /// <summary>
    /// Sunucu metninden hata türü. "domain": yönetici alan adı düzeyinde kapatmış ("IMAP access is disabled for your domain" benzeri);
    /// "disabled": hesapta IMAP kapalı; "auth": şifre/uygulama şifresi kabul edilmedi.
    /// </summary>
    internal static string Classify(string text, string fallback)
    {
        var t = text.ToLowerInvariant();
        if (t.Contains("domain") && (t.Contains("imap") || t.Contains("disabled"))) return "domain";
        if (t.Contains("imap") && (t.Contains("disabled") || t.Contains("not enabled"))) return "disabled";
        if (t.Contains("authenticationfailed") || t.Contains("invalid credentials") || t.Contains("application-specific password") || t.Contains("web login required")) return "auth";
        return fallback;
    }

    /// <summary>Loga yazılacak kısa özet (yanıtlar parola içermez; yine de uzunluk sınırlı).</summary>
    static string Brief(string t) => t.Length > 120 ? t[..120] : t;
}

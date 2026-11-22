using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace ClaudePanel;

/// <param name="GmailExt">Sunucu Gmail IMAP uzantılarını (X-GM-EXT-1: konuşma kimliği, etiket) veriyor: "Gmail'de aç" bağlantısı kurulabilir.</param>
/// <param name="AwaitingOk">"Cevap bekleyen" kuralı bu hesapta çalışır (Gmail uzantısı + Gönderilmiş klasörü bulundu).</param>
/// <param name="Cap">Gelen kutusunda üst sınırı aşan ileti vardı: yalnız en yeni bu kadarına bakıldı (0 = hepsine bakıldı).</param>
/// <param name="Suggest">Hesabın kendi alan adından, Kime/CC'de en sık geçen adresler (yalnız adres ve sayı; konu/gövde yok).</param>
public sealed record ImapInfo(bool GmailExt, bool AwaitingOk, int Cap = 0, List<MailSuggest>? Suggest = null);

/// <summary>
/// Gmail / Google Workspace IMAP sağlayıcısı (imap.gmail.com:993, TLS) — Google uygulama şifresiyle. YALNIZ OKUR:
/// EXAMINE (salt okunur), UID SEARCH, UID FETCH BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT)] — gövde istenmez, hiçbir mail okundu
/// işaretlenmez/taşınmaz/silinmez. Kaynaklar (22.11.2026'da bu sayfalardan doğrulandı):
///   Gmail IMAP uzantıları (X-GM-THRID, X-GM-MSGID, X-GM-LABELS): https://developers.google.com/workspace/gmail/imap/imap-extensions
///   IMAP ayarları (imap.gmail.com, 993, SSL; uygulama şifresi): https://support.google.com/mail/answer/7126229
///   Uygulama şifresi: https://support.google.com/accounts/answer/185833
///   "Gmail'de aç": konuşma kimliğinin onaltılık biçimi Gmail adresinde "#all/&lt;hex&gt;" olarak kullanılır (API threadId aynı değerdir).
/// "Cevap bekleyen" için konuşma kimliği (X-GM-THRID) Gelen ve Gönderilmiş (\Sent özniteliğiyle bulunan, dil bağımsız) klasörlerinden okunur.
/// Test: CLAUDE_PANEL_IMAP_BASE ("127.0.0.1:port", yalnız yerel) sunucuyu sahte IMAP'e yönlendirir ve kendi imzalı sertifikayı kabul eder.
/// </summary>
public sealed partial class ImapProvider
{
    /// <summary>Bir taramada bakılan en çok ileti (yalnız başlık; aşılırsa en yenileri) ve tek UID FETCH komutundaki ileti sayısı.</summary>
    internal const int ListMax = 1000, ChunkSize = 200;
    const int Days = 14, SubjectMax = 200, TextMax = 200;

    static (string Host, int Port, bool Test) Target()
    {
        if (Environment.GetEnvironmentVariable("CLAUDE_PANEL_IMAP_BASE") is { Length: > 0 } b && b.Split(':') is [var h and ("127.0.0.1" or "localhost"), var p] && int.TryParse(p, out var port))
            return (h, port, true);
        return ("imap.gmail.com", 993, false);
    }

    static async Task<ImapClient> Open(string user, string pass, CancellationToken ct)
    {
        var (host, port, test) = Target();
        var c = await ImapClient.Connect(host, port, test, ct);
        try { await c.Login(user, pass, ct); }
        catch { c.Dispose(); throw; }
        return c;
    }

    /// <summary>Giriş denemesi (Ayarlar'da hesap eklerken; STATUS ile okunmamış sayısını da okur). Başarısızsa <see cref="ImapException"/> (Kind: auth | disabled | domain | net | tls).</summary>
    /// <returns>Gelen kutusundaki okunmamış ileti sayısı (kanıt olarak gösterilir); alınamazsa null.</returns>
    public static async Task<int?> Check(string user, string pass, CancellationToken ct)
    {
        using var c = await Open(user, pass, ct);
        try { return await c.Unseen("INBOX", ct); }
        catch (ImapException) { return null; } // giriş yapıldı; sayı alınamadıysa da bağlantı geçerli
        finally { await c.Logout(); }
    }

    public async Task<(List<MailMeta> Mails, ImapInfo Info)> Mails(string pass, string me, IReadOnlyCollection<string> aliases, CancellationToken ct)
    {
        me = me.ToLowerInvariant();
        var mine = new HashSet<string>(aliases.Select(a => a.ToLowerInvariant())) { me };
        using var c = await Open(me, pass, ct);
        try
        {
            var gmail = (await c.Capability(ct)).Contains("X-GM-EXT-1");
            var since = DateTime.UtcNow.Date.AddDays(-Days);
            var inboxItems = "UID INTERNALDATE " + (gmail ? "X-GM-THRID X-GM-LABELS " : "") + "BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT)]";

            await c.Examine("INBOX", ct);
            var (inbox, cap) = await Fetch(c, since, inboxItems, ct);

            // Cevap bekleyen: Gönderilmiş klasöründeki konuşmaların en yeni gönderim zamanı.
            var sentNewest = new Dictionary<string, long>();
            var awaitingOk = false;
            if (gmail && (await c.List(ct)).FirstOrDefault(x => x.Attrs.Contains("\\Sent", StringComparer.OrdinalIgnoreCase)) is { Name.Length: > 0 } sent)
            {
                await c.Examine(sent.Name, ct);
                foreach (var m in (await Fetch(c, since, "UID INTERNALDATE X-GM-THRID", ct)).Items)
                    if (Str(m, "X-GM-THRID") is { } th) sentNewest[th] = Math.Max(sentNewest.GetValueOrDefault(th), Date(m));
                awaitingOk = true;
            }

            var result = new List<MailMeta>();
            // Konuşmanın en yeni mesajı (Gmail'de konuşma kimliği; değilse her ileti ayrı).
            foreach (var g in inbox.GroupBy(m => gmail ? Str(m, "X-GM-THRID") ?? "u" + Uid(m) : "u" + Uid(m)))
            {
                var m = g.OrderByDescending(Date).ThenByDescending(Uid).First();
                var h = Headers(m);
                var (name, addr) = MailRules.Sender(h.GetValueOrDefault("from"));
                var labels = gmail ? Labels(m) : [];
                var date = Date(m);
                var fromMe = addr == me || labels.Contains("SENT");
                var thread = g.Key.StartsWith('u') ? g.Key[1..] : ThreadHex(g.Key);
                var replied = gmail && Str(m, "X-GM-THRID") is { } t && sentNewest.TryGetValue(t, out var sd) && sd >= date;
                var subject = h.GetValueOrDefault("subject", "");
                if (subject.Length > SubjectMax) subject = subject[..SubjectMax] + "…";
                result.Add(new MailMeta(Uid(m).ToString(CultureInfo.InvariantCulture), thread, subject, Clip(name), addr, date,
                    MailRules.Addresses(h.GetValueOrDefault("to")).Any(mine.Contains), MailRules.Addresses(h.GetValueOrDefault("cc")).Any(mine.Contains), fromMe, replied, labels));
            }
            return (result.OrderByDescending(m => m.Date).ToList(), new ImapInfo(gmail, awaitingOk, cap, Suggestions(inbox, me, mine)));
        }
        finally { await c.Logout(); }
    }

    /// <summary>Son 14 günün iletileri: en yeni <see cref="ListMax"/> tanesi, <see cref="ChunkSize"/>'lık parçalarla (komut satırı uzamasın). Cap: üst sınır aşıldıysa sınır, değilse 0.</summary>
    static async Task<(List<Dictionary<string, object>> Items, int Cap)> Fetch(ImapClient c, DateTime since, string items, CancellationToken ct)
    {
        var uids = await c.UidSearchSince(since, ct);
        var take = uids.TakeLast(ListMax).ToList();
        var res = new List<Dictionary<string, object>>();
        foreach (var part in take.Chunk(ChunkSize)) res.AddRange(await c.UidFetch(part, items, ct));
        return (res, uids.Count > ListMax ? ListMax : 0);
    }

    const int SuggestMax = 20;

    /// <summary>
    /// Gelen kutusunda Kime/CC'de en sık geçen, hesabın KENDİ alan adından adresler (kendim ve zaten eklenmiş olanlar hariç). İleti başına
    /// bir adres bir kez sayılır. Genel posta alan adlarında (gmail.com) öneri yoktur: orada "kendi alan adı" bir kurum değildir.
    /// </summary>
    internal static List<MailSuggest> Suggestions(List<Dictionary<string, object>> inbox, string me, ICollection<string> mine)
    {
        var at = me.LastIndexOf('@');
        if (at < 0 || MailDomain.IsConsumer(me[(at + 1)..])) return [];
        var domain = me[at..];
        var count = new Dictionary<string, int>();
        foreach (var m in inbox)
        {
            var h = Headers(m);
            foreach (var a in MailRules.Addresses(h.GetValueOrDefault("to")).Concat(MailRules.Addresses(h.GetValueOrDefault("cc"))).Distinct())
                if (a.EndsWith(domain, StringComparison.Ordinal) && !mine.Contains(a)) count[a] = count.GetValueOrDefault(a) + 1;
        }
        return count.OrderByDescending(kv => kv.Value).ThenBy(kv => kv.Key, StringComparer.Ordinal).Take(SuggestMax).Select(kv => new MailSuggest(kv.Key, kv.Value)).ToList();
    }

    static long Uid(Dictionary<string, object> m) => long.TryParse(Str(m, "UID"), out var u) ? u : 0;
    static string? Str(Dictionary<string, object> m, string k) => m.TryGetValue(k, out var v) && v is string s ? s : null;

    /// <summary>X-GM-THRID ondalık → Gmail adresindeki onaltılık konuşma kimliği.</summary>
    static string ThreadHex(string dec) => ulong.TryParse(dec, NumberStyles.None, CultureInfo.InvariantCulture, out var n) ? n.ToString("x", CultureInfo.InvariantCulture) : "";

    // ---- Etiketler ----

    /// <summary>Sistem etiketleri ("\Inbox" → INBOX), kullanıcı etiketleri olduğu gibi (değiştirilmiş UTF-7 çözülür).</summary>
    static List<string> Labels(Dictionary<string, object> m) =>
        m.TryGetValue("X-GM-LABELS", out var v) && v is List<object> l
            ? l.OfType<string>().Select(x => x.StartsWith('\\') ? x[1..].ToUpperInvariant() : Clip(Utf7(x))).ToList() : [];

    /// <summary>Değiştirilmiş UTF-7 (RFC 3501 §5.1.3): "&amp;AMw-" → "Ì".</summary>
    internal static string Utf7(string s) =>
        !s.Contains('&') ? s : Utf7Rx().Replace(s, m =>
        {
            if (m.Groups[1].Value.Length == 0) return "&";
            try
            {
                var b64 = m.Groups[1].Value.Replace(',', '/');
                b64 = b64.PadRight((b64.Length + 3) / 4 * 4, '=');
                return Encoding.BigEndianUnicode.GetString(Convert.FromBase64String(b64));
            }
            catch (FormatException) { return m.Value; }
        });

    [GeneratedRegex(@"&([A-Za-z0-9+,]*)-")] private static partial Regex Utf7Rx();

    // ---- Başlıklar ----

    static Dictionary<string, string> Headers(Dictionary<string, object> m)
    {
        var res = new Dictionary<string, string>();
        var raw = m.FirstOrDefault(kv => kv.Key.StartsWith("BODY[HEADER.FIELDS", StringComparison.Ordinal)).Value as string ?? "";
        foreach (var line in Regex.Replace(raw, @"\r?\n[ \t]+", " ").Split('\n'))
        {
            var i = line.IndexOf(':');
            if (i > 0) res.TryAdd(line[..i].Trim().ToLowerInvariant(), Rfc2047(line[(i + 1)..].Trim()));
        }
        return res;
    }

    [GeneratedRegex(@"=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=")] private static partial Regex WordRx();

    /// <summary>RFC 2047 kodlu sözcükleri çözer ("=?UTF-8?B?...?="); bitişik kodlu sözcükler arasındaki boşluk atılır.</summary>
    internal static string Rfc2047(string s)
    {
        if (!s.Contains("=?")) return s;
        var joined = Regex.Replace(s, @"(\?=)\s+(=\?)", "$1$2");
        return WordRx().Replace(joined, m =>
        {
            try
            {
                Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
                var enc = Encoding.GetEncoding(m.Groups[1].Value.Split('*')[0]);
                var text = m.Groups[3].Value;
                if (m.Groups[2].Value is "B" or "b") return enc.GetString(Convert.FromBase64String(text));
                var bytes = new List<byte>();
                for (var i = 0; i < text.Length; i++)
                {
                    if (text[i] == '_') bytes.Add((byte)' ');
                    else if (text[i] == '=' && i + 2 < text.Length + 0 && Uri.IsHexDigit(text[i + 1]) && Uri.IsHexDigit(text[i + 2])) { bytes.Add(Convert.ToByte(text.Substring(i + 1, 2), 16)); i += 2; }
                    else bytes.Add((byte)text[i]);
                }
                return enc.GetString(bytes.ToArray());
            }
            catch (Exception ex) when (ex is ArgumentException or FormatException) { return m.Value; }
        });
    }

    // ---- Tarih ----

    /// <summary>INTERNALDATE "22-Nov-2026 10:00:00 +0300" → Unix ms.</summary>
    static long Date(Dictionary<string, object> m)
    {
        var s = Str(m, "INTERNALDATE")?.Trim();
        if (s is null) return 0;
        return DateTimeOffset.TryParseExact(s.Length > 0 && s[0] == ' ' ? s[1..] : s, ["dd-MMM-yyyy HH:mm:ss zzz", "d-MMM-yyyy HH:mm:ss zzz", "dd-MMM-yyyy HH:mm:ss K"],
            CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) || TryZoneNoColon(s, out d) ? d.ToUnixTimeMilliseconds() : 0;
    }

    /// <summary>"+0300" biçimli dilim (IMAP'te iki nokta yok).</summary>
    static bool TryZoneNoColon(string s, out DateTimeOffset d)
    {
        d = default;
        var sp = s.LastIndexOf(' ');
        if (sp < 0 || s.Length - sp != 6) return false;
        var zone = s[(sp + 1)..];
        return DateTimeOffset.TryParseExact(s[..sp].Trim() + " " + zone[..3] + ":" + zone[3..], ["dd-MMM-yyyy HH:mm:ss zzz", "d-MMM-yyyy HH:mm:ss zzz"],
            CultureInfo.InvariantCulture, DateTimeStyles.None, out d);
    }

    static string Clip(string s) => s.Length > TextMax ? s[..TextMax] + "…" : s;
}

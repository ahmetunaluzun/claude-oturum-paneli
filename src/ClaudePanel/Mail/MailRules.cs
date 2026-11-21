using System.Text.RegularExpressions;

namespace ClaudePanel;

/// <summary>
/// Süzgeç kuralları (yerel). Girdi yalnız başlık meta verisidir; mail içeriği hiçbir yere gönderilmez.
/// Karşılaştırmalar Türkçe kültürden bağımsızdır: "İ/I/ı" önce "i"ye indirilir, sonra değişmez kültürle küçültülür (§AU).
/// </summary>
public static partial class MailRules
{
    public const int MaxEntries = 30, MaxEntryLength = 100;

    /// <summary>Mesajın uyduğu kurallar; boşsa listelenmez. Kendi gönderdiğim mesaj hiçbir kurala uymaz (Takip başkalarından geleni izler).</summary>
    public static List<string> Match(MailMeta m, MailFilter f)
    {
        var rules = new List<string>();
        if (m.FromMe) return rules;
        if (f.Awaiting && m.Awaiting) rules.Add("awaiting");
        if (f.Direct && m.ToMe) rules.Add("direct");
        if (f.Cc && m.CcMe) rules.Add("cc");
        var from = Fold(m.FromAddr);
        if (f.Senders?.Any(s => SenderMatches(from, Fold(s))) == true) rules.Add("sender");
        var subject = Fold(m.Subject);
        if (f.Keywords?.Any(k => Fold(k) is { Length: > 0 } fk && subject.Contains(fk, StringComparison.Ordinal)) == true) rules.Add("keyword");
        if (f.Labels?.Any(l => m.Labels.Any(x => Fold(x) == Fold(l))) == true) rules.Add("label");
        return rules;
    }

    /// <summary>"ali@firma.com" tam adres; "@firma.com" ya da "firma.com" alan adı (alt alan adları dahil).</summary>
    static bool SenderMatches(string from, string rule)
    {
        if (rule.Length == 0 || from.Length == 0) return false;
        if (rule.Contains('@') && !rule.StartsWith('@')) return from == rule;
        var domain = rule.TrimStart('@');
        var at = from.LastIndexOf('@');
        if (at < 0) return false;
        var host = from[(at + 1)..];
        return host == domain || host.EndsWith("." + domain, StringComparison.Ordinal);
    }

    public static string Fold(string? s) =>
        (s ?? "").Trim().Replace('İ', 'i').Replace('I', 'i').Replace('ı', 'i').ToLowerInvariant();

    /// <summary>Ayarlardan gelen listeyi temizler: boşları atar, kırpar, tekrarı siler, sayıyı ve uzunluğu sınırlar.</summary>
    public static List<string> Clean(IEnumerable<string?>? list) =>
        (list ?? []).Select(x => (x ?? "").Trim()).Where(x => x.Length is > 0 and <= MaxEntryLength && !x.Any(char.IsControl))
            .DistinctBy(Fold).Take(MaxEntries).ToList();

    // ---- Başlık ayrıştırma ----

    [GeneratedRegex(@"[^\s<>,;:""()\[\]]+@[^\s<>,;:""()\[\]]+")] private static partial Regex AddrRx();

    /// <summary>Başlıktaki adresler (küçük harf).</summary>
    public static List<string> Addresses(string? header) =>
        header is null ? [] : AddrRx().Matches(header).Select(m => m.Value.Trim('.').ToLowerInvariant()).ToList();

    /// <summary>"Ad Soyad &lt;a@b&gt;" → (ad, adres); ad yoksa adres.</summary>
    public static (string Name, string Addr) Sender(string? header)
    {
        var addr = Addresses(header).FirstOrDefault() ?? "";
        var lt = header?.IndexOf('<') ?? -1;
        var name = lt > 0 ? header![..lt].Trim().Trim('"', '\'').Trim() : "";
        return (name.Length > 0 ? name : addr, addr);
    }
}

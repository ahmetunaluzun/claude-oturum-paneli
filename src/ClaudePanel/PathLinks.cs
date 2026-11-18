namespace ClaudePanel;

/// <summary>
/// Konuşmadaki yol adaylarını çözer: metnin başından başlayan, bu bilgisayarda var olan en uzun yolu bulur.
/// Aday "C:\Projeler\X klasörüne yazdım." ise sonuç "C:\Projeler\X" olur (boşluk/noktalamada kesilir).
/// %DEGISKEN% ve ~ açılır. Ağ yolları (\\sunucu, //sunucu) hiç denenmez: varlık sorgusu kimlik bilgisini dışarı gönderebilir.
/// </summary>
static class PathLinks
{
    public const int MaxCandidates = 200;
    const int MaxLength = 400;
    static readonly char[] Cut = [' ', '\t', '.', ',', ';', ':', ')', ']', '\'', '’', '”', '!', '?'];

    /// <summary>Adayın var olan en uzun ön ekinin uzunluğu (adayın kendi karakterleriyle); yoksa 0.</summary>
    public static int Match(string candidate)
    {
        if (string.IsNullOrWhiteSpace(candidate) || candidate.Length > MaxLength) return 0;
        for (var len = candidate.Length; len >= 3; len--)
        {
            // Yalnız sözcük sınırında dene: sonda, ya da ardından kesme karakteri geliyorsa.
            if (len < candidate.Length && Array.IndexOf(Cut, candidate[len]) < 0) continue;
            var part = candidate[..len].TrimEnd();
            if (part.Length < 3 || Array.IndexOf(Cut, part[^1]) >= 0 && part[^1] != ')') continue;
            if (Resolve(part) is not null) return part.Length;
        }
        // Son parça yoksa (joker "remote-*.log", henüz oluşmamış dosya) üst klasöre bağlan; ama yalnız derin bir
        // klasörse (en az 3 parça), "C:\Yok\Boyle" gibi uydurma yol "C:\"e düşmesin.
        var sep = candidate.TrimEnd().LastIndexOfAny(['\\', '/']);
        if (sep > 0)
        {
            var parent = candidate[..sep];
            if (parent.Split('\\', '/').Count(s => s.Length > 0) >= 3 && Resolve(parent) is not null) return parent.Length;
        }
        return 0;
    }

    /// <summary>Metni yerel mutlak yola çevirir ve varsa döner; yoksa/ağ yoluysa null.</summary>
    public static string? Resolve(string text)
    {
        var p = text.Trim();
        if (p.StartsWith("~/") || p.StartsWith("~\\"))
            p = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), p[2..]);
        if (p.Contains('%')) p = Environment.ExpandEnvironmentVariables(p);
        if (p.StartsWith(@"\\") || p.StartsWith("//") || !Path.IsPathFullyQualified(p)) return null;
        try { p = Path.GetFullPath(p); } catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException) { return null; }
        if (p.StartsWith(@"\\")) return null;
        return Directory.Exists(p) || File.Exists(p) ? p : null;
    }

    /// <summary>Var olan yolu Gezgin/Finder'da gösterir: klasörü açar, dosyayı seçili gösterir (çalıştırmaz).</summary>
    public static bool Reveal(string text)
    {
        if (Resolve(text) is not { } p) return false;
        if (Directory.Exists(p)) Native.RevealFolder(p); else Native.RevealFile(p);
        return true;
    }
}

using System.Text;
using System.Text.RegularExpressions;

namespace ClaudePanel;

/// <summary>Kütükteki bir "Drive'a yüklenecek" satırı. Path null ise satır okunamadı (yol benzeri bir şey yok).</summary>
/// <param name="Section">Satırın altında durduğu AÇIK başlığın metni.</param>
/// <param name="Line">Kütükteki satır numarası (1'den başlar).</param>
/// <param name="Since">Başlıktaki (yoksa üst başlıktaki) tam tarih, yerel gece yarısı, Unix ms.</param>
/// <param name="Extras">Aynı satırda "+" ile eklenmiş öteki dosyalar (çözülmüş yol).</param>
public sealed record LedgerEntry(string Section, int Line, long? Since, string? Path, IReadOnlyList<string> Extras, string? Version, string Text);

/// <param name="Name">Kütüğün durduğu klasörün adı.</param>
/// <param name="Root">Proje kökü (git kökü; yoksa klasör): projeye göre gruplama için.</param>
/// <param name="Mtime">Satırdaki dosyaların en yeni değişiklik zamanı (Unix ms); hiçbiri yoksa 0.</param>
public sealed record FollowDrive(string Name, string Root, string Ledger, string Section, int Line, string File, string? Path,
    IReadOnlyList<string> Extras, string? Version, long? Since, bool Exists, long Mtime, string Text);

/// <summary>
/// GUNCELLEME_KUTUGU.md ayrıştırıcısı: başlığında AÇIK ve DRIVE geçen bölümlerdeki liste ve tablo satırlarından
/// "Drive'a yüklenecek" dosyaları çıkarır. Bölüm, aynı ya da üst düzey başlığa kadar sürer; içindeki KAPATILDI / KAPANDI /
/// YERİNE GEÇTİ alt başlıkları alınmaz. Üç biçim tanınır:
///   (A) - [Ad vX —] `yol` [(not)]        (B) - `yol` [+ `ek dosya`] (sürüm)        (C) | `dosya` | sürüm | `yol` |
/// Yol benzeri bir şey taşımayan liste/tablo satırı atlanmaz: Path = null ile döner ("okunamadı" diye gösterilir).
/// Panel kütüğe YAZMAZ; yalnız okur.
/// </summary>
public static partial class DriveLedger
{
    public const string FileName = "GUNCELLEME_KUTUGU.md";
    const int MaxBytes = 4 * 1024 * 1024, TextMax = 240;

    [GeneratedRegex(@"^(#{1,6})\s+(.*?)\s*#*\s*$")] private static partial Regex Heading();
    [GeneratedRegex(@"(?<!\w)AÇIK(?!\w)")] private static partial Regex Open();
    [GeneratedRegex(@"DRIVE", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)] private static partial Regex Drive();
    [GeneratedRegex(@"(?<!\w)(KAPATILDI|KAPANDI|YERİNE GEÇTİ)(?!\w)")] private static partial Regex Closed();
    [GeneratedRegex(@"(?<!\d)(?:(\d{2})\.(\d{2})\.(\d{4})|(\d{4})-(\d{2})-(\d{2}))(?!\d)")] private static partial Regex FullDate();
    [GeneratedRegex(@"^\s*[-*+]\s+(.*)$")] private static partial Regex ListLine();
    [GeneratedRegex(@"^\s*\|(.*)\|\s*$")] private static partial Regex TableLine();
    [GeneratedRegex(@"^[\s|:\-]+$")] private static partial Regex TableRule();
    [GeneratedRegex(@"`([^`]+)`")] private static partial Regex Tick();
    [GeneratedRegex(@"\G\s*\+\s*`([^`]+)`")] private static partial Regex Plus();
    [GeneratedRegex(@"(?<![\w.])v?(\d+(?:\.\d+){1,3})(?![\w.]*\d)")] private static partial Regex Ver();
    [GeneratedRegex(@"[\\/]v?(\d+(?:\.\d+){1,3})[\\/]")] private static partial Regex VerInPath();
    [GeneratedRegex(@"^[^\\/:*?""<>|]+\.[A-Za-z0-9]{1,5}$")] private static partial Regex BareFile();

    public static List<LedgerEntry> Parse(string text, string dir)
    {
        var lines = text.Replace("\r\n", "\n").Split('\n');
        var list = new List<LedgerEntry>();
        var dates = new long?[7];
        int openLevel = 0, closedLevel = 0;
        string section = "";
        long? since = null;
        var fence = false;
        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i];
            if (line.TrimStart().StartsWith("```", StringComparison.Ordinal)) { fence = !fence; continue; }
            if (fence) continue;
            if (Heading().Match(line) is { Success: true } h)
            {
                var level = h.Groups[1].Length;
                var title = h.Groups[2].Value;
                if (closedLevel > 0 && level <= closedLevel) closedLevel = 0;
                if (openLevel > 0 && level <= openLevel) openLevel = 0;
                for (var l = level; l <= 6; l++) dates[l] = null;
                dates[level] = DateOf(title);
                if (Closed().IsMatch(title)) { if (openLevel > 0 && closedLevel == 0) closedLevel = level; }
                else if (Open().IsMatch(title) && Drive().IsMatch(title) && openLevel == 0) openLevel = level;
                if (openLevel > 0 && closedLevel == 0)
                {
                    if (openLevel == level) section = Shorten(title.Replace("`", ""));
                    since = Enumerable.Range(1, level).Reverse().Select(l => dates[l]).FirstOrDefault(d => d is not null);
                }
                continue;
            }
            if (openLevel == 0 || closedLevel > 0) continue;
            LedgerEntry? entry = null;
            if (ListLine().Match(line) is { Success: true } li) entry = FromList(li.Groups[1].Value, dir, section, i + 1, since);
            else if (TableLine().Match(line) is { Success: true } row && !TableRule().IsMatch(line))
            {
                var header = i + 1 < lines.Length && TableLine().IsMatch(lines[i + 1]) && TableRule().IsMatch(lines[i + 1]);
                if (!header) entry = FromTable(row.Groups[1].Value, dir, section, i + 1, since);
            }
            if (entry is not null) list.Add(entry);
        }
        return Dedupe(list);
    }

    /// <summary>Aynı dosya iki bölümde geçiyorsa en yeni tarihli satır kalır (eşitse ilki). Okunamayan satırlar hep kalır.</summary>
    static List<LedgerEntry> Dedupe(List<LedgerEntry> list)
    {
        var best = new Dictionary<string, LedgerEntry>(StringComparer.OrdinalIgnoreCase);
        foreach (var e in list.Where(e => e.Path is not null))
            if (!best.TryGetValue(e.Path!, out var old) || (e.Since ?? 0) > (old.Since ?? 0)) best[e.Path!] = e;
        return list.Where(e => e.Path is null || ReferenceEquals(best[e.Path], e)).ToList();
    }

    static LedgerEntry FromList(string body, string dir, string section, int line, long? since)
    {
        var first = Tick().Matches(body).FirstOrDefault(m => IsPathLike(m.Groups[1].Value));
        if (first is null || Resolve(dir, first.Groups[1].Value) is not { } path)
            return new LedgerEntry(section, line, since, null, [], null, Shorten(body));
        var extras = new List<string>();
        var at = first.Index + first.Length;
        var baseDir = Path.GetDirectoryName(path) ?? dir;
        while (Plus().Match(body, at) is { Success: true } p)
        {
            at = p.Index + p.Length;
            if (IsPathLike(p.Groups[1].Value) && Resolve(HasSep(p.Groups[1].Value) ? dir : baseDir, p.Groups[1].Value) is { } extra) extras.Add(extra);
        }
        var version = VersionIn(body[..first.Index]) ?? VersionIn(Tick().Replace(body[at..], " "))
            ?? (VerInPath().Match(first.Groups[1].Value) is { Success: true } vp ? vp.Groups[1].Value : null);
        return new LedgerEntry(section, line, since, path, extras, version, Shorten(body));
    }

    static LedgerEntry FromTable(string body, string dir, string section, int line, long? since)
    {
        var ticks = Tick().Matches(body).Select(m => m.Groups[1].Value.Trim()).ToList();
        var where = ticks.FirstOrDefault(s => HasSep(s) && IsPathLike(s));
        var file = ticks.FirstOrDefault(s => !HasSep(s) && BareFile().IsMatch(s));
        string? path = null;
        if (where is not null && Resolve(dir, where) is { } p)
        {
            // Yol hücresi yalnız klasörse (sonu ayraçla bitiyor ya da uzantısız) dosya adı hücresiyle birleştirilir.
            var isDir = where.EndsWith('\\') || where.EndsWith('/') || !Path.HasExtension(p);
            path = isDir && file is not null ? Resolve(p, file) : p;
        }
        else if (file is not null) path = Resolve(dir, file);
        var text = Shorten(string.Join(" · ", body.Split('|').Select(c => c.Trim()).Where(c => c.Length > 0)));
        if (path is null) return new LedgerEntry(section, line, since, null, [], null, text);
        var version = body.Split('|').Select(c => c.Trim()).Where(c => !c.Contains('`')).Select(VersionIn).FirstOrDefault(v => v is not null)
            ?? (VerInPath().Match(where ?? "") is { Success: true } vp ? vp.Groups[1].Value : null);
        return new LedgerEntry(section, line, since, path, [], version, text);
    }

    static bool HasSep(string s) => s.Contains('\\') || s.Contains('/');

    static bool IsPathLike(string s)
    {
        s = s.Trim();
        if (s.Length < 3 || s.Contains("://", StringComparison.Ordinal)) return false;
        return HasSep(s) || BareFile().IsMatch(s);
    }

    /// <summary>Kütükteki yolu mutlak yola çevirir (göreli yol kütüğün klasörüne göre). Ağ yolu ve bozuk yol → null.</summary>
    static string? Resolve(string dir, string raw)
    {
        var p = raw.Trim().Replace('/', Path.DirectorySeparatorChar);
        if (p.StartsWith(@"\\", StringComparison.Ordinal)) return null;
        try
        {
            var full = Path.GetFullPath(Path.IsPathFullyQualified(p) ? p : Path.Combine(dir, p));
            return full.StartsWith(@"\\", StringComparison.Ordinal) ? null : full;
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException) { return null; }
    }

    static string? VersionIn(string s)
    {
        var m = Ver().Match(FullDate().Replace(s, " "));
        return m.Success ? m.Groups[1].Value : null;
    }

    static long? DateOf(string s)
    {
        var m = FullDate().Match(s);
        if (!m.Success) return null;
        var dmy = m.Groups[1].Success;
        int y = int.Parse(m.Groups[dmy ? 3 : 4].Value), mo = int.Parse(m.Groups[dmy ? 2 : 5].Value), d = int.Parse(m.Groups[dmy ? 1 : 6].Value);
        if (mo is < 1 or > 12 || d < 1 || d > DateTime.DaysInMonth(y, mo)) return null;
        return new DateTimeOffset(new DateTime(y, mo, d, 0, 0, 0, DateTimeKind.Local)).ToUnixTimeMilliseconds();
    }

    static string Shorten(string s)
    {
        s = s.Replace("**", "").Trim();
        return s.Length > TextMax ? s[..(TextMax - 1)].TrimEnd() + "…" : s;
    }

    /// <summary>Verilen klasörlerdeki kütükleri okur (alt klasör taranmaz). Kayıt başına hata: o kütük atlanır.</summary>
    public static List<FollowDrive> Scan(IEnumerable<string> dirs)
    {
        var list = new List<FollowDrive>();
        foreach (var dir in dirs.Select(ProjectRoots.Normalize).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                var f = new FileInfo(Path.Combine(dir, FileName));
                if (!f.Exists || f.Length > MaxBytes) continue;
                var name = Path.GetFileName(dir) is { Length: > 0 } n ? n : dir;
                var root = ProjectRoots.Of(dir);
                foreach (var e in Parse(File.ReadAllText(f.FullName, Encoding.UTF8), dir))
                {
                    var files = e.Path is null ? [] : new[] { e.Path }.Concat(e.Extras).ToList();
                    var mtime = files.Select(Mtime).DefaultIfEmpty(0).Max();
                    list.Add(new FollowDrive(name, root, f.FullName, e.Section, e.Line, e.Path is null ? "" : Path.GetFileName(e.Path.TrimEnd('\\', '/')),
                        e.Path, e.Extras, e.Version, e.Since, e.Path is not null && (File.Exists(e.Path) || Directory.Exists(e.Path)), mtime, e.Text));
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* kayıt başına: sonraki kütük */ }
        }
        return list.OrderBy(d => d.Since ?? long.MaxValue).ThenBy(d => d.Name, StringComparer.CurrentCultureIgnoreCase).ThenBy(d => d.Line).ToList();
    }

    static long Mtime(string path)
    {
        try
        {
            if (File.Exists(path)) return new DateTimeOffset(File.GetLastWriteTimeUtc(path)).ToUnixTimeMilliseconds();
            if (Directory.Exists(path)) return new DateTimeOffset(Directory.GetLastWriteTimeUtc(path)).ToUnixTimeMilliseconds();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        return 0;
    }
}

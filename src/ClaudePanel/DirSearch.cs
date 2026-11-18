using System.Diagnostics;
using System.Globalization;
using System.Text;

namespace ClaudePanel;

/// <summary>
/// Yeni oturum → Klasörler aramasında alt klasörlere inen arama. Sınırlı: derinlik, sonuç sayısı ve süre.
/// Birinci düzey istemcide zaten süzülüyor; burada yalnız 2. düzey ve altı döner.
/// </summary>
public static class DirSearch
{
    public const int MaxDepth = 4, MaxResults = 50, MaxCandidates = 500;
    static readonly TimeSpan Budget = TimeSpan.FromMilliseconds(1500);

    // Kod/derleme artıkları: içinde proje klasörü aranmaz, çoğu zaman binlerce alt klasör taşır.
    static readonly HashSet<string> Skip = new(StringComparer.OrdinalIgnoreCase)
    {
        "node_modules", "bin", "obj", "dist", "build", "out", "target", "packages", "__pycache__",
        "venv", ".venv", "env", "site-packages", "$RECYCLE.BIN", "System Volume Information"
    };

    /// <summary>Büyük/küçük harf ve Türkçe harf farkı olmadan karşılaştırma için (app.js norm ile aynı).</summary>
    public static string Norm(string s)
    {
        var lower = s.Replace('İ', 'i').Replace('I', 'i').Replace('ı', 'i').ToLowerInvariant().Normalize(NormalizationForm.FormD);
        var sb = new StringBuilder(lower.Length);
        foreach (var c in lower)
            if (CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark) sb.Append(c);
        return sb.ToString();
    }

    public static (List<DirHit> Hits, bool Truncated) Find(string root, string query, Func<string, bool> known)
    {
        var q = Norm(query.Trim());
        // Sıra: Claude kullanılmış klasör önce, sonra kelime başı eşleşme, sonra bulunma (düzey) sırası. Kelime başı eşleşme ("ic" → "Ic-Isler") ortadakinden ("netanalytic") önce gelir.
        var found = new List<(bool WordStart, DirHit Hit)>();
        if (q.Length == 0) return ([], false);
        var sw = Stopwatch.StartNew();
        var cut = false;
        var queue = new Queue<(DirectoryInfo Dir, int Depth)>();
        queue.Enqueue((new DirectoryInfo(root), 0));
        var rootFull = Path.TrimEndingDirectorySeparator(new DirectoryInfo(root).FullName);
        while (queue.Count > 0 && !cut)
        {
            if (sw.Elapsed > Budget || found.Count >= MaxCandidates) { cut = true; break; }
            var (dir, depth) = queue.Dequeue();
            IEnumerable<DirectoryInfo> children;
            try { children = dir.EnumerateDirectories().ToList(); }
            catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or System.Security.SecurityException) { continue; }
            foreach (var c in children)
            {
                if ((c.Attributes & (FileAttributes.Hidden | FileAttributes.System | FileAttributes.ReparsePoint)) != 0
                    || c.Name.StartsWith('.') || Skip.Contains(c.Name)) continue;
                var d = depth + 1;
                var name = Norm(c.Name);
                var at = d >= 2 ? name.IndexOf(q, StringComparison.Ordinal) : -1;
                if (at >= 0)
                {
                    var wordStart = at == 0 || !char.IsLetterOrDigit(name[at - 1]);
                    var rel = Path.GetRelativePath(rootFull, c.FullName);
                    found.Add((wordStart, new DirHit(c.Name, c.FullName, rel, known(Path.TrimEndingDirectorySeparator(c.FullName)))));
                }
                if (d < MaxDepth) queue.Enqueue((c, d));
            }
        }
        var hits = found.OrderBy(f => f.Hit.Known ? 0 : 1).ThenBy(f => f.WordStart ? 0 : 1).Select(f => f.Hit).Take(MaxResults).ToList(); // OrderBy kararlı: düzey sırası korunur
        return (hits, cut || found.Count > MaxResults);
    }
}

public record DirHit(string Name, string Path, string Rel, bool Known);

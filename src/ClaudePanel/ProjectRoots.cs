using System.Collections.Concurrent;

namespace ClaudePanel;

/// <summary>
/// Proje kökü: klasörün içinde bulunduğu git deposunun kökü; depo yoksa klasörün kendisi. Alt klasör aynı projedir.
/// Ayrı çalışma kopyası (git worktree) kendi kökünü verir (.git dosyası o klasördedir): bilerek ayrı proje sayılır.
/// </summary>
public static class ProjectRoots
{
    static readonly TimeSpan CacheFor = TimeSpan.FromSeconds(30);
    static readonly ConcurrentDictionary<string, (DateTime At, string? Root)> Cache = new(StringComparer.OrdinalIgnoreCase);

    public static string Normalize(string path) => path.Replace('/', Path.DirectorySeparatorChar).TrimEnd('\\', '/');

    /// <summary>Git kökü (.git klasörü ya da dosyası olan ilk üst klasör); yoksa null. Kısa süre önbelleklenir.</summary>
    public static string? GitRoot(string cwd)
    {
        var key = Normalize(cwd);
        if (Cache.TryGetValue(key, out var hit) && DateTime.UtcNow - hit.At < CacheFor) return hit.Root;
        string? root = null;
        try
        {
            for (var d = new DirectoryInfo(key); d is not null; d = d.Parent)
            {
                var dot = Path.Combine(d.FullName, ".git");
                if (Directory.Exists(dot) || File.Exists(dot)) { root = d.FullName.TrimEnd('\\', '/'); break; }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.SecurityException or ArgumentException) { }
        if (Cache.Count > 500) Cache.Clear();
        Cache[key] = (DateTime.UtcNow, root);
        return root;
    }

    /// <summary>Proje kökü: git kökü, yoksa klasörün kendisi.</summary>
    public static string Of(string cwd) => GitRoot(cwd) ?? Normalize(cwd);

    public static bool Same(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

    /// <summary>Yeni depo/çalışma kopyası oluşturulunca eski "depo yok" sonucu kalmasın.</summary>
    public static void Forget() => Cache.Clear();
}

using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

namespace ClaudePanel;

/// <summary>
/// Ayarlar sekmesinin "Hakkında" bölümü: GET /api/about. Sürüm, derlemenin commit'i, işletim sistemi ve .NET sürümü,
/// panelin veri klasörü ve bu sürümün yenilikleri. Yenilikler exe'ye gömülü CHANGELOG.md'nin bu sürüme ait bölümünden
/// okunur (madde başlıkları, **…** arası); ayrı bir liste tutulmaz, sürüm notuyla kendiliğinden uyumlu kalır.
/// </summary>
public static class AboutEndpoints
{
    // Öteki okuma uçları gibi (/api/hub, /api/version) belirteç istemez; telefondan erişimi uzak erişim ara katmanı denetler.
    public static void MapAbout(this WebApplication app)
    {
        app.MapGet("/api/about", () => Results.Json(Info()));
    }

    static object? cached;

    static object Info() => cached ??= Build();

    static object Build()
    {
        var asm = typeof(AboutEndpoints).Assembly;
        var version = asm.GetName().Version?.ToString(3) ?? "?";
        // Bilgi sürümü "0.23.0+<commit>" biçiminde (SourceLink); commit yoksa boş kalır.
        var info = asm.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "";
        var plus = info.IndexOf('+');
        var commit = plus >= 0 && info.Length > plus + 1 ? info[(plus + 1)..][..Math.Min(7, info.Length - plus - 1)] : null;
        return new
        {
            version,
            commit,
            os = RuntimeInformation.OSDescription.Trim(),
            arch = RuntimeInformation.OSArchitecture.ToString().ToLowerInvariant(),
            runtime = RuntimeInformation.FrameworkDescription,
            dataDir = Handoff.DataDir,
            changes = Changes(asm, version)
        };
    }

    /// <summary>CHANGELOG.md'de "## &lt;sürüm&gt;" bölümündeki madde başlıkları; bölüm yoksa boş liste.</summary>
    internal static List<string> Changes(Assembly asm, string version)
    {
        using var s = asm.GetManifestResourceStream("CHANGELOG.md");
        if (s is null) return [];
        using var r = new StreamReader(s);
        return ChangesFrom(r.ReadToEnd(), version);
    }

    internal static List<string> ChangesFrom(string text, string version)
    {
        var list = new List<string>();
        var inSection = false;
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (line.StartsWith("## "))
            {
                if (inSection) break;
                inSection = line[3..].Split(' ', 2)[0] == version;
                continue;
            }
            if (!inSection || !line.StartsWith("- ")) continue;
            var m = Regex.Match(line, @"^- \*\*(.+?)\*\*");
            if (m.Success) list.Add(m.Groups[1].Value.TrimEnd('.'));
        }
        return list;
    }
}

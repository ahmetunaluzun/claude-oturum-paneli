using System.Text.RegularExpressions;

namespace ClaudePanel;

/// <summary>
/// Zamanlanmış görevin logunu bulur (Takip → "Logu aç"). Yalnız VAR OLAN dosya ya da klasör döner; bulunamazsa null (düğme çıkmaz).
/// Sıra: (1) komut argümanlarındaki ya da yönlendirmedeki (&gt; dosya) .log/.txt yolu, (2) betiğin içinde geçen .log yolu
/// (mutlak, %ORTAM% / $env:ORTAM ile, ya da betiğin klasörüne göre), (3) betiğin ya da çalışma klasörünün logs/log alt klasörü.
/// Tahmin edilen yol gösterilmeden önce diskte denetlenir; içerik yorumlanmaz.
/// </summary>
public static partial class TaskLogs
{
    const int MaxScriptBytes = 256 * 1024;
    static readonly string[] LogExt = [".log", ".txt"];
    static readonly string[] LogDirs = ["logs", "log"];

    [GeneratedRegex("\"([^\"]+)\"|'([^']+)'|(\\S+)")] private static partial Regex Token();
    // Betikteki tırnaklı metin içinde .log ile biten yol parçası (birleştirme/Join-Path ile kurulan yollar kaçabilir).
    [GeneratedRegex(@"[""']([^""'\r\n]{1,260}?\.log)[""']", RegexOptions.IgnoreCase)] private static partial Regex ScriptLog();
    // Tırnaksız yönlendirme: ">> son_kontrol.log" (.bat / .sh)
    [GeneratedRegex(@">>?\s*([^\s""'<>|&]{1,260}\.log)\b", RegexOptions.IgnoreCase)] private static partial Regex BareRedirect();
    [GeneratedRegex(@"^[12]?>>?")] private static partial Regex Redirect();
    [GeneratedRegex(@"\$env:([A-Za-z_][A-Za-z0-9_]*)", RegexOptions.IgnoreCase)] private static partial Regex PsEnv();

    /// <summary>Görevin betiği: Match'in bulduğu (.py/.ps1/.sh), yoksa komutun kendisi .bat/.cmd ise o (göreliyse çalışma klasörüne göre).</summary>
    public static string? ScriptOf(OsTask t, string? matched)
    {
        if (matched is not null) return matched;
        if (!(t.Command.EndsWith(".bat", StringComparison.OrdinalIgnoreCase) || t.Command.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase))) return null;
        try
        {
            var p = Path.IsPathFullyQualified(t.Command) ? t.Command : t.WorkDir.Length > 0 ? Path.Combine(t.WorkDir, t.Command) : null;
            return p is not null && File.Exists(p) ? Path.GetFullPath(p) : null;
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException) { return null; }
    }

    /// <param name="script">Görevin çalıştırdığı betik (ScriptOf); yoksa null.</param>
    public static string? Find(OsTask t, string? script)
    {
        var baseDir = t.WorkDir.Length > 0 ? t.WorkDir : script is not null ? Path.GetDirectoryName(script) : null;
        foreach (Match m in Token().Matches(t.Args))
        {
            var v = (m.Groups[1].Success ? m.Groups[1] : m.Groups[2].Success ? m.Groups[2] : m.Groups[3]).Value.Trim('"', '\'', ';', ',', '(', ')');
            v = Redirect().Replace(v, ""); // ">x.log", ">>x.log", "2>x.log" (ayrı yazılan "> x.log"da dosya sonraki sözcük)
            if (LogExt.Any(e => v.EndsWith(e, StringComparison.OrdinalIgnoreCase)) && Existing(v, baseDir, false) is { } f) return f;
        }
        if (script is not null && File.Exists(script)) if (InScript(script) is { } s) return s;
        foreach (var dir in new[] { script is null ? null : Path.GetDirectoryName(script), t.WorkDir.Length > 0 ? t.WorkDir : null })
            if (dir is not null) foreach (var name in LogDirs) if (Directory.Exists(Path.Combine(dir, name))) return Path.Combine(dir, name);
        return null;
    }

    static string? InScript(string script)
    {
        string text;
        try
        {
            if (new FileInfo(script).Length > MaxScriptBytes) return null;
            text = File.ReadAllText(script);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return null; }
        var dir = Path.GetDirectoryName(script);
        foreach (Match m in ScriptLog().Matches(text).Concat(BareRedirect().Matches(text)))
        {
            var v = PsEnv().Replace(m.Groups[1].Value, e => Environment.GetEnvironmentVariable(e.Groups[1].Value) ?? e.Value);
            v = v.Replace("$PSScriptRoot", dir ?? "", StringComparison.OrdinalIgnoreCase)
                .Replace("%~dp0", dir is null ? "" : dir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
            if (Existing(v, dir, true) is { } f) return f;
        }
        return null;
    }

    /// <summary>Yolu çözer (ortam değişkeni, göreli yol); var olan dosyanın tam yolu ya da null.</summary>
    static string? Existing(string v, string? baseDir, bool fromScript)
    {
        v = Environment.ExpandEnvironmentVariables(v).Replace('/', Path.DirectorySeparatorChar);
        if (v.Contains('$') || v.Contains('{')) return null; // çözülemeyen değişken (ör. f-string, $tarih)
        try
        {
            var full = Path.IsPathFullyQualified(v) ? v : baseDir is null ? null : Path.GetFullPath(Path.Combine(baseDir, v));
            if (full is not null && File.Exists(full)) return full;
            // Betikte yalnız dosya adı geçiyorsa (ör. "kaynak-oncelik.log") betiğin logs/ klasörüne de bak.
            if (fromScript && baseDir is not null && !v.Contains(Path.DirectorySeparatorChar))
                foreach (var name in LogDirs) if (File.Exists(Path.Combine(baseDir, name, v))) return Path.Combine(baseDir, name, v);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException) { }
        return null;
    }
}

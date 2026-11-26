namespace ClaudePanel;

/// <summary>
/// Yeni oturum → Klasörler → "Yeni klasör": o an gezilen klasörün içinde tek düzey klasör açar (0.23.0).
/// Ad Windows ve Mac'te aynı kurallarla denetlenir; var olan klasörün üstüne yazılmaz, üst klasör dışına çıkılmaz.
/// </summary>
public static class DirCreate
{
    public const int MaxName = 120;
    static readonly char[] Bad = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
    static readonly HashSet<string> Reserved = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
    };

    /// <summary>Ad uygunsa null, değilse hata kodu (empty, long, chars, dots, reserved).</summary>
    public static string? Check(string name)
    {
        if (name.Length == 0) return "empty";
        if (name.Length > MaxName) return "long";
        if (name.IndexOfAny(Bad) >= 0 || name.Any(char.IsControl)) return "chars";
        if (name.Trim('.').Length == 0 || name.EndsWith('.') || name.EndsWith(' ')) return "dots";
        var stem = name.Split('.')[0].TrimEnd();
        if (Reserved.Contains(stem)) return "reserved";
        return null;
    }

    /// <summary>Klasörü açar. Dönüş: (tam yol, null) ya da (null, hata kodu: + notfound, exists, denied).</summary>
    public static (string? Path, string? Error) Create(string? parent, string? rawName)
    {
        var name = (rawName ?? "").Trim();
        if (Check(name) is { } bad) return (null, bad);
        if (string.IsNullOrWhiteSpace(parent) || !Directory.Exists(parent)) return (null, "notfound");
        try
        {
            var root = Path.GetFullPath(parent);
            var full = Path.GetFullPath(Path.Combine(root, name));
            var up = Path.GetDirectoryName(full);
            if (up is null || !string.Equals(Path.TrimEndingDirectorySeparator(up), Path.TrimEndingDirectorySeparator(root),
                    OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
                return (null, "chars");
            if (Directory.Exists(full) || File.Exists(full)) return (null, "exists");
            Directory.CreateDirectory(full);
            return (full, null);
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or System.Security.SecurityException
                                       or ArgumentException or NotSupportedException)
        {
            return (null, "denied");
        }
    }
}

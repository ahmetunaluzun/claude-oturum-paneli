namespace ClaudePanel;

/// <summary>
/// Telefondan konuşmadaki dosya yolunu indirme (salt okuma). Yalnız proje kökünün altındaki DOSYALAR
/// (klasör değil), en fazla <see cref="MaxBytes"/>; gizli bilgi taşıyabilen ad ve klasörler hiç verilmez.
/// Kök: Windows'ta C:\AI Projeleri, Mac'te ~/AI Projeleri; test için CLAUDE_PANEL_FILES_ROOT.
/// Bağlantı (junction/symlink) zincirde varsa reddedilir: kökün dışına kaçışı engeller.
/// </summary>
static class RemoteFiles
{
    public const long MaxBytes = 100L * 1024 * 1024;

    // Klasör adı (herhangi bir düzeyde) — içi hiç verilmez.
    static readonly HashSet<string> DeniedDirs = new(StringComparer.OrdinalIgnoreCase)
        { "Test-Kimlik", ".git", ".ssh", ".aws", ".azure", ".gnupg", "secrets", "credentials" };

    // Dosya adı / uzantısı — anahtar, sertifika, parola kasası, ortam dosyası.
    static readonly HashSet<string> DeniedNames = new(StringComparer.OrdinalIgnoreCase)
        { "settings.local.json", "credentials.json", "token.json", "client_secret.json", ".netrc", ".npmrc", ".pypirc", "id_rsa", "id_ed25519" };
    static readonly HashSet<string> DeniedExts = new(StringComparer.OrdinalIgnoreCase)
        { ".pem", ".key", ".pfx", ".p12", ".kdbx", ".token", ".enc", ".jks", ".keystore", ".ppk" };

    public static string Root => Environment.GetEnvironmentVariable("CLAUDE_PANEL_FILES_ROOT") is { Length: > 0 } r
        ? Path.GetFullPath(r)
        : OperatingSystem.IsWindows() ? @"C:\AI Projeleri"
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "AI Projeleri");

    /// <summary>Yol indirilebilirse tam yolu döner; değilse null (yok, klasör, kök dışı, gizli, büyük, bağlantı).</summary>
    public static string? Allowed(string text)
    {
        if (PathLinks.Resolve(text) is not { } p || !File.Exists(p)) return null;
        var root = Root.TrimEnd('\\', '/');
        var cmp = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        if (!p.StartsWith(root + Path.DirectorySeparatorChar, cmp)) return null;

        var name = Path.GetFileName(p);
        if (DeniedNames.Contains(name) || DeniedExts.Contains(Path.GetExtension(name))
            || name.StartsWith(".env", StringComparison.OrdinalIgnoreCase)) return null;
        var rel = p[(root.Length + 1)..];
        if (rel.Split(Path.DirectorySeparatorChar).SkipLast(1).Any(DeniedDirs.Contains)) return null;

        try
        {
            var info = new FileInfo(p);
            if (info.Length > MaxBytes || info.Attributes.HasFlag(FileAttributes.ReparsePoint)) return null;
            for (var d = info.Directory; d is not null && d.FullName.Length > root.Length; d = d.Parent)
                if (d.Attributes.HasFlag(FileAttributes.ReparsePoint)) return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return null; }
        return p;
    }

    /// <summary>Konuşmadaki adayın indirilebilir ön ekinin uzunluğu; yoksa 0 (yerel <see cref="PathLinks.Match"/> ile aynı kesim).</summary>
    public static int Match(string candidate)
    {
        var len = PathLinks.Match(candidate);
        return len > 0 && Allowed(candidate[..len]) is not null ? len : 0;
    }
}

namespace ClaudePanel;

/// <summary>macOS karşılıkları: klasör seçme, pano, Finder'da açma, soru penceresi (AppleScript ile).</summary>
static class Native
{
    const string Title = "Claude Oturum Paneli";

    /// <summary>macOS klasör seçme penceresi; öne gelir. İptal edilirse null.</summary>
    public static Task<string?> PickFolder() => Task.Run<string?>(() =>
    {
        var r = Sh.Osa("""
            tell application "System Events"
              activate
              set f to choose folder with prompt "Proje klasörü"
            end tell
            return POSIX path of f
            """, timeoutMs: 15 * 60_000);
        return r.Exit == 0 && r.Out.Length > 0 ? r.Out.TrimEnd('/') is { Length: > 0 } p ? p : "/" : null;
    });

    /// <summary>Panoda Finder'dan kopyalanmış dosya/klasör (⌘C) varsa yolu.</summary>
    public static Task<List<string>> ClipboardPaths() => Task.Run(() =>
    {
        var r = Sh.Osa("""
            try
              return POSIX path of (the clipboard as «class furl»)
            on error
              return ""
            end try
            """);
        return r.Out.Length > 0 ? new List<string> { r.Out.TrimEnd('/') } : new List<string>();
    });

    /// <summary>Panoda resim (ekran görüntüsü, ⌃⇧⌘4) varsa PNG olarak kaydeder.</summary>
    public static Task<bool> SaveClipboardImage(string file) => Task.Run(() =>
        Sh.Osa("""
            on run argv
              try
                set d to the clipboard as «class PNGf»
              on error
                return "no"
              end try
              set f to open for access (POSIX file (item 1 of argv)) with write permission
              write d to f
              close access f
              return "ok"
            end run
            """, [file]).Out == "ok");

    public static void RevealFolder(string path) => Sh.Run("/usr/bin/open", [path]);

    /// <summary>Metin dosyasını TextEdit'te açar (-t: varsayılan metin düzenleyici; çalıştırılmaz).</summary>
    public static void OpenText(string path) => Sh.Run("/usr/bin/open", ["-t", path]);

    /// <summary>Dosyayı Finder'da seçili gösterir (açmaz).</summary>
    public static void RevealFile(string path) => Sh.Run("/usr/bin/open", ["-R", path]);

    /// <summary>Klasör gezgininin başlangıç noktaları: ev klasörü, kök, takılı diskler.</summary>
    public static List<DirEntry> FolderRoots()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var list = new List<DirEntry> { new(Path.GetFileName(home), home, false), new("/", "/", false) };
        try
        {
            if (Directory.Exists("/Volumes"))
                list.AddRange(Directory.EnumerateDirectories("/Volumes").Select(d => new DirEntry(Path.GetFileName(d), d, false)));
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException) { }
        return list;
    }

    public static Task<bool> Confirm(string text, bool warning = false) => Task.Run(() =>
        Sh.Osa($"""
            on run argv
              display dialog (item 1 of argv) with title "{Title}" buttons {"{"}"Hayır", "Evet"{"}"} default button "Evet"{(warning ? " with icon caution" : "")}
              return button returned of result
            end run
            """, [text], 15 * 60_000).Out == "Evet");

    public static Task Info(string text, bool warning = false) => Task.Run(() =>
        Sh.Osa($"""
            on run argv
              display dialog (item 1 of argv) with title "{Title}" buttons {"{"}"Tamam"{"}"} default button "Tamam"{(warning ? " with icon caution" : "")}
            end run
            """, [text], 15 * 60_000));
}

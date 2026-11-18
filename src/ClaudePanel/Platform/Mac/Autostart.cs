using System.Security;

namespace ClaudePanel;

/// <summary>
/// macOS oturum açılışında paneli penceresiz (--no-window) başlatır: ~/Library/LaunchAgents/com.claudepanel.panel.plist.
/// launchd ile başlayan uygulamanın PATH'i kısadır (/usr/bin:/bin); claude'un node'u bulunsun diye PATH plist'e yazılır.
/// </summary>
public static class Autostart
{
    const string Label = "com.claudepanel.panel";
    public const bool Supported = true;

    static string Home => Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    static string PlistPath => Path.Combine(Home, "Library", "LaunchAgents", Label + ".plist");

    public static bool IsEnabled() => File.Exists(PlistPath);

    public static void Set(bool on)
    {
        if (!on)
        {
            if (File.Exists(PlistPath)) File.Delete(PlistPath);
            return;
        }
        var exe = Environment.ProcessPath ?? throw new InvalidOperationException("panelin yolu bilinmiyor");
        var path = string.Join(':', Path.Combine(Home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin",
            "/usr/bin", "/bin", "/usr/sbin", "/sbin");
        static string X(string s) => SecurityElement.Escape(s);
        var xml = $"""
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0">
            <dict>
              <key>Label</key><string>{Label}</string>
              <key>ProgramArguments</key>
              <array><string>{X(exe)}</string><string>--no-window</string></array>
              <key>WorkingDirectory</key><string>{X(Path.GetDirectoryName(exe) ?? Home)}</string>
              <key>EnvironmentVariables</key>
              <dict><key>PATH</key><string>{X(path)}</string></dict>
              <key>RunAtLoad</key><true/>
              <key>KeepAlive</key><false/>
            </dict>
            </plist>
            """;
        Directory.CreateDirectory(Path.GetDirectoryName(PlistPath)!);
        File.WriteAllText(PlistPath, xml + "\n");
    }
}

using System.Diagnostics;

namespace ClaudePanel;

public static partial class Launcher
{
    static string Home => Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

    /// <summary>Paneli adres çubuğu olmayan uygulama penceresinde açar (Chrome, Edge, Brave, Chromium; yoksa varsayılan tarayıcı).</summary>
    public static void OpenAppWindow(string url)
    {
        var profile = Path.Combine(Handoff.DataDir, "browser");
        foreach (var exe in BrowserCandidates())
        {
            if (!File.Exists(exe)) continue;
            var psi = new ProcessStartInfo(exe) { UseShellExecute = false };
            psi.ArgumentList.Add($"--app={url}");
            psi.ArgumentList.Add($"--user-data-dir={profile}");
            psi.ArgumentList.Add("--window-size=1180,820");
            psi.ArgumentList.Add("--no-first-run");
            Process.Start(psi);
            return;
        }
        Sh.Run("/usr/bin/open", [url]);
    }

    static IEnumerable<string> BrowserCandidates()
    {
        string[] apps =
        {
            "Google Chrome.app/Contents/MacOS/Google Chrome",
            "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "Brave Browser.app/Contents/MacOS/Brave Browser",
            "Chromium.app/Contents/MacOS/Chromium"
        };
        foreach (var root in new[] { "/Applications", Path.Combine(Home, "Applications") })
            foreach (var a in apps)
                yield return Path.Combine(root, a);
    }

    /// <summary>Terminalde `claude agents` ekranını açar (iTerm2 açıksa onda, değilse Terminal'de).</summary>
    public static void OpenAgentsView()
    {
        var cmd = $"'{ClaudeExe().Replace("'", "'\\''")}' agents";
        var iterm = Sh.ProcessTable().Values.Any(v => v.Name == "iTerm2");
        var script = iterm
            ? "on run argv\ntell application \"iTerm2\"\ncreate window with default profile command (item 1 of argv)\nactivate\nend tell\nend run"
            : "on run argv\ntell application \"Terminal\"\ndo script (item 1 of argv)\nactivate\nend tell\nend run";
        Sh.Osa(script, [cmd]);
    }

    /// <summary>claude'un yolu. Finder'dan açılan uygulamanın PATH'i kısadır; bilinen kurulum yerlerine önce bakılır.</summary>
    public static string ClaudeExe()
    {
        string[] known =
        {
            Path.Combine(Home, ".local/bin/claude"),
            Path.Combine(Home, ".claude/local/claude"),
            "/opt/homebrew/bin/claude",
            "/usr/local/bin/claude"
        };
        foreach (var k in known) if (File.Exists(k)) return k;
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            var c = Path.Combine(dir.Trim(), "claude");
            if (File.Exists(c)) return c;
        }
        return "claude";
    }
}

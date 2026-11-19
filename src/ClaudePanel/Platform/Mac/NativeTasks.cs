namespace ClaudePanel;

/// <summary>
/// macOS: kullanıcının ~/Library/LaunchAgents plist'leri (yalnız liste). Son çıkış durumu `launchctl list` çıktısından
/// (sütunlar: PID, Status, Label). Devre dışı bırakma panelden yapılmaz.
/// </summary>
static class NativeTasks
{
    public const string Kind = "mac";

    public static List<OsTask>? List()
    {
        var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Library", "LaunchAgents");
        Dictionary<string, long>? exits = null;
        var r = Sh.Run("/bin/launchctl", ["list"], 5000);
        if (r.Exit == 0)
        {
            exits = new(StringComparer.Ordinal);
            foreach (var line in r.Out.Split('\n'))
            {
                var p = line.Split('\t');
                if (p.Length >= 3 && long.TryParse(p[1], out var code)) exits[p[2].Trim()] = code;
            }
        }
        return LaunchAgents.Read(dir, exits);
    }

    public static string? Disable(string id) => "unsupported";
}

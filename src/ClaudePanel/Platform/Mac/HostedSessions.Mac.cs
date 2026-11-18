using System.Globalization;

namespace ClaudePanel;

public sealed partial class HostedSessions
{
    /// <summary>
    /// Çalışan claude süreçleri (`ps`). Panel biçimli (stream-json) olup ebeveyni launchd (pid 1) olan süreç
    /// "sahipsiz" sayılır: başlatan panel kapanmış demektir.
    /// </summary>
    static List<RunningProc> RunningClaude()
    {
        var list = new List<RunningProc>();
        foreach (var line in Sh.Run("/bin/ps", ["-axww", "-o", "pid=,ppid=,command="]).Out.Split('\n'))
        {
            var parts = line.Trim().Split(' ', 3, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 3
                || !int.TryParse(parts[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out var pid)
                || !int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var ppid)) continue;
            var cl = parts[2];
            var exe = Path.GetFileName(cl.Split(' ', 2)[0]);
            // Yerel kurulum "claude"; npm kurulumu "node .../@anthropic-ai/claude-code/cli.js".
            if (exe != "claude" && !cl.Contains("@anthropic-ai/claude-code", StringComparison.Ordinal)) continue;
            var panelShaped = cl.Contains("--input-format stream-json", StringComparison.OrdinalIgnoreCase);
            list.Add(new RunningProc(pid, cl, panelShaped && ppid == 1));
        }
        return list;
    }
}

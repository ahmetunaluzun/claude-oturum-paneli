using System.ComponentModel;
using System.Diagnostics;

namespace ClaudePanel;

/// <summary>macOS komutlarını (ps, osascript, open) kabuk kullanmadan çalıştırır; argümanlar tek tek geçer.</summary>
static class Sh
{
    public sealed record Result(int Exit, string Out);

    public static Result Run(string file, IEnumerable<string> args, int timeoutMs = 10_000)
    {
        var psi = new ProcessStartInfo(file)
        {
            UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        try
        {
            using var p = Process.Start(psi);
            if (p is null) return new(-1, "");
            var output = p.StandardOutput.ReadToEndAsync();
            _ = p.StandardError.ReadToEndAsync(); // dolup süreci kilitlemesin
            if (!p.WaitForExit(timeoutMs))
            {
                try { p.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
                return new(-1, "");
            }
            return new(p.ExitCode, output.Result.Trim());
        }
        catch (Win32Exception) { return new(-1, ""); } // komut yok (ör. Linux'ta osascript)
    }

    /// <summary>AppleScript çalıştırır. Metinler betiğe gömülmez, `on run argv` ile argüman olarak geçer.</summary>
    public static Result Osa(string script, IEnumerable<string>? args = null, int timeoutMs = 10_000)
    {
        var all = new List<string>();
        foreach (var line in script.Split('\n')) { all.Add("-e"); all.Add(line); }
        if (args is not null) all.AddRange(args);
        return Run("/usr/bin/osascript", all, timeoutMs);
    }

    /// <summary>`ps -axo pid=,ppid=,comm=` çıktısından süreç ağacı (pid → ebeveyn, ad).</summary>
    public static Dictionary<int, (int Ppid, string Name)> ProcessTable()
    {
        var map = new Dictionary<int, (int, string)>();
        foreach (var line in Run("/bin/ps", ["-axo", "pid=,ppid=,comm="]).Out.Split('\n'))
        {
            var parts = line.Trim().Split(' ', 3, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 3 && int.TryParse(parts[0], out var pid) && int.TryParse(parts[1], out var ppid))
                map[pid] = (ppid, Path.GetFileName(parts[2]).TrimStart('-'));
        }
        return map;
    }
}

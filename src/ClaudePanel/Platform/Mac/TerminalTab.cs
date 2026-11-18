using System.Diagnostics;

namespace ClaudePanel;

/// <summary>
/// Panele alınan oturumun terminalde boş kalan kabuğunu kapatır (iTerm2/Terminal sekmesi de kapanır;
/// Terminal'de profil ayarına bağlı). Yalnız claude'u başlatmak için açılmış kabuk: ebeveyni `login`
/// (Terminal/iTerm2 sekmesinin girişi) ve içinde başka iş yok. VS Code vb. terminallere dokunulmaz.
/// </summary>
static class TerminalTab
{
    static readonly string[] Shells = { "zsh", "bash", "fish", "sh" };

    public static int FindOwnedShell(int claudePid)
    {
        var table = Sh.ProcessTable();
        if (!table.TryGetValue(claudePid, out var c) || !table.TryGetValue(c.Ppid, out var shell)) return 0;
        if (!Shells.Contains(shell.Name, StringComparer.Ordinal)) return 0;
        return table.TryGetValue(shell.Ppid, out var host) && host.Name == "login" ? c.Ppid : 0;
    }

    public static bool CloseIfIdle(int shellPid)
    {
        if (shellPid == 0) return false;
        var table = Sh.ProcessTable();
        if (!table.TryGetValue(shellPid, out var me) || !Shells.Contains(me.Name, StringComparer.Ordinal)) return false;
        if (table.Values.Any(v => v.Ppid == shellPid)) return false; // kabukta başka iş var
        try
        {
            using var p = Process.GetProcessById(shellPid);
            p.Kill();
            return true;
        }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
        catch (System.ComponentModel.Win32Exception) { return false; }
    }
}

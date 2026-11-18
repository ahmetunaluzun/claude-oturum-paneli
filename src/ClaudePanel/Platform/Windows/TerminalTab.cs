using System.Diagnostics;
using System.Globalization;
using System.Management;

namespace ClaudePanel;

/// <summary>
/// Panele alınan oturumun terminalde boş kalan sekmesini/penceresini kapatır.
/// Yalnız claude'u başlatmak için açılmış kabuk kapatılır: kabuk Windows Terminal'in ya da
/// Gezgin'in doğrudan çocuğuysa ve içinde başka çalışan iş yoksa. VS Code gibi başka
/// uygulamaların içindeki terminallere ve iç içe kabuklara dokunulmaz.
/// </summary>
static class TerminalTab
{
    static readonly string[] Shells = { "powershell", "pwsh", "cmd" };
    static readonly string[] Hosts = { "WindowsTerminal", "explorer" };
    static readonly string[] ConsoleHelpers = { "conhost.exe", "OpenConsole.exe" };

    /// <summary>claude kapatılmadan ÖNCE çağrılır; kapatılabilecek kabuğun pid'ini verir, yoksa 0.</summary>
    public static int FindOwnedShell(int claudePid)
    {
        int shell = WindowFocus.ParentOf(claudePid);
        if (shell == 0 || !IsNamed(shell, Shells)) return 0;
        int host = WindowFocus.ParentOf(shell);
        return host != 0 && IsNamed(host, Hosts) ? shell : 0;
    }

    /// <summary>claude kapandıktan SONRA çağrılır; kabukta başka iş yoksa kabuğu kapatır (sekme de kapanır).</summary>
    public static bool CloseIfIdle(int shellPid)
    {
        if (shellPid == 0 || HasOtherChildren(shellPid)) return false;
        try
        {
            using var p = Process.GetProcessById(shellPid);
            if (!IsShell(p.ProcessName)) return false;
            p.Kill();
            return true;
        }
        catch (ArgumentException) { return false; }          // zaten kapanmış
        catch (InvalidOperationException) { return false; }  // kapanırken
        catch (System.ComponentModel.Win32Exception) { return false; } // yetki yok
    }

    static bool IsShell(string name) => Shells.Contains(name, StringComparer.OrdinalIgnoreCase);

    static bool IsNamed(int pid, string[] names)
    {
        try
        {
            using var p = Process.GetProcessById(pid);
            return names.Contains(p.ProcessName, StringComparer.OrdinalIgnoreCase);
        }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
    }

    static bool HasOtherChildren(int pid)
    {
        using var s = new ManagementObjectSearcher(
            $"SELECT Name FROM Win32_Process WHERE ParentProcessId={pid.ToString(CultureInfo.InvariantCulture)}");
        foreach (var o in s.Get())
            if (!ConsoleHelpers.Contains(o["Name"] as string ?? "", StringComparer.OrdinalIgnoreCase)) return true;
        return false;
    }
}

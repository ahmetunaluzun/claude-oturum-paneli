using Microsoft.Win32;

namespace ClaudePanel;

/// <summary>
/// Windows açılışında paneli penceresiz (--no-window) başlatır: HKCU\...\Run\ClaudePanel.
/// Windows yeniden başlarsa panel kendiliğinden açılır, oturumları geri bağlar, gece modu sürer.
/// </summary>
public static class Autostart
{
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string ValueName = "ClaudePanel";
    public const bool Supported = true;

    /// <summary>Yayın sırasında çalışan exe .old.exe olarak yeniden adlandırılıyor; kayıt asıl adı göstermeli.</summary>
    static string ExePath()
    {
        var p = Environment.ProcessPath ?? "";
        return p.EndsWith(".old.exe", StringComparison.OrdinalIgnoreCase) ? p[..^".old.exe".Length] + ".exe" : p;
    }

    public static bool IsEnabled()
    {
        using var k = Registry.CurrentUser.OpenSubKey(RunKey);
        return k?.GetValue(ValueName) is string v && v.Length > 0;
    }

    public static void Set(bool on)
    {
        using var k = Registry.CurrentUser.CreateSubKey(RunKey);
        if (on) k.SetValue(ValueName, $"\"{ExePath()}\" --no-window");
        else k.DeleteValue(ValueName, throwOnMissingValue: false);
    }
}

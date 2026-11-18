using System.ComponentModel;
using System.Diagnostics;

namespace ClaudePanel;

/// <summary>
/// Gece modu penceresinde Mac'in boşta uykuya geçmesini engeller: `caffeinate -i -w &lt;panel pid&gt;`.
/// -w sayesinde panel ölürse caffeinate de kendiliğinden biter. Kapak kapatmayı engellemez (macOS izin vermez).
/// </summary>
public static class KeepAwake
{
    static readonly object Lock = new();
    static Process? _proc;

    public static bool Active { get { lock (Lock) return _proc is { HasExited: false }; } }

    public static void Set(bool on)
    {
        lock (Lock)
        {
            if (on && _proc is { HasExited: false }) return;
            if (!on)
            {
                if (_proc is { HasExited: false }) try { _proc.Kill(); } catch (InvalidOperationException) { }
                _proc?.Dispose();
                _proc = null;
                return;
            }
            var psi = new ProcessStartInfo("/usr/bin/caffeinate") { UseShellExecute = false, CreateNoWindow = true };
            psi.ArgumentList.Add("-i");
            psi.ArgumentList.Add("-w");
            psi.ArgumentList.Add(Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture));
            try { _proc = Process.Start(psi); }
            catch (Win32Exception) { _proc = null; } // caffeinate yok (macOS dışı)
        }
    }
}

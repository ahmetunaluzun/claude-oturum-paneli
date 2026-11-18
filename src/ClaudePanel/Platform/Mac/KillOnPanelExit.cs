using System.Diagnostics;

namespace ClaudePanel;

/// <summary>
/// macOS'ta iş nesnesi yok: panel kapanırken başlattığı claude süreçleri kapatılır. Panel öldürülürse
/// (kill -9) kalan süreçlerin ebeveyni launchd (pid 1) olur; sonraki açılışta sahipsiz sayılıp kapatılır
/// (HostedSessions.RunningClaude).
/// </summary>
static class KillOnPanelExit
{
    static readonly List<Process> Tracked = new();

    static KillOnPanelExit() => AppDomain.CurrentDomain.ProcessExit += (_, _) =>
    {
        lock (Tracked)
            foreach (var p in Tracked)
                try { if (!p.HasExited) p.Kill(entireProcessTree: true); }
                catch (InvalidOperationException) { /* bu arada bitti */ }
    };

    public static void Add(Process proc)
    {
        lock (Tracked)
        {
            Tracked.RemoveAll(p => { try { return p.HasExited; } catch (InvalidOperationException) { return true; } });
            Tracked.Add(proc);
        }
    }
}

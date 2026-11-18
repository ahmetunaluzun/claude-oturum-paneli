using System.Diagnostics;

namespace ClaudePanel;

public sealed partial class HostedSessions
{
    /// <summary>Çalışan claude.exe süreçleri. Panel biçimli (stream-json) olup başlatanı artık yaşamayan süreç "sahipsiz" sayılır.</summary>
    static List<RunningProc> RunningClaude()
    {
        var list = new List<RunningProc>();
        try
        {
            using var q = new System.Management.ManagementObjectSearcher(
                "SELECT ProcessId, ParentProcessId, CreationDate, CommandLine FROM Win32_Process WHERE Name='claude.exe'");
            foreach (var o in q.Get())
            {
                if (o["CommandLine"] is not string cl) continue;
                var pid = Convert.ToInt32(o["ProcessId"]);
                var panelShaped = cl.Contains("--input-format stream-json", StringComparison.OrdinalIgnoreCase);
                var orphan = false;
                if (panelShaped && o["CreationDate"] is string cd)
                {
                    var created = System.Management.ManagementDateTimeConverter.ToDateTime(cd);
                    orphan = !ParentAlive(Convert.ToInt32(o["ParentProcessId"]), created);
                }
                list.Add(new RunningProc(pid, cl, orphan));
            }
        }
        catch (System.Management.ManagementException) { /* WMI yoksa engellemeden devam */ }
        return list;
    }

    /// <summary>Başlatan süreç hâlâ yaşıyor mu? PID yeniden kullanıldıysa (çocuktan sonra başlamış) yaşamıyor sayılır.</summary>
    static bool ParentAlive(int ppid, DateTime childCreated)
    {
        try
        {
            using var p = Process.GetProcessById(ppid);
            return !p.HasExited && p.StartTime <= childCreated;
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }
}

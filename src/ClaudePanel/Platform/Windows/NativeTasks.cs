using System.Runtime.InteropServices;

namespace ClaudePanel;

/// <summary>
/// Windows Görev Zamanlayıcı (Schedule.Service COM arayüzü; süreç başlatılmaz, çıktı diline bağlı değildir).
/// Yalnız listeler ve kullanıcının onayıyla tek görevi devre dışı bırakır; görev oluşturmaz, silmez, çalıştırmaz.
/// </summary>
static class NativeTasks
{
    public const string Kind = "windows";
    const int ActionExec = 0, IncludeHidden = 1;

    public static List<OsTask>? List()
    {
        try
        {
            dynamic svc = Connect();
            var list = new List<OsTask>();
            Walk(svc.GetFolder("\\"), list);
            return list;
        }
        catch (Exception ex) when (ex is COMException or UnauthorizedAccessException or InvalidCastException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException)
        {
            RemoteLog.Info($"Görev Zamanlayıcı okunamadı: {ex.Message}");
            return null;
        }
    }

    static dynamic Connect()
    {
        var type = Type.GetTypeFromProgID("Schedule.Service") ?? throw new COMException("Schedule.Service yok");
        dynamic svc = Activator.CreateInstance(type)!;
        svc.Connect();
        return svc;
    }

    static void Walk(dynamic folder, List<OsTask> list)
    {
        string folderPath = folder.Path;
        foreach (dynamic task in folder.GetTasks(IncludeHidden))
        {
            // Kayıt başına: tanımı okunamayan görev (ör. yetki yok) ötekileri düşürmesin.
            try
            {
                string command = "", args = "", workDir = "";
                foreach (dynamic action in task.Definition.Actions)
                {
                    if ((int)action.Type != ActionExec) continue;
                    command = Environment.ExpandEnvironmentVariables((string?)action.Path ?? "").Trim('"');
                    args = Environment.ExpandEnvironmentVariables((string?)action.Arguments ?? "");
                    workDir = Environment.ExpandEnvironmentVariables((string?)action.WorkingDirectory ?? "").Trim('"');
                    break; // ilk çalıştırma eylemi
                }
                if (command.Length == 0) continue;
                bool enabled = task.Enabled;
                list.Add(new OsTask((string)task.Path, (string)task.Name, folderPath, enabled, enabled ? Ms((DateTime)task.NextRunTime) : null,
                    Ms((DateTime)task.LastRunTime), unchecked((uint)(int)task.LastTaskResult), command, args, workDir, null, true));
            }
            catch (Exception ex) when (ex is COMException or UnauthorizedAccessException or InvalidCastException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException) { }
        }
        foreach (dynamic sub in folder.GetFolders(0)) Walk(sub, list);
    }

    /// <summary>Hiç çalışmamış / planlanmamış görevde zamanlayıcı 1899 ya da 1999 tarihini verir: null.</summary>
    static long? Ms(DateTime local) =>
        local.Year < 2000 ? null : new DateTimeOffset(DateTime.SpecifyKind(local, DateTimeKind.Local)).ToUnixTimeMilliseconds();

    public static string? Disable(string path)
    {
        try
        {
            dynamic svc = Connect();
            var at = path.LastIndexOf('\\');
            if (at < 0) return "notfound";
            dynamic task = svc.GetFolder(at == 0 ? "\\" : path[..at]).GetTask(path[(at + 1)..]);
            task.Enabled = false;
            return (bool)task.Enabled ? "failed" : null;
        }
        catch (UnauthorizedAccessException) { return "denied"; }
        catch (COMException ex) when (unchecked((uint)ex.HResult) == 0x80070005) { return "denied"; }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException) { return "notfound"; }
        catch (COMException ex)
        {
            RemoteLog.Info($"Görev devre dışı bırakılamadı: 0x{unchecked((uint)ex.HResult):X8}");
            return unchecked((uint)ex.HResult) is 0x80070002 or 0x80070003 ? "notfound" : "failed";
        }
        catch (Microsoft.CSharp.RuntimeBinder.RuntimeBinderException) { return "failed"; }
    }
}

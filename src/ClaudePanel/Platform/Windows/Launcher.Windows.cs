using System.Diagnostics;

namespace ClaudePanel;

public static partial class Launcher
{
    /// <summary>
    /// Paneli adres çubuğu olmayan uygulama penceresinde açar (Edge, yoksa Chrome, yoksa varsayılan tarayıcı).
    /// Panel penceresi zaten açıksa yenisini açmaz, onu öne getirir (bildirime/tepsiye tıklama, exe'ye ikinci kez tıklama).
    /// </summary>
    /// <param name="fresh">Sunucu yeni açıldı: önceki sunucudan kalan pencere eski sayfayı ve geçersiz anahtarı taşır;
    /// öne getirmek yerine kapatılır, yenisi açılır (0.13.0'da eski sürümün sayfası yeni sunucuyla bozuk göründü).</param>
    public static void OpenAppWindow(string url, bool fresh = false)
    {
        if (fresh) CloseAppWindow(url);
        else if (FocusExistingAppWindow(url)) return;
        var profile = Path.Combine(Handoff.DataDir, "browser"); // canlıda %LOCALAPPDATA%\ClaudePanel\browser; test kopyası ayrı
        foreach (var exe in BrowserCandidates())
        {
            if (!File.Exists(exe)) continue;
            var psi = new ProcessStartInfo(exe) { UseShellExecute = false };
            psi.ArgumentList.Add($"--app={url}");
            psi.ArgumentList.Add($"--user-data-dir={profile}");
            psi.ArgumentList.Add("--window-size=1180,820");
            psi.ArgumentList.Add("--no-first-run");
            Process.Start(psi);
            return;
        }
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }

    /// <summary>
    /// Açık panel penceresini öne getirir. Pencerenin sahibi, komut satırında `--app=&lt;adres&gt;` olan ana tarayıcı sürecidir
    /// (aynı profille ikinci açılış ilk sürece devredilip kapanır; alt süreçlerde --type= vardır).
    /// </summary>
    static bool FocusExistingAppWindow(string url)
    {
        using var p = FindAppWindowProcess(url);
        if (p is null) return false;
        WindowFocus.BringToFront(p.MainWindowHandle);
        return true;
    }

    /// <summary>
    /// Panelin uygulama penceresini kapatır (Paneli kapat, yeni sürüme devir, yeni açılış). Sayfanın window.close() çağrısı
    /// Edge uygulama penceresinde her zaman çalışmıyor; sunucu durunca pencere açık kalıp "kapanmadı" gibi görünüyordu.
    /// WM_CLOSE doğrudan gönderilir: Edge uygulama penceresi kendini "etkin değil" bildiriyor, Process.CloseMainWindow bu
    /// durumda mesajı hiç göndermeyip false dönüyor (19.11.2026'da ölçüldü). En çok 3 sn kapanması beklenir.
    /// </summary>
    public static void CloseAppWindow(string url)
    {
        using var p = FindAppWindowProcess(url);
        if (p is null) return;
        try
        {
            if (PostMessage(p.MainWindowHandle, WM_CLOSE, IntPtr.Zero, IntPtr.Zero)) p.WaitForExit(3000);
        }
        catch (InvalidOperationException) { } // süreç bu arada kapandı
    }

    const uint WM_CLOSE = 0x0010;
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    /// <summary>
    /// Panel penceresinin sahibi: komut satırında `--app=&lt;adres&gt;` olan ana tarayıcı süreci
    /// (aynı profille ikinci açılış ilk sürece devredilip kapanır; alt süreçlerde --type= vardır). Pencere yoksa null.
    /// </summary>
    static Process? FindAppWindowProcess(string url)
    {
        var app = $"--app={url}";
        try
        {
            using var s = new System.Management.ManagementObjectSearcher(
                "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='msedge.exe' OR Name='chrome.exe'");
            foreach (var o in s.Get())
            {
                var cl = o["CommandLine"] as string ?? "";
                if (!cl.Contains(app, StringComparison.OrdinalIgnoreCase) || cl.Contains("--type=", StringComparison.Ordinal)) continue;
                var p = Process.GetProcessById(Convert.ToInt32(o["ProcessId"], System.Globalization.CultureInfo.InvariantCulture));
                if (p.MainWindowHandle != IntPtr.Zero) return p;
                p.Dispose(); // pencere kapanmış, süreç arka planda kalmış
            }
        }
        catch (Exception ex) when (ex is System.Management.ManagementException or ArgumentException or InvalidOperationException
                                       or System.Runtime.InteropServices.COMException or UnauthorizedAccessException) { }
        return null;
    }

    static IEnumerable<string> BrowserCandidates()
    {
        var pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        yield return Path.Combine(pf86, @"Microsoft\Edge\Application\msedge.exe");
        yield return Path.Combine(pf, @"Microsoft\Edge\Application\msedge.exe");
        yield return Path.Combine(pf, @"Google\Chrome\Application\chrome.exe");
        yield return Path.Combine(local, @"Google\Chrome\Application\chrome.exe");
    }

    /// <summary>Terminalde `claude agents` ekranını açar (arka plan oturumlarına bağlanmak için).</summary>
    public static void OpenAgentsView()
    {
        var wt = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            @"Microsoft\WindowsApps\wt.exe");
        var psi = File.Exists(wt) ? new ProcessStartInfo(wt) : new ProcessStartInfo("cmd.exe") { };
        psi.UseShellExecute = false;
        if (File.Exists(wt))
        {
            psi.ArgumentList.Add("--title");
            psi.ArgumentList.Add("Claude");
            psi.ArgumentList.Add(ClaudeExe());
            psi.ArgumentList.Add("agents");
        }
        else
        {
            psi.ArgumentList.Add("/k");
            psi.ArgumentList.Add(ClaudeExe());
            psi.ArgumentList.Add("agents");
        }
        Process.Start(psi);
    }

    public static string ClaudeExe()
    {
        // Test: gerçek claude yerine zararsız bir süreç (CLAUDE_PANEL_CLAUDE_EXE); değişken yoksa davranış aynı.
        if (Environment.GetEnvironmentVariable("CLAUDE_PANEL_CLAUDE_EXE") is { Length: > 0 } fake) return fake;
        var local = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), @".local\bin\claude.exe");
        if (File.Exists(local)) return local;
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            var c = Path.Combine(dir.Trim(), "claude.exe");
            if (File.Exists(c)) return c;
        }
        return "claude";
    }
}

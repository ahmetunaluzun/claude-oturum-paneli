using System.Diagnostics;
using System.Globalization;
using System.Management;
using System.Runtime.InteropServices;
using System.Windows.Automation;

namespace ClaudePanel;

/// <summary>
/// Bir claude sürecinin terminal penceresini, Windows Terminal'de ise doğru sekmesini öne getirir.
/// Windows Terminal tüm sekmeleri tek süreçte tuttuğu için sekme, ada göre (klasör adı ya da kullanıcının seçimi) bulunur.
/// </summary>
public static class WindowFocus
{
    const int SW_RESTORE = 9;
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int max);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    public static FocusResult Focus(int pid, string folder, string? preferredTab, string? preferredTabId = null)
    {
        var owner = FindWindowOwner(pid);
        if (owner is null) return new(false, "no-window");
        var (ownerPid, mainWindow, name) = owner.Value;

        if (!name.Equals("WindowsTerminal", StringComparison.OrdinalIgnoreCase))
        {
            // VS Code gibi uygulamalar tüm pencerelerini tek süreçte tutar; MainWindowHandle o an hangisiyse odur.
            // Birden çok pencere varsa başlığı klasör adıyla eşleşen pencere seçilir.
            var all = VirtualDesktops.TopWindows().GetValueOrDefault(ownerPid) ?? [];
            BringToFront(all.Count > 1 && ByTitle(all, folder) is { } w ? w : mainWindow);
            return new(true);
        }

        var tabs = TerminalTabs(ownerPid);
        if (tabs.Count == 0) { BringToFront(mainWindow); return new(true); }

        // Önce sekme kimliği (claude sekme başlığını değiştirse de aynı kalır), sonra hatırlanan ad, sonra klasör adı.
        var target = (preferredTabId is not null ? tabs.FirstOrDefault(t => t.Id == preferredTabId) : null)
            ?? (preferredTab is not null ? tabs.FirstOrDefault(t => t.Name == preferredTab) : null)
            ?? BestMatch(tabs, folder);
        if (target is null)
            return new(false, "pick-tab", tabs.Select(t => t.Name).Distinct().ToList());

        try
        {
            if (target.Element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var p))
                ((SelectionItemPattern)p).Select();
        }
        catch (ElementNotAvailableException) { return new(false, "pick-tab", tabs.Select(t => t.Name).ToList()); }
        BringToFront(target.Window);
        return new(true, Tab: target.Name, TabId: target.Id);
    }

    sealed record Tab(string Name, string Id, AutomationElement Element, IntPtr Window);

    /// <summary>Başlığı klasör adıyla en iyi eşleşen pencere; tek ve açık eşleşme yoksa null.</summary>
    internal static IntPtr? ByTitle(List<IntPtr> windows, string folder)
    {
        var f = Norm(Path.GetFileName(folder.TrimEnd('\\', '/')));
        if (f.Length == 0) return null;
        // VS Code başlığı: "dosya - klasör - Visual Studio Code" (ayraç ayara göre " - " ya da " — "); parçalar ayrı puanlanır.
        var scored = windows
            .Select(h => (h, score: Title(h).Split([" — ", " - ", " | "], StringSplitOptions.RemoveEmptyEntries)
                .Select(part => Score(Norm(part), f)).DefaultIfEmpty(0).Max()))
            .Where(x => x.score > 0).OrderByDescending(x => x.score).ToList();
        if (scored.Count == 0 || (scored.Count > 1 && scored[0].score == scored[1].score)) return null;
        return scored[0].h;
    }

    static string Title(IntPtr h)
    {
        var sb = new System.Text.StringBuilder(512);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    static List<Tab> TerminalTabs(int ownerPid)
    {
        var list = new List<Tab>();
        var windows = AutomationElement.RootElement.FindAll(TreeScope.Children,
            new PropertyCondition(AutomationElement.ProcessIdProperty, ownerPid));
        foreach (AutomationElement w in windows)
        {
            var hwnd = new IntPtr(w.Current.NativeWindowHandle);
            var tabs = w.FindAll(TreeScope.Descendants,
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem));
            foreach (AutomationElement t in tabs)
                list.Add(new Tab(t.Current.Name, string.Join('.', t.GetRuntimeId()), t, hwnd));
        }
        return list;
    }

    /// <summary>Sekme adını klasör adıyla karşılaştırır; tek ve açık bir eşleşme yoksa null (kullanıcıya sorulur).</summary>
    static Tab? BestMatch(List<Tab> tabs, string folder)
    {
        var f = Norm(Path.GetFileName(folder.TrimEnd('\\', '/')));
        if (f.Length == 0) return null;
        var scored = tabs
            .Select(t => (tab: t, score: Score(Norm(t.Name), f)))
            .Where(x => x.score > 0)
            .OrderByDescending(x => x.score)
            .ToList();
        if (scored.Count == 0) return null;
        if (scored.Count > 1 && scored[0].score == scored[1].score) return null; // belirsiz: sor
        return scored[0].tab;
    }

    static int Score(string tab, string folder)
    {
        if (tab.Length == 0) return 0;
        if (tab == folder) return 100;
        if (folder.Contains(tab) || tab.Contains(folder)) return 60 + Math.Min(tab.Length, folder.Length);
        // Ortak başlangıç (RAPORAR ~ raporaraci); en az 4 harf.
        var common = 0;
        while (common < tab.Length && common < folder.Length && tab[common] == folder[common]) common++;
        if (common >= 4) return 20 + common;
        // Kelime bazında: "Demo Mağaza" ~ "Mağaza"
        var words = folder.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        return words.Any(w => w.Length >= 4 && tab.Contains(w)) ? 30 : 0;
    }

    /// <summary>Türkçe harfleri sadeleştirip küçültür (İ/I sorunu olmadan).</summary>
    static string Norm(string s)
    {
        s = s.Replace('İ', 'i').Replace('I', 'i').Replace('ı', 'i');
        s = s.ToLowerInvariant().Replace('ş', 's').Replace('ğ', 'g').Replace('ü', 'u')
             .Replace('ö', 'o').Replace('ç', 'c');
        var chars = s.Select(c => char.IsLetterOrDigit(c) ? c : ' ').ToArray();
        return string.Join(' ', new string(chars).Split(' ', StringSplitOptions.RemoveEmptyEntries));
    }

    /// <summary>Süreçten yukarı doğru (en fazla 6 ata) ilk pencere sahibi süreci bulur.</summary>
    static (int Pid, IntPtr Window, string Name)? FindWindowOwner(int pid)
    {
        var current = pid;
        for (var depth = 0; depth < 6 && current > 0; depth++)
        {
            try
            {
                using var p = Process.GetProcessById(current);
                if (p.MainWindowHandle != IntPtr.Zero) return (current, p.MainWindowHandle, p.ProcessName);
            }
            catch (ArgumentException) { return null; }
            current = ParentOf(current);
        }
        return null;
    }

    internal static void BringToFront(IntPtr h)
    {
        if (h == IntPtr.Zero) return;
        if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
        // Windows, arka plandaki süreçten öne getirmeyi engeller; ALT tuşu bu kilidi açar.
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        keybd_event(0x12, 0, 2, UIntPtr.Zero);
        SetForegroundWindow(h);
    }

    internal static int ParentOf(int pid)
    {
        using var s = new ManagementObjectSearcher(
            $"SELECT ParentProcessId FROM Win32_Process WHERE ProcessId={pid}");
        foreach (var o in s.Get())
            return Convert.ToInt32(o["ParentProcessId"], CultureInfo.InvariantCulture);
        return 0;
    }
}

using System.Globalization;
using System.Management;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace ClaudePanel;

/// <summary>
/// Oturumun penceresi hangi sanal masaüstünde (Masaüstü 1, 2…). Pencerenin masaüstü kimliği belgelenmiş
/// IVirtualDesktopManager.GetWindowDesktopId ile, sıra ve ad Explorer'ın kayıt defterindeki listesinden okunur.
/// Tek masaüstü varsa (liste yok) ya da pencere kesin bulunamazsa sonuç boştur; kartta tahmin gösterilmez.
/// Sonuç 30 sn önbellekte tutulur (WMI süreç taraması her yoklamada koşmasın).
/// </summary>
public static class VirtualDesktops
{
    const string Key = @"Software\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops";
    static readonly TimeSpan Ttl = TimeSpan.FromSeconds(30);
    static readonly Lock Gate = new();
    static Dictionary<int, DesktopRef> _cache = new();
    static DateTime _at = DateTime.MinValue;
    static string _pidsSig = "";

    /// <summary>pid → masaüstü. sessions: terminal oturumlarının claude süreçleri ve klasörleri.</summary>
    public static async Task<Dictionary<int, DesktopRef>> Of(IReadOnlyList<(int Pid, string Cwd)> sessions)
    {
        var sig = string.Join(',', sessions.Select(x => x.Pid).Order());
        lock (Gate)
            if (sig == _pidsSig && DateTime.UtcNow - _at < Ttl) return _cache;
        Dictionary<int, DesktopRef> result;
        try { result = sessions.Count == 0 ? new() : await Sta.Run(() => Compute(sessions)); }
        catch (Exception ex) when (ex is COMException or ManagementException or InvalidCastException or UnauthorizedAccessException)
        {
            result = new(); // masaüstü bilgisi süs; alınamazsa kart onsuz çizilir
        }
        lock (Gate) { _cache = result; _at = DateTime.UtcNow; _pidsSig = sig; }
        return result;
    }

    static Dictionary<int, DesktopRef> Compute(IReadOnlyList<(int Pid, string Cwd)> sessions)
    {
        var result = new Dictionary<int, DesktopRef>();
        var order = DesktopOrder();
        if (order.Count < 2) return result;
        var mgr = (IVirtualDesktopManager)new CVirtualDesktopManager();
        var parents = ParentTable();
        var windows = TopWindows();
        foreach (var (pid, cwd) in sessions)
        {
            var hwnds = WindowsOf(pid, parents, windows);
            Guid IdOf(IntPtr h) => mgr.GetWindowDesktopId(h, out var g) == 0 ? g : Guid.Empty;
            var ids = hwnds.Select(IdOf).Where(g => g != Guid.Empty).Distinct().ToList();
            // Sahibin pencereleri farklı masaüstlerindeyse (VS Code'un birkaç penceresi) başlığı klasörle eşleşen pencere.
            if (ids.Count > 1 && WindowFocus.ByTitle(hwnds, cwd) is { } w && IdOf(w) is var one && one != Guid.Empty) ids = [one];
            if (ids.Count != 1) continue; // pencere yok ya da hangisi olduğu kesin değil
            var i = order.IndexOf(ids[0]);
            if (i >= 0) result[pid] = new(i + 1, NameOf(ids[0]));
        }
        return result;
    }

    /// <summary>Masaüstü sırası: kayıt defterindeki VirtualDesktopIDs (16 baytlık GUID'ler art arda). Tek masaüstünde değer yoktur.</summary>
    internal static List<Guid> DesktopOrder()
    {
        using var k = Registry.CurrentUser.OpenSubKey(Key);
        return ParseIds(k?.GetValue("VirtualDesktopIDs") as byte[]);
    }

    internal static List<Guid> ParseIds(byte[]? raw)
    {
        var list = new List<Guid>();
        if (raw is null) return list;
        for (var i = 0; i + 16 <= raw.Length; i += 16) list.Add(new Guid(raw.AsSpan(i, 16)));
        return list;
    }

    static string? NameOf(Guid id)
    {
        using var k = Registry.CurrentUser.OpenSubKey($@"{Key}\Desktops\{id.ToString("B").ToUpperInvariant()}");
        return k?.GetValue("Name") as string is { Length: > 0 } n ? n : null;
    }

    /// <summary>claude sürecinden yukarı doğru ilk görünür pencereye sahip süreç; pencereleri o süreçten.
    /// Birden çok pencere varsa (VS Code, Windows Terminal) yalnız hepsi aynı masaüstündeyse sonuç verilir.</summary>
    static List<IntPtr> WindowsOf(int pid, Dictionary<int, int> parents, Dictionary<int, List<IntPtr>> byPid)
    {
        var cur = pid;
        for (var depth = 0; depth < 8 && cur > 0; depth++)
        {
            if (byPid.TryGetValue(cur, out var list)) return list;
            cur = parents.GetValueOrDefault(cur);
        }
        return [];
    }

    static Dictionary<int, int> ParentTable()
    {
        var map = new Dictionary<int, int>();
        using var s = new ManagementObjectSearcher("SELECT ProcessId, ParentProcessId FROM Win32_Process");
        foreach (var o in s.Get())
            map[Convert.ToInt32(o["ProcessId"], CultureInfo.InvariantCulture)] =
                Convert.ToInt32(o["ParentProcessId"], CultureInfo.InvariantCulture);
        return map;
    }

    /// <summary>Görünür, başlıklı üst düzey pencereler (süreç → pencereler). Başka masaüstündeki pencereler de görünür sayılır.</summary>
    internal static Dictionary<int, List<IntPtr>> TopWindows()
    {
        var map = new Dictionary<int, List<IntPtr>>();
        EnumWindows((h, _) =>
        {
            if (!IsWindowVisible(h) || GetWindowTextLength(h) == 0 || GetWindow(h, GW_OWNER) != IntPtr.Zero) return true;
            GetWindowThreadProcessId(h, out var p);
            if (!map.TryGetValue((int)p, out var l)) map[(int)p] = l = [];
            l.Add(h);
            return true;
        }, IntPtr.Zero);
        return map;
    }

    const uint GW_OWNER = 4;
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

    [ComImport, Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a")]
    class CVirtualDesktopManager;

    [ComImport, Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IVirtualDesktopManager
    {
        [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr hwnd, out bool onCurrent);
        [PreserveSig] int GetWindowDesktopId(IntPtr hwnd, out Guid desktopId);
        [PreserveSig] int MoveWindowToDesktop(IntPtr hwnd, ref Guid desktopId);
    }
}

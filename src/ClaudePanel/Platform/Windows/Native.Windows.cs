using System.Diagnostics;
using System.Windows.Forms;

namespace ClaudePanel;

/// <summary>İşletim sistemine özel küçük işler: klasör seçme, pano, klasörü açma, soru penceresi.</summary>
static class Native
{
    /// <summary>Windows'un klasör seçme penceresi; her zaman öne gelir. İptal edilirse null.</summary>
    public static Task<string?> PickFolder() => Sta.Run(() =>
    {
        // Görünmez, en üstte duran sahip pencere: iletişim penceresi her zaman öne gelir.
        var owner = new System.Windows.Window
        {
            Width = 0, Height = 0, WindowStyle = System.Windows.WindowStyle.None, ShowInTaskbar = false,
            ShowActivated = true, Topmost = true, AllowsTransparency = true, Opacity = 0
        };
        owner.Show();
        owner.Activate();
        try
        {
            var dlg = new Microsoft.Win32.OpenFolderDialog { Title = "Proje klasörü" };
            return dlg.ShowDialog(owner) == true ? dlg.FolderName : null;
        }
        finally { owner.Close(); }
    });

    /// <summary>Panoda kopyalanmış dosya/klasör yolları (Gezgin'de Ctrl+C).</summary>
    public static Task<List<string>> ClipboardPaths() => Sta.Run(() =>
        System.Windows.Clipboard.ContainsFileDropList()
            ? System.Windows.Clipboard.GetFileDropList().Cast<string>().ToList()
            : new List<string>());

    /// <summary>Panoda resim (ekran görüntüsü) varsa PNG olarak kaydeder.</summary>
    public static Task<bool> SaveClipboardImage(string file) => Sta.Run(() =>
    {
        if (!System.Windows.Clipboard.ContainsImage() || System.Windows.Clipboard.GetImage() is not { } img) return false;
        var enc = new System.Windows.Media.Imaging.PngBitmapEncoder();
        enc.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(img));
        using var fs = File.Create(file);
        enc.Save(fs);
        return true;
    });

    public static void RevealFolder(string path) =>
        Process.Start(new ProcessStartInfo("explorer.exe") { ArgumentList = { path }, UseShellExecute = false });

    /// <summary>Dosyayı Gezgin'de seçili gösterir (açmaz/çalıştırmaz). Yol var olan yerel dosya olmalı.</summary>
    public static void RevealFile(string path) =>
        Process.Start(new ProcessStartInfo("explorer.exe") { Arguments = $"/select,\"{path}\"", UseShellExecute = false });

    /// <summary>Klasör gezgininin başlangıç noktaları: sürücüler.</summary>
    public static List<DirEntry> FolderRoots() =>
        DriveInfo.GetDrives().Where(d => d.IsReady)
            .Select(d => new DirEntry(d.Name.TrimEnd('\\'), d.RootDirectory.FullName, false)).ToList();

    public static async Task<bool> Confirm(string text, bool warning = false) =>
        await Box(text, MessageBoxButtons.YesNo, warning ? MessageBoxIcon.Warning : MessageBoxIcon.Question) == DialogResult.Yes;

    public static Task Info(string text, bool warning = false) =>
        Box(text, MessageBoxButtons.OK, warning ? MessageBoxIcon.Warning : MessageBoxIcon.Information);

    static Task<DialogResult> Box(string text, MessageBoxButtons buttons, MessageBoxIcon icon) =>
        Sta.Run(() => MessageBox.Show(text, "Claude Oturum Paneli", buttons, icon,
            MessageBoxDefaultButton.Button1, MessageBoxOptions.DefaultDesktopOnly));
}

using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;

namespace ClaudePanel;

/// <summary>
/// Gizli değerler (mail hesabı yenileme belirteci, Google istemci dosyası): Windows DPAPI (ProtectedData, CurrentUser) ile
/// şifrelenip panel veri klasörüne yazılır (secrets\&lt;ad&gt;.bin). Düz metin diske yazılmaz; dosyayı yalnız bu Windows
/// kullanıcısı çözebilir. Değerler loga yazılmaz.
/// </summary>
static class TokenStore
{
    static readonly string Dir = Path.Combine(Handoff.DataDir, "secrets");
    static readonly byte[] Entropy = Encoding.UTF8.GetBytes("ClaudePanel.secret.v1");

    static string FileOf(string name) => Path.Combine(Dir, name + ".bin");

    public static bool Save(string name, string value)
    {
        try
        {
            Directory.CreateDirectory(Dir);
            var data = ProtectedData.Protect(Encoding.UTF8.GetBytes(value), Entropy, DataProtectionScope.CurrentUser);
            var tmp = FileOf(name) + ".tmp";
            File.WriteAllBytes(tmp, data);
            File.Move(tmp, FileOf(name), overwrite: true);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or CryptographicException) { return false; }
    }

    public static string? Load(string name)
    {
        try
        {
            var f = FileOf(name);
            return File.Exists(f) ? Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(f), Entropy, DataProtectionScope.CurrentUser)) : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or CryptographicException) { return null; }
    }

    public static void Delete(string name)
    {
        try { File.Delete(FileOf(name)); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }

    /// <summary>Adresi varsayılan tarayıcıda açar (Google girişi; panel penceresinde değil).</summary>
    public static void OpenBrowser(string url) => Process.Start(new ProcessStartInfo(url) { UseShellExecute = true })?.Dispose();
}

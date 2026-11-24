using System.ComponentModel;
using System.Diagnostics;
using System.Text.Json;

namespace ClaudePanel;

/// <summary>
/// Chrome profilleri: anahtar sayfası (ApiKeys.cs) kullanıcının seçtiği profilde açılır; yanlış hesapla oturum açılmasın.
/// Profil listesi Chrome'un "Local State" dosyasından okunur (profile.info_cache: klasör adı, görünen ad, hesap e-postası).
/// Klasör adı ("Profile 1") kuruluma özeldir, koda yazılmaz: seçim hub.json'da durur (HubSettings.cs).
/// Uydurma ortamda (CLAUDE_PANEL_CLAUDE_DIR: test, ekran görüntüsü) gerçek dosya OKUNMAZ ve tarayıcı AÇILMAZ:
///   CLAUDE_PANEL_CHROME_STATE → profil listesi bu dosyadan; CLAUDE_PANEL_HUB_OPEN_LOG → açılacak adres bu dosyaya yazılır.
/// </summary>
public static class ChromeProfiles
{
    public sealed record Profile(string Dir, string Name, string? Email);

    static readonly bool Isolated = Environment.GetEnvironmentVariable("CLAUDE_PANEL_CLAUDE_DIR") is { Length: > 0 };
    static readonly string? FakeState = Environment.GetEnvironmentVariable("CLAUDE_PANEL_CHROME_STATE") is { Length: > 0 } f ? f : null;
    static readonly string? OpenLog = Environment.GetEnvironmentVariable("CLAUDE_PANEL_HUB_OPEN_LOG") is { Length: > 0 } f ? f : null;

    static string? StateFile => FakeState ?? (Isolated ? null
        : OperatingSystem.IsWindows() ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Google", "Chrome", "User Data", "Local State")
        : OperatingSystem.IsMacOS() ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Library", "Application Support", "Google", "Chrome", "Local State")
        : null);

    public static List<Profile> List()
    {
        var list = new List<Profile>();
        try
        {
            if (StateFile is not { } f || !File.Exists(f)) return list;
            using var doc = JsonDocument.Parse(File.ReadAllText(f));
            if (!doc.RootElement.TryGetProperty("profile", out var p) || !p.TryGetProperty("info_cache", out var cache) || cache.ValueKind != JsonValueKind.Object) return list;
            foreach (var e in cache.EnumerateObject())
            {
                static string? Str(JsonElement o, string n) => o.ValueKind == JsonValueKind.Object && o.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
                var email = Str(e.Value, "user_name");
                list.Add(new(e.Name, Str(e.Value, "name") is { Length: > 0 } n ? n : e.Name, string.IsNullOrWhiteSpace(email) ? null : email));
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { }
        return list.OrderBy(x => x.Dir, StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>Adresi verilen profilde (yoksa varsayılan tarayıcıda) açar. Dönen değer: açıldı mı.</summary>
    public static bool Open(string url, string? profileDir)
    {
        var profile = profileDir is not null && List().Any(p => p.Dir == profileDir) ? profileDir : null;
        if (OpenLog is not null)
        {
            File.AppendAllText(OpenLog, $"{profile ?? "-"}\t{url}\n");
            return true;
        }
        if (Isolated) return false;
        try
        {
            if (profile is not null && OperatingSystem.IsWindows() && ChromeExe() is { } exe)
            {
                var psi = new ProcessStartInfo(exe) { UseShellExecute = false };
                psi.ArgumentList.Add("--profile-directory=" + profile);
                psi.ArgumentList.Add(url);
                Process.Start(psi)?.Dispose();
                return true;
            }
            if (profile is not null && OperatingSystem.IsMacOS())
            {
                var psi = new ProcessStartInfo("/usr/bin/open") { UseShellExecute = false };
                foreach (var a in new[] { "-na", "Google Chrome", "--args", "--profile-directory=" + profile, url }) psi.ArgumentList.Add(a);
                Process.Start(psi)?.Dispose();
                return true;
            }
            TokenStore.OpenBrowser(url);
            return true;
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException or IOException) { return false; }
    }

    static string? ChromeExe()
    {
        var roots = new[] { Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86, Environment.SpecialFolder.LocalApplicationData };
        return roots.Select(r => Path.Combine(Environment.GetFolderPath(r), "Google", "Chrome", "Application", "chrome.exe")).FirstOrDefault(File.Exists);
    }
}

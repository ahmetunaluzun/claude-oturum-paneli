using System.Diagnostics;
using System.Text.Json;

namespace ClaudePanel;

/// <summary>
/// Proje başına varsayılan Claude hesabı (Accounts.cs). Yeni oturumda hesap seçilince ya da oturum öteki hesaba geçirilince
/// projenin kökü (ProjectRoots) o hesapla kaydedilir; hesap belirtilmeden açılan panel oturumları (planlı işler dahil) ve
/// arka plan oturumları bu hesapla başlar. Varsayılan hesap kayıt tutulmaz (kayıt yoksa varsayılan).
/// Dosya: &lt;veri klasörü&gt;/project-accounts.json, { "&lt;kök, küçük harf&gt;": "&lt;hesap kimliği&gt;" }.
/// </summary>
public static class ProjectAccounts
{
    static readonly string File_ = Path.Combine(Handoff.DataDir, "project-accounts.json");
    static readonly object Lock = new();

    static Dictionary<string, string> Load()
    {
        try
        {
            if (File.Exists(File_) && JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(File_)) is { } d)
                return new(d, StringComparer.OrdinalIgnoreCase);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { }
        return new(StringComparer.OrdinalIgnoreCase);
    }

    static string Key(string cwd) => ProjectRoots.Of(cwd).TrimEnd('\\', '/').ToLowerInvariant();

    /// <summary>Projenin kayıtlı hesabı; kayıt yoksa ya da hesap artık yoksa null (varsayılan hesap).</summary>
    public static string? Of(string? cwd)
    {
        if (string.IsNullOrWhiteSpace(cwd)) return null;
        lock (Lock)
            return Load().TryGetValue(Key(cwd), out var id) && Accounts.Find(id) is { IsDefault: false } a ? a.Id : null;
    }

    /// <summary>Tüm kayıtlar (arayüz: yeni oturum penceresinde seçili hesap).</summary>
    public static IReadOnlyDictionary<string, string> All()
    {
        lock (Lock) return Load();
    }

    public static void Set(string cwd, string accountId)
    {
        lock (Lock)
        {
            var d = Load();
            var key = Key(cwd);
            if (Accounts.Find(accountId) is { IsDefault: false } a) d[key] = a.Id;
            else if (!d.Remove(key)) return;
            try
            {
                Directory.CreateDirectory(Handoff.DataDir);
                var tmp = File_ + ".tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(d));
                File.Move(tmp, File_, overwrite: true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                RemoteLog.Info($"Proje hesabı kaydedilemedi: {ex.Message}");
            }
        }
    }

    /// <summary>
    /// claude sürecini hesabın klasörüyle başlatır: ek hesapta CLAUDE_CONFIG_DIR verilir; varsayılan hesapta değişken
    /// panel başka hesaptan miras almışsa kaldırılır. Ortam bloğuna yalnız gerektiğinde dokunulur.
    /// </summary>
    public static void ApplyEnv(ProcessStartInfo psi, Account? account)
    {
        if (account is { IsDefault: false }) psi.Environment["CLAUDE_CONFIG_DIR"] = account.Dir;
        else if (Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR") is not null) psi.Environment.Remove("CLAUDE_CONFIG_DIR");
    }
}

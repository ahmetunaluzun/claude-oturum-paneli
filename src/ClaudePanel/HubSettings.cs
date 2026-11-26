using System.Text.Json;

namespace ClaudePanel;

/// <summary>
/// Ayarlar sekmesinin kalıcı seçimleri: &lt;veri klasörü&gt;/hub.json. Gizli bilgi içermez (anahtarlar TokenStore'da).
/// </summary>
public static class HubSettings
{
    /// <param name="ChromeProfile">Anahtar sayfalarının açılacağı Chrome profil klasörü; null ya da "" = otomatik (bkz. HubEndpoints;
    /// 0.25.0 öncesi "" varsayılan tarayıcıydı, o sürümde otomatik seçenek yoktu), "-" = varsayılan tarayıcı.</param>
    /// <param name="Workers">Yapay zekâ işçisi aç/kapa ("codex", "gemini"); kayıt yoksa Workers.cs'teki varsayılan.</param>
    /// <param name="Routes">İş türü başına araç sırası (Routing.cs); kayıt yoksa varsayılan sıra.</param>
    /// <param name="AccountNames">Claude hesabına kullanıcının verdiği görünen ad (hesap kimliği → ad; Accounts.cs). Kayıt yoksa
    /// Claude'daki kuruluş adı ya da "Kişisel".</param>
    public sealed record Saved(string? ChromeProfile = null, Dictionary<string, bool>? Workers = null, Dictionary<string, List<string>>? Routes = null,
        Dictionary<string, string>? AccountNames = null);

    static readonly string File_ = Path.Combine(Handoff.DataDir, "hub.json");
    static readonly object Lock = new();

    public static Saved Get()
    {
        lock (Lock) return Load();
    }

    static Saved Load()
    {
        try
        {
            var s = File.Exists(File_) ? JsonSerializer.Deserialize<Saved>(File.ReadAllText(File_)) ?? new() : new();
            return s.AccountNames is { } n ? s with { AccountNames = new(n, StringComparer.OrdinalIgnoreCase) } : s;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { return new(); }
    }

    /// <summary>Oku-değiştir-yaz tek kilitte: iki ayar değişikliği birbirini ezmesin.</summary>
    public static Saved Update(Func<Saved, Saved> change)
    {
        lock (Lock)
        {
            var s = change(Load());
            try
            {
                Directory.CreateDirectory(Handoff.DataDir);
                var tmp = File_ + ".tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(s));
                File.Move(tmp, File_, overwrite: true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                RemoteLog.Info($"Ayarlar yazılamadı (hub.json): {ex.Message}");
            }
            return s;
        }
    }
}

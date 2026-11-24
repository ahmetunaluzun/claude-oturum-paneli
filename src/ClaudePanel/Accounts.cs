using System.Text.Json;
using System.Text.Json.Nodes;

namespace ClaudePanel;

/// <summary>Bir Claude hesabı: kendi ayar klasörü (CLAUDE_CONFIG_DIR) ve girişiyle.</summary>
/// <param name="Id">Klasör adı (".claude", ".claude-is"); arayüz ve ayarlar bununla anar.</param>
/// <param name="Label">Görünen ad: kişisel hesapta null (arayüz "Kişisel" yazar), kurumsal hesapta kuruluş adı.</param>
public sealed record Account(string Id, string? Label, string Dir, bool IsDefault);

/// <summary>
/// Bilgisayardaki Claude hesapları. Varsayılan hesap ~/.claude; ek hesaplar aynı üst klasörde ".claude-*" adlı ve içinde
/// giriş dosyası (.credentials.json) olan klasörlerdir (claude, CLAUDE_CONFIG_DIR=&lt;klasör&gt; ile başlatılıp giriş yapılmış).
/// macOS'ta ek hesabın girişi Anahtar Zinciri'nde durur, dosya olmaz: orada yalnız .claude.json'daki hesap kaydı aranır.
/// Liste 30 sn önbelleklenir (her /api/state çağrısında disk taranmaz).
/// </summary>
public static class Accounts
{
    static readonly TimeSpan CacheFor = TimeSpan.FromSeconds(30);
    static readonly object Lock = new();
    static IReadOnlyList<Account>? _cache;
    static DateTime _cachedAt;

    public static IReadOnlyList<Account> List()
    {
        lock (Lock)
        {
            if (_cache is not null && DateTime.UtcNow - _cachedAt < CacheFor) return _cache;
            _cache = Scan();
            _cachedAt = DateTime.UtcNow;
            return _cache;
        }
    }

    public static Account? Find(string? id) => id is null ? null : List().FirstOrDefault(a => a.Id.Equals(id, StringComparison.OrdinalIgnoreCase));

    static List<Account> Scan()
    {
        var def = Quota.ClaudeDir.TrimEnd('\\', '/');
        var list = new List<Account> { new(Path.GetFileName(def), LabelOf(def, isDefault: true), def, true) };
        var parent = Path.GetDirectoryName(def);
        if (parent is null || !Directory.Exists(parent)) return list;
        try
        {
            foreach (var dir in Directory.EnumerateDirectories(parent, Path.GetFileName(def) + "-*").Order(StringComparer.OrdinalIgnoreCase))
            {
                if (!File.Exists(Path.Combine(dir, ".credentials.json")) && !(OperatingSystem.IsMacOS() && HasAccount(dir))) continue;
                list.Add(new(Path.GetFileName(dir), LabelOf(dir, isDefault: false), dir, false));
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        return list;
    }

    /// <summary>
    /// Hesabın kayıt dosyası: varsayılan hesapta ~/.claude.json (klasörün yanında), ek hesapta klasörün içinde.
    /// Testte varsayılan klasör değiştirilmişse onun içindeki dosya da denenir.
    /// </summary>
    static JsonNode? OauthAccount(string dir, bool isDefault)
    {
        var files = isDefault
            ? new[] { Path.Combine(dir, ".claude.json"), Path.Combine(Path.GetDirectoryName(dir) ?? dir, ".claude.json") }
            : new[] { Path.Combine(dir, ".claude.json") };
        foreach (var f in files)
        {
            try
            {
                if (File.Exists(f) && JsonNode.Parse(File.ReadAllText(f))?["oauthAccount"] is JsonObject o) return o;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { }
        }
        return null;
    }

    static bool HasAccount(string dir) => OauthAccount(dir, false) is not null;

    /// <summary>
    /// Kurumsal hesapta kuruluş adı; kişisel hesapta null. Claude kişisel abonelikte kuruluşa "&lt;e-posta&gt;'s Organization"
    /// adını verir: bu ad e-posta içerdiği için arayüze taşınmaz.
    /// </summary>
    static string? LabelOf(string dir, bool isDefault)
    {
        var org = OauthAccount(dir, isDefault)?["organizationName"] is JsonValue v && v.TryGetValue<string>(out var s) ? s.Trim() : null;
        if (string.IsNullOrEmpty(org) || org.EndsWith("'s Organization", StringComparison.OrdinalIgnoreCase) || org.Contains('@')) return null;
        return org;
    }
}

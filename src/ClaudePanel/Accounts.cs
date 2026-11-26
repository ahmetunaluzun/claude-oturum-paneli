using System.Text.Json;
using System.Text.Json.Nodes;

namespace ClaudePanel;

/// <summary>Bir Claude hesabı: kendi ayar klasörü (CLAUDE_CONFIG_DIR) ve girişiyle.</summary>
/// <param name="Id">Klasör adı (".claude", ".claude-is"); arayüz ve ayarlar bununla anar.</param>
/// <param name="Label">Görünen ad: kullanıcının Ayarlar → Hesaplar'da verdiği ad; yoksa kurumsal hesapta kuruluş adı, kişisel
/// hesapta null (arayüz "Kişisel" yazar).</param>
/// <param name="OrgLabel">Claude'daki kuruluş adı (kullanıcı adı yokken görünecek ad); düzenleme kutusunda öneri olarak.</param>
/// <param name="Custom">Ad kullanıcı tarafından verildi mi.</param>
public sealed record Account(string Id, string? Label, string Dir, bool IsDefault, string? OrgLabel = null, bool Custom = false);

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

    /// <summary>
    /// Durum satırında gösterilecek hesap adı (panel kartındaki rozetle aynı: kuruluş adı, varsayılan hesapta "Kişisel",
    /// öteki ek hesapta klasör adı). Tek hesap varsa null: ad kalabalık yapmasın.
    /// </summary>
    public static string? NameOf(string dir, bool tr)
    {
        var list = List();
        if (list.Count < 2) return null;
        var cmp = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        var full = Path.GetFullPath(dir).TrimEnd('\\', '/');
        var a = list.FirstOrDefault(x => string.Equals(Path.GetFullPath(x.Dir).TrimEnd('\\', '/'), full, cmp));
        if (a is null) return null;
        if (!string.IsNullOrEmpty(a.Label)) return a.Label;
        if (a.IsDefault) return tr ? "Kişisel" : "Personal";
        var id = a.Id.StartsWith(".claude-") ? a.Id[".claude-".Length..] : a.Id;
        return id.Length > 0 ? id : a.Id;
    }

    public const int MaxNameLength = 40;

    /// <summary>
    /// Kullanıcının verdiği görünen ad; boş ya da yalnız boşluk = kaldır (Claude'daki ada dönülür). Denetim: en çok
    /// <see cref="MaxNameLength"/> karakter, kontrol karakteri yok. Hesap yoksa ya da ad geçersizse false.
    /// </summary>
    public static bool Rename(string id, string? name)
    {
        if (Find(id) is not { } a) return false;
        var n = (name ?? "").Trim();
        if (n.Length > MaxNameLength || n.Any(char.IsControl)) return false;
        HubSettings.Update(s =>
        {
            var d = new Dictionary<string, string>(s.AccountNames ?? [], StringComparer.OrdinalIgnoreCase);
            if (n.Length == 0) d.Remove(a.Id); else d[a.Id] = n;
            return s with { AccountNames = d.Count == 0 ? null : d };
        });
        lock (Lock) _cache = null; // yeni ad hemen görünsün
        RemoteLog.Info(n.Length == 0 ? $"Hesap adı kaldırıldı: {a.Id}" : $"Hesap adı değişti: {a.Id} → {n}");
        return true;
    }

    public static Account? Find(string? id) => id is null ? null : List().FirstOrDefault(a => a.Id.Equals(id, StringComparison.OrdinalIgnoreCase));

    static List<Account> Scan()
    {
        var def = Quota.ClaudeDir.TrimEnd('\\', '/');
        var names = HubSettings.Get().AccountNames;
        Account Make(string dir, bool isDefault)
        {
            var id = Path.GetFileName(dir);
            var org = LabelOf(dir, isDefault);
            var custom = names is not null && names.TryGetValue(id, out var n) && !string.IsNullOrWhiteSpace(n) ? n : null;
            return new(id, custom ?? org, dir, isDefault, org, custom is not null);
        }
        var list = new List<Account> { Make(def, true) };
        var parent = Path.GetDirectoryName(def);
        if (parent is null || !Directory.Exists(parent)) return list;
        try
        {
            foreach (var dir in Directory.EnumerateDirectories(parent, Path.GetFileName(def) + "-*").Order(StringComparer.OrdinalIgnoreCase))
            {
                if (!File.Exists(Path.Combine(dir, ".credentials.json")) && !(OperatingSystem.IsMacOS() && HasAccount(dir))) continue;
                list.Add(Make(dir, false));
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

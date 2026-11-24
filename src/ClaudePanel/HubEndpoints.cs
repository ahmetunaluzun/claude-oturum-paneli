namespace ClaudePanel;

/// <summary>
/// Ayarlar sekmesinin "Hesaplar" bölümü: /api/hub. Claude hesapları (Accounts.cs) kotaları ve varsayılan projeleriyle
/// (ProjectAccounts.cs). Tek hesap varken de liste döner (/api/state'teki "accounts" tek hesapta null'dır).
/// </summary>
public static class HubEndpoints
{
    public static void MapHub(this WebApplication app, Func<HttpContext, bool> authorized, Func<HttpContext, bool> isLocal)
    {
        app.MapGet("/api/hub", (HttpContext ctx, SessionStore store, NightMode night) => Results.Json(new
        {
            accounts = AccountCards(store, night)
        }));
    }

    static object AccountCards(SessionStore store, NightMode night)
    {
        var byAccount = ProjectAccounts.All().GroupBy(p => p.Value, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.Select(p => RealCase(p.Key)).Order(StringComparer.OrdinalIgnoreCase).ToList(), StringComparer.OrdinalIgnoreCase);
        return Accounts.List().Select(a => new
        {
            id = a.Id, label = a.Label, isDefault = a.IsDefault,
            usage = a.IsDefault ? store.Usage(night.RefreshUsageSoon) : store.Usage(a.Dir, () => night.RefreshUsageSoon(a.Dir)),
            // Varsayılan hesapta kayıt tutulmaz: kaydı olmayan her proje onundur.
            projects = a.IsDefault ? [] : byAccount.GetValueOrDefault(a.Id) ?? []
        }).ToList();
    }

    /// <summary>
    /// Proje kayıtları küçük harfle saklanır; gösterim için son klasör adının diskteki yazımı alınır (klasör yoksa kayıttaki hali).
    /// </summary>
    static string RealCase(string path)
    {
        try
        {
            var parent = Path.GetDirectoryName(path);
            var name = Path.GetFileName(path);
            if (parent is null || name.Length == 0 || !Directory.Exists(parent)) return path;
            return Directory.EnumerateDirectories(parent, name).FirstOrDefault() ?? path;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) { return path; }
    }
}

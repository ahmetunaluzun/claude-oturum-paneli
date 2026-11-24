namespace ClaudePanel;

public sealed record HubKeyRequest(string? Provider, string? Key);
public sealed record HubProfileRequest(string? Dir);

/// <summary>
/// Ayarlar sekmesinin "Hesaplar" bölümü: /api/hub. Claude hesapları (Accounts.cs) kotaları ve varsayılan projeleriyle
/// (ProjectAccounts.cs); tek hesap varken de liste döner (/api/state'teki "accounts" tek hesapta null'dır).
/// Dış servis anahtarları (ApiKeys.cs): durum herkese, bağlama/kaldırma/sayfa açma yalnız bilgisayardan (telefondan 403).
/// Hiçbir yanıtta anahtarın kendisi yoktur.
/// </summary>
public static class HubEndpoints
{
    public static void MapHub(this WebApplication app, Func<HttpContext, bool> authorized, Func<HttpContext, bool> isLocal)
    {
        bool Admin(HttpContext ctx) => isLocal(ctx) && authorized(ctx);

        app.MapGet("/api/hub", (HttpContext ctx, SessionStore store, NightMode night, MailSettings mail) => Results.Json(new
        {
            accounts = AccountCards(store, night),
            keys = KeyCards(),
            // Chrome profil adları ve e-postaları yalnız bilgisayardaki arayüze gider.
            chrome = isLocal(ctx) ? ChromeCard(mail) : null
        }));

        // Anahtar sayfasını seçili Chrome profilinde açar. Panel anahtar oluşturmaz.
        app.MapPost("/api/hub/key/open", async (HttpContext ctx, MailSettings mail) =>
        {
            if (!Admin(ctx)) return Results.StatusCode(403);
            if (ApiKeys.Find((await ctx.Request.ReadFromJsonAsync<HubKeyRequest>())?.Provider) is not { } p) return Results.BadRequest();
            var opened = ChromeProfiles.Open(p.KeyPage, SelectedProfile(mail));
            return Results.Json(new { opened, url = p.KeyPage });
        });

        // Dene ve kaydet: geçmezse neden ("badkey" | "noperm" | "nobalance" | "network" | "http" | "store"), eski anahtar yerinde kalır.
        app.MapPost("/api/hub/key/save", async (HttpContext ctx) =>
        {
            if (!Admin(ctx)) return Results.StatusCode(403);
            var req = await ctx.Request.ReadFromJsonAsync<HubKeyRequest>();
            if (ApiKeys.Find(req?.Provider) is not { } p) return Results.BadRequest();
            return KeyResult(await ApiKeys.TestAndSave(p, req!.Key));
        });

        // Kayıtlı anahtarı yeniden dener (kalan karakter/limit yenilenir).
        app.MapPost("/api/hub/key/check", async (HttpContext ctx) =>
        {
            if (!Admin(ctx)) return Results.StatusCode(403);
            if (ApiKeys.Find((await ctx.Request.ReadFromJsonAsync<HubKeyRequest>())?.Provider) is not { } p) return Results.BadRequest();
            return KeyResult(await ApiKeys.Recheck(p));
        });

        app.MapPost("/api/hub/key/remove", async (HttpContext ctx) =>
        {
            if (!Admin(ctx)) return Results.StatusCode(403);
            if (ApiKeys.Find((await ctx.Request.ReadFromJsonAsync<HubKeyRequest>())?.Provider) is not { } p) return Results.BadRequest();
            ApiKeys.Remove(p);
            return Results.Json(new { keys = KeyCards() });
        });

        // Anahtar sayfalarının açılacağı Chrome profili ("" = varsayılan tarayıcı).
        app.MapPost("/api/hub/chrome-profile", async (HttpContext ctx, MailSettings mail) =>
        {
            if (!Admin(ctx)) return Results.StatusCode(403);
            var dir = (await ctx.Request.ReadFromJsonAsync<HubProfileRequest>())?.Dir;
            if (dir is null || (dir.Length > 0 && ChromeProfiles.List().All(p => p.Dir != dir))) return Results.BadRequest();
            HubSettings.Update(s => s with { ChromeProfile = dir });
            return Results.Json(ChromeCard(mail));
        });
    }

    static IResult KeyResult(ApiKeys.Result r) => r.Error is null
        ? Results.Json(new { keys = KeyCards() })
        : Results.Json(new { error = r.Error, status = r.Status }, statusCode: 400);

    static object KeyCards()
    {
        var status = ApiKeys.Status();
        return ApiKeys.Providers.Select(p =>
        {
            var i = status.GetValueOrDefault(p.Id);
            return new
            {
                id = p.Id, name = p.Name, connected = i is not null, last4 = i?.Last4, at = i?.At,
                remaining = i?.Remaining, limit = i?.Limit, tier = i?.Tier, balance = i?.Balance, noLimit = i?.NoLimit, models = i?.Models
            };
        }).ToList();
    }

    /// <summary>
    /// Seçili profil: kullanıcı seçtiyse o; seçmediyse panelde bağlı Gmail hesabının (Mail ve takvim) Chrome profili;
    /// o da yoksa varsayılan tarayıcı (null).
    /// </summary>
    static string? SelectedProfile(MailSettings mail)
    {
        var profiles = ChromeProfiles.List();
        if (HubSettings.Get().ChromeProfile is { } chosen) return chosen.Length > 0 && profiles.Any(p => p.Dir == chosen) ? chosen : null;
        var emails = mail.Accounts.Select(a => a.Email).ToHashSet(StringComparer.OrdinalIgnoreCase);
        return profiles.FirstOrDefault(p => p.Email is not null && emails.Contains(p.Email))?.Dir;
    }

    static object ChromeCard(MailSettings mail) => new
    {
        profiles = ChromeProfiles.List().Select(p => new { dir = p.Dir, name = p.Name, email = p.Email }),
        selected = SelectedProfile(mail) ?? ""
    };

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

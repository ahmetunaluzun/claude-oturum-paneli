namespace ClaudePanel;

public sealed record HubKeyRequest(string? Provider, string? Key);
public sealed record HubProfileRequest(string? Dir);
public sealed record HubWorkerRequest(string? Id, bool? Enabled);
public sealed record HubRouteRequest(string? Job, List<string>? Order);
public sealed record HubAccountRequest(string? Id, string? Name, string? Project);

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

        // ---- Claude hesabını düzenleme: görünen ad (boş = Claude'daki ad), hesaba kayıtlı projeyi çıkarma ----
        app.MapPost("/api/hub/account/name", async (HttpContext ctx, SessionStore store, NightMode night) =>
        {
            if (!authorized(ctx)) return Results.StatusCode(403);
            var req = await ctx.Request.ReadFromJsonAsync<HubAccountRequest>();
            if (req?.Id is not { } id || Accounts.Find(id) is null) return Results.NotFound();
            if (!Accounts.Rename(id, req.Name)) return Results.Json(new { error = "name" }, statusCode: 400);
            return Results.Json(new { accounts = AccountCards(store, night) });
        });

        app.MapPost("/api/hub/account/project-remove", async (HttpContext ctx, SessionStore store, NightMode night) =>
        {
            if (!authorized(ctx)) return Results.StatusCode(403);
            var req = await ctx.Request.ReadFromJsonAsync<HubAccountRequest>();
            if (req?.Id is not { } id || req.Project is not { Length: > 0 } p) return Results.BadRequest();
            if (!ProjectAccounts.Remove(id, p)) return Results.NotFound();
            return Results.Json(new { accounts = AccountCards(store, night) });
        });

        // ---- Yapay zekâ işçileri (Workers.cs) ve iş yönlendirme (Routing.cs) ----
        app.MapGet("/api/workers", () => Results.Json(WorkerCards()));

        app.MapPost("/api/workers", async (HttpContext ctx) =>
        {
            if (!authorized(ctx)) return Results.StatusCode(403);
            var req = await ctx.Request.ReadFromJsonAsync<HubWorkerRequest>();
            if (req?.Id is not { } id || !Workers.Ids.Contains(id) || req.Enabled is not { } on) return Results.BadRequest();
            Workers.Set(id, on);
            return Results.Json(WorkerCards());
        });

        // Antigravity CLI'yi (agy) hemen yeniden dener (kurulumdan sonra); en çok zaman aşımı kadar sürer.
        app.MapPost("/api/workers/gemini/check", async (HttpContext ctx) =>
        {
            if (!authorized(ctx)) return Results.StatusCode(403);
            await Workers.RecheckGemini();
            return Results.Json(WorkerCards());
        });

        // project: oturumun klasörü; şirket işiyse kişisel araçlar (Gemini, Higgsfield) atlanır.
        app.MapGet("/api/routing", (string? project) => Results.Json(Routing.Snapshot(project)));

        app.MapPost("/api/routing", async (HttpContext ctx) =>
        {
            if (!authorized(ctx)) return Results.StatusCode(403);
            var req = await ctx.Request.ReadFromJsonAsync<HubRouteRequest>();
            if (Routing.Find(req?.Job) is not { } job || !Routing.SetOrder(job, req!.Order)) return Results.BadRequest();
            return Results.Json(Routing.Snapshot(null));
        });

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
            if (dir is null || (dir is not ("" or DefaultBrowser) && ChromeProfiles.List().All(p => p.Dir != dir))) return Results.BadRequest();
            HubSettings.Update(s => s with { ChromeProfile = dir.Length == 0 ? null : dir });
            return Results.Json(ChromeCard(mail));
        });
    }

    static object WorkerCards()
    {
        var (plan, version) = CodexEndpoints.Info();
        var g = Workers.Gemini();
        return new
        {
            codex = new { enabled = Workers.Enabled("codex"), installed = CodexSessions.Installed, plan, version },
            gemini = new { enabled = Workers.Enabled("gemini"), state = g.State, version = g.Version, apiKey = ApiKeys.Has("gemini") }
        };
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

    /// <summary>Ayarlarda açıkça "Varsayılan tarayıcı" seçimi (hub.json ChromeProfile).</summary>
    const string DefaultBrowser = "-";

    /// <summary>
    /// Seçili profil: kullanıcı elle seçtiyse o ("-" = varsayılan tarayıcı → null); seçmediyse otomatik (AutoProfile).
    /// </summary>
    static string? SelectedProfile(MailSettings mail)
    {
        if (HubSettings.Get().ChromeProfile is { Length: > 0 } chosen)
            return chosen != DefaultBrowser && ChromeProfiles.List().Any(p => p.Dir == chosen) ? chosen : null;
        return AutoProfile(mail);
    }

    /// <summary>
    /// Otomatik profil (kullanıcı 2026-11-26: "ilgili oturuma göre kendisi otomatik davranması lazım"): anahtar sayfaları kişisel
    /// servislerdir (Gemini, OpenRouter, ElevenLabs; şirket verisi bu servislere gitmez), bu yüzden kişisel Claude hesabının
    /// (kuruluş adı olmayan; yoksa varsayılan hesap) giriş e-postasıyla oturum açılmış Chrome profili seçilir. Profil klasörü
    /// ("Profile 1") kuruluma özeldir, e-postadan bulunur. Eşleşme yoksa panelde bağlı Gmail hesabının profili, o da yoksa
    /// varsayılan tarayıcı (null).
    /// </summary>
    static string? AutoProfile(MailSettings mail)
    {
        var profiles = ChromeProfiles.List().Where(p => p.Email is not null).ToList();
        var accts = Accounts.List();
        var personal = accts.FirstOrDefault(a => a.OrgLabel is null) ?? accts.FirstOrDefault();
        if (personal is not null && Accounts.Email(personal) is { } email
            && profiles.FirstOrDefault(p => p.Email!.Equals(email, StringComparison.OrdinalIgnoreCase)) is { } byAccount)
            return byAccount.Dir;
        var emails = mail.Accounts.Select(a => a.Email).ToHashSet(StringComparer.OrdinalIgnoreCase);
        return profiles.FirstOrDefault(p => emails.Contains(p.Email!))?.Dir;
    }

    static object ChromeCard(MailSettings mail)
    {
        var chosen = HubSettings.Get().ChromeProfile;
        var list = ChromeProfiles.List();
        return new
        {
            profiles = list.Select(p => new { dir = p.Dir, name = p.Name, email = p.Email }),
            // "" = otomatik, "-" = varsayılan tarayıcı, ya da elle seçilen profil klasörü
            selected = chosen is { Length: > 0 } c && (c == DefaultBrowser || list.Any(p => p.Dir == c)) ? c : "",
            auto = AutoProfile(mail) ?? ""
        };
    }

    static object AccountCards(SessionStore store, NightMode night)
    {
        var byAccount = ProjectAccounts.All().GroupBy(p => p.Value, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.Select(p => RealCase(p.Key)).Order(StringComparer.OrdinalIgnoreCase).ToList(), StringComparer.OrdinalIgnoreCase);
        return Accounts.List().Select(a => new
        {
            id = a.Id, label = a.Label, isDefault = a.IsDefault, orgLabel = a.OrgLabel, custom = a.Custom,
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

namespace ClaudePanel;

public sealed record MailClientRequest(string? Json);
public sealed record MailAddRequest(bool? Mail, bool? Cal, string? Id);
public sealed record MailImapRequest(string? Email, string? Password, string? Ical);
public sealed record MailOpenRequest(string? Target, string? Email);
public sealed record MailAccountRequest(string? Id, bool? Mail, bool? Cal);
public sealed record MailAliasRequest(string? Id, string[]? Aliases);
public sealed record MailFilterRequest(bool? Direct, bool? Cc, bool? Awaiting, string[]? Senders, string[]? Keywords, string[]? Labels);

/// <summary>
/// Mail ve takvim uçları. Okuma (GET /api/mail, Takip'teki mail/takvim satırları) telefondan da açık; hesap ekleme, istemci
/// dosyası, kaynak açma/kapama ve kaldırma YALNIZ bilgisayardan (telefondan 403; yollar ayrıca Remote.Blocked listesinde).
/// Süzgeç (Ayarlar) telefondan da değiştirilebilir: yerel kural, izin ya da belirteç gerektirmez.
///   GET  /api/mail                   → istemci var mı, hesaplar, süzgeç, süren giriş
///   POST /api/mail/client            → istemci JSON'u (içerik doğrulanır, şifreli saklanır; içerik loga/yanıta yazılmaz)
///   POST /api/mail/imap/add          → Gmail/Workspace hesabı: e-posta + uygulama şifresi (IMAP girişi denenir) + isteğe bağlı iCal adresi (okunup doğrulanır).
///                                      Parola boşsa ve hesap varsa yalnız iCal adresi güncellenir. Gizli değerler şifreli saklanır; yanıta/loga yazılmaz.
///   POST /api/mail/accounts/add      → Google girişi başlatır (yeni hesap ya da Id ile var olan hesaba kaynak ekleme)
///   POST /api/mail/accounts/cancel   → süren girişi iptal eder
///   POST /api/mail/accounts/sources  → kaynak kapatma (açma izin istiyorsa 409 "needauth": istemci girişi başlatır)
///   POST /api/mail/accounts/remove   → hesabı ve belirtecini siler
///   POST /api/mail/accounts/aliases  → hesap başına "benim adreslerim / gruplarım" (tam adres listesi)
///   POST /api/mail/filter            → süzgeç
///   POST /api/mail/refresh           → şimdi denetle
/// </summary>
public static class MailEndpoints
{
    public static void MapMail(this WebApplication app, Func<HttpContext, bool> authorized, Func<HttpContext, bool> isLocal)
    {
        bool Admin(HttpContext ctx) => isLocal(ctx) && authorized(ctx);

        app.MapGet("/api/mail", (MailSettings s, MailLogin login, MailWatch watch) => Results.Json(Brief(s, login, watch)));

        app.MapPost("/api/mail/client", async (HttpContext ctx, MailSettings s, MailLogin login, MailWatch watch) =>
        {
            if (!Admin(ctx)) return Results.StatusCode(403);
            var req = await ctx.Request.ReadFromJsonAsync<MailClientRequest>();
            var (client, error) = MailSettings.ParseClient(req?.Json);
            if (client is null) return Results.Json(new { error = "client_" + error }, statusCode: 400);
            if (!s.SaveClient(client)) return Results.Json(new { error = "client_store" }, statusCode: 500);
            watch.Poke();
            return Results.Json(Brief(s, login, watch));
        });

        app.MapPost("/api/mail/imap/add", async (HttpContext ctx, MailSettings s, MailLogin login, MailWatch watch, ILogger<MailSettings> log) =>
        {
            if (!Admin(ctx)) return Results.StatusCode(403);
            var req = await ctx.Request.ReadFromJsonAsync<MailImapRequest>();
            var email = MailRules.Addresses(req?.Email).FirstOrDefault();
            if (email is null || email.Length > 254 || !email.Any(c => c == '@') || (req?.Email ?? "").Trim().Length != email.Length || email.Any(c => c > 126 || char.IsControl(c)))
                return Results.Json(new { error = "imap_email" }, statusCode: 400);
            var existing = s.Accounts.FirstOrDefault(a => a.Provider == "imap" && string.Equals(a.Email, email, StringComparison.OrdinalIgnoreCase));
            var pass = new string((req?.Password ?? "").Where(c => !char.IsWhiteSpace(c)).ToArray());
            var ical = (req?.Ical ?? "").Trim();
            if (pass.Length == 0 && existing is null) return Results.Json(new { error = "imap_format" }, statusCode: 400);
            if (pass.Length > 0 && !(pass.Length == 16 && pass.All(char.IsAsciiLetter))) return Results.Json(new { error = "imap_format" }, statusCode: 400);
            if (ical.Length > 0 && !IcalProvider.ValidUrl(ical)) return Results.Json(new { error = "ical_invalid" }, statusCode: 400);
            if (existing is null && s.Full) return Results.Json(new { error = "mail_full" }, statusCode: 400);
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(40));
            int? unseen = null, eventCount = null;
            if (pass.Length > 0)
            {
                try { unseen = await ImapProvider.Check(email, pass, cts.Token); }
                catch (ImapException ex)
                {
                    log.LogInformation("IMAP girişi denendi, olmadı ({Kind})", ex.Kind);
                    return Results.Json(new { error = "imap_" + (ex.Kind is "auth" or "disabled" or "domain" or "tls" ? ex.Kind : "net") }, statusCode: 400);
                }
            }
            if (ical.Length > 0)
            {
                try { eventCount = (await IcalProvider.Events(ical, cts.Token)).Count; }
                catch (IcalException ex)
                {
                    log.LogInformation("iCal adresi denendi, olmadı ({Kind})", ex.Kind);
                    return Results.Json(new { error = "ical_" + (ex.Kind is "denied" or "parse" ? ex.Kind : "net") }, statusCode: 400);
                }
            }
            var id = s.UpsertImap(email, ical.Length > 0);
            if ((pass.Length > 0 && !TokenStore.Save(MailSettings.TokenName(id), pass)) || (ical.Length > 0 && !TokenStore.Save(MailSettings.IcalName(id), ical)))
            {
                if (existing is null) { s.Remove(id); watch.Forget(id); }
                return Results.Json(new { error = "imap_store" }, statusCode: 500);
            }
            log.LogInformation("Gmail IMAP hesabı eklendi/güncellendi (parola {P}, takvim adresi {C}); gizli değerler şifreli saklandı", pass.Length > 0 ? "yeni" : "aynı", ical.Length > 0 ? "var" : "yok");
            watch.Poke();
            return Results.Json(Brief(s, login, watch, unseen, eventCount));
        });

        // Alan adı Google mı (gmail.com ya da MX'i Google)? "google" | "other" | "unknown" (denetlenemedi: kullanıcı yine de deneyebilir).
        app.MapPost("/api/mail/imap/provider", async (HttpContext ctx) =>
        {
            if (!Admin(ctx)) return Results.StatusCode(403);
            var req = await ctx.Request.ReadFromJsonAsync<MailImapRequest>();
            if (MailRules.Addresses(req?.Email).FirstOrDefault() is not { } addr) return Results.Json(new { error = "imap_email" }, statusCode: 400);
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            return Results.Json(new { provider = await MailDomain.Provider(addr, cts.Token) });
        });

        // Google'ın sabit sayfalarını varsayılan tarayıcıda açar. Yalnız bu üç adres; istemciden adres alınmaz (hedef adı + e-posta).
        app.MapPost("/api/mail/open", async (HttpContext ctx) =>
        {
            if (!Admin(ctx)) return Results.StatusCode(403);
            var req = await ctx.Request.ReadFromJsonAsync<MailOpenRequest>();
            if (MailRules.Addresses(req?.Email).FirstOrDefault() is not { } addr || addr.Length > 254 || addr.Any(c => c > 126 || char.IsControl(c)))
                return Results.Json(new { error = "imap_email" }, statusCode: 400);
            var q = "?authuser=" + Uri.EscapeDataString(addr);
            var url = req?.Target switch
            {
                "apppasswords" => "https://myaccount.google.com/apppasswords" + q,
                "twosv" => "https://myaccount.google.com/signinoptions/twosv" + q,
                "calendar" => "https://calendar.google.com/calendar/r/settings" + q,
                _ => null
            };
            if (url is null) return Results.BadRequest();
            // Test: CLAUDE_PANEL_MAIL_OPEN_LOG dosyaya yazar (tarayıcı açılmaz); CLAUDE_PANEL_MAIL_NO_BROWSER=1 hiçbir şey yapmaz.
            if (Environment.GetEnvironmentVariable("CLAUDE_PANEL_MAIL_OPEN_LOG") is { Length: > 0 } logFile)
                await File.AppendAllTextAsync(logFile, url + "\n");
            else if (Environment.GetEnvironmentVariable("CLAUDE_PANEL_MAIL_NO_BROWSER") != "1")
            {
                try { TokenStore.OpenBrowser(url); }
                catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException) { return Results.Json(new { url, opened = false }); }
            }
            return Results.Json(new { url, opened = true });
        });

        app.MapPost("/api/mail/accounts/add", async (HttpContext ctx, MailSettings s, MailLogin login, MailWatch watch) =>
        {
            if (!Admin(ctx)) return Results.StatusCode(403);
            var req = await ctx.Request.ReadFromJsonAsync<MailAddRequest>();
            string? hint = null;
            if (req?.Id is { } id)
            {
                if (s.Find(id) is not { } a) return Results.Json(new { error = "noaccount" }, statusCode: 404);
                hint = a.Email;
            }
            var (url, error) = login.Start(req?.Mail == true, req?.Cal == true, hint);
            if (url is null) return Results.Json(new { error = "mail_" + error }, statusCode: error == "listen" ? 500 : 400);
            return Results.Json(new { url, state = Brief(s, login, watch) });
        });

        app.MapPost("/api/mail/accounts/cancel", (HttpContext ctx, MailSettings s, MailLogin login, MailWatch watch) =>
        {
            if (!Admin(ctx)) return Results.StatusCode(403);
            login.Cancel();
            return Results.Json(Brief(s, login, watch));
        });

        app.MapPost("/api/mail/accounts/sources", async (HttpContext ctx, MailSettings s, MailLogin login, MailWatch watch) =>
        {
            if (!Admin(ctx)) return Results.StatusCode(403);
            var req = await ctx.Request.ReadFromJsonAsync<MailAccountRequest>();
            if (s.Find(req?.Id) is not { } a || req!.Mail is not { } mail || req.Cal is not { } cal) return Results.BadRequest();
            // İzni olmayan kaynağı açmak giriş ister (kurulu uygulamada kademeli izin yok: açık kaynakların tamamı yeniden istenir).
            if ((mail && !a.MailGranted) || (cal && !a.CalGranted)) return Results.Json(new { error = "needauth" }, statusCode: 409);
            s.SetSources(a.Id, mail, cal);
            watch.Poke();
            return Results.Json(Brief(s, login, watch));
        });

        app.MapPost("/api/mail/accounts/remove", async (HttpContext ctx, MailSettings s, MailLogin login, MailWatch watch) =>
        {
            if (!Admin(ctx)) return Results.StatusCode(403);
            var req = await ctx.Request.ReadFromJsonAsync<MailAccountRequest>();
            if (req?.Id is not { } id || s.Remove(id) is null) return Results.Json(new { error = "noaccount" }, statusCode: 404);
            watch.Forget(id);
            return Results.Json(Brief(s, login, watch));
        });

        app.MapPost("/api/mail/filter", async (HttpContext ctx, MailSettings s, MailLogin login, MailWatch watch) =>
        {
            if (!authorized(ctx)) return Results.StatusCode(403);
            var req = await ctx.Request.ReadFromJsonAsync<MailFilterRequest>();
            if (req is null) return Results.BadRequest();
            var f = s.Filter;
            s.SetFilter(new MailFilter(req.Direct ?? f.Direct, req.Cc ?? f.Cc, req.Awaiting ?? f.Awaiting,
                req.Senders?.ToList() ?? f.Senders, req.Keywords?.ToList() ?? f.Keywords, req.Labels?.ToList() ?? f.Labels));
            return Results.Json(Brief(s, login, watch));
        });

        // "Benim adreslerim / gruplarım": yerel kural (süzgeç gibi telefondan da değiştirilebilir). Kayıttan sonra hemen yeniden taranır
        // (Kime/CC eşleşmesi tarama sırasında hesaplanır).
        app.MapPost("/api/mail/accounts/aliases", async (HttpContext ctx, MailSettings s, MailLogin login, MailWatch watch) =>
        {
            if (!authorized(ctx)) return Results.StatusCode(403);
            var req = await ctx.Request.ReadFromJsonAsync<MailAliasRequest>();
            if (req?.Id is not { } id || s.Find(id) is null) return Results.Json(new { error = "noaccount" }, statusCode: 404);
            var before = s.Find(id)!.Aliases ?? [];
            var now = s.SetAliases(id, req.Aliases) ?? [];
            if (!before.SequenceEqual(now)) watch.Poke();
            return Results.Json(Brief(s, login, watch));
        });

        app.MapPost("/api/mail/refresh", (HttpContext ctx, MailWatch watch) =>
        {
            if (!authorized(ctx)) return Results.StatusCode(403);
            watch.Poke();
            return Results.StatusCode(202);
        });
    }

    /// <param name="unseen">Yalnız IMAP girişi denemesinde: gelen kutusundaki okunmamış sayısı (kanıt).</param>
    /// <param name="events">Yalnız iCal denemesinde: önümüzdeki 24 saatte bulunan etkinlik sayısı.</param>
    static object Brief(MailSettings s, MailLogin login, MailWatch watch, int? unseen = null, int? events = null)
    {
        var snap = watch.Snapshot();
        var f = s.Filter;
        return new
        {
            client = s.Client is not null,
            accounts = s.Accounts.Select(a => new
            {
                id = a.Id, email = a.Email, provider = a.Provider, mail = a.Mail, cal = a.Cal, mailGranted = a.MailGranted, calGranted = a.CalGranted,
                state = snap.Accounts.FirstOrDefault(x => x.Id == a.Id)?.State ?? "pending",
                aliases = a.Aliases ?? [],
                suggest = a.Provider == "imap" ? watch.Suggestions(a) : [],
                truncated = snap.Accounts.FirstOrDefault(x => x.Id == a.Id)?.Truncated ?? 0,
                awaitingOk = snap.Accounts.FirstOrDefault(x => x.Id == a.Id)?.AwaitingOk ?? true,
                gmailLink = snap.Accounts.FirstOrDefault(x => x.Id == a.Id)?.GmailLink ?? true,
                okAt = snap.Accounts.FirstOrDefault(x => x.Id == a.Id)?.OkAt ?? 0,
                triedAt = snap.Accounts.FirstOrDefault(x => x.Id == a.Id)?.TriedAt ?? 0
            }),
            filter = new { f.Direct, f.Cc, f.Awaiting, senders = f.Senders ?? [], keywords = f.Keywords ?? [], labels = f.Labels ?? [] },
            login = login.State,
            result = new { unseen, events }
        };
    }
}

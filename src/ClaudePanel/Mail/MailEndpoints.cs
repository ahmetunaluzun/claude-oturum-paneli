namespace ClaudePanel;

public sealed record MailClientRequest(string? Json);
public sealed record MailAddRequest(bool? Mail, bool? Cal, string? Id);
public sealed record MailAccountRequest(string? Id, bool? Mail, bool? Cal);
public sealed record MailFilterRequest(bool? Direct, bool? Cc, bool? Awaiting, string[]? Senders, string[]? Keywords, string[]? Labels);

/// <summary>
/// Mail ve takvim uçları. Okuma (GET /api/mail, Takip'teki mail/takvim satırları) telefondan da açık; hesap ekleme, istemci
/// dosyası, kaynak açma/kapama ve kaldırma YALNIZ bilgisayardan (telefondan 403; yollar ayrıca Remote.Blocked listesinde).
/// Süzgeç (Ayarlar) telefondan da değiştirilebilir: yerel kural, izin ya da belirteç gerektirmez.
///   GET  /api/mail                   → istemci var mı, hesaplar, süzgeç, süren giriş
///   POST /api/mail/client            → istemci JSON'u (içerik doğrulanır, şifreli saklanır; içerik loga/yanıta yazılmaz)
///   POST /api/mail/accounts/add      → Google girişi başlatır (yeni hesap ya da Id ile var olan hesaba kaynak ekleme)
///   POST /api/mail/accounts/cancel   → süren girişi iptal eder
///   POST /api/mail/accounts/sources  → kaynak kapatma (açma izin istiyorsa 409 "needauth": istemci girişi başlatır)
///   POST /api/mail/accounts/remove   → hesabı ve belirtecini siler
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

        app.MapPost("/api/mail/refresh", (HttpContext ctx, MailWatch watch) =>
        {
            if (!authorized(ctx)) return Results.StatusCode(403);
            watch.Poke();
            return Results.StatusCode(202);
        });
    }

    static object Brief(MailSettings s, MailLogin login, MailWatch watch)
    {
        var snap = watch.Snapshot();
        var f = s.Filter;
        return new
        {
            client = s.Client is not null,
            accounts = s.Accounts.Select(a => new
            {
                id = a.Id, email = a.Email, provider = a.Provider, mail = a.Mail, cal = a.Cal, mailGranted = a.MailGranted, calGranted = a.CalGranted,
                state = snap.Accounts.FirstOrDefault(x => x.Id == a.Id)?.State ?? "pending"
            }),
            filter = new { f.Direct, f.Cc, f.Awaiting, senders = f.Senders ?? [], keywords = f.Keywords ?? [], labels = f.Labels ?? [] },
            login = login.State
        };
    }
}

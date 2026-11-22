using System.Diagnostics;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ClaudePanel;

// Gece modu koruması: panelin başlattığı claude oturumları paneli hook olarak çağırır (NightGuard.cs).
if (args.Length > 0 && args[0] == NightGuard.Arg) Environment.Exit(NightGuard.RunHook());
// Aynı projede başka oturum çalışırken yazmayı bekleten hook (ProjectGuard.cs).
if (args.Length > 0 && args[0] == ProjectGuard.Arg) Environment.Exit(ProjectGuard.RunHook());
// Terminal durum satırı ve kota koruması (QuotaCli.cs): ~/.claude/settings.json'dan çağrılır.
if (args.Length > 0 && args[0] == QuotaCli.StatusLineArg) Environment.Exit(QuotaCli.RunStatusLine(args));
if (args.Length > 0 && args[0] == QuotaCli.GuardArg) Environment.Exit(QuotaCli.RunGuard(args));
if (args.Length > 0 && args[0] == CodexSessions.ScanArg) Environment.Exit(CodexSessions.RunScan(args));

Preload.All(); // güncelleme sırasında exe değişse de sonradan yüklenecek kitaplık kalmasın (Preload.cs)

const int DefaultPort = 8790;
var port = int.TryParse(Environment.GetEnvironmentVariable("CLAUDE_PANEL_PORT"), out var p) ? p : DefaultPort;
var baseUrl = $"http://127.0.0.1:{port}";

// Tek kopya: panel zaten açıksa yalnız pencereyi aç ve çık.
// Açık olan daha eski sürümse kullanıcıya sorulur; onaylarsa eski kapatılır ve bu sürüm açılır.
// Paneli yeniden başlat (Restart.cs): eski panel bu süreci başlattı; sormadan devral, olmazsa eski açık kalsın.
if (Restart.FromPid(args) is { } restartFrom)
{
    var rc = await Restart.TakeOver(baseUrl, port, restartFrom, args.Contains(Restart.ForceArg));
    if (rc != 0) Environment.Exit(rc);
}
else if (await PanelAlreadyRunning(baseUrl) && !await Handoff.TryReplaceOlder(baseUrl, port))
{
    Launcher.OpenAppWindow(baseUrl);
    return;
}

var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(24));
// Sunucunun bu açılışının kimliği: açık sayfa farklı bir değer görürse (yeni sürüm, yeniden başlatma) kendini yeniler.
var boot = Convert.ToHexString(RandomNumberGenerator.GetBytes(6));
int pickerOpen = 0; // Gözat penceresi açık mı (aynı anda tek pencere)
var builder = WebApplication.CreateSlimBuilder(args);
builder.WebHost.UseUrls(baseUrl); // yalnız bu bilgisayar; ağa açılmaz
builder.Logging.ClearProviders();
builder.Logging.AddDebug();
builder.Services.AddSingleton<SessionStore>();
builder.Services.AddSingleton<Transcripts>();
builder.Services.AddSingleton<ContextWindows>();
builder.Services.AddSingleton<HostedSessions>();
builder.Services.AddSingleton<Skills>();
builder.Services.AddSingleton<ProjectCost>();
builder.Services.AddSingleton<StartupLoad>();
builder.Services.AddSingleton<UpdateCheck>();
builder.Services.AddSingleton<ClaudeUpdater>();
builder.Services.AddSingleton<LoopScan>();
builder.Services.AddSingleton<ScheduledJobs>();
builder.Services.AddSingleton<GitHubWatch>();
builder.Services.AddSingleton<MailSettings>();
builder.Services.AddSingleton<MailLogin>();
builder.Services.AddSingleton<MailWatch>();
builder.Services.AddSingleton<FollowUp>();
builder.Services.AddSingleton<ProjectGuard>();
builder.Services.AddSingleton<FollowJobs>();
builder.Services.AddSingleton<NightMode>();
builder.Services.AddSingleton<PlannedJobs>();
builder.Services.AddSingleton<RemoteAccess>();
builder.Services.AddSingleton<Dictation>();
builder.Services.AddSingleton(sp => new Tray(baseUrl, sp.GetRequiredService<SessionStore>(),
    sp.GetRequiredService<HostedSessions>(), sp.GetRequiredService<IHostApplicationLifetime>(),
    sp.GetRequiredService<ILogger<Tray>>()));
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase);
var app = builder.Build();

var remote = app.Services.GetRequiredService<RemoteAccess>();

// DNS rebinding'e karşı: yalnız 127.0.0.1/localhost Host başlığı kabul edilir.
// Telefondan erişim açıksa bu makinenin Tailscale adı da kabul edilir; o addan gelen HER istek
// (okuma dahil) eşleştirilmiş cihaz çerezi ister. Bilgisayarı ekrana bağlayan işler telefondan yapılamaz.
app.Use(async (ctx, next) =>
{
    var host = ctx.Request.Host.Host;
    var isLocal = host is "127.0.0.1" or "localhost";
    if (!isLocal && !remote.HostAllowed(host))
    {
        ctx.Response.StatusCode = 403;
        return;
    }
    ctx.Response.Headers["X-Content-Type-Options"] = "nosniff";
    ctx.Response.Headers["Referrer-Policy"] = "no-referrer";
    ctx.Response.Headers["Content-Security-Policy"] =
        "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";
    if (!isLocal)
    {
        ctx.Items["remote"] = true;
        var path = ctx.Request.Path.Value ?? "/";
        if (!Remote.IsPublic(path))
        {
            var cookie = ctx.Request.Cookies[RemoteAccess.CookieName];
            if (remote.Validate(cookie) is null)
            {
                RemoteLog.Denied(string.IsNullOrEmpty(cookie) ? "çerez yok" : "tanınmayan çerez", path);
                if (HttpMethods.IsGet(ctx.Request.Method) && path == "/") ctx.Response.Redirect("/pair");
                else ctx.Response.StatusCode = 401;
                return;
            }
            // 0.9.1'den önce çerez Strict veriliyordu; ana ekrandaki uygulamadan açılışta gönderilmiyordu. Sayfa açılışında Lax ile yenilenir.
            if (HttpMethods.IsGet(ctx.Request.Method) && path == "/") ctx.Response.Cookies.Append(RemoteAccess.CookieName, cookie!, Remote.CookieOptions());
            if (Remote.IsBlocked(path))
            {
                ctx.Response.StatusCode = 403;
                return;
            }
        }
    }
    await next();
});

// Değişiklik yapan istekler: oturum anahtarı + aynı köken zorunlu (CSRF koruması).
bool Authorized(HttpContext ctx)
{
    var origin = ctx.Request.Headers.Origin.ToString();
    var remoteOrigin = ctx.Items.ContainsKey("remote") ? $"https://{ctx.Request.Host.Host}" : null;
    return ctx.Request.Headers["X-Panel-Token"] == token
           && (origin.Length == 0 || origin == baseUrl || origin == $"http://localhost:{port}" || origin == remoteOrigin);
}
bool IsLocal(HttpContext ctx) => !ctx.Items.ContainsKey("remote");

app.MapGet("/", (HttpContext ctx) => Results.Content(Web.Read("index.html")
    .Replace("{{TOKEN}}", token)
    .Replace("{{REMOTE}}", IsLocal(ctx) ? "0" : "1"), "text/html; charset=utf-8"));
app.MapGet("/manifest.webmanifest", () => Results.Text(Web.Read("manifest.webmanifest"), "application/manifest+json; charset=utf-8"));

// ---- Telefondan erişim ----
app.MapGet("/pair", () => Results.Content(Web.Read("pair.html"), "text/html; charset=utf-8"));
app.MapPost("/api/remote/claim", async (HttpContext ctx) =>
{
    // Yalnız telefon adresinden ve aynı kökenden; çerez yalnız HTTPS'te gönderilir.
    if (IsLocal(ctx) || ctx.Request.Headers.Origin.ToString() != $"https://{ctx.Request.Host.Host}") return Results.StatusCode(403);
    var req = await ctx.Request.ReadFromJsonAsync<ClaimRequest>();
    var result = remote.Claim(req?.Code?.Trim(), req?.Secret?.Trim(), req?.Name, out var deviceToken);
    if (result != RemoteAccess.ClaimResult.Ok)
        return Results.Json(new { error = result.ToString().ToLowerInvariant() }, statusCode: result == RemoteAccess.ClaimResult.Wrong ? 401 : 409);
    ctx.Response.Cookies.Append(RemoteAccess.CookieName, deviceToken, Remote.CookieOptions());
    return Results.Ok();
});
app.MapGet("/api/remote", (HttpContext ctx) => IsLocal(ctx) ? Results.Json(remote.Status()) : Results.StatusCode(403));
// Telefondaki Ayarlar: erişimin durumu ve eşleşmiş cihazlar, yalnız okuma (ekleme/kaldırma bilgisayardan).
app.MapGet("/api/remote/view", (HttpContext ctx) =>
    Results.Json(remote.View(IsLocal(ctx) ? null : remote.Validate(ctx.Request.Cookies[RemoteAccess.CookieName])?.Id)));
app.MapPost("/api/remote/enable", async (HttpContext ctx) =>
{
    if (!IsLocal(ctx) || !Authorized(ctx)) return Results.StatusCode(403);
    var req = await ctx.Request.ReadFromJsonAsync<EnableRequest>();
    var on = req?.Enabled == true;
    remote.SetEnabled(on);
    // Tailscale kuruluysa yönlendirmeyi de aç/kapat; hata panelde gösterilir.
    // Test adresi verilmişse (CLAUDE_PANEL_REMOTE_HOST) gerçek Tailscale ayarına dokunulmaz.
    var serve = Environment.GetEnvironmentVariable("CLAUDE_PANEL_REMOTE_HOST") is { Length: > 0 } ? (Ok: true, Message: "test", EnableUrl: (string?)null)
        : Tailscale.Find() is null ? (Ok: false, Message: "notfound", EnableUrl: null) : Tailscale.Serve(port, on);
    return Results.Json(new { status = remote.Status(), serveOk = serve.Ok, serveMessage = serve.Message, enableUrl = serve.EnableUrl });
});
app.MapPost("/api/remote/pair", (HttpContext ctx) =>
{
    if (!IsLocal(ctx) || !Authorized(ctx)) return Results.StatusCode(403);
    if (!remote.Enabled || remote.Host is not { } host) return Results.Json(new { error = "nohost" }, statusCode: 409);
    var (code, secret, expires) = remote.StartPairing();
    var url = $"https://{host}/pair#s={secret}"; // gizli değer adreste değil parçada: sunucu loglarına/yönlendiriciye gitmez
    return Results.Json(new { code, url, host, qr = Remote.QrSvg(url), expires = expires.ToUnixTimeMilliseconds() });
});
// Kurulum sihirbazı: Tailscale'i kur / giriş yap (yalnız bilgisayardan).
app.MapPost("/api/remote/install", (HttpContext ctx) =>
{
    if (!IsLocal(ctx) || !Authorized(ctx)) return Results.StatusCode(403);
    if (Tailscale.Find() is not null) return Results.Json(new { installed = true });
    var (started, url) = Tailscale.Install();
    return Results.Json(new { started, url });
});
app.MapPost("/api/remote/login", async (HttpContext ctx) =>
{
    if (!IsLocal(ctx) || !Authorized(ctx)) return Results.StatusCode(403);
    if (Tailscale.Find() is null) return Results.Json(new { error = "notfound" }, statusCode: 409);
    var url = await Task.Run(Tailscale.LoginUrl);
    return Results.Json(new { url });
});
app.MapPost("/api/remote/pair/cancel", (HttpContext ctx) =>
{
    if (!IsLocal(ctx) || !Authorized(ctx)) return Results.StatusCode(403);
    remote.CancelPairing();
    return Results.Ok();
});
app.MapPost("/api/remote/revoke/{id}", (string id, HttpContext ctx) =>
{
    if (!IsLocal(ctx) || !Authorized(ctx)) return Results.StatusCode(403);
    return remote.Revoke(id) ? Results.Json(remote.Status()) : Results.NotFound();
});
app.MapPost("/api/remote/forget", (HttpContext ctx) =>
{
    // Telefonda "bu cihazı unut": çerezi siler.
    RemoteLog.Info("Telefonda 'Bu cihazı unut' basıldı (çerez silindi)");
    ctx.Response.Cookies.Delete(RemoteAccess.CookieName, new CookieOptions { Secure = true, SameSite = SameSiteMode.Lax, Path = "/" });
    return Authorized(ctx) ? Results.Ok() : Results.StatusCode(403);
});
app.MapGet("/assets/{file}", (string file) => Web.Serve(file));
app.MapGet("/api/ping", () => Results.Text("claude-panel"));
// pid + boot: yeniden başlatmada sayfa yeni süreci tanır; diskVersion: diskteki exe daha yeniyse (Restart.DiskVersion).
app.MapGet("/api/version", () => Results.Json(new
{
    version = typeof(Web).Assembly.GetName().Version?.ToString(3), pid = Environment.ProcessId, boot,
    diskVersion = Restart.DiskVersion(), restartError = Restart.LastError
}));

app.MapGet("/api/state", async (SessionStore store, HostedSessions hosted, Tray tray, NightMode night,
    Transcripts transcripts, ContextWindows windows) =>
{
    var sessions = store.List();
    var hostedList = hosted.List();
    var hostedIds = hostedList.Select(h => h.SessionId).Where(x => x is not null).ToHashSet();
    // Terminal oturumlarının sanal masaüstü (Windows; birden çok masaüstü varsa). 30 sn önbellekli.
    var desktops = await VirtualDesktops.Of(sessions.Where(s => s.Kind == "interactive" && !hostedIds.Contains(s.SessionId))
        .Select(s => (s.Pid, s.Cwd)).ToList());
    return Results.Json(new
    {
    night = night.Brief(),
    now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
    boot,
    trayNotify = tray.Notifies,
    sessions,
    hosted = hostedList,
    desktops = desktops.ToDictionary(d => d.Key.ToString(System.Globalization.CultureInfo.InvariantCulture), d => d.Value),
    stats = SessionStatsOf(sessions, hostedList, transcripts, windows),
    usage = store.Usage(night.RefreshUsageSoon),
    // Oturum klasörü → proje kökü (git kökü; yoksa klasör): "bu projede N oturum açık" ve Takip'te oturumdaki projeler.
    roots = sessions.Select(s => s.Cwd).Concat(hostedList.Select(h => h.Cwd)).Where(c => !string.IsNullOrEmpty(c))
        .Distinct(StringComparer.OrdinalIgnoreCase).ToDictionary(c => c, ProjectRoots.Of),
    home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
    });
});

app.MapPost("/api/focus/{pid:int}", async (int pid, HttpContext ctx, SessionStore store) =>
{
    if (!Authorized(ctx)) return Results.StatusCode(403);
    var s = store.List().FirstOrDefault(x => x.Pid == pid);
    if (s is null) return Results.NotFound();
    var body = ctx.Request.ContentLength > 0 ? await ctx.Request.ReadFromJsonAsync<FocusRequest>() : null;
    // UI Automation STA iş parçacığında çalışmalı.
    var result = await Sta.Run(() => WindowFocus.Focus(pid, s.Cwd, body?.Tab, body?.TabId));
    return result.Ok ? Results.Json(result) : Results.Json(result, statusCode: 409);
});

app.MapPost("/api/open-folder", async (HttpContext ctx, SessionStore store) =>
{
    if (!Authorized(ctx)) return Results.StatusCode(403);
    var body = await ctx.Request.ReadFromJsonAsync<PathRequest>();
    // Yalnız canlı bir oturumun klasörü açılabilir (rastgele yol çalıştırılmaz).
    if (body?.Path is null || store.List().All(s => !s.Cwd.Equals(body.Path, StringComparison.OrdinalIgnoreCase)))
        return Results.BadRequest();
    Native.RevealFolder(body.Path);
    return Results.Ok();
});

// Konuşmadaki yol adayları: her biri için bu bilgisayarda var olan en uzun ön ekin uzunluğu (0 = yol değil).
app.MapPost("/api/path-links", async (HttpContext ctx) =>
{
    if (!Authorized(ctx)) return Results.StatusCode(403);
    var list = await ctx.Request.ReadFromJsonAsync<string[]>();
    if (list is null || list.Length > PathLinks.MaxCandidates) return Results.BadRequest();
    return Results.Json(await Task.Run(() => list.Select(PathLinks.Match).ToArray()));
});

// Konuşmadaki yola tıklanınca: klasör Gezgin'de açılır, dosya seçili gösterilir (çalıştırılmaz).
app.MapPost("/api/reveal", async (HttpContext ctx) =>
{
    if (!Authorized(ctx)) return Results.StatusCode(403);
    var body = await ctx.Request.ReadFromJsonAsync<PathRequest>();
    return body?.Path is { } p && PathLinks.Reveal(p) ? Results.Ok() : Results.NotFound();
});

app.MapPost("/api/sessions", async (HttpContext ctx, ProjectGuard guard) =>
{
    if (!Authorized(ctx)) return Results.StatusCode(403);
    var req = await ctx.Request.ReadFromJsonAsync<NewSessionRequest>();
    var error = Launcher.Validate(req);
    if (error is not null) return Results.Json(new { error }, statusCode: 400);
    // Yinelenen istek (düğmeye art arda basma) ikinci oturumu açmaz (StartOnce.cs).
    // Aynı projede oturum varsa açılmaz (409 + seçenekler); kullanıcı "yine de aç" derse mode=force ile gelir.
    object? conflict = null;
    StartOnce.Run("bg:" + req!.Mode, req.Cwd, req.Prompt, req.Name, () =>
    {
        var others = guard.SessionsIn(ProjectRoots.Of(req.Cwd!));
        if (others.Count > 0 && req.Mode != "force") { conflict = FollowEndpoints.Conflict(others, true, req.Cwd!, null, worktree: false); return null; }
        Launcher.StartSession(req);
        return "ok";
    }, k => k is not null);
    return conflict is null ? Results.Ok() : Results.Json(conflict, statusCode: 409);
});

app.MapGet("/api/recent", (Transcripts tr) => Results.Json(tr.Recent()));
app.MapGet("/api/skills", (Skills sk) => Results.Json(sk.List()));
app.MapGet("/api/transcript/{id}", (string id, int? limit, Transcripts tr) =>
{
    var (items, title, cwd) = tr.Read(id, Math.Clamp(limit ?? 200, 1, 400));
    return Results.Json(new { items, title, cwd });
});

app.MapPost("/api/hosted", async (HttpContext ctx, HostedSessions hosted, ProjectGuard guard) =>
{
    if (!Authorized(ctx)) return Results.StatusCode(403);
    var req = await ctx.Request.ReadFromJsonAsync<HostedRequest>();
    var model = string.IsNullOrWhiteSpace(req?.Model) ? null : req.Model;
    var error = HostedSessions.Validate(req?.Cwd, req?.Prompt, model);
    if (error is null && string.IsNullOrWhiteSpace(req!.Prompt) && req.ResumeId is null) error = "prompt";
    if (error is not null) return Results.Json(new { error }, statusCode: 400);
    // Yinelenen istek ilk oturumun anahtarını alır; o oturum kapatıldıysa yeniden başlatılır.
    // Aynı projede başka oturum varsa 409 + seçenekler (FollowEndpoints.StartHosted).
    return FollowEndpoints.StartHosted(req!, model, hosted, guard);
});
app.MapPost("/api/hosted/{key}/send", async (string key, HttpContext ctx, HostedSessions hosted) =>
{
    if (!Authorized(ctx)) return Results.StatusCode(403);
    var req = await ctx.Request.ReadFromJsonAsync<SendRequest>();
    if (string.IsNullOrWhiteSpace(req?.Text) || req.Text.Length > 20_000) return Results.BadRequest();
    return hosted.Send(key, req.Text) ? Results.Ok() : Results.NotFound();
});
app.MapPost("/api/hosted/{key}/interrupt", (string key, HttpContext ctx, HostedSessions hosted) =>
    !Authorized(ctx) ? Results.StatusCode(403) : hosted.Interrupt(key) ? Results.Ok() : Results.NotFound());
app.MapPost("/api/hosted/{key}/stop", (string key, HttpContext ctx, HostedSessions hosted) =>
    !Authorized(ctx) ? Results.StatusCode(403) : hosted.Stop(key) ? Results.Ok() : Results.NotFound());

// İş bitince gönder (çalışan oturumda "iş bitince: devam et"); bekleyen zinciri iptal.
app.MapPost("/api/hosted/{key}/later", async (string key, HttpContext ctx, HostedSessions hosted) =>
{
    if (!Authorized(ctx)) return Results.StatusCode(403);
    var req = await ctx.Request.ReadFromJsonAsync<SendRequest>();
    if (string.IsNullOrWhiteSpace(req?.Text) || req.Text.Length > 20_000) return Results.BadRequest();
    return hosted.SendWhenDone(key, req.Text) ? Results.Ok() : Results.NotFound();
});
app.MapPost("/api/hosted/{key}/cancel-task", (string key, HttpContext ctx, HostedSessions hosted) =>
    !Authorized(ctx) ? Results.StatusCode(403) : hosted.CancelTask(key) ? Results.Ok() : Results.NotFound());

// Kaydet ve temizle (close=false) / kaydet ve kapat (close=true).
app.MapPost("/api/hosted/{key}/wrap", async (string key, HttpContext ctx, HostedSessions hosted) =>
{
    if (!Authorized(ctx)) return Results.StatusCode(403);
    var req = ctx.Request.ContentLength > 0 ? await ctx.Request.ReadFromJsonAsync<WrapRequest>() : null;
    return hosted.Wrap(key, req?.Close == true) ? Results.Ok() : Results.NotFound();
});

// Terminaldeki oturumu panele taşı: terminaldeki claude kapatılır, aynı konuşma panelde --resume ile açılır.
// Yalnız bekleyen (idle) oturum alınır; çalışan iş yarıda kesilmez.
app.MapPost("/api/adopt/{pid:int}", async (int pid, HttpContext ctx, SessionStore store, HostedSessions hosted) =>
{
    if (!Authorized(ctx)) return Results.StatusCode(403);
    var s = store.List().FirstOrDefault(x => x.Pid == pid);
    if (s is null) return Results.NotFound();
    if (s.Status != "idle") return Results.Json(new { error = "busy" }, statusCode: 409);
    if (!Guid.TryParse(s.SessionId, out _)) return Results.Json(new { error = "generic" }, statusCode: 409);
    try
    {
        using var p = Process.GetProcessById(pid);
        // Mac'te npm ile kurulan claude "node" adıyla görünür; pid zaten claude'un kendi oturum dosyasından geliyor.
        if (!p.ProcessName.Equals("claude", StringComparison.OrdinalIgnoreCase)
            && !(!OperatingSystem.IsWindows() && p.ProcessName == "node"))
            return Results.Json(new { error = "generic" }, statusCode: 409);
        int shell = TerminalTab.FindOwnedShell(pid); // claude kapanmadan önce: sonra ebeveyni okunamaz
        p.Kill();
        await p.WaitForExitAsync(new CancellationTokenSource(5000).Token);
        TerminalTab.CloseIfIdle(shell); // boş kalan terminal sekmesi de kapansın
    }
    catch (ArgumentException) { /* zaten kapanmış */ }
    catch (OperationCanceledException) { return Results.Json(new { error = "generic" }, statusCode: 409); }
    var (key, _) = StartOnce.Run("hosted", s.Cwd, null, s.SessionId,
        () => hosted.Start(s.Cwd, null, null, s.CustomName, s.SessionId), k => k is not null && hosted.Has(k));
    return Results.Json(new { key, sessionId = s.SessionId });
});
app.MapPost("/api/attach", async (HttpContext ctx) =>
{
    if (!Authorized(ctx)) return Results.StatusCode(403);
    Launcher.OpenAgentsView();
    await Task.CompletedTask;
    return Results.Ok();
});

// Çalışan panel oturumu varsa kapatma reddedilir (force=1 ile zorlanır); açık oturumlar sonraki açılışta geri gelir.
app.MapPost("/api/quit", (HttpContext ctx, IHostApplicationLifetime life, HostedSessions hosted) =>
{
    if (!Authorized(ctx)) return Results.StatusCode(403);
    if (hosted.AnyBusy && ctx.Request.Query["force"] != "1") return Results.Json(new { error = "busy" }, statusCode: 409);
    Restart.MarkHandingOver(); // yeniden başlatma sürüyorsa bu istek yeni süreçten: uygulama penceresi açık kalır
    _ = Task.Delay(300).ContinueWith(_ => life.StopApplication());
    return Results.Ok();
});
// Paneli yeniden başlat: telefondan da (Blocked'da değil) ama zorlama yalnız bilgisayardan.
app.MapPost("/api/restart", async (HttpContext ctx, HostedSessions hosted) =>
{
    if (!Authorized(ctx)) return Results.StatusCode(403);
    return await Restart.Begin(hosted.BusyNames, force: IsLocal(ctx) && ctx.Request.Query["force"] == "1");
});

// Klasör seçme penceresi (işletim sisteminin kendi penceresi).
app.MapPost("/api/pick-folder", async (HttpContext ctx) =>
{
    if (!Authorized(ctx)) return Results.StatusCode(403);
    // Aynı anda tek pencere: sahipsiz pencere panelin arkasında açılıyor, her tıklama yenisini açıp ekranı kilitliyordu.
    if (Interlocked.Exchange(ref pickerOpen, 1) == 1) return Results.Json(new { error = "open" }, statusCode: 409);
    try
    {
        var path = await Native.PickFolder();
        return Results.Json(new { path });
    }
    finally { Interlocked.Exchange(ref pickerOpen, 0); }
});

// Panel içi klasör gezgini: bir klasörün alt klasörleri (yol yoksa sürücüler).
app.MapPost("/api/dirs", async (HttpContext ctx, Transcripts tr) =>
{
    if (!Authorized(ctx)) return Results.StatusCode(403);
    var req = await ctx.Request.ReadFromJsonAsync<DirsRequest>();
    var path = req?.Path?.Trim();
    var known = new HashSet<string>(tr.Projects().Select(p => p.Cwd.TrimEnd('\\', '/')), StringComparer.OrdinalIgnoreCase);
    if (string.IsNullOrEmpty(path))
    {
        return Results.Json(new { path = "", parent = (string?)null, dirs = Native.FolderRoots() });
    }
    try
    {
        var di = new DirectoryInfo(path);
        if (!di.Exists) return Results.Json(new { error = "notfound" }, statusCode: 404);
        var dirs = di.EnumerateDirectories()
            .Where(d => (d.Attributes & (FileAttributes.Hidden | FileAttributes.System)) == 0 && !d.Name.StartsWith('.'))
            .OrderBy(d => d.Name, StringComparer.CurrentCultureIgnoreCase)
            .Select(d => new DirEntry(d.Name, d.FullName, known.Contains(d.FullName.TrimEnd('\\', '/'))))
            .ToList();
        return Results.Json(new { path = di.FullName, parent = di.Parent?.FullName ?? "", dirs });
    }
    catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or System.Security.SecurityException)
    {
        return Results.Json(new { error = "denied" }, statusCode: 403);
    }
});

// Klasörler aramasında alt klasörlere iner (2. düzey ve altı; sınırlar DirSearch'te). Kökte ("Bu bilgisayar") çalışmaz.
app.MapPost("/api/dirs/search", async (HttpContext ctx, Transcripts tr) =>
{
    if (!Authorized(ctx)) return Results.StatusCode(403);
    var req = await ctx.Request.ReadFromJsonAsync<DirsRequest>();
    var path = req?.Path?.Trim();
    var q = req?.Q?.Trim() ?? "";
    if (string.IsNullOrEmpty(path) || q.Length == 0 || q.Length > 200 || !Directory.Exists(path))
        return Results.Json(new { hits = Array.Empty<DirHit>(), truncated = false });
    var known = new HashSet<string>(tr.Projects().Select(p => p.Cwd.TrimEnd('\\', '/')), StringComparer.OrdinalIgnoreCase);
    var (hits, truncated) = await Task.Run(() => DirSearch.Find(path, q, known.Contains));
    return Results.Json(new { hits, truncated });
});

// Yapıştırılan resimlerin yeri (panel veri klasörü/pastes).
// Oturum kimliği → kart/konuşma özeti (konuşma kaydından; bağlam penceresi öğrenilmişse yüzde için).
static Dictionary<string, object> SessionStatsOf(IReadOnlyList<SessionInfo> sessions, IReadOnlyList<HostedInfo> hosted,
    Transcripts transcripts, ContextWindows windows)
{
    var result = new Dictionary<string, object>();
    var ids = sessions.Select(s => s.SessionId).Concat(hosted.Select(h => h.SessionId)).OfType<string>().Distinct();
    foreach (var id in ids)
    {
        var st = transcripts.Stats(id);
        if (st is null) continue;
        var model = st.Model ?? hosted.FirstOrDefault(h => h.SessionId == id)?.Model;
        result[id] = new { st.Model, st.CtxTokens, CtxWindow = windows.Of(id, model), st.InTok, st.OutTok,
            st.CacheRead, st.CacheWrite, st.Turns, st.Compactions, st.LastText, st.LastTool, st.LastToolName, st.LastIsTool };
    }
    return result;
}

static string PasteFile(string ext)
{
    var dir = Path.Combine(Handoff.DataDir, "pastes");
    Directory.CreateDirectory(dir);
    return Path.Combine(dir, $"yapistir-{DateTime.Now:yyyyMMdd-HHmmss-fff}{ext}");
}

static string? SafeFileName(string raw)
{
    var n = Path.GetFileName(raw.Replace('\\', '/').Split('/').Last()).Trim().TrimStart('.');
    foreach (var c in Path.GetInvalidFileNameChars().Concat(new[] { '"', '<', '>', '|', ':', '*', '?' })) n = n.Replace(c, '_');
    if (n.Length == 0) return null;
    if (n.Length > 80) { var e = Path.GetExtension(n); n = n[..(80 - Math.Min(e.Length, 15))] + (e.Length <= 15 ? e : ""); }
    return n;
}

// Panoda kopyalanmış dosya/klasör varsa yollarını döner (Gezgin'de Ctrl+C).
app.MapPost("/api/clipboard-paths", async (HttpContext ctx) =>
{
    if (!Authorized(ctx)) return Results.StatusCode(403);
    var paths = await Native.ClipboardPaths();
    // Dosya yoksa panodaki resim (ekran görüntüsü) kaydedilip yolu verilir.
    if (paths.Count == 0)
    {
        var file = PasteFile(".png");
        if (await Native.SaveClipboardImage(file)) return Results.Json(new { paths = new[] { file }, image = true });
    }
    return Results.Json(new { paths });
});

// Yapıştırılan ekran görüntüsünü kaydeder, yolunu döner (Claude resmi yoldan okur).
app.MapPost("/api/paste-image", async (HttpContext ctx) =>
{
    if (!Authorized(ctx)) return Results.StatusCode(403);
    if (ctx.Request.ContentLength is null or > 20_000_000) return Results.BadRequest();
    // 📎 ile seçilen dosya: özgün adı korunur (yalnız ad kısmı, geçersiz karakterler atılır); ad yoksa panodan gelen resim.
    var name = SafeFileName(ctx.Request.Query["name"].ToString());
    var ext = ctx.Request.ContentType switch { "image/jpeg" => ".jpg", "image/gif" => ".gif", "image/webp" => ".webp", _ => ".png" };
    var file = name is null ? PasteFile(ext) : PasteFile("-" + name);
    await using (var fs = File.Create(file)) await ctx.Request.Body.CopyToAsync(fs);
    return Results.Json(new { path = file });
});

// Dikte: ses bu bilgisayarda yazıya çevrilir (Whisper). Model ilk kullanımda indirilir.
app.MapGet("/api/dictation", (Dictation d) => Results.Json(d.Status()));
app.MapPost("/api/dictation/model", (HttpContext ctx, Dictation d) =>
{
    if (!Authorized(ctx)) return Results.StatusCode(403);
    d.EnsureModel();
    return Results.Json(d.Status());
});
app.MapPost("/api/dictation/warm", (HttpContext ctx, Dictation d) =>
{
    if (!Authorized(ctx)) return Results.StatusCode(403);
    d.Warm();
    return Results.Ok();
});
app.MapPost("/api/dictation", async (HttpContext ctx, Dictation d) =>
{
    if (!Authorized(ctx)) return Results.StatusCode(403);
    if (ctx.Request.ContentLength is null or < 1000 or > Dictation.MaxWavBytes) return Results.BadRequest();
    var lang = ctx.Request.Query["lang"].ToString() is "en" ? "en" : "tr";
    using var ms = new MemoryStream();
    await ctx.Request.Body.CopyToAsync(ms, ctx.RequestAborted);
    ms.Position = 0;
    var text = await d.Transcribe(ms, lang, ctx.RequestAborted);
    return text is null ? Results.Json(new { error = "model" }, statusCode: 409) : Results.Json(new { text });
});

app.MapGet("/api/hosted/{key}/commands", (string key, HostedSessions hosted) =>
    hosted.CommandsOf(key) is { } c ? Results.Json(c) : Results.NotFound());

app.MapGet("/api/night", (NightMode night) => Results.Json(night.Status()));
app.MapPost("/api/night", async (HttpContext ctx, NightMode night) =>
{
    if (!Authorized(ctx)) return Results.StatusCode(403);
    var req = await ctx.Request.ReadFromJsonAsync<NightRequest>();
    if (req?.Settings is null) return Results.BadRequest();
    if (night.Update(req.Settings) is { } err) return Results.BadRequest(new { error = err });
    // Gece modu açılınca Windows açılışında başlatma da açılır (yeniden başlatmada gece işi yarım kalmasın).
    if (req.Autostart is { } a && Autostart.Supported) Autostart.Set(a);
    return Results.Json(night.Status());
});
app.MapGet("/api/projects", (Transcripts tr) => Results.Json(tr.Projects()));
// Takip sekmesi: git durumu, NEXT_SESSION.md dosyaları, güncellemeler (FollowUp.cs). Okuma önbellekten gelir, bayatsa arka planda yenilenir.
// "Karar bekleyenler" bölümü /api/state içindeki oturum listesinden çizilir. Oturum başlatan düğmeler /api/hosted kullanır.
app.MapGet("/api/followup", (FollowUp fu) => Results.Json(fu.Get()));
app.MapPost("/api/followup/refresh", (HttpContext ctx, FollowUp fu) =>
{
    if (!Authorized(ctx)) return Results.StatusCode(403);
    fu.Refresh();
    return Results.Ok();
});
app.MapFollow(Authorized); // Takip'in arka plan işleri: /api/follow/* (FollowEndpoints.cs)
app.MapSchedule(Authorized, IsLocal); // Zamanlanmış işler: /api/schedule/* (ScheduleEndpoints.cs)
app.MapPlans(Authorized); // Planlı işler: /api/plans* (PlanEndpoints.cs)
app.MapMail(Authorized, IsLocal); // Mail ve takvim: /api/mail* (Mail/MailEndpoints.cs)
app.MapCodex(Authorized); // Codex oturumları, salt okuma: /api/codex* (CodexEndpoints.cs)
app.MapCost(); // Proje maliyeti ve açılış yükü, salt okuma: /api/cost, /api/startup-load (CostEndpoints.cs)
app.MapGet("/api/terminal-quota", () => Results.Json(QuotaSetup.Status()));
app.MapPost("/api/terminal-quota", async (HttpContext ctx) =>
{
    if (!IsLocal(ctx) || !Authorized(ctx)) return Results.StatusCode(403);
    var req = await ctx.Request.ReadFromJsonAsync<TerminalQuotaRequest>();
    if (req?.Enabled is not { } on) return Results.BadRequest();
    return QuotaSetup.Set(on, req.Lang) is { } err ? Results.BadRequest(new { error = err }) : Results.Json(QuotaSetup.Status());
});

await app.StartAsync();
Handoff.WriteToken(port, token); // yeni sürüm açılınca bu paneli kapatabilsin
app.Lifetime.ApplicationStopping.Register(() => Handoff.DeleteToken(port));
// Paneli kapat / yeni sürüme devir: pencere de kapanır (sayfanın window.close()'u Edge uygulama penceresinde yetmiyordu).
app.Lifetime.ApplicationStopping.Register(() => { if (!Restart.HandingOver) Launcher.CloseAppWindow(baseUrl); });
app.Services.GetRequiredService<HostedSessions>().Restore();
app.Services.GetRequiredService<Tray>().Start();
app.Services.GetRequiredService<NightMode>().Start();
app.Services.GetRequiredService<PlannedJobs>().Start();
app.Services.GetRequiredService<ProjectGuard>().Start();
// Takip → GitHub: pencere kapalıyken de 15 dakikada bir denetler; yeni "cevap bekliyor" öğesi tepsi bildirimi verir.
var ghWatch = app.Services.GetRequiredService<GitHubWatch>();
ghWatch.Notify = app.Services.GetRequiredService<Tray>().Notify;
ghWatch.Start();
// Takip → Mail ve Takvim: hesap varsa pencere kapalıyken de 10 dakikada bir denetler (yalnız başlık meta verisi).
app.Services.GetRequiredService<MailWatch>().Start();
app.Services.GetRequiredService<Dictation>(); // inmiş dikte modelini açılışta arka planda bir kez doğrular (SHA256, damga dosyası)
if (!args.Contains("--no-window")) Launcher.OpenAppWindow(baseUrl, fresh: true);
await app.WaitForShutdownAsync();

static async Task<bool> PanelAlreadyRunning(string url)
{
    try
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromMilliseconds(800) };
        return await http.GetStringAsync($"{url}/api/ping") == "claude-panel";
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
    {
        return false;
    }
}

record PathRequest(string? Path);
record FocusRequest(string? Tab, string? TabId);
record SendRequest(string? Text);
public record NewSessionRequest(string? Cwd, string? Prompt, string? Name, string? Mode = null);
public record DirsRequest(string? Path, string? Q = null);
public record DirEntry(string Name, string Path, bool Known);
public record WrapRequest(bool Close);
public record NightRequest(NightSettings? Settings, bool? Autostart);
record ClaimRequest(string? Code, string? Secret, string? Name);
record EnableRequest(bool? Enabled);
record TerminalQuotaRequest(bool? Enabled, string? Lang);

/// <summary>Telefon adresinden gelen istekler için yol kuralları.</summary>
static class Remote
{
    // Eşleşmeden açılabilenler: eşleştirme sayfası ve onun dosyaları.
    static readonly HashSet<string> Public = new(StringComparer.Ordinal)
    {
        "/pair", "/api/remote/claim", "/assets/pair.js", "/assets/app.css", "/assets/logo.svg",
        "/assets/icon-192.png", "/assets/icon-512.png", "/manifest.webmanifest", "/api/ping"
    };
    // Bilgisayarın ekranında/panosunda iş yapan ya da paneli yöneten uçlar telefondan kapalı.
    static readonly string[] Blocked =
    [
        "/api/focus/", "/api/open-folder", "/api/adopt/", "/api/attach", "/api/quit", "/api/pick-folder",
        "/api/clipboard-paths", "/api/reveal", "/api/path-links", "/api/terminal-quota", "/api/schedule/disable", "/api/schedule/run", "/api/schedule/log",
        "/api/mail/client", "/api/mail/accounts", "/api/mail/imap", "/api/mail/open", // mail hesabı ekleme/kaldırma, istemci dosyası, uygulama şifresi: yalnız bilgisayardan
        "/api/codex/open-folder" // Codex oturumunun klasörünü bilgisayarda açar
    ];

    public static bool IsPublic(string path) => Public.Contains(path);

    /// <summary>
    /// Cihaz çerezi. Lax: Android'de ana ekrana yüklenen uygulama ve başka uygulamadan açılan bağlantı sayfayı "dışarıdan"
    /// açar; Strict çerez o ilk istekte gönderilmiyor, panel yeniden eşleştirme istiyordu (log 18.11 12:35 "çerez yok").
    /// CSRF koruması çereze değil, değişiklik isteklerindeki X-Panel-Token + Origin denetimine dayanır.
    /// </summary>
    public static CookieOptions CookieOptions() => new()
    {
        HttpOnly = true, Secure = true, SameSite = SameSiteMode.Lax, Path = "/", MaxAge = TimeSpan.FromDays(400)
    };

    // Yönlendirme büyük/küçük harfe duyarsız eşler (/API/QUIT de /api/quit'e gider): karşılaştırma da öyle olmalı.
    public static bool IsBlocked(string path)
    {
        var p = path.ToLowerInvariant().TrimEnd('/');
        return p == "/api/sessions" // yeni terminal penceresi açar
               || (p.StartsWith("/api/remote", StringComparison.Ordinal) && p is not ("/api/remote/forget" or "/api/remote/view")) // cihaz yönetimi yalnız bilgisayardan
               || Blocked.Any(b => p.StartsWith(b.TrimEnd('/'), StringComparison.Ordinal));
    }

    public static string QrSvg(string text)
    {
        using var gen = new QRCoder.QRCodeGenerator();
        using var data = gen.CreateQrCode(text, QRCoder.QRCodeGenerator.ECCLevel.M);
        return new QRCoder.SvgQRCode(data).GetGraphic(6, "#000000", "#ffffff", drawQuietZones: true);
    }
}

static class Web
{
    static readonly Assembly Asm = typeof(Web).Assembly;

    public static string Read(string name)
    {
        using var s = Asm.GetManifestResourceStream($"web/{name}")
                      ?? throw new FileNotFoundException(name);
        using var r = new StreamReader(s, Encoding.UTF8);
        return r.ReadToEnd();
    }

    public static IResult Serve(string file)
    {
        var s = Asm.GetManifestResourceStream($"web/{file}");
        if (s is null) return Results.NotFound();
        var type = Path.GetExtension(file) switch
        {
            ".css" => "text/css; charset=utf-8",
            ".js" => "text/javascript; charset=utf-8",
            ".svg" => "image/svg+xml",
            ".png" => "image/png",
            ".ico" => "image/x-icon",
            _ => "application/octet-stream"
        };
        return Results.Stream(s, type);
    }
}

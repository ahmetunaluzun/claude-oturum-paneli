using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.WebUtilities;

namespace ClaudePanel;

/// <param name="State">"waiting" (tarayıcıda giriş bekleniyor) | "done" | "failed" | "cancelled".</param>
/// <param name="Error">failed ise: "denied" (kullanıcı reddetti) | "exchange" | "noemail" | "store" | "timeout" | "full" | "net".</param>
public sealed record MailLoginState(string Id, string State, string? Error, string? Email, long At);

/// <summary>
/// Masaüstü OAuth girişi (Google): loopback 127.0.0.1 boş port + PKCE S256 + state. Kaynak:
/// https://developers.google.com/identity/protocols/oauth2/native-app (22.11.2026'da doğrulandı):
///   yetki isteği client_id, redirect_uri (http://127.0.0.1:port), response_type=code, scope (boşlukla ayrılmış),
///   code_challenge + code_challenge_method=S256, state; login_hint isteğe bağlı. "Incremental authorization is not supported for
///   installed apps" — kaynak eklerken açık kaynakların tamamı yeniden istenir.
///   token değişimi: code, client_id, client_secret (isteğe bağlı), code_verifier, grant_type=authorization_code, redirect_uri.
/// Yalnız açılan kaynağın salt okuma kapsamı istenir. Kod, belirteç ve dönüş adresi loga yazılmaz.
/// Aynı anda tek giriş; yenisi başlarsa eskisi iptal edilir. 10 dakikada tamamlanmazsa kapanır.
/// Test: CLAUDE_PANEL_MAIL_NO_BROWSER=1 tarayıcı açmaz (test betiği yetki adresini kendisi çağırır).
/// </summary>
public sealed class MailLogin(MailSettings settings, ILogger<MailLogin> log)
{
    static readonly TimeSpan Timeout = TimeSpan.FromMinutes(10);
    readonly object _gate = new();
    CancellationTokenSource? _cts;
    volatile MailLoginState? _state;

    /// <summary>Giriş tamamlandı: (hesap kimliği, belirteçler) — MailWatch erişim belirtecini önbelleğe alır ve hemen denetler.</summary>
    public event Action<string, GoogleProvider.Tokens>? Completed;

    public MailLoginState? State => _state;

    /// <summary>Girişi başlatır; dönen yetki adresi tarayıcıda açılır. Hata: "noclient" | "nosource" | "full" | "listen".</summary>
    public (string? Url, string? Error) Start(bool mail, bool cal, string? hint)
    {
        if (settings.Client is not { } client) return (null, "noclient");
        if (!mail && !cal) return (null, "nosource");
        if (settings.Full && (hint is null || settings.Accounts.All(a => !string.Equals(a.Email, hint, StringComparison.OrdinalIgnoreCase)))) return (null, "full");
        TcpListener listener;
        try { listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(); }
        catch (SocketException) { return (null, "listen"); }
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var redirect = $"http://127.0.0.1:{port}";
        var verifier = B64(RandomNumberGenerator.GetBytes(32));
        var challenge = B64(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
        var state = B64(RandomNumberGenerator.GetBytes(16));
        var scopes = string.Join(' ', new[] { mail ? GoogleProvider.ScopeMail : null, cal ? GoogleProvider.ScopeCal : null }.OfType<string>());
        var q = new Dictionary<string, string?>
        {
            ["client_id"] = client.Id, ["redirect_uri"] = redirect, ["response_type"] = "code", ["scope"] = scopes,
            ["code_challenge"] = challenge, ["code_challenge_method"] = "S256", ["state"] = state, ["login_hint"] = hint
        };
        var url = GoogleProvider.AuthUrl + "?" + string.Join('&', q.Where(kv => kv.Value is not null).Select(kv => kv.Key + "=" + Uri.EscapeDataString(kv.Value!)));
        var id = Guid.NewGuid().ToString("N")[..10];
        var cts = new CancellationTokenSource(Timeout);
        lock (_gate)
        {
            _cts?.Cancel();
            _cts = cts;
            _state = new MailLoginState(id, "waiting", null, null, Now());
        }
        log.LogInformation("Google girişi başladı (yerel port {Port}; kaynaklar: {Src})", port, (mail ? "mail " : "") + (cal ? "takvim" : ""));
        _ = Task.Run(() => Serve(id, listener, client, verifier, state, redirect, cts.Token));
        if (Environment.GetEnvironmentVariable("CLAUDE_PANEL_MAIL_NO_BROWSER") != "1")
        {
            try { TokenStore.OpenBrowser(url); }
            catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException) { log.LogWarning("Tarayıcı açılamadı: {Msg}", ex.Message); }
        }
        return (url, null);
    }

    public void Cancel()
    {
        lock (_gate)
        {
            _cts?.Cancel();
            if (_state is { State: "waiting" } s) _state = s with { State = "cancelled", At = Now() };
        }
    }

    async Task Serve(string id, TcpListener listener, GoogleClient client, string verifier, string state, string redirect, CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                using var tcp = await listener.AcceptTcpClientAsync(ct);
                var (status, page, result) = await Handle(tcp, client, verifier, state, redirect, ct);
                await Reply(tcp, status, page);
                if (result is null) continue; // geçersiz/eşleşmeyen istek: beklemeye devam
                Finish(id, result.Value.Error, result.Value.Email);
                return;
            }
        }
        catch (OperationCanceledException)
        {
            // Cancel() durumu zaten "cancelled" yaptı; yeni giriş başladıysa kimlik değişti. Kalan tek yol: süre doldu.
            lock (_gate) if (_state is { State: "waiting" } s && s.Id == id) _state = s with { State = "failed", Error = "timeout", At = Now() };
        }
        catch (Exception ex) when (ex is SocketException or IOException or ObjectDisposedException)
        {
            log.LogWarning("Google girişi yarıda kaldı: {Msg}", ex.Message);
            Finish(id, "net", null);
        }
        finally { listener.Stop(); }
    }

    /// <summary>Tek tarayıcı dönüşü. result null: kabul edilmedi (state uyuşmadı, favicon…), giriş beklemeye devam eder.</summary>
    async Task<(int, string, (string? Error, string? Email)?)> Handle(TcpClient tcp, GoogleClient client, string verifier, string state, string redirect, CancellationToken ct)
    {
        var target = await ReadTarget(tcp, ct);
        if (target is null || !target.StartsWith('/')) return (400, PageBad, null);
        var qi = target.IndexOf('?');
        if (qi < 0) return (404, PageBad, null);
        var q = QueryHelpers.ParseQuery(target[qi..]);
        var got = q.TryGetValue("state", out var sv) ? sv.ToString() : "";
        if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(got), Encoding.ASCII.GetBytes(state)))
        {
            log.LogWarning("Google girişi dönüşü reddedildi: state uyuşmadı");
            return (400, PageBad, null);
        }
        if (q.TryGetValue("error", out var err)) return (200, PageFail, (err.ToString() == "access_denied" ? "denied" : "exchange", null));
        if (!q.TryGetValue("code", out var code) || code.ToString().Length == 0) return (400, PageBad, null);
        GoogleProvider.Tokens tok;
        try { tok = await GoogleProvider.Exchange(client, code.ToString(), verifier, redirect, ct); }
        catch (Exception ex) when (ex is HttpRequestException or MailAuthException or TaskCanceledException)
        {
            log.LogWarning("Google girişi: belirteç alınamadı ({Msg})", ex.Message);
            return (200, PageFail, ("exchange", null));
        }
        var mail = tok.Scope.Split(' ').Contains(GoogleProvider.ScopeMail);
        var cal = tok.Scope.Split(' ').Contains(GoogleProvider.ScopeCal);
        if (tok.Refresh is null || (!mail && !cal)) return (200, PageFail, ("exchange", null));
        string? email;
        try { email = await GoogleProvider.Email(tok.Access, mail, ct); }
        catch (Exception ex) when (ex is HttpRequestException or MailAuthException or TaskCanceledException) { email = null; log.LogWarning("Google girişi: adres alınamadı ({Msg})", ex.Message); }
        if (email is null || MailRules.Addresses(email).FirstOrDefault() is not { } addr) return (200, PageFail, ("noemail", null));
        var accountId = settings.Upsert("google", addr, mail, cal);
        if (!TokenStore.Save(MailSettings.TokenName(accountId), tok.Refresh))
        {
            settings.Remove(accountId);
            return (200, PageFail, ("store", null));
        }
        log.LogInformation("Google hesabı eklendi/yenilendi (mail {Mail}, takvim {Cal}); belirteç şifreli saklandı", mail, cal);
        Completed?.Invoke(accountId, tok);
        return (200, PageOk, (null, addr));
    }

    void Finish(string id, string? error, string? email)
    {
        lock (_gate)
            if (_state?.Id == id) _state = new MailLoginState(id, error is null ? "done" : "failed", error, email, Now());
    }

    static async Task<string?> ReadTarget(TcpClient tcp, CancellationToken ct)
    {
        using var t = CancellationTokenSource.CreateLinkedTokenSource(ct);
        t.CancelAfter(5000);
        var buf = new byte[8192];
        var n = 0;
        var s = tcp.GetStream();
        try
        {
            while (n < buf.Length)
            {
                var r = await s.ReadAsync(buf.AsMemory(n), t.Token);
                if (r == 0) break;
                n += r;
                if (Encoding.ASCII.GetString(buf, 0, n).Contains("\r\n\r\n", StringComparison.Ordinal)) break;
            }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { return null; }
        var line = Encoding.ASCII.GetString(buf, 0, n).Split("\r\n")[0].Split(' ');
        return line.Length == 3 && line[0] == "GET" ? line[1] : null;
    }

    static async Task Reply(TcpClient tcp, int status, string html)
    {
        var body = Encoding.UTF8.GetBytes(html);
        var head = Encoding.ASCII.GetBytes($"HTTP/1.1 {status} {(status == 200 ? "OK" : "Bad Request")}\r\nContent-Type: text/html; charset=utf-8\r\n" +
                                           $"Content-Length: {body.Length}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n");
        try
        {
            var s = tcp.GetStream();
            await s.WriteAsync(head);
            await s.WriteAsync(body);
        }
        catch (IOException) { }
    }

    const string Style = "<style>body{font-family:system-ui,'Segoe UI',sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#222}p{color:#555}</style>";
    const string PageOk = "<!doctype html><meta charset=utf-8><title>Claude Oturum Paneli</title>" + Style +
                          "<h2>Giriş tamamlandı</h2><p>Bu sekmeyi kapatıp panele dönebilirsiniz.</p><h2 lang=en>Sign-in complete</h2><p lang=en>You can close this tab and return to the panel.</p>";
    const string PageFail = "<!doctype html><meta charset=utf-8><title>Claude Oturum Paneli</title>" + Style +
                            "<h2>Giriş tamamlanamadı</h2><p>Panele dönüp yeniden deneyin.</p><h2 lang=en>Sign-in failed</h2><p lang=en>Return to the panel and try again.</p>";
    const string PageBad = "<!doctype html><meta charset=utf-8><title>Claude Oturum Paneli</title>" + Style + "<h2>Geçersiz istek</h2><p lang=en>Invalid request.</p>";

    static string B64(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
}

using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace ClaudePanel;

/// <summary>
/// Google (Workspace / Gmail + Takvim) sağlayıcısı. YALNIZ OKUR, gövde istemez:
///   Gmail users.messages.list → yalnız id + threadId
///     https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
///   Gmail users.messages.get format=metadata ("Returns only email message ID, labels, and email headers.")
///     https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get
///     https://developers.google.com/workspace/gmail/api/reference/rest/v1/Format
///   Gmail users.getProfile (emailAddress) https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile
///   Takvim events.list (calendarId=primary, timeMin/timeMax RFC3339, singleEvents=true, orderBy=startTime)
///     https://developers.google.com/workspace/calendar/api/v3/reference/events/list
///     https://developers.google.com/workspace/calendar/api/v3/reference/events (summary, location, htmlLink, hangoutLink, conferenceData)
///   Takvim calendars.get (primary) https://developers.google.com/workspace/calendar/api/v3/reference/calendars/get
/// Uç adresleri 22.11.2026'da bu sayfalardan doğrulandı. Test: CLAUDE_PANEL_GOOGLE_BASE (yalnız 127.0.0.1/localhost) tüm API ve
/// token uçlarını yerel sahte sunucuya yönlendirir (tools/sahte_google.py).
/// </summary>
public sealed partial class GoogleProvider : IMailProvider
{
    public const string ScopeMail = "https://www.googleapis.com/auth/gmail.readonly";
    public const string ScopeCal = "https://www.googleapis.com/auth/calendar.readonly";
    const int ListMax = 40, Days = 14, Parallel = 4, SubjectMax = 200, TextMax = 200, EventsMax = 20;

    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(20) };

    public string Name => "google";

    static string? TestBase(string env) =>
        Environment.GetEnvironmentVariable(env) is { Length: > 0 } b && (b.StartsWith("http://127.0.0.1:", StringComparison.Ordinal) || b.StartsWith("http://localhost:", StringComparison.Ordinal))
            ? b.TrimEnd('/') : null;

    // https://developers.google.com/identity/protocols/oauth2/native-app (Authorization: accounts.google.com/o/oauth2/v2/auth; Token: oauth2.googleapis.com/token)
    public static string AuthUrl => (TestBase("CLAUDE_PANEL_GOOGLE_AUTH_BASE") ?? "https://accounts.google.com") + "/o/oauth2/v2/auth";
    public static string TokenUrl => TestBase("CLAUDE_PANEL_GOOGLE_BASE") is { } b ? b + "/token" : "https://oauth2.googleapis.com/token";
    static string Gmail => TestBase("CLAUDE_PANEL_GOOGLE_BASE") is { } b ? b + "/gmail/v1" : "https://gmail.googleapis.com/gmail/v1";
    static string Calendar => TestBase("CLAUDE_PANEL_GOOGLE_BASE") is { } b ? b + "/calendar/v3" : "https://www.googleapis.com/calendar/v3";

    [GeneratedRegex(@"^[A-Za-z0-9_-]{1,100}$")] private static partial Regex IdRx();

    // ---- Token ----

    public sealed record Tokens(string Access, long ExpiresAt, string? Refresh, string Scope);

    /// <summary>Yetki kodunu belirteçle değiştirir (PKCE code_verifier ile).</summary>
    public static Task<Tokens> Exchange(GoogleClient c, string code, string verifier, string redirect, CancellationToken ct) =>
        TokenCall(new()
        {
            ["code"] = code, ["client_id"] = c.Id, ["code_verifier"] = verifier, ["grant_type"] = "authorization_code", ["redirect_uri"] = redirect,
            ["client_secret"] = c.Secret
        }, ct);

    /// <summary>Yenileme belirteciyle yeni erişim belirteci. invalid_grant → <see cref="MailAuthException"/> (yeniden giriş gerekli).</summary>
    public static Task<Tokens> Refresh(GoogleClient c, string refresh, CancellationToken ct) =>
        TokenCall(new() { ["client_id"] = c.Id, ["grant_type"] = "refresh_token", ["refresh_token"] = refresh, ["client_secret"] = c.Secret }, ct);

    static async Task<Tokens> TokenCall(Dictionary<string, string?> form, CancellationToken ct)
    {
        using var body = new FormUrlEncodedContent(form.Where(kv => kv.Value is not null).Select(kv => new KeyValuePair<string, string>(kv.Key, kv.Value!)));
        using var res = await Http.PostAsync(TokenUrl, body, ct);
        var text = await res.Content.ReadAsStringAsync(ct);
        JsonNode? j = null;
        try { j = JsonNode.Parse(text); } catch (System.Text.Json.JsonException) { }
        if (!res.IsSuccessStatusCode)
        {
            var err = Str(j?["error"]) ?? ((int)res.StatusCode).ToString(CultureInfo.InvariantCulture);
            if (err is "invalid_grant" or "invalid_client" or "unauthorized_client") throw new MailAuthException(err);
            throw new HttpRequestException("token: " + err);
        }
        var access = Str(j?["access_token"]) ?? throw new HttpRequestException("token: access_token yok");
        var expires = j?["expires_in"] is JsonValue ev && ev.TryGetValue<int>(out var e) ? e : 3600;
        return new Tokens(access, DateTimeOffset.UtcNow.AddSeconds(Math.Max(60, expires - 60)).ToUnixTimeMilliseconds(), Str(j?["refresh_token"]), Str(j?["scope"]) ?? "");
    }

    // ---- Hesap adresi (girişten) ----

    public static async Task<string?> Email(string access, bool hasMail, CancellationToken ct)
    {
        if (hasMail) return Str((await Get(access, $"{Gmail}/users/me/profile", ct))?["emailAddress"]);
        return Str((await Get(access, $"{Calendar}/calendars/primary", ct))?["id"]);
    }

    // ---- Mail ----

    public async Task<List<MailMeta>> Mails(string access, string me, CancellationToken ct)
    {
        me = me.ToLowerInvariant();
        var inbox = await List(access, $"in:inbox newer_than:{Days}d", ct);
        var sent = await List(access, $"in:sent newer_than:{Days}d", ct);
        var labels = await LabelNames(access, ct);
        // Liste en yeniden eskiye: konuşmanın ilk görülen mesajı en yenisidir.
        var newestIn = inbox.GroupBy(m => m.Thread).Select(g => g.First()).ToList();
        var newestSent = sent.GroupBy(m => m.Thread).ToDictionary(g => g.Key, g => g.First().Id);
        var result = new List<MailMeta>();
        using var gate = new SemaphoreSlim(Parallel);
        var jobs = newestIn.Select(async m =>
        {
            await gate.WaitAsync(ct);
            try
            {
                if (await Meta(access, m.Id, ct) is not { } h) return null;
                var (name, addr) = MailRules.Sender(h.From);
                var fromMe = addr == me || h.Labels.Contains("SENT");
                var replied = false;
                if (newestSent.TryGetValue(m.Thread, out var sid) && sid != m.Id && await Meta(access, sid, ct) is { } s) replied = s.Date >= h.Date;
                var subject = h.Subject.Length > SubjectMax ? h.Subject[..SubjectMax] + "…" : h.Subject;
                return new MailMeta(m.Id, m.Thread, subject, Clip(name), addr, h.Date,
                    MailRules.Addresses(h.To).Contains(me), MailRules.Addresses(h.Cc).Contains(me), fromMe, replied,
                    h.Labels.Select(l => labels.GetValueOrDefault(l, l)).ToList());
            }
            finally { gate.Release(); }
        }).ToList();
        foreach (var r in await Task.WhenAll(jobs)) if (r is not null) result.Add(r);
        return result.OrderByDescending(m => m.Date).ToList();
    }

    async Task<List<(string Id, string Thread)>> List(string access, string q, CancellationToken ct)
    {
        var url = $"{Gmail}/users/me/messages?q={Uri.EscapeDataString(q)}&maxResults={ListMax}";
        var list = new List<(string, string)>();
        if ((await Get(access, url, ct))?["messages"] is JsonArray arr)
            foreach (var n in arr)
                if (Str(n?["id"]) is { } id && Str(n?["threadId"]) is { } th && IdRx().IsMatch(id) && IdRx().IsMatch(th)) list.Add((id, th));
        return list;
    }

    /// <summary>Etiket kimliği → adı (kullanıcı etiketleri "Label_12" gibi kimlik taşır).</summary>
    async Task<Dictionary<string, string>> LabelNames(string access, CancellationToken ct)
    {
        var map = new Dictionary<string, string>();
        if ((await Get(access, $"{Gmail}/users/me/labels", ct))?["labels"] is JsonArray arr)
            foreach (var n in arr)
                if (Str(n?["id"]) is { } id && Str(n?["name"]) is { } name) map[id] = Clip(name);
        return map;
    }

    sealed record Head(string From, string To, string Cc, string Subject, long Date, List<string> Labels);

    /// <summary>Tek mesajın başlıkları: format=metadata + yalnız gereken başlıklar. Gövde (full/raw) asla istenmez.</summary>
    async Task<Head?> Meta(string access, string id, CancellationToken ct)
    {
        var url = $"{Gmail}/users/me/messages/{id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject";
        if (await Get(access, url, ct) is not { } j) return null;
        string H(string name) => (j["payload"]?["headers"] as JsonArray)?.FirstOrDefault(h => string.Equals(Str(h?["name"]), name, StringComparison.OrdinalIgnoreCase)) is { } x
            ? Str(x["value"]) ?? "" : "";
        var date = long.TryParse(Str(j["internalDate"]), NumberStyles.Integer, CultureInfo.InvariantCulture, out var d) ? d : 0;
        var labels = (j["labelIds"] as JsonArray)?.Select(Str).OfType<string>().ToList() ?? [];
        return new Head(H("From"), H("To"), H("Cc"), H("Subject"), date, labels);
    }

    // ---- Takvim ----

    public async Task<List<CalEvent>> Events(string access, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        string R(DateTimeOffset t) => t.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
        var url = $"{Calendar}/calendars/primary/events?timeMin={Uri.EscapeDataString(R(now))}&timeMax={Uri.EscapeDataString(R(now.AddHours(24)))}"
                  + $"&singleEvents=true&orderBy=startTime&maxResults={EventsMax}";
        var list = new List<CalEvent>();
        if ((await Get(access, url, ct))?["items"] is not JsonArray arr) return list;
        foreach (var n in arr)
        {
            if (n is null || Str(n["status"]) == "cancelled" || Str(n["id"]) is not { } id) continue;
            var (start, allDay) = When(n["start"]);
            var (end, _) = When(n["end"]);
            if (start == 0) continue;
            var join = Https(Str(n["hangoutLink"]))
                       ?? (n["conferenceData"]?["entryPoints"] as JsonArray)?.Where(e => Str(e?["entryPointType"]) == "video").Select(e => Https(Str(e?["uri"]))).FirstOrDefault(u => u is not null);
            var link = Https(Str(n["htmlLink"])) is { } h && (h.StartsWith("https://www.google.com/calendar/", StringComparison.Ordinal) || h.StartsWith("https://calendar.google.com/", StringComparison.Ordinal))
                ? h : "https://calendar.google.com/calendar/r";
            var updated = DateTimeOffset.TryParse(Str(n["updated"]), CultureInfo.InvariantCulture, DateTimeStyles.None, out var u) ? u.ToUnixTimeMilliseconds() : start;
            list.Add(new CalEvent(Clip(id), Clip(Str(n["summary"]) ?? ""), start, end, allDay, Str(n["location"]) is { } loc ? Clip(loc) : null, join, link, updated));
        }
        return list;
    }

    /// <summary>start/end: dateTime (RFC3339) ya da tüm gün etkinlikte date ("yyyy-mm-dd", yerel gün başı).</summary>
    static (long Ms, bool AllDay) When(JsonNode? n)
    {
        if (Str(n?["dateTime"]) is { } dt && DateTimeOffset.TryParse(dt, CultureInfo.InvariantCulture, DateTimeStyles.None, out var t)) return (t.ToUnixTimeMilliseconds(), false);
        if (Str(n?["date"]) is { } d && DateTime.TryParseExact(d, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.AssumeLocal, out var day))
            return (new DateTimeOffset(day).ToUnixTimeMilliseconds(), true);
        return (0, false);
    }

    // ---- Ortak ----

    /// <summary>
    /// GET + JSON. 401 → <see cref="MailAuthException"/>; 404 → null; diğer hata (403 kota/hız sınırı dahil) → HttpRequestException:
    /// geçici sayılır, kalıcı kilitlenmez.
    /// </summary>
    static async Task<JsonNode?> Get(string access, string url, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", access);
        using var res = await Http.SendAsync(req, ct);
        if (res.StatusCode is HttpStatusCode.Unauthorized) throw new MailAuthException("401");
        if (res.StatusCode is HttpStatusCode.NotFound) return null;
        if (!res.IsSuccessStatusCode) throw new HttpRequestException($"HTTP {(int)res.StatusCode}");
        try { return JsonNode.Parse(await res.Content.ReadAsStringAsync(ct)); }
        catch (System.Text.Json.JsonException) { throw new HttpRequestException("geçersiz yanıt"); }
    }

    static string? Str(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
    static string Clip(string s) => s.Length > TextMax ? s[..TextMax] + "…" : s;
    static string? Https(string? u) => u is not null && u.StartsWith("https://", StringComparison.Ordinal) && u.Length <= 1300 ? u : null;
}

using System.Collections.Concurrent;
using System.Text.Json;

namespace ClaudePanel;

/// <summary>
/// Takip → Mail ve Takvim: hesapların gelen kutusu (başlık meta verisi) ve önümüzdeki 24 saatin etkinlikleri. <see cref="Every"/>
/// aralıkla arka planda (panel penceresi kapalıyken de), "Yenile"de hemen. YALNIZ OKUR; süzme yereldir (<see cref="MailRules"/>),
/// mail içeriği hiçbir yere gönderilmez. Alınamazsa son bilinen liste kalır ("güncellenemedi"); ağ hatası kalıcı kilitlenmez
/// (<see cref="RetryAfter"/> sonra yeniden denenir). Yenileme belirteci <see cref="TokenStore"/>'da; erişim belirteci yalnız bellekte.
/// Son alınan listeler `mail-watch.json`'da (yeniden başlatmada ve ağ yokken gösterilir; belirteç içermez).
/// </summary>
public sealed class MailWatch
{
    static readonly string StateFile = Path.Combine(Handoff.DataDir, "mail-watch.json");
    static readonly TimeSpan Every = TimeSpan.FromMinutes(10), RetryAfter = TimeSpan.FromMinutes(2), TickEvery = TimeSpan.FromSeconds(30);
    const int FirstTickMs = 5000, MaxMails = 60;

    /// <param name="Fail">"" (başarılı) | "net" | "reauth" | "noclient".</param>
    sealed record Acct(long TriedAt = 0, long OkAt = 0, string Fail = "", List<MailMeta>? Mails = null, List<CalEvent>? Events = null);

    readonly MailSettings _settings;
    readonly ILogger<MailWatch> _log;
    readonly IMailProvider _google = new GoogleProvider();
    readonly ConcurrentDictionary<string, (string Access, long Expires)> _access = new();
    readonly object _gate = new();
    volatile Dictionary<string, Acct> _s = Load();
    int _running, _force;
    System.Threading.Timer? _timer;

    public MailWatch(MailSettings settings, MailLogin login, ILogger<MailWatch> log)
    {
        _settings = settings;
        _log = log;
        // Yeni giriş: erişim belirteci önbelleğe, hemen denetle.
        login.Completed += (id, tok) => { _access[id] = (tok.Access, tok.ExpiresAt); Update(id, a => a with { Fail = "" }); Poke(); };
    }

    public void Start() => _timer = new System.Threading.Timer(_ => Tick(), null, FirstTickMs, (int)TickEvery.TotalMilliseconds);

    public void Poke()
    {
        Interlocked.Exchange(ref _force, 1);
        Tick();
    }

    /// <summary>Hesap kaldırıldı: listeler ve bellekteki belirteç silinir.</summary>
    public void Forget(string id)
    {
        _access.TryRemove(id, out _);
        lock (_gate)
        {
            var d = new Dictionary<string, Acct>(_s);
            d.Remove(id);
            Save(_s = d);
        }
    }

    public MailSnapshot Snapshot()
    {
        var accounts = _settings.Accounts;
        if (accounts.Count == 0) return MailSnapshot.Off;
        var filter = _settings.Filter;
        var noClient = _settings.Client is null;
        var s = _s;
        var states = new List<MailAccountState>();
        var mails = new List<MailItem>();
        var events = new List<CalItem>();
        var now = Now();
        foreach (var a in accounts)
        {
            var st = s.GetValueOrDefault(a.Id) ?? new Acct();
            var state = noClient ? "noclient" : st.Fail is "reauth" or "net" ? st.Fail : st.OkAt == 0 ? "pending" : "ok";
            states.Add(new MailAccountState(a.Id, a.Email, a.Mail, a.Cal, a.MailGranted, a.CalGranted, state, st.OkAt, st.TriedAt));
            if (a.Mail)
                foreach (var m in st.Mails ?? [])
                    if (MailRules.Match(m, filter) is { Count: > 0 } rules)
                        mails.Add(new MailItem(a.Email, m.Id, m.ThreadId, m.Subject, m.FromName, m.FromAddr, m.Date, rules, rules.Contains("awaiting"), GmailUrl(a.Email, m.ThreadId)));
            if (a.Cal)
                foreach (var e in st.Events ?? [])
                    if ((e.End > 0 ? e.End : e.Start) > now && e.Start < now + 86_400_000)
                        events.Add(new CalItem(a.Email, e.Id, e.Title, e.Start, e.End, e.AllDay, e.Location, e.Join, e.Url, e.Updated));
        }
        var known = accounts.Select(a => s.GetValueOrDefault(a.Id)).OfType<Acct>().ToList();
        return new MailSnapshot(noClient ? "noclient" : "ok", states,
            mails.OrderByDescending(m => m.Awaiting).ThenByDescending(m => m.Date).Take(MaxMails).ToList(),
            events.OrderBy(e => e.Start).ToList(),
            known.Count == 0 ? 0 : known.Max(k => k.OkAt), known.Any(k => k.Fail.Length > 0 && k.OkAt > 0), _running == 1,
            accounts.Any(a => a.Mail), accounts.Any(a => a.Cal), filter.Empty);
    }

    /// <summary>Gmail'de konuşmayı açan adres (hesap seçili). Konuşma kimliği sağlayıcıda doğrulandı (harf/rakam).</summary>
    static string GmailUrl(string email, string thread) => $"https://mail.google.com/mail/?authuser={Uri.EscapeDataString(email)}#all/{thread}";

    void Tick()
    {
        var accounts = _settings.Accounts.Where(a => a.Mail || a.Cal).ToList();
        if (accounts.Count == 0) return;
        var forced = Interlocked.Exchange(ref _force, 0) == 1;
        var now = Now();
        var due = accounts.Where(a => forced || _s.GetValueOrDefault(a.Id) is not { } st
            || now - st.TriedAt >= (st.Fail.Length == 0 ? Every : RetryAfter).TotalMilliseconds).ToList();
        if (due.Count == 0) return;
        if (Interlocked.Exchange(ref _running, 1) == 1) { if (forced) Interlocked.Exchange(ref _force, 1); return; }
        _ = Task.Run(async () =>
        {
            try { foreach (var a in due) await Fetch(a); }
            finally { Interlocked.Exchange(ref _running, 0); }
            if (Interlocked.CompareExchange(ref _force, 0, 0) == 1) Tick(); // sürerken "Yenile"ye basıldı
        });
    }

    async Task Fetch(MailAccount a)
    {
        var now = Now();
        if (_settings.Client is not { } client) { Update(a.Id, s => s with { TriedAt = now, Fail = "noclient" }); return; }
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(90));
        try
        {
            List<MailMeta>? mails = null;
            List<CalEvent>? events = null;
            for (var attempt = 0; ; attempt++)
            {
                var token = await Access(a.Id, client, cts.Token);
                try
                {
                    if (a.Mail) mails = await _google.Mails(token, a.Email, cts.Token);
                    if (a.Cal) events = await _google.Events(token, cts.Token);
                    break;
                }
                catch (MailAuthException) when (attempt == 0) { _access.TryRemove(a.Id, out _); } // süresi dolmuş erişim belirteci: bir kez yenile
            }
            Update(a.Id, s => s with { TriedAt = now, OkAt = now, Fail = "", Mails = mails ?? s.Mails, Events = events ?? s.Events });
            _log.LogInformation("Mail/takvim denetlendi: {M} konuşma, {E} etkinlik", mails?.Count ?? 0, events?.Count ?? 0);
        }
        catch (MailAuthException ex)
        {
            _access.TryRemove(a.Id, out _);
            _log.LogInformation("Mail hesabı yeniden giriş istiyor ({Why})", ex.Message);
            Update(a.Id, s => s with { TriedAt = now, Fail = "reauth" });
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or IOException)
        {
            // Son bilinen liste silinmez: "alamadım" boş liste değildir.
            _log.LogInformation("Mail/takvim alınamadı: {Msg}", ex.Message);
            Update(a.Id, s => s with { TriedAt = now, Fail = "net" });
        }
    }

    async Task<string> Access(string id, GoogleClient client, CancellationToken ct)
    {
        if (_access.TryGetValue(id, out var c) && c.Expires > Now()) return c.Access;
        var refresh = TokenStore.Load(MailSettings.TokenName(id)) ?? throw new MailAuthException("belirteç yok");
        var tok = await GoogleProvider.Refresh(client, refresh, ct);
        _access[id] = (tok.Access, tok.ExpiresAt);
        return tok.Access;
    }

    void Update(string id, Func<Acct, Acct> change)
    {
        lock (_gate)
        {
            if (_settings.Find(id) is null) return; // bu arada kaldırıldı
            var d = new Dictionary<string, Acct>(_s) { [id] = change(_s.GetValueOrDefault(id) ?? new Acct()) };
            Save(_s = d);
        }
    }

    void Save(Dictionary<string, Acct> s)
    {
        try
        {
            Directory.CreateDirectory(Handoff.DataDir);
            var tmp = StateFile + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(s));
            File.Move(tmp, StateFile, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.LogDebug("Mail durumu yazılamadı: {Msg}", ex.Message);
        }
    }

    static Dictionary<string, Acct> Load()
    {
        try { return File.Exists(StateFile) ? JsonSerializer.Deserialize<Dictionary<string, Acct>>(File.ReadAllText(StateFile)) ?? [] : []; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { return []; }
    }

    static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
}

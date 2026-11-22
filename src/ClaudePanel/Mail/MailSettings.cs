using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace ClaudePanel;

/// <param name="Secret">Masaüstü uygulaması istemcisinin gizli değeri (Google'a göre isteğe bağlı).</param>
public sealed record GoogleClient(string Id, string? Secret);

/// <summary>
/// Mail ve takvim ayarları (kalıcı, panel veri klasöründe `mail-settings.json`): hesap listesi, kaynak kutuları, süzgeç.
/// Token ve OAuth istemci dosyası burada DEĞİL: <see cref="TokenStore"/>'da (Windows DPAPI / Mac Anahtar Zinciri).
/// Hesap adresi yalnız girişten gelir; ayarlarda elle yazılmaz.
/// </summary>
public sealed partial class MailSettings(ILogger<MailSettings> log)
{
    static readonly string FilePath = Path.Combine(Handoff.DataDir, "mail-settings.json");
    const string ClientKey = "google-client";
    const int MaxAccounts = 10;

    sealed record Saved(List<MailAccount>? Accounts = null, MailFilter? Filter = null);

    volatile Saved _s = Load();
    readonly object _gate = new();
    GoogleClient? _client;
    bool _clientRead;

    public IReadOnlyList<MailAccount> Accounts => _s.Accounts ?? [];
    public MailFilter Filter => _s.Filter ?? new();
    public bool Full => Accounts.Count >= MaxAccounts;

    public static string TokenName(string accountId) => "mail-token-" + accountId;

    public void SetFilter(MailFilter f) => Update(s => s with
    {
        Filter = f with { Senders = MailRules.Clean(f.Senders), Keywords = MailRules.Clean(f.Keywords), Labels = MailRules.Clean(f.Labels) }
    });

    /// <summary>Aynı adresli hesap varsa onu günceller (yeniden giriş), yoksa ekler. Dönen: kaydın kimliği.</summary>
    public string Upsert(string provider, string email, bool mail, bool cal)
    {
        string id = "";
        Update(s =>
        {
            var list = (s.Accounts ?? []).ToList();
            var i = list.FindIndex(a => a.Provider == provider && string.Equals(a.Email, email, StringComparison.OrdinalIgnoreCase));
            if (i >= 0)
            {
                id = list[i].Id;
                list[i] = list[i] with { Email = email, Mail = mail, Cal = cal, MailGranted = mail, CalGranted = cal };
            }
            else
            {
                id = Guid.NewGuid().ToString("N")[..12];
                list.Add(new MailAccount(id, provider, email, mail, cal, mail, cal, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
            }
            return s with { Accounts = list };
        });
        return id;
    }

    public static string IcalName(string accountId) => "mail-ical-" + accountId;

    /// <summary>
    /// IMAP (uygulama şifresi) hesabı: aynı adres varsa günceller. Mail her zaman açık/izinli; takvim yalnız iCal adresi verildiyse açılır
    /// (adres önceden kayıtlıysa korunur). Dönen: kaydın kimliği.
    /// </summary>
    public string UpsertImap(string email, bool newIcal)
    {
        string id = "";
        Update(s =>
        {
            var list = (s.Accounts ?? []).ToList();
            var i = list.FindIndex(a => a.Provider == "imap" && string.Equals(a.Email, email, StringComparison.OrdinalIgnoreCase));
            if (i >= 0)
            {
                id = list[i].Id;
                list[i] = list[i] with { Email = email, Mail = true, MailGranted = true, Cal = newIcal || list[i].Cal, CalGranted = newIcal || list[i].CalGranted };
            }
            else
            {
                id = Guid.NewGuid().ToString("N")[..12];
                list.Add(new MailAccount(id, "imap", email, true, newIcal, true, newIcal, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
            }
            return s with { Accounts = list };
        });
        return id;
    }

    public MailAccount? Find(string? id) => Accounts.FirstOrDefault(a => a.Id == id);

    /// <summary>Kaynağı kapatır (izin istenmeden). Açma izin gerektiriyorsa giriş akışından geçer (<see cref="MailLogin"/>).</summary>
    public void SetSources(string id, bool mail, bool cal) => Update(s => s with
    {
        Accounts = (s.Accounts ?? []).Select(a => a.Id == id ? a with { Mail = mail && a.MailGranted, Cal = cal && a.CalGranted } : a).ToList()
    });

    /// <summary>Hesabı ve yenileme belirtecini siler.</summary>
    public MailAccount? Remove(string id)
    {
        var a = Find(id);
        if (a is null) return null;
        Update(s => s with { Accounts = (s.Accounts ?? []).Where(x => x.Id != id).ToList() });
        TokenStore.Delete(TokenName(id));
        TokenStore.Delete(IcalName(id));
        log.LogInformation("Mail hesabı kaldırıldı ({Provider}), belirteç silindi", a.Provider);
        return a;
    }

    // ---- OAuth istemci dosyası ----

    public GoogleClient? Client
    {
        get
        {
            lock (_gate)
            {
                if (!_clientRead)
                {
                    _clientRead = true;
                    try { _client = TokenStore.Load(ClientKey) is { } j ? JsonSerializer.Deserialize<GoogleClient>(j) : null; }
                    catch (JsonException) { _client = null; }
                }
                return _client;
            }
        }
    }

    public bool SaveClient(GoogleClient c)
    {
        lock (_gate)
        {
            if (!TokenStore.Save(ClientKey, JsonSerializer.Serialize(c))) return false;
            _client = c; _clientRead = true;
        }
        log.LogInformation("Google istemci dosyası kaydedildi (şifreli)");
        return true;
    }

    [GeneratedRegex(@"^[A-Za-z0-9._-]{8,200}$")] private static partial Regex IdRx();

    /// <summary>
    /// Google Cloud Console'dan indirilen istemci JSON'u. Yalnız masaüstü uygulaması türü ("installed") kabul edilir.
    /// Hata: "web" (web uygulaması türü) | "invalid". İçerik loga/yanıta yazılmaz.
    /// </summary>
    public static (GoogleClient? Client, string? Error) ParseClient(string? json)
    {
        if (string.IsNullOrWhiteSpace(json) || json.Length > 20_000) return (null, "invalid");
        JsonNode? root;
        try { root = JsonNode.Parse(json); }
        catch (JsonException) { return (null, "invalid"); }
        if (root is not JsonObject o) return (null, "invalid");
        if (o["installed"] is not JsonObject inst) return (null, o["web"] is not null ? "web" : "invalid");
        var id = Str(inst["client_id"]);
        var secret = Str(inst["client_secret"]);
        if (id is null || !IdRx().IsMatch(id)) return (null, "invalid");
        if (secret is not null && (secret.Length > 200 || secret.Any(char.IsControl))) return (null, "invalid");
        return (new GoogleClient(id, secret), null);
    }

    static string? Str(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) && s.Length > 0 ? s : null;

    // ---- Kalıcılık ----

    void Update(Func<Saved, Saved> change)
    {
        lock (_gate)
        {
            var next = change(_s);
            _s = next;
            try
            {
                Directory.CreateDirectory(Handoff.DataDir);
                var tmp = FilePath + ".tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(next));
                File.Move(tmp, FilePath, overwrite: true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                log.LogWarning("Mail ayarları yazılamadı: {Msg}", ex.Message);
            }
        }
    }

    static Saved Load()
    {
        try { return File.Exists(FilePath) ? JsonSerializer.Deserialize<Saved>(File.ReadAllText(FilePath)) ?? new() : new(); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { return new(); }
    }
}

using System.Net;
using System.Text.Json;

namespace ClaudePanel;

/// <summary>
/// Dış servis anahtarları (ElevenLabs, OpenRouter, Gemini API): Ayarlar → Hesaplar'daki "Bağlan" akışı.
/// Anahtar önce servisin ücretsiz bir okuma ucuyla denenir; geçerse işletim sisteminin şifreli kasasına yazılır
/// (TokenStore: Windows'ta DPAPI, macOS'ta Anahtar Zinciri). Anahtar loga, yanıt gövdesine, adrese (URL) ve düz dosyaya
/// yazılmaz; arayüze yalnız son 4 karakteri ve denemeden gelen gizli olmayan bilgi (kalan karakter, limit) gider.
/// Uçlar yalnız bilgisayardan çağrılır (HubEndpoints.cs). Test: CLAUDE_PANEL_KEYTEST_BASE (yalnız 127.0.0.1/localhost)
/// deneme isteklerini sahte sunucuya yönlendirir (tools/sahte_anahtar.py).
/// </summary>
public static class ApiKeys
{
    /// <param name="KeyPage">Kullanıcının anahtarı oluşturduğu sayfa (panel anahtar oluşturmaz, yalnız sayfayı açar).</param>
    public sealed record Provider(string Id, string Name, string KeyPage);

    /// <summary>Denemeden gelen, gizli olmayan bilgi. Kasadaki anahtarın kendisi burada yoktur.</summary>
    public sealed record Info(string Last4, long At, long? Remaining = null, long? Limit = null, string? Tier = null,
        double? Balance = null, bool? NoLimit = null, int? Models = null);

    /// <summary>Deneme sonucu. Error: null (geçti) | "badkey" | "noperm" | "nobalance" | "network" | "http" | "store".</summary>
    public sealed record Result(string? Error, int? Status = null, Info? Info = null);

    public static readonly IReadOnlyList<Provider> Providers =
    [
        new("elevenlabs", "ElevenLabs", "https://elevenlabs.io/app/settings/api-keys"),
        new("openrouter", "OpenRouter", "https://openrouter.ai/settings/keys"),
        new("gemini", "Gemini API", "https://aistudio.google.com/apikey")
    ];

    static readonly string StateFile = Path.Combine(Handoff.DataDir, "api-keys.json");
    static readonly object Lock = new();
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(12) };
    const int MinLength = 8, MaxLength = 400;

    static string? TestBase =>
        Environment.GetEnvironmentVariable("CLAUDE_PANEL_KEYTEST_BASE") is { Length: > 0 } b
        && (b.StartsWith("http://127.0.0.1:", StringComparison.Ordinal) || b.StartsWith("http://localhost:", StringComparison.Ordinal)) ? b.TrimEnd('/') : null;

    public static Provider? Find(string? id) => Providers.FirstOrDefault(p => p.Id == id);
    static string SecretName(string id) => "apikey-" + id;

    /// <summary>Kasadaki anahtar (işi yapan kod için); yoksa null. Arayüze verilmez.</summary>
    public static string? Get(string id) => Find(id) is null ? null : TokenStore.Load(SecretName(id));

    /// <summary>Anahtar bağlı mı (deneme bilgisi kayıtlı mı). Kasaya her sorguda gidilmez.</summary>
    public static bool Has(string id) => Load().ContainsKey(id);

    public static IReadOnlyDictionary<string, Info> Status()
    {
        lock (Lock) return Load();
    }

    static Dictionary<string, Info> Load()
    {
        try
        {
            if (File.Exists(StateFile) && JsonSerializer.Deserialize<Dictionary<string, Info>>(File.ReadAllText(StateFile)) is { } d) return d;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { }
        return [];
    }

    static void Update(Action<Dictionary<string, Info>> change)
    {
        lock (Lock)
        {
            var d = Load();
            change(d);
            try
            {
                Directory.CreateDirectory(Handoff.DataDir);
                var tmp = StateFile + ".tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(d));
                File.Move(tmp, StateFile, overwrite: true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                RemoteLog.Info($"Anahtar durumu yazılamadı: {ex.Message}"); // hata metninde anahtar yok (yalnız dosya yolu)
            }
        }
    }

    /// <summary>Başlık değerine girebilecek, makul uzunlukta bir anahtar mı. Değilse ağa çıkılmaz.</summary>
    static string? Clean(string? key)
    {
        var k = key?.Trim();
        return k is { Length: >= MinLength and <= MaxLength } && k.All(c => c is > ' ' and < (char)127) ? k : null;
    }

    /// <summary>Anahtarı dener; geçerse kasaya yazar ve durumu kaydeder. Geçmezse eski anahtar yerinde kalır.</summary>
    public static async Task<Result> TestAndSave(Provider p, string? key)
    {
        if (Clean(key) is not { } k) return new("badkey");
        var r = await Test(p, k);
        if (r.Error is not null) return r;
        if (!TokenStore.Save(SecretName(p.Id), k)) return new("store");
        Update(d => d[p.Id] = r.Info!);
        return r;
    }

    /// <summary>Kasadaki anahtarı yeniden dener (kalan karakter/limit yenilenir). Anahtar artık geçmiyorsa kayıt silinmez, hata döner.</summary>
    public static async Task<Result> Recheck(Provider p)
    {
        if (Get(p.Id) is not { } k) return new("badkey");
        var r = await Test(p, k);
        if (r.Error is null) Update(d => d[p.Id] = r.Info!);
        return r;
    }

    public static void Remove(Provider p)
    {
        TokenStore.Delete(SecretName(p.Id));
        Update(d => d.Remove(p.Id));
    }

    /// <summary>
    /// Ücretsiz deneme isteği. Anahtar yalnız istek başlığında gider (Gemini'de de x-goog-api-key başlığı: adrese yazılmaz).
    /// Uçlar: ElevenLabs GET /v1/user/subscription, OpenRouter GET /api/v1/key, Gemini GET /v1beta/models.
    /// </summary>
    static async Task<Result> Test(Provider p, string key)
    {
        var (url, header, value) = p.Id switch
        {
            "elevenlabs" => ((TestBase is { } b ? b + "/elevenlabs" : "https://api.elevenlabs.io") + "/v1/user/subscription", "xi-api-key", key),
            "openrouter" => ((TestBase is { } b ? b + "/openrouter" : "https://openrouter.ai") + "/api/v1/key", "Authorization", "Bearer " + key),
            _ => ((TestBase is { } b ? b + "/gemini" : "https://generativelanguage.googleapis.com") + "/v1beta/models", "x-goog-api-key", key)
        };
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.TryAddWithoutValidation(header, value);
            using var res = await Http.SendAsync(req);
            var body = await res.Content.ReadAsStringAsync();
            var code = (int)res.StatusCode;
            if (res.StatusCode is HttpStatusCode.PaymentRequired or HttpStatusCode.TooManyRequests) return new("nobalance", code);
            // ElevenLabs: anahtar geçerli ama "User: Read" izni verilmemişse de 401 döner; ayrı söylenir.
            if (p.Id == "elevenlabs" && code == 401 && body.Contains("missing_permissions", StringComparison.Ordinal)) return new("noperm", code);
            if (code is 400 or 401 or 403) return new("badkey", code);
            if (!res.IsSuccessStatusCode) return new("http", code);
            var info = Parse(p.Id, body, new Info(key[^4..], DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
            if (info is null) return new("http", code);
            var empty = info.Remaining is <= 0 || info.Balance is <= 0;
            return empty ? new("nobalance", code) : new(null, code, info);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or IOException) { return new("network"); }
    }

    /// <summary>Yanıttan gizli olmayan bilgi; beklenen biçimde değilse null.</summary>
    static Info? Parse(string id, string body, Info info)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var r = doc.RootElement;
            if (r.ValueKind != JsonValueKind.Object) return null;
            static long? Long(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n) ? n : null;
            switch (id)
            {
                case "elevenlabs":
                    if (Long(r, "character_count") is not { } used || Long(r, "character_limit") is not { } limit) return null;
                    return info with { Remaining = Math.Max(0, limit - used), Limit = limit, Tier = r.TryGetProperty("tier", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null };
                case "openrouter":
                    if (!r.TryGetProperty("data", out var d) || d.ValueKind != JsonValueKind.Object) return null;
                    // limit_remaining: anahtara konmuş harcama sınırından kalan; sınır yoksa null.
                    return d.TryGetProperty("limit_remaining", out var left) && left.ValueKind == JsonValueKind.Number
                        ? info with { Balance = left.GetDouble() } : info with { NoLimit = true };
                default:
                    return r.TryGetProperty("models", out var m) && m.ValueKind == JsonValueKind.Array ? info with { Models = m.GetArrayLength() } : null;
            }
        }
        catch (JsonException) { return null; }
    }
}

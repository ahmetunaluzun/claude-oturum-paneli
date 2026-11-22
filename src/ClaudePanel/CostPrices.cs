using System.Text.RegularExpressions;

namespace ClaudePanel;

/// <summary>
/// Model fiyatları (USD / milyon token), Proje maliyeti için. TEK KAYNAK burasıdır.
/// Kaynak: Anthropic "Pricing" sayfası, https://platform.claude.com/docs/en/about-claude/pricing
/// (docs.claude.com/en/docs/about-claude/pricing buraya yönlenir), 2026-11-22'de okundu.
/// Sayfadaki kurallar: 5 dk önbelleğe yazma = 1,25 × girdi, 1 saat önbelleğe yazma = 2 × girdi; önbellekten okuma çoğu
/// modelde 0,1 × girdi, Opus 5.5 / Sonnet 5.5'te 0,05 ×, Fable/Mythos 5.1–5.2'de 0,025 ×. Hızlı mod (usage.speed = "fast")
/// yalnız tabloda hızlı fiyatı olan modellerde; önbellek çarpanları hızlı girdi fiyatının üstüne uygulanır. inference_geo "us"
/// tüm kalemlerde 1,1 ×. Haiku 5.5: isteğin istem boyu (girdi + önbellekten okuma + önbelleğe yazma) 100.000'i aşarsa yüksek
/// fiyat. Web araması 1.000 aramada 10 USD. Tabloda olmayan model (ör. Claude 3.x) için maliyet "bilinmiyor" sayılır.
/// Mythos kimlikleri sayfada yazmıyor; Fable ile aynı adlandırma varsayıldı (eşleşmezse yalnız "bilinmiyor" olur).
/// </summary>
public static partial class CostPrices
{
    public const string Source = "https://platform.claude.com/docs/en/about-claude/pricing";
    public const string AsOf = "2026-11-22";

    /// <param name="In">Girdi</param><param name="Out">Çıktı</param><param name="ReadMult">Önbellekten okuma çarpanı</param>
    /// <param name="FastIn">Hızlı mod girdi (yoksa null)</param><param name="FastOut">Hızlı mod çıktı</param>
    public sealed record Price(double In, double Out, double ReadMult, double? FastIn = null, double? FastOut = null);

    static readonly Dictionary<string, Price> Table = new(StringComparer.OrdinalIgnoreCase)
    {
        ["claude-fable-5-2"] = new(8, 40, 0.025, 16, 80),
        ["claude-mythos-5-2"] = new(8, 40, 0.025, 16, 80),
        ["claude-fable-5-1"] = new(10, 50, 0.025),
        ["claude-mythos-5-1"] = new(10, 50, 0.025),
        ["claude-fable-5"] = new(10, 50, 0.1),
        ["claude-mythos-5"] = new(10, 50, 0.1),
        ["claude-opus-5-5"] = new(4, 20, 0.05, 8, 40),
        ["claude-opus-5"] = new(5, 25, 0.1, 10, 50),
        ["claude-opus-4-8"] = new(5, 25, 0.1, 10, 50),
        ["claude-opus-4-7"] = new(5, 25, 0.1),
        ["claude-opus-4-6"] = new(5, 25, 0.1),
        ["claude-opus-4-5"] = new(5, 25, 0.1),
        ["claude-opus-4-1"] = new(15, 75, 0.1),
        ["claude-opus-4"] = new(15, 75, 0.1),
        ["claude-sonnet-5-5"] = new(2, 10, 0.05),
        ["claude-sonnet-5"] = new(2, 10, 0.1),
        ["claude-sonnet-4-6"] = new(3, 15, 0.1),
        ["claude-sonnet-4-5"] = new(3, 15, 0.1),
        ["claude-sonnet-4"] = new(3, 15, 0.1),
        ["claude-haiku-5-5"] = new(0.10, 0.50, 0.1),
        ["claude-haiku-4-5"] = new(1, 5, 0.1),
    };
    static readonly Price Haiku55Long = new(0.50, 2.50, 0.1);
    const long Haiku55Threshold = 100_000;
    const double WebSearchUsd = 10.0 / 1000;

    // "claude-haiku-4-5-20251001" → "claude-haiku-4-5"; "claude-opus-5-5[1m]" → "claude-opus-5-5"
    [GeneratedRegex(@"(\[[^\]]*\])|(-\d{8})$")]
    private static partial Regex Suffix();

    public static string Normalize(string model) => Suffix().Replace(Suffix().Replace(model.Trim(), ""), "");

    public static bool Known(string? model) => model is not null && Table.ContainsKey(Normalize(model));

    /// <summary>Tek yanıtın maliyeti (USD); model ya da hızlı mod fiyatı tabloda yoksa null (uydurulmaz).</summary>
    public static double? Cost(string? model, long input, long output, long read, long write5m, long write1h,
        bool fast, bool us, long webSearches)
    {
        if (model is null || !Table.TryGetValue(Normalize(model), out var p)) return null;
        if (Normalize(model).Equals("claude-haiku-5-5", StringComparison.OrdinalIgnoreCase)
            && input + read + write5m + write1h > Haiku55Threshold) p = Haiku55Long;
        double inP = p.In, outP = p.Out;
        if (fast)
        {
            if (p.FastIn is not { } fi || p.FastOut is not { } fo) return null;
            inP = fi; outP = fo;
        }
        var usd = (input * inP + output * outP + read * inP * p.ReadMult + write5m * inP * 1.25 + write1h * inP * 2) / 1_000_000;
        if (us) usd *= 1.1;
        return usd + webSearches * WebSearchUsd;
    }
}

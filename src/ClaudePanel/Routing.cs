namespace ClaudePanel;

/// <summary>
/// Ayarlar → İş yönlendirme: her iş türü için araç sırası (kullanıcı değiştirir, hub.json'da kalır). Claude listede açık ve
/// bağlı olan ilk aracı kullanır; hiçbiri yoksa işi kendi yoluyla yapar (yedek yol, arayüzde iş türüne göre anlatılır).
/// Şirket işinde (proje şirket hesabına kayıtlı ya da Musteri-Isleri / Simphony altında) kişisel araçlar (Google: Gemini,
/// Higgsfield) atlanır: şirket ve müşteri verisi kişisel hesaba gitmez. GET /api/routing?project=&lt;yol&gt; (HubEndpoints.cs).
/// </summary>
public static class Routing
{
    public sealed record Job(string Id, IReadOnlyList<string> Tools);

    /// <summary>Varsayılan sıralar (onaylı taslak, _onizleme/ayarlar-taslak).</summary>
    public static readonly IReadOnlyList<Job> Jobs =
    [
        new("image", ["gemini", "openrouter", "higgsfield"]),
        new("video", ["higgsfield", "gemini"]),
        new("summary", ["gemini", "codex"]),
        new("translate", ["gemini", "codex"]),
        new("review", ["codex"])
    ];

    /// <summary>Yalnız kişisel işte kullanılan araçlar (kişisel Google hesabı, Higgsfield).</summary>
    public static readonly IReadOnlySet<string> PersonalOnly = new HashSet<string> { "gemini", "higgsfield" };

    static readonly string[] CompanyFolders = ["Musteri-Isleri", "Simphony"];
    const string CompanyAccount = "claude-is";

    public static Job? Find(string? id) => Jobs.FirstOrDefault(j => j.Id == id);

    /// <summary>Kayıtlı sıra; kayıt yoksa ya da araç kümesi değişmişse (eski kayıt) varsayılan.</summary>
    public static List<string> Order(Job j) =>
        HubSettings.Get().Routes is { } r && r.TryGetValue(j.Id, out var saved) && IsPermutation(saved, j.Tools) ? saved : [.. j.Tools];

    static bool IsPermutation(IReadOnlyCollection<string> a, IReadOnlyCollection<string> b) =>
        a.Count == b.Count && a.Distinct().Count() == a.Count && a.All(b.Contains);

    /// <summary>Sırayı kaydeder; aynı araçların başka bir sırası değilse false.</summary>
    public static bool SetOrder(Job j, List<string>? order)
    {
        if (order is null || !IsPermutation(order, j.Tools)) return false;
        HubSettings.Update(s => s with { Routes = new Dictionary<string, List<string>>(s.Routes ?? []) { [j.Id] = order } });
        return true;
    }

    /// <summary>Aracın durumu: "on" (açık ve bağlı) | "off" (işçi kapalı) | "none" (kurulu/bağlı değil) | "checking".</summary>
    public static string Status(string tool) => tool switch
    {
        "codex" => !Workers.Enabled("codex") ? "off" : CodexSessions.Installed ? "on" : "none",
        "gemini" => !Workers.Enabled("gemini") ? "off"
            : ApiKeys.Has("gemini") || Workers.Gemini().State == "ok" ? "on"
            : Workers.Gemini().State == "checking" ? "checking" : "none",
        "openrouter" => ApiKeys.Has("openrouter") ? "on" : "none",
        _ => "none" // higgsfield: panelde bağlantısı yok
    };

    /// <summary>Şirket işi mi: proje şirket hesabına kayıtlı ya da yolunda Musteri-Isleri / Simphony klasörü var.</summary>
    public static bool IsCompany(string? project)
    {
        if (string.IsNullOrWhiteSpace(project)) return false;
        var parts = project.Split('\\', '/');
        if (parts.Any(p => CompanyFolders.Any(c => p.Equals(c, StringComparison.OrdinalIgnoreCase)))) return true;
        return ProjectAccounts.Of(project) is { } id && id.TrimStart('.').Equals(CompanyAccount, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Her iş türü için sıra, araç durumları ve seçilen araç (use: null = Claude'un kendi yolu).</summary>
    public static object Snapshot(string? project)
    {
        var company = IsCompany(project);
        return new
        {
            company,
            jobs = Jobs.Select(j =>
            {
                var chain = Order(j).Select(t => new
                {
                    tool = t, status = Status(t), personal = PersonalOnly.Contains(t), skipped = company && PersonalOnly.Contains(t)
                }).ToList();
                return new { id = j.Id, chain, use = chain.FirstOrDefault(c => c.status == "on" && !c.skipped)?.tool };
            })
        };
    }
}

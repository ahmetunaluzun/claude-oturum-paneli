using System.Text.Json;
using System.Text.RegularExpressions;

namespace ClaudePanel;

public sealed record SkillInfo(string Name, string Description, string Summary, string Source, bool Active,
    string Category, string Path);

/// <summary>"Hangi iş → hangi skill" satırı (kullanıcının skill-yonlendirme.md tablosundan).</summary>
public sealed record SkillGuide(string Task, IReadOnlyList<string> Skills, string Note);

public sealed record SkillLibrary(IReadOnlyList<SkillInfo> Skills, IReadOnlyList<SkillGuide> Guide,
    IReadOnlyList<CategoryCount> Categories);

public sealed record CategoryCount(string Key, int Count);

/// <summary>
/// Skill kütüphanesi: ~/.claude/skills (etkin), ~/.claude/skills-disabled (havuz) ve kurulu eklentilerin skill'leri.
/// Yalnız SKILL.md başlığı okunur; hiçbir şey değiştirilmez. Kategori, ad+açıklamadaki anahtar kelimelerle atanır.
/// </summary>
public sealed class Skills(ILogger<Skills> log)
{
    static readonly string ClaudeDir = System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude");
    SkillLibrary? _cache;
    DateTime _cachedAt;

    // Sıra önemli: ilk eşleşen kategori kazanır. Anahtarlar küçük harf, kelime parçası olarak aranır.
    static readonly (string Key, string[] Words)[] Rules =
    [
        ("claude", ["skill", "claude", "agent", "subagent", "hook", "plugin", "mcp", "prompt", "orchestrat", "workflow", "checkpoint", "context", "memory", "loop", "brainstorm", "plan", "swarm", "superpowers", "reflexion", "instinct"]),
        ("office", ["docx", "word", "pptx", "slide", "presentation", "xlsx", "excel", "spreadsheet", "pdf", "sunum", "belge", "document"]),
        ("security", ["security", "vulnerab", "pentest", "exploit", "fuzz", "sanitizer", "audit", "secret", "cve", "malware", "crypto", "smart contract", "güvenlik"]),
        ("testing", ["test", "tdd", "qa ", "coverage", "playwright", "e2e", "quality gate", "verify"]),
        ("media", ["image", "video", "audio", "voice", "speech", "music", "thumbnail", "photo", "gif", "animation", "seedance", "higgsfield", "cinemat", "görsel"]),
        ("design", ["design", "ui ", "ux", "frontend", "css", "tailwind", "figma", "brand", "theme", "typography", "diagram", "chart", "visual", "canvas", "arayüz"]),
        ("api", ["api", "openapi", "postman", "rest", "graphql", "webhook", "endpoint", "mock"]),
        ("data", ["sql", "database", "postgres", "mongo", "data ", "dataset", "pandas", "analytics", "etl", "veritaban"]),
        ("dotnet", [".net", "dotnet", "c#", "csharp", "asp.net", "akka", "blazor", "nuget", "wpf", "maui"]),
        ("python", ["python", "django", "fastapi", "pytest", "uv ", "ruff"]),
        ("web", ["react", "next.js", "nextjs", "vue", "svelte", "javascript", "typescript", "node", "web ", "website", "html"]),
        ("devops", ["git", "github", "ci", "deploy", "docker", "kubernetes", "terraform", "cloud", "aws", "azure", "build", "release"]),
        ("research", ["research", "search", "scrape", "crawl", "web fetch", "youtube", "reddit", "twitter", "rss", "araştır"]),
        ("business", ["market", "seo", "sales", "pricing", "founder", "startup", "email", "mail", "content", "copywrit", "social", "ads"]),
        ("finance", ["trading", "trade", "crypto", "stock", "backtest", "quant", "finance", "portfolio"]),
        ("science", ["scien", "bio", "chem", "physics", "math", "statistic", "genom", "molecul", "research paper"]),
    ];

    public SkillLibrary List()
    {
        if (_cache is not null && DateTime.UtcNow - _cachedAt < TimeSpan.FromMinutes(2)) return _cache;
        var list = new List<SkillInfo>();
        Scan(System.IO.Path.Combine(ClaudeDir, "skills"), "user", true, list);
        Scan(System.IO.Path.Combine(ClaudeDir, "skills-disabled"), "pool", false, list);
        ScanCommands(System.IO.Path.Combine(ClaudeDir, "commands"), list);
        foreach (var (name, path) in InstalledPlugins())
        {
            Scan(System.IO.Path.Combine(path, "skills"), "plugin:" + name, true, list);
        }
        var skills = list
            .GroupBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
            .Select(g => g.OrderBy(s => s.Source == "user" ? 0 : s.Source.StartsWith("plugin") ? 1 : 2).First())
            .OrderByDescending(s => s.Active).ThenBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
        var cats = skills.GroupBy(s => s.Category).Select(g => new CategoryCount(g.Key, g.Count()))
            .OrderByDescending(c => c.Count).ToList();
        _cache = new SkillLibrary(skills, ReadGuide(), cats);
        _cachedAt = DateTime.UtcNow;
        return _cache;
    }

    /// <summary>Yalnız kurulu eklenti sürümleri (önbellekteki eski sürüm klasörleri sayılmaz).</summary>
    IEnumerable<(string Name, string Path)> InstalledPlugins()
    {
        var file = System.IO.Path.Combine(ClaudeDir, "plugins", "installed_plugins.json");
        if (!File.Exists(file)) yield break;
        JsonDocument doc;
        try { doc = JsonDocument.Parse(File.ReadAllText(file)); }
        catch (Exception ex) when (ex is IOException or JsonException)
        {
            log.LogDebug("installed_plugins.json okunamadı: {Msg}", ex.Message);
            yield break;
        }
        using (doc)
        {
            if (!doc.RootElement.TryGetProperty("plugins", out var plugins)) yield break;
            foreach (var p in plugins.EnumerateObject())
            {
                var name = p.Name.Split('@')[0];
                foreach (var inst in p.Value.EnumerateArray())
                    if (inst.TryGetProperty("installPath", out var ip) && ip.GetString() is { } path && Directory.Exists(path))
                        yield return (name, path);
            }
        }
    }

    /// <summary>Kullanıcının kendi / komutları (~/.claude/commands/*.md): açıklama başlıktan ya da ilk satırdan.</summary>
    void ScanCommands(string dir, List<SkillInfo> list)
    {
        if (!Directory.Exists(dir)) return;
        foreach (var md in Directory.EnumerateFiles(dir, "*.md"))
        {
            try
            {
                var (_, desc) = Frontmatter(md);
                desc ??= File.ReadLines(md).Select(l => l.Trim().TrimStart('#').Trim()).FirstOrDefault(l => l.Length > 0) ?? "";
                var name = System.IO.Path.GetFileNameWithoutExtension(md);
                list.Add(new SkillInfo(name, desc, Summary(desc), "command", true, "claude", md));
            }
            catch (IOException ex)
            {
                log.LogDebug("Komut okunamadı {Path}: {Msg}", md, ex.Message);
            }
        }
    }

    void Scan(string dir, string source, bool active, List<SkillInfo> list)
    {
        if (!Directory.Exists(dir)) return;
        foreach (var sub in Directory.EnumerateDirectories(dir))
        {
            var md = System.IO.Path.Combine(sub, "SKILL.md");
            if (!File.Exists(md)) continue;
            try
            {
                var (name, desc) = Frontmatter(md);
                name ??= System.IO.Path.GetFileName(sub);
                desc ??= "";
                list.Add(new SkillInfo(name, desc, Summary(desc), source, active, Categorize(name, desc, source), sub));
            }
            catch (IOException ex)
            {
                log.LogDebug("Skill okunamadı {Path}: {Msg}", md, ex.Message);
            }
        }
    }

    /// <summary>
    /// Önce ad + eklenti adına bakılır (güçlü işaret). Bulunamazsa açıklamaya bakılır; ama "claude" kategorisi
    /// açıklamadan atanmaz, çünkü hemen her açıklamada "skill/agent/context" geçer.
    /// </summary>
    static string Categorize(string name, string desc, string source)
    {
        var head = $" {name.Replace('-', ' ').Replace('_', ' ')} {source.Replace("plugin:", "").Replace("skills", "").Replace('-', ' ')} ".ToLowerInvariant();
        foreach (var (key, words) in Rules)
            if (words.Any(w => Has(head, w))) return key;
        var body = $" {desc} ".ToLowerInvariant();
        string? best = null;
        var bestHits = 0;
        foreach (var (key, words) in Rules)
        {
            if (key == "claude") continue;
            var hits = words.Count(w => Has(body, w));
            if (hits > bestHits) { best = key; bestHits = hits; }
        }
        return best ?? "other";
    }

    /// <summary>Kısa anahtar (≤4 harf) tam kelime olarak aranır: "ci" decision'da, "git" digital'de eşleşmesin.</summary>
    static bool Has(string text, string w) =>
        w.Trim().Length > 4 ? text.Contains(w) : Regex.IsMatch(text, $@"(?<![a-z0-9]){Regex.Escape(w.Trim())}(?![a-z0-9])");

    /// <summary>İlk cümle (en fazla 160 karakter); "Use when..." gibi tetik cümleleri öne alınmaz.</summary>
    static string Summary(string desc)
    {
        var d = desc.Trim();
        var m = Regex.Match(d, @"^(.{20,160}?[.!?])(\s|$)");
        var s = m.Success ? m.Groups[1].Value : d;
        return s.Length > 160 ? s[..157] + "…" : s;
    }

    /// <summary>~/.claude/rules/skill-yonlendirme.md tablosundan "İş | Kullan | Not" satırları (varsa).</summary>
    IReadOnlyList<SkillGuide> ReadGuide()
    {
        var file = System.IO.Path.Combine(ClaudeDir, "rules", "skill-yonlendirme.md");
        if (!File.Exists(file)) return [];
        var result = new List<SkillGuide>();
        try
        {
            foreach (var line in File.ReadLines(file))
            {
                if (!line.StartsWith('|') || line.StartsWith("|---") || line.Contains("| İş |")) continue;
                var cells = line.Trim().Trim('|').Split('|').Select(c => c.Trim()).ToArray();
                if (cells.Length < 2) continue;
                var names = Regex.Matches(cells[1], "`/?([a-z0-9][a-z0-9:_-]+)`")
                    .Select(m => m.Groups[1].Value)
                    .Where(n => !n.Contains('.') && !n.EndsWith("-md") && !n.StartsWith("feedback_") && !n.StartsWith("project_"))
                    .Distinct().ToList();
                if (names.Count == 0) continue;
                var note = cells.Length > 2 ? Clean(cells[2]) : "";
                result.Add(new SkillGuide(Clean(cells[0]), names, note.Length > 220 ? note[..217] + "…" : note));
            }
        }
        catch (IOException ex)
        {
            log.LogDebug("Skill rehberi okunamadı: {Msg}", ex.Message);
        }
        return result;
    }

    static string Clean(string s) => Regex.Replace(s.Replace("**", "").Replace("`", ""), @"\s+", " ").Trim();

    /// <summary>YAML başlığından name ve description (tek satır ya da katlanmış çok satır).</summary>
    static (string? Name, string? Desc) Frontmatter(string path)
    {
        using var r = new StreamReader(path);
        if (r.ReadLine()?.Trim() != "---") return (null, null);
        string? name = null, desc = null;
        string? line;
        var inDesc = false;
        var sb = new System.Text.StringBuilder();
        for (var i = 0; i < 80 && (line = r.ReadLine()) is not null; i++)
        {
            if (line.Trim() == "---") break;
            if (inDesc && (line.StartsWith(' ') || line.StartsWith('\t')))
            {
                sb.Append(' ').Append(line.Trim());
                continue;
            }
            inDesc = false;
            if (line.StartsWith("name:")) name = Unquote(line[5..]);
            else if (line.StartsWith("description:"))
            {
                var v = line[12..].Trim();
                if (v is "|" or ">" or "|-" or ">-" or "") { inDesc = true; sb.Clear(); }
                else desc = Unquote(v);
            }
        }
        if (desc is null && sb.Length > 0) desc = sb.ToString().Trim();
        if (desc is { Length: > 1200 }) desc = desc[..1200] + " …";
        return (name, desc);
    }

    static string Unquote(string s)
    {
        s = s.Trim();
        return s.Length >= 2 && (s[0] == '"' || s[0] == '\'') && s[^1] == s[0] ? s[1..^1] : s;
    }
}

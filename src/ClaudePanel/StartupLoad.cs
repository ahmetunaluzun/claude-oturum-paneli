using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;

namespace ClaudePanel;

/// <summary>
/// Açılış yükü (Skill kütüphanesi): oturumun ilk yanıtında modele giden bağlam. Ölçülen: son oturumların İLK asistan
/// yanıtındaki girdi + önbellekten okuma + önbelleğe yazma. Dağılım TAHMİNİDİR: her oturumda yüklenen metinlerin karakter
/// sayısı / <see cref="CharsPerToken"/>. Ölçülemeyen kalem (MCP araç tanımları, sistem istemi) uydurulmaz.
/// Panel hiçbir dosyayı değiştirmez, yalnız okur. Uydurma ortamda (CLAUDE_PANEL_CLAUDE_DIR) gerçek ~/.claude okunmaz.
/// </summary>
public sealed class StartupLoad(ILogger<StartupLoad> log, Skills skills)
{
    /// <summary>Karakter / token oranı (TEK YER). Türkçe ağırlıklı metinde yaklaşık değer; arayüzde "tahmini" etiketiyle.</summary>
    public const double CharsPerToken = 3.5;
    public const int SampleCount = 40;
    const int MaxLinesPerFile = 400;
    const long MaxBytesPerFile = 8 << 20;

    static readonly string ProjectsDir = Path.Combine(Quota.ClaudeDir, "projects");
    static readonly bool Isolated = Environment.GetEnvironmentVariable("CLAUDE_PANEL_CLAUDE_DIR") is { Length: > 0 };
    static readonly string RealClaudeDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude");
    readonly ConcurrentDictionary<string, (long Ctx, string? Cwd, long Ts)> _first = new(StringComparer.OrdinalIgnoreCase);

    public sealed record Sample(string Cwd, long Ctx, long Ts, string ProjectDir);
    /// <param name="Kind">global | rule | projectMd | parentMd | projectRule | memory | skill | mcp</param>
    /// <param name="Tokens">tahmini token; null = ölçülemedi</param>
    public sealed record Item(string Kind, string Label, string? Path, long Chars, long? Tokens, string? Source = null);

    public object Get(string? cwd)
    {
        var samples = Samples();
        var ctx = samples.Select(s => s.Ctx).OrderBy(x => x).ToList();
        var cwds = samples.Select(s => s.Cwd).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        // İstemciden gelen klasör yalnız ölçülen oturumlardan biriyse kullanılır (rastgele yol okunmaz).
        var pick = cwd is not null && cwds.Contains(cwd, StringComparer.OrdinalIgnoreCase) ? cwd : cwds.FirstOrDefault();
        var projectDir = pick is null ? null : samples.First(s => s.Cwd.Equals(pick, StringComparison.OrdinalIgnoreCase)).ProjectDir;
        var items = pick is null ? [] : Items(pick, projectDir!);
        long? median = ctx.Count == 0 ? null : ctx.Count % 2 == 1 ? ctx[ctx.Count / 2] : (ctx[ctx.Count / 2 - 1] + ctx[ctx.Count / 2]) / 2;
        var estimate = items.Sum(i => i.Tokens ?? 0);
        return new
        {
            sessions = ctx.Count, min = ctx.FirstOrDefault(), median, max = ctx.LastOrDefault(),
            charsPerToken = CharsPerToken, cwd = pick, cwds, items, estimate,
            rest = median is { } m ? m - estimate : (long?)null
        };
    }

    /// <summary>Son oturumların ilk yanıtındaki bağlam (en yeni önce). Alt ajan kayıtları sayılmaz.</summary>
    List<Sample> Samples()
    {
        if (!Directory.Exists(ProjectsDir)) return [];
        var files = Directory.EnumerateDirectories(ProjectsDir)
            .SelectMany(d => Directory.EnumerateFiles(d, "*.jsonl").Select(f => (File: new FileInfo(f), Dir: d)))
            .OrderByDescending(x => x.File.LastWriteTimeUtc).Take(SampleCount * 2);
        var list = new List<Sample>();
        foreach (var (f, dir) in files)
        {
            if (!_first.TryGetValue(f.FullName, out var v))
            {
                if (FirstContext(f.FullName) is not { } found) continue; // henüz yanıt yok: önbelleğe alınmaz, sonra yeniden bakılır
                _first[f.FullName] = v = found;
            }
            if (v.Cwd is null) continue;
            list.Add(new Sample(v.Cwd.TrimEnd('\\', '/'), v.Ctx, v.Ts, dir));
            if (list.Count >= SampleCount) break;
        }
        return list;
    }

    (long Ctx, string? Cwd, long Ts)? FirstContext(string path)
    {
        try
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var r = new StreamReader(fs, new UTF8Encoding(false));
            string? cwd = null;
            for (var i = 0; i < MaxLinesPerFile && fs.Position <= MaxBytesPerFile && r.ReadLine() is { } line; i++)
            {
                if (line.Length < 3) continue;
                try
                {
                    using var doc = JsonDocument.Parse(line);
                    var e = doc.RootElement;
                    if (e.TryGetProperty("isSidechain", out var sc) && sc.ValueKind == JsonValueKind.True) continue;
                    cwd ??= e.TryGetProperty("cwd", out var c) && c.ValueKind == JsonValueKind.String ? c.GetString() : null;
                    if (!e.TryGetProperty("type", out var t) || t.GetString() != "assistant") continue;
                    if (!e.TryGetProperty("message", out var m) || !m.TryGetProperty("usage", out var u)) continue;
                    var ctx = Num(u, "input_tokens") + Num(u, "cache_read_input_tokens") + Num(u, "cache_creation_input_tokens");
                    if (ctx == 0) continue; // "<synthetic>" yanıt
                    var ts = e.TryGetProperty("timestamp", out var tsv) && DateTimeOffset.TryParse(tsv.GetString(), out var d)
                        ? d.ToUnixTimeMilliseconds() : 0;
                    return (ctx, cwd, ts);
                }
                catch (JsonException) { /* bozuk satır */ }
            }
        }
        catch (IOException ex) { log.LogDebug("Açılış yükü: kayıt okunamadı {Path}: {Msg}", path, ex.Message); }
        return null;
    }

    static long Num(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n) ? n : 0;

    List<Item> Items(string cwd, string projectDir)
    {
        var list = new List<Item>();
        var global = Path.Combine(Quota.ClaudeDir, "CLAUDE.md");
        AddFile(list, "global", global);
        var rules = Path.Combine(Quota.ClaudeDir, "rules");
        if (Directory.Exists(rules))
            foreach (var f in Directory.EnumerateFiles(rules, "*.md", SearchOption.AllDirectories).OrderBy(f => f, StringComparer.OrdinalIgnoreCase))
                AddFile(list, "rule", f, Path.GetRelativePath(rules, f));
        // Proje ve üst klasörlerdeki CLAUDE.md'ler (Claude Code çalışma klasöründen köke kadar okur).
        for (var d = new DirectoryInfo(cwd); d is not null; d = d.Parent)
        {
            var kind = d.FullName.TrimEnd('\\', '/').Equals(cwd, StringComparison.OrdinalIgnoreCase) ? "projectMd" : "parentMd";
            foreach (var name in new[] { "CLAUDE.md", Path.Combine(".claude", "CLAUDE.md"), "CLAUDE.local.md" })
            {
                var f = Path.Combine(d.FullName, name);
                if (f.Equals(global, StringComparison.OrdinalIgnoreCase) || ForbiddenReal(f)) continue;
                AddFile(list, kind, f, Path.Combine(d.Name, name)); // "Alfa Projesi\CLAUDE.md"; tam yol Path'te
            }
        }
        var projRules = Path.Combine(cwd, ".claude", "rules");
        if (Directory.Exists(projRules) && !ForbiddenReal(projRules))
            foreach (var f in Directory.EnumerateFiles(projRules, "*.md", SearchOption.AllDirectories))
                AddFile(list, "projectRule", f, Path.GetRelativePath(cwd, f));
        AddFile(list, "memory", Path.Combine(projectDir, "memory", "MEMORY.md"), "MEMORY.md");
        foreach (var s in skills.List().Skills.Where(s => s.Active))
        {
            var chars = s.Name.Length + s.Description.Length + 4;
            list.Add(new Item("skill", s.Name, null, chars, Tok(chars), s.Source));
        }
        foreach (var (name, source) in McpServers(cwd)) list.Add(new Item("mcp", name, null, 0, null, source));
        return list;
    }

    /// <summary>Uydurma ortamda gerçek ~/.claude altındaki dosya okunmaz (üst klasör yürüyüşü oraya varabilir).</summary>
    static bool ForbiddenReal(string path) =>
        Isolated && path.StartsWith(RealClaudeDir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    static long Tok(long chars) => (long)Math.Round(chars / CharsPerToken);

    void AddFile(List<Item> list, string kind, string path, string? label = null)
    {
        if (!File.Exists(path)) return;
        try
        {
            var chars = File.ReadAllText(path).Length;
            list.Add(new Item(kind, label ?? Path.GetFileName(path), path, chars, Tok(chars)));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            log.LogDebug("Açılış yükü: dosya okunamadı {Path}: {Msg}", path, ex.Message);
        }
    }

    /// <summary>MCP sunucu adları: ~/.claude/settings.json, ~/.claude.json (genel + bu proje), proje .mcp.json, eklentiler.</summary>
    IEnumerable<(string Name, string Source)> McpServers(string cwd)
    {
        var found = new List<(string, string)>();
        var home = Path.GetDirectoryName(Quota.ClaudeDir.TrimEnd('\\', '/'));
        ReadMcp(Path.Combine(Quota.ClaudeDir, "settings.json"), "settings.json", found, null);
        if (home is not null) ReadMcp(Path.Combine(home, ".claude.json"), ".claude.json", found, cwd);
        ReadMcp(Path.Combine(cwd, ".mcp.json"), ".mcp.json", found, null);
        foreach (var (plugin, path) in skills.InstalledPlugins())
            ReadMcp(Path.Combine(path, ".mcp.json"), "plugin:" + plugin, found, null, topLevelServers: true);
        return found.DistinctBy(x => x.Item1, StringComparer.OrdinalIgnoreCase);
    }

    void ReadMcp(string file, string source, List<(string, string)> found, string? projectCwd, bool topLevelServers = false)
    {
        if (!File.Exists(file) || ForbiddenReal(file)) return;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(file));
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return;
            if (root.TryGetProperty("mcpServers", out var servers) && servers.ValueKind == JsonValueKind.Object)
                foreach (var p in servers.EnumerateObject()) found.Add((p.Name, source));
            else if (topLevelServers)
                foreach (var p in root.EnumerateObject().Where(p => p.Value.ValueKind == JsonValueKind.Object)) found.Add((p.Name, source));
            if (projectCwd is null || !root.TryGetProperty("projects", out var projects) || projects.ValueKind != JsonValueKind.Object) return;
            var want = projectCwd.Replace('\\', '/').TrimEnd('/');
            foreach (var p in projects.EnumerateObject())
                if (p.Name.Replace('\\', '/').TrimEnd('/').Equals(want, StringComparison.OrdinalIgnoreCase)
                    && p.Value.TryGetProperty("mcpServers", out var ps) && ps.ValueKind == JsonValueKind.Object)
                    foreach (var s in ps.EnumerateObject()) found.Add((s.Name, source));
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            log.LogDebug("Açılış yükü: MCP ayarı okunamadı {File}: {Msg}", file, ex.Message);
        }
    }
}

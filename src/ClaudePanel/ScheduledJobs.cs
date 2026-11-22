using System.Text;
using System.Text.RegularExpressions;

namespace ClaudePanel;

/// <summary>Takip'te gösterilen işletim sistemi görevi: OsTask + eşleşen proje + gösterilecek yol.</summary>
/// <param name="Root">Eylemin altında durduğu proje kökü; proje eşleşmediyse null.</param>
/// <param name="Reveal">"Klasörde göster" hedefi (betik, çalışma klasörü ya da program); yoksa null.</param>
/// <param name="Log">Görevin logu (var olan dosya ya da klasör, TaskLogs.cs); bulunamadıysa null.</param>
/// <param name="Cwd">"Claude'a incelet" oturumunun klasörü: proje kökü, yoksa çalışma klasörü, yoksa betiğin klasörü; yoksa null.</param>
public sealed record SchedTask(string Id, string Name, string Folder, bool Enabled, long? NextRun, long? LastRun, long? LastResult,
    string Command, string? Schedule, string? Root, string? Project, string? Reveal, bool CanDisable, bool Unreadable, string? Log = null, string? Cwd = null, bool Running = false);

/// <param name="State">"ok" | "failed" (zamanlayıcı okunamadı).</param>
/// <param name="Kind">"windows" | "mac" | "test".</param>
public sealed record SchedOs(string State, string Kind, IReadOnlyList<SchedTask> Tasks);

/// <summary>Projedeki .claude/scheduled_tasks.json (ve .lock). Biçim belgesiz: içerik AYRIŞTIRILMAZ, yalnız varlık + tarih.</summary>
public sealed record SchedFile(string Name, string Root, string Path, bool HasJson, bool HasLock, long Mtime);

/// <summary>Masaüstü uygulaması görevi: ~/.claude/scheduled-tasks/&lt;ad&gt;/SKILL.md. Zamanlama dosyada yoktur.</summary>
public sealed record SchedDesktop(string Name, string Path, string Prompt, long Mtime);

/// <summary>NEXT_SESSION.md'deki "TAKİP: YYYY-AA-GG — metin" satırı. Date null: satır okunamadı (biçim ya da tarih geçersiz).</summary>
/// <param name="Date">Yerel gece yarısı, Unix ms.</param>
public sealed record SchedPromise(string Name, string Root, string File, int Line, long? Date, string Text);

/// <param name="QuotaLow">Kota düşükken (5 saatlik ya da haftalık kalan eşiğin altında) tekrarlı iş uyarısı için kalan yüzdeler; değilse null.</param>
public sealed record SchedQuota(double? FiveLeft, double? WeekLeft);

public sealed record FollowSched(SchedOs Os, IReadOnlyList<SchedFile> Files, IReadOnlyList<SchedDesktop> Desktop, IReadOnlyList<SchedPromise> Promises)
{
    public static readonly FollowSched Empty = new(new SchedOs("ok", OsTasks.Kind, []), [], [], []);
}

/// <summary>
/// Takip → "Zamanlanmış işler" kaynakları (0.14.0). Hepsi yalnız OKUR; panel kendiliğinden hiçbir şeyi durdurmaz ya da
/// devre dışı bırakmaz (kullanıcı düğmeye basar, onay verir: ScheduleEndpoints.cs).
///   1) İşletim sistemi zamanlayıcısı: eylemi bilinen bir proje kökünün (ya da ~/.claude'un) altında olan ya da
///      claude / python / PowerShell betiği çalıştıran görevler. \Microsoft\ altındaki sistem görevleri yalnız proje eşleşirse.
///   2) Claude'un kalıcı görev dosyaları (.claude/scheduled_tasks.json: yalnız "var" + tarih) ve masaüstü uygulaması görevleri.
///   3) Verilmiş sözler: projelerin NEXT_SESSION.md'sindeki "TAKİP: YYYY-AA-GG — metin" satırları.
/// Açık oturumlardaki /loop, CronCreate, ScheduleWakeup: LoopScan.cs (her okumada canlı).
/// </summary>
public sealed partial class ScheduledJobs(SessionStore store, HostedSessions hosted, LoopScan loops)
{
    /// <summary>Bu yüzdelerin altında tekrarlı iş için kota uyarısı gösterilir (5 saatlik / haftalık kalan).</summary>
    const double QuotaWarnFive = 30, QuotaWarnWeek = 30;

    /// <summary>
    /// "Kaydet ve kapat" / "Kaydet ve temizle" ve gece modu istemlerine eklenen cümle: oturumun verdiği ileri tarihli söz
    /// NEXT_SESSION.md'ye Takip'in okuduğu satır biçimiyle yazılır (ScanPromises).
    /// </summary>
    public const string PromiseRule =
        "Bu oturumda kullanıcıya ileri tarihli bir söz verdiysen ya da belli bir tarihte yapılacak bir kontrol kaldıysa " +
        "(ör. \"yarın bakarım\", \"cuma günü yeniden deneriz\"), her biri için proje kökündeki NEXT_SESSION.md'ye ayrı satırda, satır başında, " +
        "tam şu biçimde yaz: `TAKİP: YYYY-AA-GG — yapılacak iş` (gerçek takvim tarihi; panel bu satırları Takip sekmesinde gösterir, " +
        "tarihi gelince öne alır). Söz yerine getirildiyse satırını sil. Böyle bir söz yoksa satır ekleme.";
    const int MaxBytes = 2 * 1024 * 1024, TextMax = 240;
    const string NextFile = "NEXT_SESSION.md";
    static readonly string[] ScriptExt = [".py", ".pyw", ".ps1", ".sh"];
    static readonly HashSet<string> Runners = new(StringComparer.OrdinalIgnoreCase) { "claude", "py", "pyw", "pwsh", "powershell" };

    [GeneratedRegex("\"([^\"]+)\"|'([^']+)'|(\\S+)")] private static partial Regex Token();
    [GeneratedRegex(@"^[\s>*+\-]*(?:\*\*|__)?TAKİP:(?:\*\*|__)?\s*(.*)$")] private static partial Regex PromiseLine();
    [GeneratedRegex(@"^(\d{4})-(\d{2})-(\d{2})\s+—\s+(\S.*)$")] private static partial Regex PromiseBody();

    public FollowSched Scan(IReadOnlyList<Transcripts.ProjectInfo> projects)
    {
        var dirs = projects.Select(p => ProjectRoots.Normalize(p.Cwd)).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var roots = dirs.Concat(dirs.Select(ProjectRoots.Of)).Distinct(StringComparer.OrdinalIgnoreCase).Where(Directory.Exists).ToList();
        return new FollowSched(ScanOs(roots), ScanFiles(roots), ScanDesktop(), ScanPromises(dirs));
    }

    // ---- 1) İşletim sistemi zamanlayıcısı ----

    static SchedOs ScanOs(List<string> roots)
    {
        var all = OsTasks.List();
        if (all is null) return new SchedOs("failed", OsTasks.Kind, []);
        var list = new List<SchedTask>();
        foreach (var t in all)
        {
            if (t.Unreadable) { list.Add(new SchedTask(t.Id, t.Name, t.Folder, t.Enabled, null, null, null, "", null, null, null, t.Id, false, true)); continue; }
            if (Match(t, roots) is not { } m) continue;
            var command = (Path.GetFileName(t.Command) + " " + t.Args).Trim();
            var script = TaskLogs.ScriptOf(t, m.Script);
            var cwd = m.Root ?? (Directory.Exists(t.WorkDir) ? t.WorkDir : script is not null ? Path.GetDirectoryName(script) : null);
            list.Add(new SchedTask(t.Id, t.Name, t.Folder, t.Enabled, t.NextRun, t.LastRun, t.LastResult, Shorten(command), t.Schedule,
                m.Root, m.Root is null ? null : Path.GetFileName(m.Root), m.Reveal, t.CanDisable, false, TaskLogs.Find(t, script),
                cwd is not null && Directory.Exists(cwd) ? cwd : null, t.Running));
        }
        return new SchedOs("ok", OsTasks.Kind, list.OrderBy(t => t.Name, StringComparer.CurrentCultureIgnoreCase).ToList());
    }

    /// <summary>Görev Takip'i ilgilendiriyor mu; ilgilendiriyorsa eşleşen proje kökü ve gösterilecek yol.</summary>
    public static (string? Root, string? Reveal, string? Script)? Match(OsTask t, IReadOnlyList<string> roots)
    {
        var paths = new List<string>();
        if (t.Command.Length > 0) paths.Add(t.Command);
        if (t.WorkDir.Length > 0) paths.Add(t.WorkDir);
        foreach (Match m in Token().Matches(t.Args))
        {
            var v = (m.Groups[1].Success ? m.Groups[1] : m.Groups[2].Success ? m.Groups[2] : m.Groups[3]).Value.Trim('"', '\'', ';', ',', '&', '(', ')');
            // "-File=C:\x.ps1" gibi birleşik argümanda yol kısmı
            var eq = v.IndexOf('=');
            if (eq > 0 && eq < v.Length - 1 && !Path.IsPathFullyQualified(v)) v = v[(eq + 1)..];
            if (v.Length > 2 && (Path.IsPathFullyQualified(v) || IsScript(v))) paths.Add(v);
        }
        // Göreli betik adı çalışma klasörüne göre çözülür.
        var full = paths.Select(p => Path.IsPathFullyQualified(p) ? p : t.WorkDir.Length > 0 ? Path.Combine(t.WorkDir, p) : p)
            .Select(ProjectRoots.Normalize).ToList();
        var root = roots.Where(r => full.Any(p => Under(p, r))).OrderByDescending(r => r.Length).FirstOrDefault();
        var exe = Path.GetFileNameWithoutExtension(t.Command);
        var runner = Runners.Contains(exe) || exe.StartsWith("python", StringComparison.OrdinalIgnoreCase);
        var script = full.FirstOrDefault(IsScript);
        var claudeDir = full.Any(p => Under(p, ProjectRoots.Normalize(Quota.ClaudeDir)));
        var system = t.Folder.StartsWith(@"\Microsoft", StringComparison.OrdinalIgnoreCase);
        if (root is null && (system || !(runner || script is not null || claudeDir))) return null;
        var reveal = script ?? full.Skip(1).FirstOrDefault(p => root is not null && Under(p, root)) ?? (t.WorkDir.Length > 0 ? t.WorkDir : t.Command);
        return (root, Path.IsPathFullyQualified(reveal) ? reveal : null, script is not null && Path.IsPathFullyQualified(script) ? script : null);
    }

    static bool IsScript(string p) => ScriptExt.Any(e => p.EndsWith(e, StringComparison.OrdinalIgnoreCase));

    static bool Under(string path, string root) =>
        path.Length >= root.Length && path.StartsWith(root, StringComparison.OrdinalIgnoreCase)
        && (path.Length == root.Length || path[root.Length] is '\\' or '/');

    // ---- 2) Claude'un kalıcı görev dosyaları ----

    static List<SchedFile> ScanFiles(List<string> roots)
    {
        var list = new List<SchedFile>();
        foreach (var root in roots)
        {
            try
            {
                var json = new FileInfo(Path.Combine(root, ".claude", "scheduled_tasks.json"));
                var lck = new FileInfo(Path.Combine(root, ".claude", "scheduled_tasks.lock"));
                if (!json.Exists && !lck.Exists) continue;
                var f = json.Exists ? json : lck;
                list.Add(new SchedFile(Path.GetFileName(root) is { Length: > 0 } n ? n : root, ProjectRoots.Of(root), f.FullName, json.Exists, lck.Exists,
                    new DateTimeOffset(f.LastWriteTimeUtc).ToUnixTimeMilliseconds()));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* kayıt başına: sonraki proje */ }
        }
        return list.OrderBy(f => f.Name, StringComparer.CurrentCultureIgnoreCase).ThenBy(f => f.Path, StringComparer.OrdinalIgnoreCase).ToList();
    }

    static List<SchedDesktop> ScanDesktop()
    {
        var list = new List<SchedDesktop>();
        var dir = Path.Combine(Quota.ClaudeDir, "scheduled-tasks");
        try
        {
            if (!Directory.Exists(dir)) return list;
            foreach (var d in Directory.EnumerateDirectories(dir).OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
            {
                var f = new FileInfo(Path.Combine(d, "SKILL.md"));
                if (!f.Exists) continue;
                list.Add(new SchedDesktop(Path.GetFileName(d), f.FullName, f.Length > MaxBytes ? "" : FirstPromptLine(f.FullName),
                    new DateTimeOffset(f.LastWriteTimeUtc).ToUnixTimeMilliseconds()));
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        return list;
    }

    /// <summary>SKILL.md'nin ön bilgi (--- … ---) bloğundan sonraki ilk dolu satırı.</summary>
    static string FirstPromptLine(string file)
    {
        var front = false;
        var n = 0;
        foreach (var raw in File.ReadLines(file, Encoding.UTF8).Take(200))
        {
            var line = raw.Trim();
            if (n++ == 0 && line == "---") { front = true; continue; }
            if (front) { if (line == "---") front = false; continue; }
            if (line.Length > 0) return Shorten(line.TrimStart('#', ' '));
        }
        return "";
    }

    // ---- 3) Verilmiş sözler ----

    static List<SchedPromise> ScanPromises(List<string> dirs)
    {
        var list = new List<SchedPromise>();
        foreach (var dir in dirs)
        {
            try
            {
                var f = new FileInfo(Path.Combine(dir, NextFile));
                if (!f.Exists || f.Length > MaxBytes) continue;
                var name = Path.GetFileName(dir) is { Length: > 0 } n ? n : dir;
                var root = ProjectRoots.Of(dir);
                foreach (var (date, text, line) in ParsePromises(File.ReadAllText(f.FullName, Encoding.UTF8)))
                    list.Add(new SchedPromise(name, root, f.FullName, line, date, text));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* kayıt başına: sonraki proje */ }
        }
        return list.OrderBy(p => p.Date ?? long.MinValue).ToList();
    }

    /// <summary>
    /// Satır başında (liste/alıntı işaretinden sonra) "TAKİP:" olan satırlar. Biçim tam "TAKİP: YYYY-AA-GG — metin";
    /// uymayan ya da tarihi geçersiz satır atlanmaz: Date = null ("okunamadı"). Kod bloğu içindeki satırlar alınmaz.
    /// </summary>
    public static List<(long? Date, string Text, int Line)> ParsePromises(string text)
    {
        var list = new List<(long?, string, int)>();
        var lines = text.Replace("\r\n", "\n").Split('\n');
        var fence = false;
        for (var i = 0; i < lines.Length; i++)
        {
            if (lines[i].TrimStart().StartsWith("```", StringComparison.Ordinal)) { fence = !fence; continue; }
            if (fence || PromiseLine().Match(lines[i]) is not { Success: true } m) continue;
            var body = m.Groups[1].Value.Trim().TrimEnd('*', '_').Trim();
            long? date = null;
            if (PromiseBody().Match(body) is { Success: true } b)
            {
                int y = int.Parse(b.Groups[1].Value), mo = int.Parse(b.Groups[2].Value), d = int.Parse(b.Groups[3].Value);
                if (y >= 2000 && mo is >= 1 and <= 12 && d >= 1 && d <= DateTime.DaysInMonth(y, mo))
                {
                    date = new DateTimeOffset(new DateTime(y, mo, d, 0, 0, 0, DateTimeKind.Local)).ToUnixTimeMilliseconds();
                    body = b.Groups[4].Value;
                }
            }
            list.Add((date, Shorten(body.Replace("**", "").Replace("`", "")), i + 1));
        }
        return list;
    }

    static string Shorten(string s)
    {
        s = s.Trim();
        return s.Length > TextMax ? s[..(TextMax - 1)].TrimEnd() + "…" : s;
    }

    // ---- Açık oturumlardaki tekrarlı işler + kota ----

    public List<LoopInfo> Loops()
    {
        var hostedList = hosted.List();
        var open = hostedList.Where(h => h.SessionId is not null && h.Status != "ended")
            .Select(h => new LoopScan.OpenSession(h.SessionId!, h.Key, null, h.Name ?? Path.GetFileName(h.Cwd.TrimEnd('\\', '/')), h.Cwd))
            .Concat(store.List().Where(s => !string.IsNullOrEmpty(s.SessionId))
                .Select(s => new LoopScan.OpenSession(s.SessionId, null, s.Pid, s.CustomName ?? s.Name, s.Cwd)));
        return loops.Scan(open);
    }

    /// <summary>Kota düşükse kalan yüzdeler (yalnız önbellekten; ağa çıkmaz); değilse ya da bilinmiyorsa null.</summary>
    public static SchedQuota? QuotaLow()
    {
        var q = Quota.Read(fetch: false);
        if (q is null) return null;
        var low = q.Five.Left is < QuotaWarnFive || q.Week.Left is < QuotaWarnWeek;
        return low ? new SchedQuota(q.Five.Left, q.Week.Left) : null;
    }
}

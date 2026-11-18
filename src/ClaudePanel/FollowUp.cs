using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

namespace ClaudePanel;

/// <param name="NoUpstream">Dalın izlediği uzak dal yok (uzak depo var).</param>
public sealed record FollowRepo(string Name, string Path, string Branch, int Dirty, int Ahead, bool NoUpstream);

/// <param name="State">"ok" | "nogit" (git bulunamadı).</param>
public sealed record FollowGit(string State, IReadOnlyList<FollowRepo> Repos, int Clean, int Failed);

/// <param name="Root">Proje kökü (git kökü; yoksa klasör): oturumdaki projeyi tanımak için.</param>
public sealed record FollowNext(string Name, string Cwd, long UpdatedAt, string Summary, string Root);

public sealed record FollowSnapshot(long CheckedAt, bool Scanning, FollowGit Git, IReadOnlyList<FollowNext> Next, UpdateInfo Updates);

/// <summary>
/// "Takip" sekmesinin kota harcamayan kaynakları: bilinen projelerin git durumu, NEXT_SESSION.md dosyaları ve
/// güncellemeler (UpdateCheck). Tarama arka planda yapılır, sonuç önbellekte durur; ağ yalnız güncelleme denetiminde kullanılır
/// (git fetch yapılmaz). Yeni kaynak (takvim, mail) eklenirken: anlık görüntüye alan + Scan'e adım.
/// </summary>
public sealed partial class FollowUp(Transcripts transcripts, UpdateCheck updates, ILogger<FollowUp> log)
{
    static readonly TimeSpan StaleAfter = TimeSpan.FromSeconds(150);
    const int GitTimeoutMs = 5000;
    const int SummaryMax = 140;
    const string NextFile = "NEXT_SESSION.md";

    static readonly FollowSnapshot Empty = new(0, true, new FollowGit("ok", [], 0, 0), [], UpdateInfo.Unknown);
    volatile FollowSnapshot _snap = Empty;
    int _scanning;

    /// <summary>Son anlık görüntü; bayatsa (ya da hiç yoksa) arka planda yeniler.</summary>
    public FollowSnapshot Get()
    {
        var s = _snap;
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - s.CheckedAt > StaleAfter.TotalMilliseconds) Refresh();
        return s with { Scanning = _scanning == 1 };
    }

    /// <summary>Arka planda yeniden tarar (aynı anda tek tarama).</summary>
    public void Refresh()
    {
        if (Interlocked.Exchange(ref _scanning, 1) == 1) return;
        _ = Task.Run(async () =>
        {
            try { _snap = await Scan(); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
            {
                log.LogWarning("Takip taraması yarıda kaldı: {Msg}", ex.Message);
            }
            finally { Interlocked.Exchange(ref _scanning, 0); }
        });
    }

    async Task<FollowSnapshot> Scan()
    {
        var projects = transcripts.Projects();
        var git = ScanGit(projects);
        var next = ScanNext(projects);
        var upd = await updates.Check();
        return new FollowSnapshot(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), false, git, next, upd);
    }

    // ---- Git ----

    FollowGit ScanGit(IReadOnlyList<Transcripts.ProjectInfo> projects)
    {
        var roots = projects.Select(p => GitRoot(p.Cwd)).OfType<string>()
            .Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var repos = new List<FollowRepo>();
        int clean = 0, failed = 0;
        foreach (var root in roots)
        {
            string? status;
            try { status = Git(root, "status", "--porcelain=v2", "--branch"); }
            catch (Win32Exception)
            {
                log.LogInformation("Takip: git bulunamadı, depo durumu gösterilmiyor");
                return new FollowGit("nogit", [], 0, 0);
            }
            if (status is null) { failed++; continue; }
            var repo = ParseStatus(root, status);
            // Uzak depo hiç yoksa "uzak dal yok" uyarısı anlamsız: yalnız commit'lenmemiş dosyalar sayılır.
            if (repo.NoUpstream && string.IsNullOrWhiteSpace(Git(root, "remote"))) repo = repo with { NoUpstream = false };
            if (repo.Dirty == 0 && repo.Ahead == 0 && !repo.NoUpstream) clean++;
            else repos.Add(repo);
        }
        return new FollowGit("ok", repos.OrderBy(r => r.Name, StringComparer.CurrentCultureIgnoreCase).ToList(), clean, failed);
    }

    static string? GitRoot(string cwd) => ProjectRoots.GitRoot(cwd);

    /// <summary>`git status --porcelain=v2 --branch` çıktısı: başlık satırları (# branch.*) + dosya satırları.</summary>
    static FollowRepo ParseStatus(string root, string status)
    {
        string branch = "";
        int dirty = 0, ahead = 0;
        var upstream = false;
        foreach (var raw in status.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (line.Length == 0) continue;
            if (line.StartsWith("# branch.head ", StringComparison.Ordinal)) branch = line[14..];
            else if (line.StartsWith("# branch.upstream ", StringComparison.Ordinal)) upstream = true;
            else if (line.StartsWith("# branch.ab ", StringComparison.Ordinal))
            {
                var plus = line.Split(' ').FirstOrDefault(x => x.StartsWith('+'));
                if (plus is not null) int.TryParse(plus[1..], out ahead);
            }
            else if (line[0] != '#') dirty++;
        }
        return new FollowRepo(Path.GetFileName(root) is { Length: > 0 } n ? n : root, root, branch, dirty, ahead, !upstream);
    }

    /// <summary>
    /// git'i depo klasöründe zaman aşımıyla çalıştırır; başarısızsa null. Ağa çıkmaz, dizin kilidi almaz
    /// (GIT_OPTIONAL_LOCKS=0: çalışan bir oturumun git işlemiyle çakışmasın). git yoksa Win32Exception fırlatır.
    /// </summary>
    string? Git(string root, params string[] args)
    {
        var psi = new ProcessStartInfo("git")
        {
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        psi.Environment["GIT_OPTIONAL_LOCKS"] = "0";
        psi.Environment["GIT_TERMINAL_PROMPT"] = "0";
        using var p = Process.Start(psi);
        if (p is null) return null;
        try
        {
            p.ErrorDataReceived += (_, _) => { };
            p.BeginErrorReadLine();
            var read = p.StandardOutput.ReadToEndAsync();
            if (!p.WaitForExit(GitTimeoutMs) || !read.Wait(1000))
            {
                p.Kill(entireProcessTree: true);
                log.LogInformation("Takip: git {Cmd} zaman aşımına uğradı ({Root})", args[0], root);
                return null;
            }
            if (p.ExitCode != 0) { log.LogDebug("Takip: git {Cmd} çıkış {Code} ({Root})", args[0], p.ExitCode, root); return null; }
            return read.Result;
        }
        catch (Exception ex) when (ex is InvalidOperationException or IOException or AggregateException)
        {
            log.LogDebug("Takip: git çalıştırılamadı ({Root}): {Msg}", root, ex.Message);
            return null;
        }
    }

    // ---- Sıradaki işler (NEXT_SESSION.md) ----

    static List<FollowNext> ScanNext(IReadOnlyList<Transcripts.ProjectInfo> projects)
    {
        var list = new List<FollowNext>();
        foreach (var dir in projects.Select(p => p.Cwd.TrimEnd('\\', '/')).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                var f = new FileInfo(Path.Combine(dir, NextFile));
                if (!f.Exists) continue;
                list.Add(new FollowNext(Path.GetFileName(dir) is { Length: > 0 } n ? n : dir, dir,
                    new DateTimeOffset(f.LastWriteTimeUtc).ToUnixTimeMilliseconds(), Summary(f.FullName), ProjectRoots.Of(dir)));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* kayıt başına: sonraki proje */ }
        }
        return list.OrderByDescending(n => n.UpdatedAt).ToList();
    }

    [GeneratedRegex(@"\[([^\]]*)\]\([^)]*\)")] private static partial Regex MdLink();
    [GeneratedRegex(@"^\s*(?:[-*+]\s+|\d+[.)]\s+|#+\s*)+")] private static partial Regex MdLead();
    [GeneratedRegex(@"\s+")] private static partial Regex Spaces();

    /// <summary>
    /// Dosyanın ilk anlamlı satırı, markdown işaretleri temizlenmiş. Başlık, alıntı (>) ve çizgi satırları atlanır
    /// (şablonda ilk başlık hep "Sonraki Oturum Planı"dır, bilgi vermez); başka satır yoksa ilk başlık kullanılır.
    /// </summary>
    static string Summary(string file)
    {
        string? heading = null;
        using var r = new StreamReader(file, Encoding.UTF8);
        for (var i = 0; i < 80 && r.ReadLine() is { } raw; i++)
        {
            var line = raw.Trim();
            if (line.Length == 0 || line[0] == '>' || line.Trim('-', '=', '*', '_', ' ').Length == 0) continue;
            if (line[0] == '#') { heading ??= Clean(line); continue; }
            if (Clean(line) is { Length: > 0 } text) return text;
        }
        return heading ?? "";
    }

    static string Clean(string line)
    {
        var s = MdLink().Replace(line, "$1");
        s = MdLead().Replace(s, "");
        s = s.Replace("**", "").Replace("__", "").Replace("`", "");
        s = Spaces().Replace(s, " ").Trim();
        return s.Length > SummaryMax ? s[..(SummaryMax - 1)].TrimEnd() + "…" : s;
    }
}

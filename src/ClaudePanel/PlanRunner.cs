using System.ComponentModel;
using System.Diagnostics;

namespace ClaudePanel;

/// <summary>
/// Tek planlı işin bir çalışması (arka plan görevinde). Sonuç <see cref="PlanRun"/>'a yazılır, <c>save</c> ile diske geçer.
/// - session: görünür panel oturumu; ilk yanıt bitince durum yazılır, oturum açık kalır (kullanıcı sabah okur).
/// - review: ayrı çalışma kopyası (git worktree, kardeş klasör) + dal; commit dalda kalır, push yok. Bitince oturum kapanır;
///   dalda commit varsa "Kontrolünü bekliyor", yoksa kopya silinir. Karar gerekiyorsa oturum açık kalır.
/// - warmup: en küçük modelle tek kısa istem (5 saatlik kota penceresi erken başlasın). Pencere zaten açıksa çalışmaz.
/// </summary>
public sealed class PlanRunner(HostedSessions hosted, ILogger log, PlanJob job, PlanRun run, Action save)
{
    const string WarmupPrompt = "Reply with just: ok";
    static readonly TimeSpan WarmupTimeout = TimeSpan.FromMinutes(3), RunTimeout = TimeSpan.FromHours(4);

    public void Run()
    {
        try
        {
            switch (job.Kind)
            {
                case "warmup": Warmup(); break;
                case "review": Review(); break;
                default: Session(); break;
            }
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException or UnauthorizedAccessException or Win32Exception)
        {
            log.LogWarning("Planlı iş yarıda kaldı {Id}: {Msg}", job.Id, ex.Message);
            End("failed", ex is Win32Exception ? "nostart" : "failed", GitOps.Scrub(ex.Message));
        }
    }

    void End(string state, string? code = null, string? detail = null)
    {
        run.State = state;
        run.Code = code;
        if (detail is not null) run.Detail = detail;
        run.EndedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        RemoteLog.Info($"Planlı iş bitti {job.Id}: {state}{(code is null ? "" : " (" + code + ")")}");
        save();
    }

    string Title() => (job.Lang == "en" ? "Planned: " : "Planlı: ") + (job.Name ?? Path.GetFileName(ProjectRoots.Normalize(job.Cwd ?? "")));

    void Session()
    {
        var key = hosted.Start(job.Cwd!, Prompt(null), job.Model, Title(), null);
        run.SessionKey = key;
        save();
        var st = Wait(key);
        Collect(key, st);
        if (st is null || st.Value.Status == "ended") { End("failed", "failed", GitOps.Scrub(st?.LastError ?? "")); return; }
        var decision = NightMode.Marked(st.Value.LastResult ?? "", NightMode.DecisionMark);
        // Gece modu bu oturumu "devam et" diye dürtmesin: iş bitti ya da karar bekliyor.
        hosted.SetNight(key, decision ? "decision" : "done");
        End(decision ? "decision" : "done");
    }

    void Review()
    {
        var root = ProjectRoots.GitRoot(job.Cwd!);
        if (root is null) { End("failed", "nogit"); return; }
        var (path, error) = GitOps.AddWorktree(root);
        if (path is null) { End("failed", "worktree", error); return; }
        run.Root = root;
        run.Worktree = path;
        run.Branch = GitOps.Run(path, 15_000, "rev-parse", "--abbrev-ref", "HEAD").StdOut.Trim();
        run.Base = GitOps.Run(path, 15_000, "rev-parse", "HEAD").StdOut.Trim();
        save();
        var rel = Path.GetRelativePath(root, ProjectRoots.Normalize(job.Cwd!));
        var dir = rel == "." ? path : Path.Combine(path, rel);
        if (!Directory.Exists(dir)) dir = path;
        var key = hosted.Start(dir, Prompt(run.Branch), job.Model, Title(), null);
        run.SessionKey = key;
        save();
        var st = Wait(key);
        Collect(key, st);
        ReadBranch(run);
        var decision = st is { Status: "idle" } && NightMode.Marked(st.Value.LastResult ?? "", NightMode.DecisionMark);
        if (decision || st is { Status: "busy" }) // karar ya da zaman aşımı: oturum açık kalır, kullanıcı konuşmayı açar
        {
            hosted.SetNight(key, "decision");
            End("decision", st is { Status: "busy" } ? "timeout" : null);
            return;
        }
        if (st is not null) hosted.Stop(key);
        run.SessionKey = null;
        if (run.Commits > 0) { End("review"); return; }
        PlanGit.Discard(run);
        End(st is null || st.Value.Status == "ended" ? "failed" : "nochange", st is null || st.Value.Status == "ended" ? "failed" : null,
            GitOps.Scrub(st?.LastError ?? ""));
    }

    /// <summary>Dalda kaç commit var, hangi dosyalar değişti (yalnız ad ve tür; içerik okunmaz).</summary>
    public static void ReadBranch(PlanRun r)
    {
        if (r.Worktree is null || r.Base is null || !Directory.Exists(r.Worktree)) return;
        r.Commits = GitOps.CommitsSince(r.Worktree, r.Base);
        var names = GitOps.Run(r.Worktree, 15_000, "diff", "--name-status", r.Base + "..HEAD");
        r.Files = names.Ok ? names.StdOut.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Take(200).ToList() : [];
    }

    /// <summary>Panel yeniden açıldı: önceki süreç yaşamıyor. Kopyada commit varsa kontrol bekler, yoksa yarıda kaldı.</summary>
    public static void AfterRestart(PlanRun r)
    {
        r.SessionKey = null;
        r.EndedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (r.Worktree is not null) ReadBranch(r);
        if (r.Commits > 0) { r.State = "review"; r.Code = "restart"; return; }
        if (r.Worktree is not null) PlanGit.Discard(r);
        r.State = "failed";
        r.Code = "restart";
    }

    (string Status, string? LastResult, bool Failed, string? LastError)? Wait(string key)
    {
        var deadline = DateTime.UtcNow + RunTimeout;
        (string Status, string? LastResult, bool Failed, string? LastError)? st;
        Thread.Sleep(1500);
        while (true)
        {
            st = hosted.Peek(key);
            if (st is null || st.Value.Status is not ("busy" or "starting") || DateTime.UtcNow > deadline) return st;
            Thread.Sleep(2000);
        }
    }

    void Collect(string key, (string Status, string? LastResult, bool Failed, string? LastError)? st)
    {
        var text = (st?.LastResult ?? "").Replace("\r", "").Trim();
        run.Summary = text.Length > PlannedJobs.SummaryMax ? text[..PlannedJobs.SummaryMax].TrimEnd() + "…" : text;
        run.CostUsd = hosted.ListAll().FirstOrDefault(h => h.Key == key)?.CostUsd ?? run.CostUsd;
    }

    string Prompt(string? branch)
    {
        var en = job.Lang == "en";
        var head = en
            ? "[Planned task: the user scheduled this prompt in advance and cannot answer now.]\n"
            : "[Planlı iş: kullanıcı bu istemi önceden planladı, şu an cevap veremez.]\n";
        var where = branch is null ? "" : en
            ? $"\nYou are in a separate working copy on branch {branch}. Commit your changes to this branch with meaningful messages. " +
              "Do not push, do not switch branches, do not touch the main working folder; the user will review the diff and merge it. " +
              "End your reply with a short list of what you changed."
            : $"\nAyrı bir çalışma kopyasındasın, dal {branch}. Değişikliklerini bu dalda anlamlı mesajlarla commit et. " +
              "Push etme, dal değiştirme, ana çalışma klasörüne dokunma; kullanıcı farkı inceleyip birleştirecek. " +
              "Yanıtının sonunda neleri değiştirdiğini kısa maddelerle yaz.";
        var rules = en
            ? "\nRules: nothing that goes outside or costs money (push, release, deploy, mail/message, sharing, purchase), no irreversible " +
              "deletion or history rewrite. Do not use AskUserQuestion or plan mode. When the task is finished, write " +
              $"{NightMode.DoneMark} on the FIRST line of your reply. If the user's decision is needed, write {NightMode.DecisionMark} " +
              "on the FIRST line and the decision with its options below it."
            : "\nKurallar: dışarıya giden ya da para harcatan işlem yok (push, yayın, deploy, mail/mesaj, paylaşım, satın alma); geri " +
              "alınamaz silme ya da git geçmişini değiştirme yok. AskUserQuestion ve plan modunu kullanma. İş bitince yanıtının İLK " +
              $"satırına {NightMode.DoneMark} yaz. Kullanıcının kararı gerekiyorsa İLK satıra {NightMode.DecisionMark} yaz, altına " +
              "kararı ve seçenekleri kısaca yaz.";
        return head + job.Prompt + "\n" + where + rules;
    }

    void Warmup()
    {
        var q = Quota.Read(fetch: true);
        if (q?.Five.ResetsAt is { } reset && reset > DateTimeOffset.UtcNow) { End("skipped", "active"); return; }
        var psi = new ProcessStartInfo(Launcher.ClaudeExe())
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
            WorkingDirectory = Handoff.DataDir
        };
        foreach (var a in new[] { "-p", WarmupPrompt, "--model", "haiku", "--max-turns", "1" }) psi.ArgumentList.Add(a);
        Directory.CreateDirectory(Handoff.DataDir);
        using var p = Process.Start(psi) ?? throw new Win32Exception("claude başlatılamadı");
        var so = p.StandardOutput.ReadToEndAsync();
        var se = p.StandardError.ReadToEndAsync();
        if (!p.WaitForExit(WarmupTimeout))
        {
            try { p.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            End("failed", "timeout");
            return;
        }
        Task.WaitAll([so, se], 2000);
        if (p.ExitCode != 0) { End("failed", "failed", GitOps.Scrub(LastLine(se.IsCompletedSuccessfully ? se.Result : ""))); return; }
        run.Summary = (so.IsCompletedSuccessfully ? so.Result : "").Trim();
        End("done");
    }

    static string LastLine(string s) => s.Split('\n').Select(l => l.Trim()).LastOrDefault(l => l.Length > 0) ?? "";
}

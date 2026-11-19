namespace ClaudePanel;

/// <param name="Mode">Projede zaten oturum varken ne yapılacağı: null (sor: 409) | "send" | "later" | "worktree" | "force".</param>
public sealed record HostedRequest(string? Cwd, string? Prompt, string? Model, string? Name, string? ResumeId, string? Mode = null);
public sealed record FollowRepoRequest(string? Path, bool? Push, string? Lang);
public sealed record FollowAllRequest(string[]? Paths, string? Lang);
public sealed record FollowLedgerRequest(string? Ledger, string[]? Files, string? Lang);

/// <summary>
/// Takip 2. aşama uçları (0.12.0): aynı projede ikinci oturumu önleyen başlatma (/api/hosted'ın gövdesi) ve
/// Takip sekmesinin arka plan işleri (/api/follow/*). Telefondan da açıktır (telefon zaten oturum başlatabiliyor).
/// </summary>
public static class FollowEndpoints
{
    static readonly HashSet<string> Modes = new(StringComparer.Ordinal) { "send", "later", "worktree", "force" };

    /// <summary>409 gövdesi: projede açık oturumlar ve sunulabilecek seçenekler.</summary>
    public static object Conflict(IReadOnlyList<ProjectSession> others, bool hasPrompt, string cwd, string? resumeId, bool worktree = true)
    {
        var panels = others.Where(s => s.Kind == "panel").ToList();
        var options = new List<string>();
        if (hasPrompt && panels.Any(s => s.Status == "idle")) options.Add("send");
        if (hasPrompt && panels.Any(s => s.Status == "busy")) options.Add("later");
        if (worktree && resumeId is null && ProjectRoots.GitRoot(cwd) is not null) options.Add("worktree");
        options.Add("force");
        return new
        {
            error = "conflict",
            root = ProjectRoots.Of(cwd),
            sessions = others.Select(s => new { kind = s.Kind, key = s.Kind == "panel" ? s.Key : null, pid = s.Pid, name = s.Name, status = s.Status, cwd = s.Cwd }),
            options
        };
    }

    /// <summary>
    /// Panel oturumu başlatır. Aynı projede (git kökü; alt klasör dahil) oturum varsa ve mod verilmediyse başlatmaz, 409 döner.
    /// Denetim StartOnce kilidinin içindedir: eşzamanlı iki farklı istek aynı projeye iki oturum açamaz.
    /// </summary>
    public static IResult StartHosted(HostedRequest req, string? model, HostedSessions hosted, ProjectGuard guard)
    {
        var cwd = req.Cwd!;
        var mode = req.Mode is not null && Modes.Contains(req.Mode) ? req.Mode : null;
        var hasPrompt = !string.IsNullOrWhiteSpace(req.Prompt);
        object? body = null;
        var (key, repeated) = StartOnce.Run("hosted:" + mode, cwd, req.Prompt, req.ResumeId, () =>
        {
            var others = guard.SessionsIn(ProjectRoots.Of(cwd), req.ResumeId);
            if (others.Count == 0 || mode == "force") return hosted.Start(cwd, req.Prompt, model, req.Name, req.ResumeId);
            var panels = others.Where(s => s.Kind == "panel" && s.Key is not null).ToList();
            if (mode == "send" && hasPrompt && panels.FirstOrDefault(s => s.Status == "idle") is { } idle && hosted.Send(idle.Key!, req.Prompt!))
            {
                body = new { key = idle.Key, sent = true };
                return idle.Key;
            }
            if (mode == "later" && hasPrompt && (panels.FirstOrDefault(s => s.Status == "busy") ?? panels.FirstOrDefault()) is { } target
                && hosted.SendWhenDone(target.Key!, req.Prompt!))
            {
                body = new { key = target.Key, queued = true };
                return target.Key;
            }
            if (mode == "worktree" && req.ResumeId is null && ProjectRoots.GitRoot(cwd) is { } gitRoot)
            {
                var (path, error) = GitOps.AddWorktree(gitRoot);
                if (path is null) { body = new { error = "worktree", detail = error }; return null; }
                // Oturum alt klasörde istenmişse kopyada da aynı alt klasörde açılır.
                var rel = Path.GetRelativePath(gitRoot, ProjectRoots.Normalize(cwd));
                var dir = rel == "." ? path : Path.Combine(path, rel);
                if (!Directory.Exists(dir)) dir = path;
                var started = hosted.Start(dir, req.Prompt, model, req.Name, null);
                RemoteLog.Info($"Ayrı çalışma kopyası açıldı: {path}");
                body = new { key = started, worktree = path };
                return started;
            }
            body = Conflict(others, hasPrompt, cwd, req.ResumeId);
            return null;
        }, k => k is not null && hosted.Has(k));
        if (key is null) return Results.Json(body ?? new { error = "generic" }, statusCode: 409);
        return Results.Json(body ?? new { key, repeated });
    }

    public static void MapFollow(this WebApplication app, Func<HttpContext, bool> authorized)
    {
        app.MapGet("/api/follow/jobs", (FollowJobs jobs) => Results.Json(jobs.List()));

        // Gönder: panel doğrudan git push yapar (önce gizli bilgi denetimi). Commit et / Commit et ve gönder: gizli arka plan işi.
        app.MapPost("/api/follow/push", async (HttpContext ctx, FollowUp fu, FollowJobs jobs) =>
        {
            if (!authorized(ctx)) return Results.StatusCode(403);
            var req = await ctx.Request.ReadFromJsonAsync<FollowRepoRequest>();
            return Enqueue(fu, jobs, [req?.Path], req?.Lang, _ => (false, true));
        });
        app.MapPost("/api/follow/commit", async (HttpContext ctx, FollowUp fu, FollowJobs jobs) =>
        {
            if (!authorized(ctx)) return Results.StatusCode(403);
            var req = await ctx.Request.ReadFromJsonAsync<FollowRepoRequest>();
            return Enqueue(fu, jobs, [req?.Path], req?.Lang, _ => (true, req?.Push == true));
        });
        // Claude Code'u şimdi güncelle (`claude update`); sürüyorsa 409. Sonuç Takip anlık görüntüsünde (claudeUpdate).
        app.MapPost("/api/follow/claude-update", (HttpContext ctx, FollowUp fu, ClaudeUpdater updater) =>
        {
            if (!authorized(ctx)) return Results.StatusCode(403);
            return updater.Start(fu.ForceRefresh) ? Results.Json(updater.State, statusCode: 202) : Results.Json(new { error = "busy" }, statusCode: 409);
        });
        // Tümünü commit et ve gönder: tek iş, depolar sırayla; sorunlu depo atlanır ve satırında raporlanır.
        app.MapPost("/api/follow/all", async (HttpContext ctx, FollowUp fu, FollowJobs jobs) =>
        {
            if (!authorized(ctx)) return Results.StatusCode(403);
            var req = await ctx.Request.ReadFromJsonAsync<FollowAllRequest>();
            if (req?.Paths is not { Length: > 0 and <= 200 }) return Results.BadRequest();
            return Enqueue(fu, jobs, req.Paths, req.Lang, r => (r.Dirty > 0, true));
        });
        // Kütüğü kapat: gizli oturum kütüğü günceller (panel kütüğe kendisi yazmaz). Yalnız Takip'in okuduğu kütük ve
        // o kütükte "yüklenecek" diye duran dosyalar kabul edilir (istekle rastgele klasörde claude çalıştırılamaz).
        app.MapPost("/api/follow/ledger", async (HttpContext ctx, FollowUp fu, FollowJobs jobs) =>
        {
            if (!authorized(ctx)) return Results.StatusCode(403);
            var req = await ctx.Request.ReadFromJsonAsync<FollowLedgerRequest>();
            if (req?.Ledger is null || req.Files is not { Length: > 0 and <= 500 }) return Results.BadRequest();
            var rows = fu.Get().Drive.Where(d => d.Path is not null && ProjectRoots.Same(d.Ledger, ProjectRoots.Normalize(req.Ledger))).ToList();
            var files = req.Files.Select(f => rows.FirstOrDefault(d => ProjectRoots.Same(d.Path!, ProjectRoots.Normalize(f ?? "")))?.Path).ToList();
            if (rows.Count == 0 || files.Any(f => f is null)) return Results.Json(new { error = "noledger" }, statusCode: 404);
            // Satırın yerine geçtiği eski sürümler de yüklendi sayılır: kütükte onlar da kapatılır.
            var withOlder = files.Concat(files.SelectMany(f => rows.First(d => ProjectRoots.Same(d.Path!, f!)).Older ?? []));
            var job = jobs.EnqueueLedger(rows[0].Ledger, rows[0].Name, withOlder.Distinct(StringComparer.OrdinalIgnoreCase).ToList()!, req.Lang);
            return job is null ? Results.Json(new { error = "jobactive" }, statusCode: 409) : Results.Json(job);
        });
    }

    /// <summary>Yalnız Takip'in bildiği depolar işlenir (istekle rastgele klasörde git/claude çalıştırılamaz).</summary>
    static IResult Enqueue(FollowUp fu, FollowJobs jobs, IEnumerable<string?> paths, string? lang, Func<FollowRepo, (bool Commit, bool Push)> plan)
    {
        var known = fu.Get().Git.Repos;
        var repos = new List<(string, string, bool, bool)>();
        foreach (var p in paths)
        {
            var repo = p is null ? null : known.FirstOrDefault(r => ProjectRoots.Same(r.Path, ProjectRoots.Normalize(p)));
            if (repo is null) return Results.Json(new { error = "norepo" }, statusCode: 404);
            var (commit, push) = plan(repo);
            repos.Add((repo.Path, repo.Name, commit, push));
        }
        var job = jobs.Enqueue(repos, lang);
        return job is null ? Results.Json(new { error = "jobactive" }, statusCode: 409) : Results.Json(job);
    }
}

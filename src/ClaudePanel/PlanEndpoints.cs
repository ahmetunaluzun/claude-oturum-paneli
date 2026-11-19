namespace ClaudePanel;

public sealed record PlanIdRequest(string? Id, bool? On = null);

/// <summary>
/// Planlı işler uçları (0.16.0). Telefondan da açıktır (telefon zaten oturum başlatabiliyor; birleştirme yereldir, push yok).
///   GET  /api/plans                 → işler + panel ayarı (geç çalışma payı vb.)
///   POST /api/plans                 → yeni iş / güncelleme (gövde PlanJob)
///   POST /api/plans/delete|enable|run → sil, aç/kapat, şimdi çalıştır
///   POST /api/plans/diff|merge|discard → "kontrolüme bırak" dalı: farkı gör, birleştir, at
/// </summary>
public static class PlanEndpoints
{
    public static void MapPlans(this WebApplication app, Func<HttpContext, bool> authorized)
    {
        app.MapGet("/api/plans", (PlannedJobs plans) => Results.Json(new
        {
            jobs = plans.List(),
            graceMin = (int)PlannedJobs.Grace.TotalMinutes,
            warmupGraceMin = (int)PlannedJobs.WarmupGrace.TotalMinutes,
            awakeAheadH = (int)PlannedJobs.AwakeAhead.TotalHours
        }));

        app.MapPost("/api/plans", async (HttpContext ctx, PlannedJobs plans) =>
        {
            if (!authorized(ctx)) return Results.StatusCode(403);
            var req = await ctx.Request.ReadFromJsonAsync<PlanJob>();
            if (req is null) return Results.BadRequest();
            var (job, error) = plans.Upsert(req);
            return error is null ? Results.Json(job) : Results.BadRequest(new { error });
        });

        Map(app, authorized, "delete", (plans, req) => plans.Remove(req.Id!));
        Map(app, authorized, "enable", (plans, req) => plans.SetEnabled(req.Id!, req.On != false));
        Map(app, authorized, "run", (plans, req) => plans.RunNow(req.Id!));

        app.MapPost("/api/plans/diff", async (HttpContext ctx, PlannedJobs plans) =>
        {
            if (!authorized(ctx)) return Results.StatusCode(403);
            if (Review(plans, await ctx.Request.ReadFromJsonAsync<PlanIdRequest>()) is not { } run) return NoReview();
            var (text, cut) = await Task.Run(() => PlanGit.Diff(run));
            return text is null ? Results.Json(new { error = "nodiff" }, statusCode: 404) : Results.Json(new { text, cut, files = run.Files });
        });

        app.MapPost("/api/plans/merge", async (HttpContext ctx, PlannedJobs plans, ProjectGuard guard) =>
        {
            if (!authorized(ctx)) return Results.StatusCode(403);
            var req = await ctx.Request.ReadFromJsonAsync<PlanIdRequest>();
            if (Review(plans, req) is not { } run) return NoReview();
            // Ana klasörde çalışan oturum varken birleştirme onun dosyalarını değiştirirdi.
            if (guard.SessionsIn(run.Root!).Any(s => s.Status == "busy")) return Results.Json(new { error = "busy" }, statusCode: 409);
            var (code, detail) = await Task.Run(() => PlanGit.Merge(run));
            if (code is not null) return Results.Json(new { error = code, detail }, statusCode: 409);
            plans.Update(req!.Id!, r => { r.State = "merged"; r.Code = null; r.Worktree = null; });
            RemoteLog.Info($"Planlı iş dalı birleştirildi: {run.Branch} → {run.Root}");
            return Results.Json(new { ok = true });
        });

        app.MapPost("/api/plans/discard", async (HttpContext ctx, PlannedJobs plans) =>
        {
            if (!authorized(ctx)) return Results.StatusCode(403);
            var req = await ctx.Request.ReadFromJsonAsync<PlanIdRequest>();
            if (Review(plans, req) is not { } run) return NoReview();
            await Task.Run(() => PlanGit.Discard(run));
            plans.Update(req!.Id!, r => { r.State = "discarded"; r.Code = null; r.Worktree = null; });
            RemoteLog.Info($"Planlı iş dalı atıldı: {run.Branch}");
            return Results.Json(new { ok = true });
        });
    }

    static PlanRun? Review(PlannedJobs plans, PlanIdRequest? req) =>
        req?.Id is { } id && plans.Get(id)?.Last is { State: "review", Worktree: not null } run ? run : null;

    static IResult NoReview() => Results.Json(new { error = "noreview" }, statusCode: 404);

    static void Map(WebApplication app, Func<HttpContext, bool> authorized, string name, Func<PlannedJobs, PlanIdRequest, string?> act) =>
        app.MapPost("/api/plans/" + name, async (HttpContext ctx, PlannedJobs plans) =>
        {
            if (!authorized(ctx)) return Results.StatusCode(403);
            var req = await ctx.Request.ReadFromJsonAsync<PlanIdRequest>();
            if (string.IsNullOrEmpty(req?.Id)) return Results.BadRequest();
            var error = await Task.Run(() => act(plans, req));
            return error is null ? Results.Json(new { ok = true })
                : Results.Json(new { error }, statusCode: error == "noplan" ? 404 : 409);
        });
}

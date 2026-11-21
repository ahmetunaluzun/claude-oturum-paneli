namespace ClaudePanel;

public sealed record SchedDisableRequest(string? Id);
public sealed record SchedStopRequest(string? Key, string? Lang);

/// <summary>
/// Takip → "Zamanlanmış işler" uçları (0.14.0). Panel kendiliğinden hiçbir şeyi durdurmaz: her uç kullanıcının
/// onayladığı tek işlemi yapar.
///   POST /api/schedule/disable  → Takip'te listelenen bir zamanlayıcı görevini devre dışı bırakır. YALNIZ bilgisayardan
///                                 (telefondan 403; yol ayrıca Remote.Blocked listesinde).
///   POST /api/schedule/run      → listelenen görevi şimdi çalıştırır; POST /api/schedule/log → logunu açar (ikisi de yalnız bilgisayardan).
///   POST /api/schedule/stop     → panelde barındırılan oturuma "tekrarlı işleri durdur" mesajı gönderir (mevcut gönderim
///                                 yolu; oturum çalışıyorsa iş bitince). Terminal oturumuna mesaj gönderilemez.
/// </summary>
public static class ScheduleEndpoints
{
    const string StopTr =
        "Bu oturumdaki tekrarlı işleri durdur: CronList ile zamanlanmış görevleri listele ve hepsini CronDelete ile sil; " +
        "/loop ya da ScheduleWakeup döngüsü sürüyorsa yeni uyanma planlama. Başka iş yapma; neyi durdurduğunu bir iki cümleyle yaz.";
    const string StopEn =
        "Stop the recurring work in this session: list the scheduled tasks with CronList and delete all of them with CronDelete; " +
        "if a /loop or ScheduleWakeup loop is running, do not schedule another wakeup. Do nothing else; say in a sentence or two what you stopped.";

    public static void MapSchedule(this WebApplication app, Func<HttpContext, bool> authorized, Func<HttpContext, bool> isLocal)
    {
        app.MapPost("/api/schedule/disable", async (HttpContext ctx, FollowUp fu) =>
        {
            if (!isLocal(ctx) || !authorized(ctx)) return Results.StatusCode(403);
            var req = await ctx.Request.ReadFromJsonAsync<SchedDisableRequest>();
            if (string.IsNullOrEmpty(req?.Id)) return Results.BadRequest();
            // Yalnız Takip'in listelediği görev (istekle rastgele sistem görevi kapatılamaz).
            var task = fu.Get().Sched.Os.Tasks.FirstOrDefault(t => t.Id == req.Id);
            if (task is null) return Results.Json(new { error = "notask" }, statusCode: 404);
            if (!task.CanDisable) return Results.Json(new { error = "taskunsupported" }, statusCode: 400);
            var error = await Task.Run(() => OsTasks.Disable(task.Id));
            RemoteLog.Info(error is null ? $"Zamanlanmış görev devre dışı bırakıldı: {task.Id}" : $"Zamanlanmış görev devre dışı bırakılamadı ({error}): {task.Id}");
            if (error is not null) return Results.Json(new { error = "task" + error }, statusCode: error == "notfound" ? 404 : 409);
            fu.Refresh();
            return Results.Json(new { ok = true });
        });

        // Görevi şimdi çalıştırır (Görev Zamanlayıcı'daki "Çalıştır"). Yalnız bilgisayardan, yalnız Takip'in listelediği görev.
        app.MapPost("/api/schedule/run", async (HttpContext ctx, FollowUp fu) =>
        {
            if (!isLocal(ctx) || !authorized(ctx)) return Results.StatusCode(403);
            var req = await ctx.Request.ReadFromJsonAsync<SchedDisableRequest>();
            if (string.IsNullOrEmpty(req?.Id)) return Results.BadRequest();
            var task = fu.Get().Sched.Os.Tasks.FirstOrDefault(t => t.Id == req.Id);
            if (task is null) return Results.Json(new { error = "notask" }, statusCode: 404);
            if (!task.CanDisable) return Results.Json(new { error = "taskunsupported" }, statusCode: 400);
            var error = await Task.Run(() => OsTasks.Run(task.Id));
            RemoteLog.Info(error is null ? $"Zamanlanmış görev elle çalıştırıldı: {task.Id}" : $"Zamanlanmış görev çalıştırılamadı ({error}): {task.Id}");
            if (error is not null) return Results.Json(new { error = "task" + error }, statusCode: error == "notfound" ? 404 : 409);
            fu.Refresh();
            return Results.Json(new { ok = true });
        });

        // Görevin logunu açar: dosya metin düzenleyicide, klasör Gezgin'de. Yol istemciden ALINMAZ (taramanın bulduğu yol).
        app.MapPost("/api/schedule/log", async (HttpContext ctx, FollowUp fu) =>
        {
            if (!isLocal(ctx) || !authorized(ctx)) return Results.StatusCode(403);
            var req = await ctx.Request.ReadFromJsonAsync<SchedDisableRequest>();
            if (string.IsNullOrEmpty(req?.Id)) return Results.BadRequest();
            var log = fu.Get().Sched.Os.Tasks.FirstOrDefault(t => t.Id == req.Id)?.Log;
            if (log is null) return Results.Json(new { error = "nolog" }, statusCode: 404);
            // Sahte zamanlayıcıyla (test) pencere açılmaz; açılacak yol döner.
            if (OsTasks.Kind == "test") return Results.Json(new { ok = true, opened = log });
            if (Directory.Exists(log)) Native.RevealFolder(log);
            else if (File.Exists(log)) Native.OpenText(log);
            else return Results.Json(new { error = "nolog" }, statusCode: 404);
            return Results.Json(new { ok = true });
        });

        app.MapPost("/api/schedule/stop", async (HttpContext ctx, ScheduledJobs jobs, HostedSessions hosted) =>
        {
            if (!authorized(ctx)) return Results.StatusCode(403);
            var req = await ctx.Request.ReadFromJsonAsync<SchedStopRequest>();
            if (string.IsNullOrEmpty(req?.Key)) return Results.BadRequest();
            // Yalnız şu an tekrarlı işi görünen panel oturumu.
            if (jobs.Loops().All(l => l.Key != req.Key)) return Results.Json(new { error = "noloop" }, statusCode: 404);
            var text = req.Lang == "en" ? StopEn : StopTr;
            var busy = hosted.List().FirstOrDefault(h => h.Key == req.Key)?.Status == "busy";
            var ok = busy ? hosted.SendWhenDone(req.Key, text) : hosted.Send(req.Key, text);
            return ok ? Results.Json(new { ok = true, queued = busy }) : Results.Json(new { error = "noloop" }, statusCode: 404);
        });
    }
}

using System.Text.RegularExpressions;

namespace ClaudePanel;

/// <summary>
/// Codex oturumları, salt okuma (issue #1 madde 8): /api/codex*. Okuyucu CodexSessions.cs.
/// Panel ~/.codex'e hiçbir şey yazmaz, kilit almaz, Codex'i çalıştırmaz. Codex kurulu değilse yalnız {installed:false}.
/// </summary>
public static partial class CodexEndpoints
{
    static readonly TimeSpan MinInterval = TimeSpan.FromSeconds(4); // arayüz 5 sn'de bir sorar; birden çok pencere taramayı çoğaltmasın
    static readonly object Gate = new();
    static (DateTime At, List<CodexSessions.CodexSession> List)? last;

    // Devam komutuna yalnız bu biçimdeki kimlik girer (Codex kimliği UUID); başka karakter panoya komut olarak gitmez.
    [GeneratedRegex("^[A-Za-z0-9-]{8,64}$")]
    private static partial Regex SafeId();

    static List<CodexSessions.CodexSession> Sessions()
    {
        lock (Gate)
        {
            if (last is { } l && DateTime.UtcNow - l.At < MinInterval) return l.List;
            var list = CodexSessions.Scan();
            last = (DateTime.UtcNow, list);
            return list;
        }
    }

    static object? Window(CodexSessions.RateWindow? w) => w is null ? null : new
    {
        usedPercent = w.UsedPercent, windowMinutes = w.WindowMinutes, resetsAt = w.ResetsAt * 1000 // ms
    };

    /// <summary>GET /api/codex yanıtı. Kota: kota bilgisi olan en yeni oturumun son token_count'u.</summary>
    public static object Snapshot()
    {
        if (!CodexSessions.Installed) return new { installed = false };
        var list = Sessions();
        var q = list.OrderByDescending(s => s.Updated).FirstOrDefault(s => s.Primary is not null);
        return new
        {
            installed = true,
            sessions = list.Select(s => new
            {
                id = s.Id, cwd = s.Cwd, source = s.Source, model = s.Model, cliVersion = s.CliVersion, title = s.Title,
                lastAssistant = s.LastAssistant, started = s.Started.ToUnixTimeMilliseconds(), updated = s.Updated.ToUnixTimeMilliseconds(),
                state = s.State,
                // Kilit canlıyken devam ettirme önerilmez ("thread already has an active writer"): komut yalnız bitmiş oturumda.
                resume = s.State == "ended" && SafeId().IsMatch(s.Id) ? "codex resume " + s.Id : null
            }),
            quota = q is null ? null : new
            {
                plan = q.PlanType, primary = Window(q.Primary), secondary = Window(q.Secondary), at = q.Updated.ToUnixTimeMilliseconds()
            }
        };
    }

    public static void MapCodex(this WebApplication app, Func<HttpContext, bool> authorized)
    {
        app.MapGet("/api/codex", () => Results.Json(Snapshot()));
        app.MapGet("/api/codex/transcript/{id}", (string id, int? limit) =>
            CodexSessions.Installed && CodexSessions.ReadTranscript(id, Math.Clamp(limit ?? 250, 1, 400)) is { } items
                ? Results.Json(new { items }) : Results.NotFound());
        // Klasörü aç: kimlik taramadaki oturuma eşlenir (yol istemciden alınmaz). Telefondan kapalı (Remote.Blocked).
        app.MapPost("/api/codex/open-folder", async (HttpContext ctx) =>
        {
            if (!authorized(ctx)) return Results.StatusCode(403);
            var body = await ctx.Request.ReadFromJsonAsync<CodexIdRequest>();
            var s = body?.Id is { } id ? Sessions().FirstOrDefault(x => x.Id == id) : null;
            if (s is null || string.IsNullOrEmpty(s.Cwd) || !Directory.Exists(s.Cwd)) return Results.NotFound();
            Native.RevealFolder(s.Cwd);
            return Results.Ok();
        });
    }
}

public record CodexIdRequest(string? Id);

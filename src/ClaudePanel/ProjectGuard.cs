using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace ClaudePanel;

/// <param name="Kind">"panel" | "terminal" | "bg" | "job" (Takip'in arka plan işi).</param>
public sealed record ProjectSession(string Kind, string? Key, int? Pid, string? SessionId, string Name, string Cwd, string Status, long BusySince);

/// <summary>
/// Aynı projede (git kökü; yoksa klasör) birden çok oturum denetimi.
/// 1) Önleme: oturum başlatan uçlar <see cref="SessionsIn"/> ile bakar, oturum varsa 409 + seçenek döner.
/// 2) Son savunma: panelin başlattığı claude'a `--settings` ile verilen PreToolUse hook'u (`ClaudePanel --project-guard`),
///    aynı kökte DAHA ÖNCE çalışmaya başlamış başka oturum varken dosya yazmayı ve git commit/push/rebase/merge/pull'u
///    bekletir (exit 2). Hook oturum listesini panelin 2 sn'de bir yazdığı project-sessions.json'dan okur; dosya eskiyse
///    ya da panel kapalıysa engellemez. Öncelik önce çalışmaya başlayanda olduğu için iki oturum birbirini kilitlemez.
/// </summary>
public sealed class ProjectGuard(SessionStore store, HostedSessions hosted, ILogger<ProjectGuard> log) : IDisposable
{
    public const string Arg = "--project-guard";
    public static readonly string StateFile = Path.Combine(Handoff.DataDir, "project-sessions.json");
    static readonly TimeSpan WriteEvery = TimeSpan.FromSeconds(2);
    const int StaleSeconds = 30;
    static readonly HashSet<string> WriteTools = new(StringComparer.Ordinal) { "Write", "Edit", "MultiEdit", "NotebookEdit" };
    static readonly Regex GitWrite = new(@"\bgit\b[^\n|;&]*\b(commit|push|rebase|merge|pull)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    Timer? _timer;

    /// <summary>Tüm canlı oturumlar (panel + arka plan işi + terminal), kökleriyle.</summary>
    public IReadOnlyList<(string Root, ProjectSession Session)> All()
    {
        var list = new List<(string, ProjectSession)>();
        var panelIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var h in hosted.ListAll())
        {
            if (h.Status == "ended") continue;
            if (h.SessionId is not null) panelIds.Add(h.SessionId);
            var busy = h.Status is "busy" or "starting";
            list.Add((ProjectRoots.Of(h.Cwd), new ProjectSession(hosted.IsHidden(h.Key) ? "job" : "panel", h.Key, null, h.SessionId,
                h.Name ?? Path.GetFileName(ProjectRoots.Normalize(h.Cwd)), h.Cwd, busy ? "busy" : "idle", busy ? h.StatusSince : 0)));
        }
        foreach (var s in store.List())
        {
            if (panelIds.Contains(s.SessionId) || string.IsNullOrEmpty(s.Cwd)) continue; // panel oturumu claude'un kendi listesinde de görünür
            var busy = s.Status != "idle";
            list.Add((ProjectRoots.Of(s.Cwd), new ProjectSession(s.Kind == "interactive" ? "terminal" : "bg", null, s.Pid, s.SessionId,
                s.CustomName ?? (Path.GetFileName(ProjectRoots.Normalize(s.Cwd)) is { Length: > 0 } n ? n : s.Name), s.Cwd,
                busy ? "busy" : "idle", busy ? s.StatusSince : 0)));
        }
        return list;
    }

    /// <summary>Bu projede açık oturumlar. exceptSessionId: sürdürülen konuşmanın kendisi sayılmaz.</summary>
    public IReadOnlyList<ProjectSession> SessionsIn(string root, string? exceptSessionId = null) =>
        All().Where(x => ProjectRoots.Same(x.Root, root) && (exceptSessionId is null || x.Session.SessionId != exceptSessionId))
            .Select(x => x.Session).ToList();

    // ---- Hook'un okuduğu dosya ----

    public void Start() => _timer = new Timer(_ => Write(), null, TimeSpan.Zero, WriteEvery);

    void Write()
    {
        try
        {
            var doc = new JsonObject
            {
                ["at"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                ["pid"] = Environment.ProcessId,
                ["sessions"] = new JsonArray(All().Where(x => !string.IsNullOrEmpty(x.Session.SessionId)).Select(x => (JsonNode)new JsonObject
                {
                    ["id"] = x.Session.SessionId, ["root"] = x.Root, ["name"] = x.Session.Name, ["busySince"] = x.Session.BusySince
                }).ToArray())
            };
            Directory.CreateDirectory(Handoff.DataDir);
            var tmp = StateFile + ".tmp";
            File.WriteAllText(tmp, doc.ToJsonString());
            File.Move(tmp, StateFile, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            log.LogDebug("Proje oturum listesi yazılamadı: {Msg}", ex.Message);
        }
    }

    public void Dispose()
    {
        _timer?.Dispose();
        try { File.Delete(StateFile); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }

    // ---- Hook (ClaudePanel --project-guard) ----

    /// <summary>İşlem bu kuralın kapsamında mı: dosya yazan araç ya da git'in depoyu değiştiren komutu.</summary>
    public static bool IsWrite(string tool, JsonNode? input) =>
        WriteTools.Contains(tool)
        || (tool is "Bash" or "PowerShell" && GitWrite.IsMatch(input?["command"]?.GetValue<string>() ?? ""));

    /// <summary>Engelleyen oturumun adı; engel yoksa null. state: project-sessions.json içeriği.</summary>
    public static string? BlockedBy(JsonNode? state, string sessionId, string cwd, long nowSeconds, Func<int, bool> alive)
    {
        if (state is null) return null;
        var at = state["at"]?.GetValue<long>() ?? 0;
        var pid = state["pid"]?.GetValue<int>() ?? 0;
        if (nowSeconds - at > StaleSeconds || pid <= 0 || !alive(pid)) return null; // panel kapalı / dosya eski: engelleme
        var sessions = state["sessions"]?.AsArray().OfType<JsonObject>().ToList() ?? [];
        var me = sessions.FirstOrDefault(s => s["id"]?.GetValue<string>() == sessionId);
        var root = me?["root"]?.GetValue<string>() ?? (cwd.Length > 0 ? ProjectRoots.Of(cwd) : null);
        if (root is null) return null;
        // Kendi başlangıcım dosyaya henüz yansımadıysa (2 sn'lik gecikme) "şimdi başladım" sayılır.
        var mine = me?["busySince"]?.GetValue<long>() is > 0 and var b ? b : long.MaxValue;
        foreach (var o in sessions)
        {
            var id = o["id"]?.GetValue<string>() ?? "";
            if (id == sessionId || !ProjectRoots.Same(o["root"]?.GetValue<string>() ?? "", root)) continue;
            var since = o["busySince"]?.GetValue<long>() ?? 0;
            if (since <= 0) continue; // boşta: yazmıyor
            if (since < mine || (since == mine && string.CompareOrdinal(id, sessionId) < 0))
                return o["name"]?.GetValue<string>() ?? id;
        }
        return null;
    }

    public static int RunHook()
    {
        try
        {
            if (!File.Exists(StateFile)) return 0;
            // Claude Code olayı UTF-8 yazar; Console.In Windows'ta konsol kod sayfasıyla okur, Türkçe harfli klasör yolu bozulurdu.
            using var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            var ev = JsonNode.Parse(stdin.ReadToEnd());
            if (!IsWrite(ev?["tool_name"]?.GetValue<string>() ?? "", ev?["tool_input"])) return 0;
            var state = JsonNode.Parse(File.ReadAllText(StateFile));
            var by = BlockedBy(state, ev?["session_id"]?.GetValue<string>() ?? "", ev?["cwd"]?.GetValue<string>() ?? "",
                DateTimeOffset.UtcNow.ToUnixTimeSeconds(), Alive);
            if (by is null) return 0;
            var msg = $"Bu projede başka bir oturum şu an çalışıyor ({by}). İki oturum aynı dosyalara yazmasın diye dosya yazma ve " +
                      "git commit/push/rebase/merge/pull bekletildi; okuma serbest. Yazmadan yapabileceğin iş varsa sürdür; " +
                      "yoksa öteki oturumun bitmesini beklemek gerektiğini kullanıcıya kısaca söyle ve dur.\n";
            using var err = Console.OpenStandardError();
            err.Write(Encoding.UTF8.GetBytes(msg));
            return 2;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or FormatException)
        {
            return 0; // okunamayan veri engel nedeni değildir
        }
    }

    static bool Alive(int pid)
    {
        try { using var p = Process.GetProcessById(pid); return !p.HasExited; }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception) { return false; }
    }
}

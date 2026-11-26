using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;

namespace ClaudePanel;

/// <summary>
/// Panel exe'sinin terminal alt komutları (Python gerekmez):
/// <c>--statusline</c>: Claude Code durum satırı (plan, 5 saatlik + haftalık kota, bağlam);
/// <c>--quota-guard</c>: PreToolUse hook'u, 5 saatlik kotadan %5 ya da daha az kalınca yalnız okuma ve hafıza kaydına izin verir.
/// </summary>
public static class QuotaCli
{
    public const string StatusLineArg = "--statusline";
    public const string GuardArg = "--quota-guard";
    /// <summary>5 saatlik kotadan en çok bu kadar yüzde kalınca koruma devreye girer.</summary>
    public const double GuardThreshold = 5;

    static readonly string ContextCacheFile = Path.Combine(Quota.ClaudeDir, "context-window-cache.json");

    // ---------------- durum satırı ----------------

    /// <summary>Dil: komuttaki "--lang tr|en" (panelin dil seçimi kurulumda yazılır), yoksa sistem dili.</summary>
    static bool Turkish(string[] args)
    {
        var i = Array.IndexOf(args, "--lang");
        return i >= 0 && i + 1 < args.Length ? args[i + 1] == "tr" : Quota.TurkishUi;
    }

    public static int RunStatusLine(string[] args)
    {
        JsonNode? ev = null;
        try { ev = JsonNode.Parse(Console.In.ReadToEnd()); }
        catch (System.Text.Json.JsonException) { }
        SaveContextWindow(ev);
        Write(Console.OpenStandardOutput(), StatusLine(Quota.Read(Quota.CurrentDir, fetch: true), ev, Quota.Plan(Quota.CurrentDir), Turkish(args),
            Accounts.NameOf(Quota.CurrentDir, Turkish(args))) + "\n");
        return 0;
    }

    public static string StatusLine(QuotaInfo? q, JsonNode? ev, string? plan, bool tr, string? account = null)
    {
        var parts = new List<string>();
        if (account is not null) parts.Add(account);
        if (plan is not null) parts.Add(plan);
        double? fiveLeft = null, weekLeft = null;
        if (q is null) parts.Add(tr ? "Kota: okunamadı" : "Quota: unavailable");
        else
        {
            fiveLeft = q.Five.Left;
            weekLeft = q.Week.Left;
            if (Window(tr ? "5sa" : "5h", q.Five, tr) is { } f) parts.Add(f);
            if (Window(tr ? "Hafta" : "Week", q.Week, tr) is { } w) parts.Add(w);
        }
        var ctx = ev?["context_window"];
        double? ctxLeft = Num(ctx?["remaining_percentage"]);
        if (ctxLeft is { } cl)
        {
            var size = Num(ctx?["context_window_size"]);
            var tokens = size is > 0 ? $" ({Short(size.Value * cl / 100)})" : "";
            parts.Add($"{(tr ? "Bağlam" : "Context")}: {Pct(cl, tr)} {(tr ? "kaldı" : "left")}{tokens}{Icon(cl, 10, 25, 50)}");
        }
        parts.AddRange(Warnings(fiveLeft, weekLeft, ctxLeft, tr));
        return string.Join(" | ", parts);
    }

    static string? Window(string label, QuotaWindow w, bool tr)
    {
        if (w.Left is not { } left) return null;
        var reset = Quota.ResetLabel(w.ResetsAt, tr);
        var rem = Quota.Remaining(w.ResetsAt, tr);
        var when = reset.Length == 0 ? "" : $" · {reset}" + (rem.Length > 0 ? $" ({rem})" : "");
        return $"{label}: {Pct(left, tr)} {(tr ? "kaldı" : "left")}{when}{Icon(left, 5, 15, 30)}";
    }

    static IEnumerable<string> Warnings(double? five, double? week, double? ctx, bool tr)
    {
        if (five <= 5) yield return tr ? "KOTA KRİTİK: yalnız zorunlu işlem" : "QUOTA CRITICAL: essentials only";
        else if (five <= 15) yield return tr ? "Kota az" : "Quota low";
        if (week <= 15) yield return tr ? "HAFTALIK KOTA KRİTİK" : "WEEKLY QUOTA CRITICAL";
        else if (week <= 30) yield return tr ? "Haftalık kota düşük" : "Weekly quota low";
        if (ctx <= 10) yield return tr ? "Bağlam doldu: /compact" : "Context full: /compact";
        else if (ctx <= 25) yield return tr ? "Bağlam azaldı: /compact önerilir" : "Context low: /compact suggested";
    }

    static string Pct(double v, bool tr) => tr
        ? "%" + v.ToString("0", CultureInfo.InvariantCulture)
        : v.ToString("0", CultureInfo.InvariantCulture) + "%";

    static string Icon(double left, double crit, double low, double warn) =>
        left <= crit ? " !!!" : left <= low ? " !!" : left <= warn ? " !" : "";

    static string Short(double n) => n >= 1_000_000 ? (n / 1_000_000).ToString(n < 10_000_000 ? "0.0" : "0", CultureInfo.InvariantCulture) + "M"
        : n >= 1000 ? (n / 1000).ToString(n < 10_000 ? "0.0" : "0", CultureInfo.InvariantCulture) + "K"
        : n.ToString("0", CultureInfo.InvariantCulture);

    static double? Num(JsonNode? n) => n is JsonValue v && v.TryGetValue<double>(out var d) ? d : null;

    /// <summary>
    /// Panel terminal oturumlarının bağlam penceresini başka yerden öğrenemez (ContextWindows.cs):
    /// ~/.claude/context-window-cache.json'a { session_id: { size, model, ts } } yazılır, son 60 oturum tutulur.
    /// </summary>
    static void SaveContextWindow(JsonNode? ev)
    {
        var sid = ev?["session_id"] is JsonValue s && s.TryGetValue<string>(out var str) ? str : null;
        var size = Num(ev?["context_window"]?["context_window_size"]);
        if (string.IsNullOrEmpty(sid) || size is not > 0) return;
        try
        {
            var data = File.Exists(ContextCacheFile) ? JsonNode.Parse(File.ReadAllText(ContextCacheFile)) as JsonObject : null;
            data ??= [];
            if (Num(data[sid]?["size"]) == size) return;
            data[sid] = new JsonObject
            {
                ["size"] = (long)size.Value,
                ["model"] = ev?["model"]?["id"]?.DeepClone(),
                ["ts"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
            };
            if (data.Count > 60)
                foreach (var old in data.OrderBy(kv => Num(kv.Value?["ts"]) ?? 0).Take(data.Count - 60).Select(kv => kv.Key).ToList())
                    data.Remove(old);
            var tmp = ContextCacheFile + $".{Environment.ProcessId}.tmp";
            File.WriteAllText(tmp, data.ToJsonString());
            File.Move(tmp, ContextCacheFile, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Text.Json.JsonException
                                       or InvalidOperationException) { }
    }

    // ---------------- kota koruması ----------------

    static readonly HashSet<string> ReadTools = new(StringComparer.Ordinal)
    {
        "Read", "Grep", "Glob", "LS", "ToolSearch", "TodoWrite",
        "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "TaskOutput", "TaskStop"
    };
    static readonly string[] MemoryMarks =
        ["CLAUDE_MEMORY", "NEXT_SESSION", "MEMORY.md", "memory/", "memory\\", ".claude/projects", ".claude\\projects"];
    static readonly string[] SafeCommands =
        ["git status", "git diff", "git log", "git branch", "wc ", "cat ", "type ", "dir ", "ls ", "pwd", "echo "];

    /// <summary>Kota koruması bu aracı engellemeli mi (kotadan bağımsız kısım).</summary>
    public static bool Allowed(string tool, JsonNode? input)
    {
        if (ReadTools.Contains(tool)) return true;
        var path = Str(input?["file_path"]) ?? Str(input?["path"]) ?? Str(input?["notebook_path"]) ?? "";
        if (tool is "Write" or "Edit" or "MultiEdit" or "NotebookEdit")
            return MemoryMarks.Any(m => path.Contains(m, StringComparison.OrdinalIgnoreCase));
        if (tool is "Bash" or "PowerShell")
        {
            var cmd = (Str(input?["command"]) ?? "").Trim();
            return SafeCommands.Any(c => cmd.StartsWith(c, StringComparison.Ordinal))
                   || MemoryMarks.Any(m => cmd.Contains(m, StringComparison.OrdinalIgnoreCase));
        }
        return false;
    }

    static string? Str(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    public static int RunGuard(string[] args)
    {
        JsonNode? ev;
        try { ev = JsonNode.Parse(Console.In.ReadToEnd()); }
        catch (System.Text.Json.JsonException) { return 0; }
        var q = Quota.Read(Quota.CurrentDir, fetch: true);
        if (q?.Five.Left is not { } left || left > GuardThreshold) return 0; // okunamıyorsa engelleme
        if (Allowed(Str(ev?["tool_name"]) ?? "", ev?["tool_input"])) return 0;
        var tr = Turkish(args);
        var reset = Quota.ResetLabel(q.Five.ResetsAt, tr);
        var rem = Quota.Remaining(q.Five.ResetsAt, tr);
        var when = reset + (rem.Length > 0 ? $" ({rem})" : "");
        var leftText = left.ToString("0", CultureInfo.InvariantCulture);
        var msg = tr
            ? $"Kota koruması: 5 saatlik kotadan %{leftText} kaldı; yeni iş yapılmaz. Sıfırlanma: {when}.\n" +
              "Yapılacaklar: 1) yapılanı ve yarım kalanı hafıza dosyasına (CLAUDE_MEMORY.md / NEXT_SESSION.md) yaz, " +
              "2) kullanıcıya durumu bildir ve sıfırlanmayı bekle. Yalnız okuma ve hafıza kaydı serbest.\n"
            : $"Quota guard: {leftText}% of the 5-hour quota left; no new work. Resets: {when}.\n" +
              "To do: 1) write what was done and what is unfinished to the memory file (CLAUDE_MEMORY.md / NEXT_SESSION.md), " +
              "2) tell the user and wait for the reset. Only reading and memory notes are allowed.\n";
        Write(Console.OpenStandardError(), msg);
        return 2; // Claude Code'da yalnız exit 2 engeller
    }

    /// <summary>Konsol kod sayfasına bakmadan UTF-8 (Claude Code UTF-8 okur).</summary>
    static void Write(Stream stream, string text)
    {
        using (stream) stream.Write(Encoding.UTF8.GetBytes(text));
    }
}

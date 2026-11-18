using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ClaudePanel;

public sealed record TerminalQuotaStatus(bool Enabled, bool Available, string? CurrentStatusLine, bool OwnGuard, string? Error);

/// <summary>
/// Ayarlar → "Terminal oturumlarında kota": ~/.claude/settings.json'a panelin durum satırını (statusLine) ve kota
/// koruması hook'unu yazar; kapatınca yalnız kendi eklediklerini kaldırır, önceki statusLine'ı geri koyar.
/// Önceki statusLine panel veri klasöründe saklanır (settings.json'a bilinmeyen anahtar eklenmez).
/// Kullanıcının kendi kota koruması (komutunda "quota-guard" geçen hook) varsa ikinci bir koruma eklenmez.
/// </summary>
public static class QuotaSetup
{
    static readonly string SettingsFile = Path.Combine(Quota.ClaudeDir, "settings.json");
    static readonly string BackupFile = Path.Combine(Handoff.DataDir, "statusline-backup.json");
    static readonly JsonSerializerOptions Pretty = new() { WriteIndented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    static readonly object Lock = new();

    static string? StatusCommand => NightGuard.PanelExe() is { } exe ? $"\"{exe}\" {QuotaCli.StatusLineArg}" : null;
    static string Lang(string? lang) => lang == "en" ? " --lang en" : " --lang tr";

    static bool IsOurs(string? command, string arg) =>
        command is not null && command.Contains(arg, StringComparison.Ordinal)
        && command.Contains("ClaudePanel", StringComparison.OrdinalIgnoreCase);

    public static TerminalQuotaStatus Status()
    {
        lock (Lock)
        {
            if (StatusCommand is null) return new(false, false, null, false, "noexe");
            try
            {
                var root = Load();
                var current = root["statusLine"]?["command"] is JsonValue v && v.TryGetValue<string>(out var c) ? c : null;
                var enabled = IsOurs(current, QuotaCli.StatusLineArg);
                return new(enabled, true, enabled ? null : current, HasForeignGuard(root), null);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException)
            {
                return new(false, false, null, false, "unreadable");
            }
        }
    }

    /// <summary>Açar ya da kapatır; hata varsa kodu döner ("unreadable", "noexe", "write").</summary>
    public static string? Set(bool on, string? lang)
    {
        lock (Lock)
        {
            if (StatusCommand is null) return "noexe";
            JsonObject root;
            try { root = Load(); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException)
            {
                return "unreadable"; // bozuk/yorumlu dosyanın üzerine yazılmaz
            }
            if (on) { Disable(root); Enable(root, lang); } else Disable(root); // açıkken dil değişirse yeniden yazılır
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(SettingsFile)!);
                var tmp = SettingsFile + ".panel.tmp";
                File.WriteAllText(tmp, root.ToJsonString(Pretty));
                File.Move(tmp, SettingsFile, overwrite: true);
                return null;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return "write"; }
        }
    }

    static void Enable(JsonObject root, string? lang)
    {
        var current = root["statusLine"];
        var currentCmd = current?["command"] is JsonValue v && v.TryGetValue<string>(out var c) ? c : null;
        if (current is not null && !IsOurs(currentCmd, QuotaCli.StatusLineArg))
        {
            Directory.CreateDirectory(Handoff.DataDir);
            File.WriteAllText(BackupFile, current.ToJsonString(Pretty));
        }
        root["statusLine"] = new JsonObject { ["type"] = "command", ["command"] = StatusCommand + Lang(lang), ["padding"] = 0 };
        if (HasForeignGuard(root) || HasOurGuard(root)) return;
        var hooks = root["hooks"] as JsonObject ?? (JsonObject)(root["hooks"] = new JsonObject());
        var pre = hooks["PreToolUse"] as JsonArray ?? (JsonArray)(hooks["PreToolUse"] = new JsonArray());
        pre.Add(GuardEntry($"\"{NightGuard.PanelExe()}\" {QuotaCli.GuardArg}{Lang(lang)}"));
    }

    static void Disable(JsonObject root)
    {
        var currentCmd = root["statusLine"]?["command"] is JsonValue v && v.TryGetValue<string>(out var c) ? c : null;
        if (IsOurs(currentCmd, QuotaCli.StatusLineArg))
        {
            root.Remove("statusLine");
            try
            {
                if (File.Exists(BackupFile))
                {
                    root["statusLine"] = JsonNode.Parse(File.ReadAllText(BackupFile));
                    File.Delete(BackupFile);
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { }
        }
        if (root["hooks"] is not JsonObject hooks || hooks["PreToolUse"] is not JsonArray pre) return;
        foreach (var entry in pre.OfType<JsonObject>().ToList())
        {
            if (entry["hooks"] is not JsonArray list) continue;
            foreach (var h in list.OfType<JsonObject>().Where(h => IsOurs(Cmd(h), QuotaCli.GuardArg)).ToList()) list.Remove(h);
            if (list.Count == 0) pre.Remove(entry);
        }
        if (pre.Count == 0) hooks.Remove("PreToolUse");
        if (hooks.Count == 0) root.Remove("hooks");
    }

    public static JsonObject GuardEntry(string command) => new()
    {
        ["matcher"] = "*",
        ["hooks"] = new JsonArray(new JsonObject { ["type"] = "command", ["command"] = command, ["timeout"] = 15 })
    };

    static string? Cmd(JsonObject h) => h["command"] is JsonValue v && v.TryGetValue<string>(out var c) ? c : null;

    static IEnumerable<string> PreToolCommands(JsonObject root) =>
        (root["hooks"]?["PreToolUse"] as JsonArray)?.OfType<JsonObject>()
            .SelectMany(e => (e["hooks"] as JsonArray)?.OfType<JsonObject>() ?? [])
            .Select(Cmd).OfType<string>() ?? [];

    static bool HasOurGuard(JsonObject root) => PreToolCommands(root).Any(c => IsOurs(c, QuotaCli.GuardArg));

    /// <summary>Kullanıcının kendi kota koruması (ör. quota-guard.py) kayıtlı mı.</summary>
    static bool HasForeignGuard(JsonObject root) =>
        PreToolCommands(root).Any(c => c.Contains("quota-guard", StringComparison.OrdinalIgnoreCase) && !IsOurs(c, QuotaCli.GuardArg));

    static JsonObject Load()
    {
        if (!File.Exists(SettingsFile)) return [];
        var text = File.ReadAllText(SettingsFile);
        if (string.IsNullOrWhiteSpace(text)) return [];
        return JsonNode.Parse(text) as JsonObject ?? throw new JsonException("settings.json nesne değil");
    }
}

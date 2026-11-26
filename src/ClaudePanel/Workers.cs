using System.ComponentModel;
using System.Diagnostics;
using System.Text.RegularExpressions;

namespace ClaudePanel;

/// <summary>
/// Ayarlar → Yapay zekâ işçileri: Claude'un iş verebileceği araçlar (Codex, Gemini) için kalıcı aç/kapa (hub.json) ve
/// Gemini işçisinin komut satırı aracı Antigravity CLI'nin (`agy`) kurulu sürümü. Google, 18.06.2026'dan beri ücretsiz ve
/// Google AI Pro kişisel kullanımı Gemini CLI'de değil Antigravity CLI'de karşılıyor (antigravity.google/docs/plans); işçi kimliği
/// hub.json uyumu için "gemini" kalır. Kapalı işçiye iş yönlendirilmez (Routing.cs). Panel bu araçları çalıştırmaz; yalnız
/// `agy --version` okunur: arka planda, zaman aşımlı, 10 dakikada bir (istek beklemez, ilk yanıtta "checking").
/// Test: CLAUDE_PANEL_GEMINI_EXE sahte betiği verir (dosya yoksa "kurulu değil"); uydurma ortamda (CLAUDE_PANEL_CLAUDE_DIR)
/// sahte betik verilmediyse gerçek agy aranmaz.
/// </summary>
public static partial class Workers
{
    public static readonly IReadOnlyList<string> Ids = ["codex", "gemini"];
    static readonly Dictionary<string, bool> Defaults = new() { ["codex"] = true, ["gemini"] = false };

    /// <param name="State">"checking" (ilk deneme sürüyor) | "none" (kurulu değil ya da sürüm okunamadı) | "ok".</param>
    public sealed record CliInfo(string State, string? Version);

    static readonly TimeSpan GeminiEvery = TimeSpan.FromMinutes(10);
    const int GeminiTimeoutMs = 15000;
    static readonly object Gate = new();
    static CliInfo gemini = new("checking", null);
    static DateTime geminiAt;
    static Task? geminiTask;

    [GeneratedRegex(@"\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.\-]+)?")]
    private static partial Regex VersionRx();

    public static bool Enabled(string id) =>
        HubSettings.Get().Workers is { } w && w.TryGetValue(id, out var on) ? on : Defaults.GetValueOrDefault(id);

    public static void Set(string id, bool on) =>
        HubSettings.Update(s => s with { Workers = new Dictionary<string, bool>(s.Workers ?? []) { [id] = on } });

    /// <summary>Antigravity CLI (agy) durumu (önbellekten). Süresi dolduysa arka planda yeniden okur; çağıranı bekletmez.</summary>
    public static CliInfo Gemini()
    {
        lock (Gate)
        {
            if (geminiTask is null && DateTime.UtcNow - geminiAt > GeminiEvery) StartProbe();
            return gemini;
        }
    }

    /// <summary>Antigravity CLI'yi hemen yeniden dener (kurulumdan sonra "Yeniden dene"); en çok zaman aşımı kadar sürer.</summary>
    public static Task<CliInfo> RecheckGemini()
    {
        Task task;
        lock (Gate) task = geminiTask ?? StartProbe();
        return task.ContinueWith(_ => { lock (Gate) return gemini; });
    }

    static Task StartProbe()
    {
        geminiAt = DateTime.UtcNow;
        var t = Task.Run(() =>
        {
            var info = ProbeGemini();
            lock (Gate) { gemini = info; geminiAt = DateTime.UtcNow; geminiTask = null; }
        });
        geminiTask = t;
        return t;
    }

    static CliInfo ProbeGemini()
    {
        if (FindGemini() is not { } exe) return new("none", null);
        try
        {
            var psi = new ProcessStartInfo(exe)
            {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true
            };
            psi.ArgumentList.Add("--version");
            psi.Environment["NO_COLOR"] = "1";
            using var p = Process.Start(psi);
            if (p is null) return new("none", null);
            p.StandardInput.Close();
            p.ErrorDataReceived += (_, _) => { };
            p.BeginErrorReadLine();
            var read = p.StandardOutput.ReadToEndAsync();
            if (!p.WaitForExit(GeminiTimeoutMs) || !read.Wait(1000))
            {
                try { p.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
                RemoteLog.Info("agy --version zaman aşımına uğradı; Antigravity CLI kurulu değil sayıldı.");
                return new("none", null);
            }
            return VersionRx().Match(read.Result) is { Success: true } m ? new("ok", m.Value) : new("none", null);
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException or IOException or AggregateException)
        {
            RemoteLog.Info($"agy --version okunamadı: {ex.Message}");
            return new("none", null);
        }
    }

    /// <summary>agy komutunun yolu. Resmi kurulum yeri (getting-started?tab=cli): Windows %LOCALAPPDATA%\agy\bin, macOS/Linux
    /// ~/.local/bin/agy; ikisi de PATH'e eklenir ama panel PATH güncellenmeden önce açılmış olabilir. Yoksa null.</summary>
    static string? FindGemini()
    {
        if (Environment.GetEnvironmentVariable("CLAUDE_PANEL_GEMINI_EXE") is { Length: > 0 } fake) return File.Exists(fake) ? fake : null;
        if (Environment.GetEnvironmentVariable("CLAUDE_PANEL_CLAUDE_DIR") is { Length: > 0 }) return null;
        var names = OperatingSystem.IsWindows() ? new[] { "agy.exe", "agy.cmd" } : ["agy"];
        var dirs = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator).Select(d => d.Trim()).Where(d => d.Length > 0).ToList();
        if (OperatingSystem.IsWindows()) dirs.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "agy", "bin"));
        else dirs.InsertRange(0, [Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]); // Finder'dan açılan uygulamanın PATH'i kısadır
        foreach (var d in dirs)
            foreach (var n in names)
            {
                var f = Path.Combine(d, n);
                if (File.Exists(f)) return f;
            }
        return null;
    }
}

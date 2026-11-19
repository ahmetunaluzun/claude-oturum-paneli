using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ClaudePanel;

/// <param name="State">"idle" | "running" | "done" | "failed".</param>
/// <param name="Error">Kısa kod (nostart, timeout, interrupted; arayüz çevirir) ya da claude çıktısının son satırı.</param>
/// <param name="To">Kurulan sürüm; `claude update` yeni sürüm kurmadıysa null.</param>
/// <param name="AutoFor">Kendiliğinden güncellemenin en son denendiği hedef sürüm (aynı sürüm için tekrar denenmez).</param>
public sealed record ClaudeUpdateState(string State = "idle", string? From = null, string? To = null, string? Error = null,
    long At = 0, string? AutoFor = null);

/// <summary>
/// Claude Code'u günceller: `claude update` panelin kendi sürecinde, pencere açmadan çalışır. Takip taraması yeni sürüm görünce
/// kendiliğinden başlatır (aynı hedef sürüm için bir kez; başarısızsa <see cref="RetryAfter"/> sonra yeniden); "Şimdi güncelle"
/// düğmesi elle başlatır. Aynı anda tek güncelleme. Açık oturumlar eski sürümle sürer, yeni sürüm yeni oturumlarda geçerli olur.
/// </summary>
public sealed partial class ClaudeUpdater(UpdateCheck updates, ILogger<ClaudeUpdater> log)
{
    static readonly string StateFile = Path.Combine(Handoff.DataDir, "claude-update.json");
    static readonly TimeSpan RetryAfter = TimeSpan.FromHours(6);
    const int TimeoutMs = 5 * 60 * 1000, ErrorMax = 200;

    int _running;
    volatile ClaudeUpdateState _state = Load();

    public ClaudeUpdateState State => _state;

    /// <summary>Kendiliğinden güncelleme: <paramref name="latest"/> için daha önce denenmediyse (ya da başarısız deneme eskidiyse) başlatır.</summary>
    public void Auto(string latest, Action onDone)
    {
        var s = _state;
        var retry = s.State == "failed" && DateTimeOffset.UtcNow.ToUnixTimeSeconds() - s.At > RetryAfter.TotalSeconds;
        if (s.AutoFor == latest && !retry) return;
        Start(onDone, latest);
    }

    /// <summary>Güncellemeyi arka planda başlatır; zaten sürüyorsa false.</summary>
    public bool Start(Action onDone, string? autoFor = null)
    {
        if (Interlocked.Exchange(ref _running, 1) == 1) return false;
        var prev = _state;
        Set(prev with { State = "running", Error = null, At = Now(), AutoFor = autoFor ?? prev.AutoFor });
        _ = Task.Run(() =>
        {
            try { Set(Run() with { AutoFor = _state.AutoFor }); }
            finally
            {
                Interlocked.Exchange(ref _running, 0);
                updates.ForgetLocal();
                onDone();
            }
        });
        return true;
    }

    ClaudeUpdateState Run()
    {
        log.LogInformation("Claude Code güncelleniyor (claude update)");
        try
        {
            var psi = new ProcessStartInfo(Launcher.ClaudeExe())
            {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
            };
            psi.ArgumentList.Add("update");
            using var p = Process.Start(psi);
            if (p is null) return Failed("nostart");
            p.StandardInput.Close(); // soru sorarsa beklemesin: girdi yok
            var output = new StringBuilder();
            p.OutputDataReceived += (_, e) => { if (e.Data is not null) lock (output) output.AppendLine(e.Data); };
            p.ErrorDataReceived += (_, e) => { if (e.Data is not null) lock (output) output.AppendLine(e.Data); };
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            if (!p.WaitForExit(TimeoutMs))
            {
                p.Kill(entireProcessTree: true);
                return Failed("timeout");
            }
            p.WaitForExit(); // akışların sonu
            string text;
            lock (output) text = output.ToString();
            if (p.ExitCode != 0) return Failed(LastLine(text) ?? $"çıkış kodu {p.ExitCode}");
            var m = UpdatedRx().Match(text);
            log.LogInformation("Claude Code güncellemesi bitti: {Result}", m.Success ? $"{m.Groups[1].Value} → {m.Groups[2].Value}" : "yeni sürüm kurulmadı");
            return new("done", m.Success ? m.Groups[1].Value : null, m.Success ? m.Groups[2].Value : null, null, Now());
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException or IOException)
        {
            return Failed(ex.Message);
        }
    }

    ClaudeUpdateState Failed(string why)
    {
        var msg = why.Length > ErrorMax ? why[..ErrorMax] + "…" : why;
        log.LogWarning("Claude Code güncellenemedi: {Msg}", msg);
        return new("failed", null, null, msg, Now());
    }

    static string? LastLine(string text) =>
        text.Split('\n').Select(l => l.Trim()).LastOrDefault(l => l.Length > 0);

    // "Successfully updated from 2.1.327 to version 2.1.328"
    [GeneratedRegex(@"from\s+v?(\d+\.\d+\.\d+\S*)\s+to\s+(?:version\s+)?v?(\d+\.\d+\.\d+\S*)", RegexOptions.IgnoreCase)]
    private static partial Regex UpdatedRx();

    static long Now() => DateTimeOffset.UtcNow.ToUnixTimeSeconds();

    void Set(ClaudeUpdateState s)
    {
        _state = s;
        try
        {
            Directory.CreateDirectory(Handoff.DataDir);
            var tmp = StateFile + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(s));
            File.Move(tmp, StateFile, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            log.LogDebug("Güncelleme durumu yazılamadı: {Msg}", ex.Message);
        }
    }

    static ClaudeUpdateState Load()
    {
        try
        {
            var s = File.Exists(StateFile) ? JsonSerializer.Deserialize<ClaudeUpdateState>(File.ReadAllText(StateFile)) ?? new() : new();
            // Panel güncelleme sürerken kapandıysa "running" kalmış olur: yarıda kalmış sayılır.
            return s.State == "running" ? s with { State = "failed", Error = "interrupted" } : s;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { return new(); }
    }
}

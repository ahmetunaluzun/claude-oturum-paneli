using System.Collections.Concurrent;
using System.Text.Json;

namespace ClaudePanel;

/// <summary>
/// Modelin bağlam penceresi (token). Sabit yazılmaz, kaynağından öğrenilir:
/// 1) panel oturumunun sonuç kaydı: modelUsage[model].contextWindow (oturum + model için),
/// 2) statusline'ın yazdığı ~/.claude/context-window-cache.json: { "&lt;sessionId&gt;": { "size": N, "model": "..." } }.
/// Model başına öğrenilen değer diske yazılır; terminal oturumu da panel yeniden başlasa da bilinir.
/// Bilinmiyorsa null döner, arayüz yüzde değil yalnız token sayısı gösterir.
/// </summary>
public sealed class ContextWindows(ILogger<ContextWindows> log)
{
    static readonly string LearnedFile = Path.Combine(Handoff.DataDir, "context-windows.json");
    static readonly string StatuslineFile = Path.Combine(Quota.ClaudeDir, "context-window-cache.json");

    readonly ConcurrentDictionary<string, long> _byModel = new(StringComparer.OrdinalIgnoreCase);
    readonly ConcurrentDictionary<string, long> _bySession = new();
    DateTime _statuslineStamp;
    bool _loaded;
    readonly object _lock = new();

    public long? Of(string? sessionId, string? model)
    {
        Load();
        RefreshStatusline();
        if (sessionId is not null && _bySession.TryGetValue(sessionId, out var s)) return s;
        if (model is not null && _byModel.TryGetValue(model, out var m)) return m;
        return null;
    }

    /// <summary>Panel oturumunun result olayından: modelUsage içindeki her modelin contextWindow değeri.</summary>
    public void LearnFromResult(string? sessionId, JsonElement result)
    {
        if (!result.TryGetProperty("modelUsage", out var mu) || mu.ValueKind != JsonValueKind.Object) return;
        var changed = false;
        foreach (var p in mu.EnumerateObject())
        {
            if (p.Value.ValueKind != JsonValueKind.Object || !p.Value.TryGetProperty("contextWindow", out var cw)
                || cw.ValueKind != JsonValueKind.Number || !cw.TryGetInt64(out var size) || size <= 0) continue;
            if (_byModel.TryGetValue(p.Name, out var old) && old == size) continue;
            _byModel[p.Name] = size;
            changed = true;
            log.LogInformation("Bağlam penceresi öğrenildi: {Model} = {Size}", p.Name, size);
        }
        // Oturumun ana modeli: en çok çıktı üreten (alt ajan modelleri de listede olabilir).
        var main = mu.EnumerateObject().Where(p => p.Value.ValueKind == JsonValueKind.Object)
            .OrderByDescending(p => p.Value.TryGetProperty("outputTokens", out var o) && o.TryGetInt64(out var n) ? n : 0)
            .Select(p => p.Name).FirstOrDefault();
        if (sessionId is not null && main is not null && _byModel.TryGetValue(main, out var ms)) _bySession[sessionId] = ms;
        if (changed) Save();
    }

    void Load()
    {
        if (_loaded) return;
        lock (_lock)
        {
            if (_loaded) return;
            _loaded = true;
            try
            {
                if (!File.Exists(LearnedFile)) return;
                var d = JsonSerializer.Deserialize<Dictionary<string, long>>(File.ReadAllText(LearnedFile));
                if (d is not null) foreach (var (k, v) in d) if (v > 0) _byModel.TryAdd(k, v);
            }
            catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
            {
                log.LogWarning("Bağlam penceresi dosyası okunamadı: {Msg}", ex.Message);
            }
        }
    }

    void Save()
    {
        try
        {
            Directory.CreateDirectory(Handoff.DataDir);
            var tmp = LearnedFile + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(_byModel.ToDictionary(k => k.Key, v => v.Value)));
            File.Move(tmp, LearnedFile, true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            log.LogWarning("Bağlam penceresi dosyası yazılamadı: {Msg}", ex.Message);
        }
    }

    void RefreshStatusline()
    {
        try
        {
            if (!File.Exists(StatuslineFile)) return;
            var stamp = File.GetLastWriteTimeUtc(StatuslineFile);
            if (stamp == _statuslineStamp) return;
            _statuslineStamp = stamp;
            using var doc = JsonDocument.Parse(File.ReadAllText(StatuslineFile));
            foreach (var p in doc.RootElement.EnumerateObject())
            {
                if (p.Value.ValueKind != JsonValueKind.Object || !p.Value.TryGetProperty("size", out var sz)
                    || !sz.TryGetInt64(out var size) || size <= 0) continue;
                _bySession[p.Name] = size;
            }
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException or InvalidOperationException)
        {
            log.LogDebug("Statusline bağlam önbelleği okunamadı: {Msg}", ex.Message);
        }
    }
}

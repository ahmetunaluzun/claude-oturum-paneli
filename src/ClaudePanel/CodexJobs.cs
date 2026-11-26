using System.Text.Json;

namespace ClaudePanel;

/// <summary>
/// Claude'un Codex'e verdiği işlerin özeti (Ayarlar → Yapay zekâ işçileri → Codex kartı, "son başarılı iş").
/// Kaynak: `.shared-knowledge\araclar\codex_isci.py` her iş sonunda &lt;veri klasörü&gt;\codex-isler\&lt;zaman&gt;-sonuc.json yazar
/// ({"cikis", "bitis", "engel"}). Panel bu dosyaları yalnız okur; görev metni ve proje adı bu dosyada yoktur.
/// Betik bu özeti eklemeden önceki işler sayılmaz (kayıt yoksa "henüz yok").
/// </summary>
public static class CodexJobs
{
    /// <param name="LastAt">Son işin bitişi (Unix ms).</param>
    /// <param name="LastExit">Son işin çıkış kodu (0 = başarılı).</param>
    /// <param name="OkAt">Son başarılı işin bitişi (Unix ms); hiç yoksa null.</param>
    public sealed record Summary(long LastAt, int LastExit, long? OkAt);

    sealed record Row(int Cikis, DateTimeOffset Bitis);

    static string Dir => Path.Combine(Handoff.DataDir, "codex-isler");
    const int MaxFiles = 200; // en yeni dosyalardan geriye; başarılı iş bunlar içinde aranır

    /// <summary>Kayıt yoksa (hiç iş verilmemiş ya da betik eski) null.</summary>
    public static Summary? Last()
    {
        string[] files;
        try
        {
            if (!Directory.Exists(Dir)) return null;
            // Dosya adı yyyyMMdd-HHmmss: ada göre sıralama zamana göre sıralamadır.
            files = Directory.GetFiles(Dir, "*-sonuc.json");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return null; }
        Array.Sort(files, StringComparer.Ordinal);
        Summary? result = null;
        foreach (var f in files.Reverse().Take(MaxFiles))
        {
            if (Read(f) is not { } r) continue; // bozuk/yarım dosya: sonrakine bak
            var at = r.Bitis.ToUnixTimeMilliseconds();
            result ??= new Summary(at, r.Cikis, null);
            if (r.Cikis == 0) return result with { OkAt = at };
        }
        return result;
    }

    static Row? Read(string file)
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(file));
            var root = doc.RootElement;
            if (root.TryGetProperty("cikis", out var c) && c.TryGetInt32(out var code)
                && root.TryGetProperty("bitis", out var b) && DateTimeOffset.TryParse(b.GetString(), out var at))
                return new Row(code, at);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException) { }
        return null;
    }
}

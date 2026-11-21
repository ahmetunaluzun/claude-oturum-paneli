using System.Text.Json;

namespace ClaudePanel;

/// <param name="Fp">GitOps.Fingerprint (depo kökü + dosya + kural + eşleşen metin). Değerin kendisi saklanmaz.</param>
public sealed record PushAllowEntry(string Fp, string Root, string File, string What, long At);

/// <summary>
/// Gizli bilgi denetiminde kullanıcının "test verisi, yine de gönder" dediği bulgular (panel veri klasöründe push-allow.json).
/// Yalnız kalıp bulguları girer; dosya bulguları (izin dosyası, .env, anahtar dosyası...) asla. Aynı metin aynı dosyada
/// yeniden eklenirse izinli kalır; başka bir bulgu gönderimi yine durdurur.
/// Yazma oku-birleştir-yaz (kilit altında, geçici dosya + taşıma); bozuk dosya silinmez, yanına yedeklenir.
/// </summary>
public static class PushAllow
{
    const int MaxEntries = 5000;
    static readonly object Lock = new();
    static string FilePath => Path.Combine(Handoff.DataDir, "push-allow.json");

    public static HashSet<string> Fps()
    {
        lock (Lock) return (Read() ?? []).Select(e => e.Fp).ToHashSet(StringComparer.Ordinal);
    }

    /// <summary>Bulguları izinli yapar; dosya bulguları atlanır. → yeni eklenen sayısı.</summary>
    public static int Add(string root, IEnumerable<SecretFinding> findings)
    {
        lock (Lock)
        {
            var list = Read();
            if (list is null) // okunamadı: üzerine yazıp eski izinleri kaybetme, yanına yedekle
            {
                try { File.Move(FilePath, FilePath + $".bozuk-{DateTime.Now:yyyyMMdd-HHmmss}", overwrite: true); }
                catch (IOException) { }
                list = [];
            }
            var have = list.Select(e => e.Fp).ToHashSet(StringComparer.Ordinal);
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var added = 0;
            foreach (var f in findings)
            {
                if (f.Kind != "pattern" || f.Fp.Length == 0 || !have.Add(f.Fp)) continue;
                list.Add(new PushAllowEntry(f.Fp, ProjectRoots.Normalize(root), f.File, f.What, now));
                added++;
            }
            if (added == 0) return 0;
            if (list.Count > MaxEntries) list = list.OrderBy(e => e.At).Skip(list.Count - MaxEntries).ToList();
            Directory.CreateDirectory(Handoff.DataDir);
            var tmp = FilePath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(list, new JsonSerializerOptions { WriteIndented = true }));
            File.Move(tmp, FilePath, overwrite: true);
            return added;
        }
    }

    /// <summary>Kayıtlı izinler; dosya yoksa boş, okunamıyorsa null.</summary>
    static List<PushAllowEntry>? Read()
    {
        try
        {
            if (!File.Exists(FilePath)) return [];
            return JsonSerializer.Deserialize<List<PushAllowEntry>>(File.ReadAllText(FilePath))?.Where(e => e?.Fp is { Length: > 0 }).ToList() ?? [];
        }
        catch (JsonException) { return null; }
        catch (IOException) { return null; }
    }
}

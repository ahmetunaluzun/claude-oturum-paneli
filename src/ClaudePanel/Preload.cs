using System.Reflection;

namespace ClaudePanel;

/// <summary>
/// Tek dosyalık yayında kitaplıklar ilk kullanıldıkları an exe'nin kendisinden (yolundan) okunur. Canlı panel güncellenirken
/// çalışan exe yeniden adlandırılıp yerine yenisi yazılıyor; o arada ilk kez yüklenen kitaplık bulunamıyordu
/// (18.11.2026: QRCoder → FileNotFoundException, Ayarlar → Telefondan erişim kalıcı 500). Açılışta hepsi yüklenir.
/// </summary>
static class Preload
{
    public static int All()
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var queue = new Queue<Assembly>([Assembly.GetEntryAssembly()!]);
        while (queue.Count > 0)
        {
            foreach (var name in queue.Dequeue().GetReferencedAssemblies())
            {
                if (!seen.Add(name.FullName)) continue;
                try { queue.Enqueue(Assembly.Load(name)); }
                catch (Exception ex) when (ex is FileNotFoundException or FileLoadException or BadImageFormatException) { }
            }
        }
        return seen.Count;
    }
}

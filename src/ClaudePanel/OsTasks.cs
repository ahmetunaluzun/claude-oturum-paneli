using System.Text;
using System.Text.Json;
using System.Xml;
using System.Xml.Linq;

namespace ClaudePanel;

/// <summary>İşletim sisteminin zamanlayıcısındaki bir görev (Windows Görev Zamanlayıcı / macOS LaunchAgent).</summary>
/// <param name="Id">Windows: görev yolu (\Klasör\Ad); macOS: plist dosyasının yolu.</param>
/// <param name="LastResult">Son çalışmanın sonuç kodu (Windows: HRESULT / çıkış kodu; macOS: launchctl'in son çıkış durumu); bilinmiyorsa null.</param>
/// <param name="Schedule">macOS: plist'teki zamanlama anahtarı (ör. "StartInterval=3600"); Windows'ta null (sonraki çalışma gösterilir).</param>
/// <param name="Unreadable">Kaynak okunamadı (ör. ikili plist): satır "okunamadı" diye gösterilir, sessiz atlanmaz.</param>
/// <param name="Running">Görevin bir kopyası şu an çalışıyor (Windows: TASK_STATE_RUNNING). Tek kopya kuralında saatlik tetikleme
/// 0x800710E0 ile reddedilir; çalışan kopya varken bu kod arıza değildir.</param>
public sealed record OsTask(string Id, string Name, string Folder, bool Enabled, long? NextRun, long? LastRun, long? LastResult,
    string Command, string Args, string WorkDir, string? Schedule, bool CanDisable, bool Unreadable = false, bool Running = false);

/// <summary>
/// Görev kaynağı seçimi. Testte ve ekran görüntüsünde gerçek zamanlayıcıya dokunulmaz:
///   CLAUDE_PANEL_TASKS_FILE       → görevler bu JSON dosyasından okunur, "devre dışı bırak" yalnız bu dosyaya yazar;
///   CLAUDE_PANEL_LAUNCHAGENTS_DIR → görevler bu klasördeki plist'lerden okunur (macOS okuyucusu Windows'ta da denenebilsin).
/// İkisi de yoksa platformun kendi kaynağı (Platform\Windows\NativeTasks.cs, Platform\Mac\NativeTasks.cs).
/// Uydurma ortamda (CLAUDE_PANEL_CLAUDE_DIR verilmiş: test, ekran görüntüsü) gerçek zamanlayıcı OKUNMAZ, liste boştur:
/// kullanıcının gerçek görev adları teste ve görüntüye sızmasın. Gerçek kaynağı bilerek denemek için CLAUDE_PANEL_TASKS_REAL=1.
/// </summary>
public static class OsTasks
{
    static readonly bool Isolated = Environment.GetEnvironmentVariable("CLAUDE_PANEL_CLAUDE_DIR") is { Length: > 0 }
        && Environment.GetEnvironmentVariable("CLAUDE_PANEL_TASKS_REAL") != "1";
    static readonly string? FakeFile = Environment.GetEnvironmentVariable("CLAUDE_PANEL_TASKS_FILE") is { Length: > 0 } f ? f : null;
    static readonly string? AgentsDir = Environment.GetEnvironmentVariable("CLAUDE_PANEL_LAUNCHAGENTS_DIR") is { Length: > 0 } d ? d : null;
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    static readonly object FakeLock = new();

    /// <summary>"windows" | "mac" | "test": arayüzdeki bölüm adı ve "devre dışı bırak" düğmesi buna göre.</summary>
    public static string Kind => FakeFile is not null ? "test" : AgentsDir is not null ? "mac" : NativeTasks.Kind;

    /// <summary>Tüm görevler (süzülmemiş); kaynak okunamadıysa null.</summary>
    public static List<OsTask>? List()
    {
        if (FakeFile is not null) return ReadFake();
        if (AgentsDir is not null) return LaunchAgents.Read(AgentsDir, null);
        return Isolated ? [] : NativeTasks.List();
    }

    /// <summary>Görevi devre dışı bırakır. null: oldu; yoksa hata kodu ("unsupported" | "denied" | "notfound" | "failed").
    /// Test dosyası modunda (CLAUDE_PANEL_TASKS_FILE) Run da yalnız bu dosyaya yazar.</summary>
    public static string? Disable(string id)
    {
        if (FakeFile is null) return AgentsDir is not null || Isolated ? "unsupported" : NativeTasks.Disable(id);
        lock (FakeLock)
        {
            var list = ReadFake();
            var at = list?.FindIndex(t => t.Id == id) ?? -1;
            if (list is null || at < 0) return "notfound";
            if (!list[at].CanDisable) return "denied";
            list[at] = list[at] with { Enabled = false, NextRun = null };
            File.WriteAllText(FakeFile, JsonSerializer.Serialize(list, Json), new UTF8Encoding(false));
            return null;
        }
    }

    /// <summary>Görevi hemen çalıştırır. null: başlatıldı; yoksa hata kodu ("unsupported" | "disabled" | "denied" | "notfound" | "failed").
    /// Test dosyasında görev çalıştırılmaz: son çalışma "şimdi", sonuç "çalışıyor" (0x41301) olarak yazılır.</summary>
    public static string? Run(string id)
    {
        if (FakeFile is null) return AgentsDir is not null || Isolated ? "unsupported" : NativeTasks.Run(id);
        lock (FakeLock)
        {
            var list = ReadFake();
            var at = list?.FindIndex(t => t.Id == id) ?? -1;
            if (list is null || at < 0) return "notfound";
            if (!list[at].Enabled) return "disabled";
            list[at] = list[at] with { LastRun = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), LastResult = 0x41301 };
            File.WriteAllText(FakeFile, JsonSerializer.Serialize(list, Json), new UTF8Encoding(false));
            return null;
        }
    }

    static List<OsTask>? ReadFake()
    {
        try { return JsonSerializer.Deserialize<List<OsTask>>(File.ReadAllText(FakeFile!, Encoding.UTF8), Json); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { return null; }
    }
}

/// <summary>
/// ~/Library/LaunchAgents/*.plist okuyucusu (yalnız okur). Plist'te son/sonraki çalışma zamanı YOKTUR: gösterilmez.
/// Son çıkış durumu `launchctl list` çıktısından gelir (çağıran verir). İkili plist ayrıştırılmaz: "okunamadı".
/// </summary>
public static class LaunchAgents
{
    const int MaxBytes = 512 * 1024;

    /// <param name="lastExit">Etiket → son çıkış durumu (launchctl list); bilinmiyorsa null.</param>
    public static List<OsTask>? Read(string dir, IReadOnlyDictionary<string, long>? lastExit)
    {
        if (!Directory.Exists(dir)) return [];
        var list = new List<OsTask>();
        try
        {
            foreach (var file in Directory.EnumerateFiles(dir, "*.plist").OrderBy(f => f, StringComparer.OrdinalIgnoreCase))
            {
                var name = Path.GetFileNameWithoutExtension(file);
                try
                {
                    if (new FileInfo(file).Length > MaxBytes || Parse(File.ReadAllText(file, Encoding.UTF8)) is not { } d)
                    {
                        list.Add(new OsTask(file, name, "", true, null, null, null, "", "", "", null, false, Unreadable: true));
                        continue;
                    }
                    var args = d.Args.Count > 0 ? d.Args : d.Program is null ? [] : [d.Program];
                    var label = d.Label ?? name;
                    list.Add(new OsTask(file, label, "", !d.Disabled, null, null, lastExit is not null && lastExit.TryGetValue(label, out var code) ? code : null,
                        d.Program ?? args.FirstOrDefault() ?? "", string.Join(' ', args.Skip(1).Select(Quote)), d.WorkDir ?? "", d.Schedule, false));
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    list.Add(new OsTask(file, name, "", true, null, null, null, "", "", "", null, false, Unreadable: true));
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return null; }
        return list;
    }

    static string Quote(string a) => a.Contains(' ') ? $"\"{a}\"" : a;

    public sealed record Plist(string? Label, string? Program, List<string> Args, string? WorkDir, bool Disabled, string? Schedule);

    /// <summary>XML plist'in üst sözlüğü; XML değilse (ikili plist, bozuk dosya) null.</summary>
    public static Plist? Parse(string text)
    {
        if (!text.TrimStart().StartsWith('<')) return null;
        XElement? dict;
        try
        {
            using var reader = XmlReader.Create(new StringReader(text), new XmlReaderSettings { DtdProcessing = DtdProcessing.Ignore, XmlResolver = null });
            dict = XDocument.Load(reader).Root?.Element("dict");
        }
        catch (XmlException) { return null; }
        if (dict is null) return null;
        string? label = null, program = null, workDir = null, schedule = null;
        var args = new List<string>();
        var disabled = false;
        var kids = dict.Elements().ToList();
        for (var i = 0; i + 1 < kids.Count; i += 2)
        {
            if (kids[i].Name != "key") return null;
            var v = kids[i + 1];
            switch (kids[i].Value)
            {
                case "Label": label = v.Value; break;
                case "Program": program = v.Value; break;
                case "ProgramArguments": args = v.Elements("string").Select(x => x.Value).ToList(); break;
                case "WorkingDirectory": workDir = v.Value; break;
                case "Disabled": disabled = v.Name == "true"; break;
                case "StartInterval": schedule = Join(schedule, "StartInterval=" + v.Value.Trim()); break;
                case "StartCalendarInterval": schedule = Join(schedule, "StartCalendarInterval " + Flat(v)); break;
                case "RunAtLoad": if (v.Name == "true") schedule = Join(schedule, "RunAtLoad"); break;
                case "KeepAlive": if (v.Name != "false") schedule = Join(schedule, "KeepAlive"); break;
            }
        }
        return new Plist(label, program, args, workDir, disabled, schedule);
    }

    static string Join(string? a, string b) => a is null ? b : a + "; " + b;

    /// <summary>Zamanlama sözlüğünü olduğu gibi düz metne çevirir ("Hour=3 Minute=0"); yorumlanmaz.</summary>
    static string Flat(XElement v)
    {
        var dicts = v.Name == "array" ? v.Elements("dict") : [v];
        return string.Join(" | ", dicts.Select(d =>
        {
            var k = d.Elements().ToList();
            return string.Join(' ', Enumerable.Range(0, k.Count / 2).Select(i => $"{k[i * 2].Value}={k[i * 2 + 1].Value.Trim()}"));
        }));
    }
}

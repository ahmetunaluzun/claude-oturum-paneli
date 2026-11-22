using System.Globalization;

namespace ClaudePanel;

/// <summary>
/// Yeni sürüm açılırken eski panel çalışıyorsa devralma: kullanıcıya sorar, eski paneli kapatır.
/// Eski panel kendi oturum anahtarını yalnız bu kullanıcının okuyabildiği veri klasörüne yazar
/// (panel.token); yeni sürüm bu anahtarla /api/quit çağırır. 0.4.3'ten eski panellerde dosya yoktur,
/// o durumda elle kapatma tarif edilir.
/// </summary>
static class Handoff
{
    public static readonly string DataDir =
        Environment.GetEnvironmentVariable("CLAUDE_PANEL_DATA") is { Length: > 0 } d ? d
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ClaudePanel");

    static string TokenFile(int port) => Path.Combine(DataDir, $"panel-{port.ToString(CultureInfo.InvariantCulture)}.token");

    public static void WriteToken(int port, string token)
    {
        Directory.CreateDirectory(DataDir);
        File.WriteAllText(TokenFile(port), token);
    }

    /// <summary>Çalışan panelin oturum anahtarı (yoksa null).</summary>
    public static string? ReadToken(int port)
    {
        try { return File.ReadAllText(TokenFile(port)).Trim(); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return null; }
    }

    public static void DeleteToken(int port)
    {
        try { File.Delete(TokenFile(port)); }
        catch (IOException) { /* sonraki açılışta üzerine yazılır */ }
    }

    /// <summary>Üç parçalı sürüm. Derleme sürümü 4 parçalı (0.9.1.0), /api/version 3 parçalı (0.9.1) verir;
    /// Version(0.9.1) &lt; Version(0.9.1.0) olduğundan aynı sürüm "eski" sayılıp kullanıcıya soruluyordu (18.11.2026).</summary>
    public static Version Mine => Three(typeof(Handoff).Assembly.GetName().Version ?? new Version(0, 0));

    static Version Three(Version v) => new(v.Major, v.Minor, Math.Max(v.Build, 0));

    /// <summary>
    /// Çalışan panel daha eskiyse ve kullanıcı onaylarsa onu kapatır.
    /// true: eski panel kapandı, bu süreç panel olarak açılmalı. false: çalışan panelin penceresi açılmalı.
    /// </summary>
    public static async Task<bool> TryReplaceOlder(string baseUrl, int port)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
        var running = await RunningVersion(http, baseUrl);
        if (running is null || running >= Mine) return false;

        string old = running.ToString(3), mine = Mine.ToString(3);
        var token = ReadToken(port);

        if (string.IsNullOrEmpty(token))
        {
            await Native.Info($"Açık panel eski sürüm (v{old}); yeni sürüm v{mine} hazır.\n\n" +
                      "Bu eski sürüm kendiliğinden kapatılamıyor. Panelde Ayarlar → Paneli kapat deyip " +
                      "kısayoldan yeniden açın. Bundan sonraki güncellemelerde bu otomatik olacak.");
            return false;
        }

        if (!await Native.Confirm($"Yeni sürüm hazır: v{mine} (açık olan v{old}).\n\nEski panel kapatılıp yenisi açılsın mı?\n" +
                      "Panelde açık oturumlar yeni panelde kaldığı yerden geri gelir."))
            return false;

        var r = await Quit(http, baseUrl, token, force: false);
        if (r == System.Net.HttpStatusCode.Conflict)
        {
            if (!await Native.Confirm("Panelde şu an çalışan bir oturum var. Kapatırsanız o iş yarıda kalır " +
                          "(konuşma kaybolmaz, yeni panelde geri gelir).\n\nYine de kapatılsın mı?", warning: true))
                return false;
            r = await Quit(http, baseUrl, token, force: true);
        }
        if (r != System.Net.HttpStatusCode.OK)
        {
            await Native.Info($"Eski panel kapatılamadı ({(int?)r}). Ayarlar → Paneli kapat ile kapatıp yeniden açın.", warning: true);
            return false;
        }

        // Eski panel kapanıp portu bırakana kadar bekle.
        for (int i = 0; i < 60; i++)
        {
            await Task.Delay(250);
            if (await RunningVersion(http, baseUrl) is null) return true;
        }
        await Native.Info("Eski panel 15 saniyede kapanmadı. Biraz sonra kısayoldan yeniden açın.", warning: true);
        return false;
    }

    public static async Task<Version?> RunningVersion(HttpClient http, string baseUrl)
    {
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(await http.GetStringAsync($"{baseUrl}/api/version"));
            return Version.TryParse(doc.RootElement.GetProperty("version").GetString(), out var v) ? Three(v) : null;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException
                                       or System.Text.Json.JsonException or KeyNotFoundException
                                       or InvalidOperationException)
        {
            return null;
        }
    }

    public static async Task<System.Net.HttpStatusCode?> Quit(HttpClient http, string baseUrl, string token, bool force)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, $"{baseUrl}/api/quit{(force ? "?force=1" : "")}");
            req.Headers.Add("X-Panel-Token", token);
            using var res = await http.SendAsync(req);
            return res.StatusCode;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            return null;
        }
    }
}

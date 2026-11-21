namespace ClaudePanel;

/// <summary>
/// macOS: menü çubuğu ikonu yok (ek kütüphane gerektirir); yalnız bildirim. Bir oturum çalışıyordan
/// bekliyora geçince macOS bildirimi gösterilir, panel penceresi kapalıyken de.
/// </summary>
sealed class Tray(string baseUrl, SessionStore store, HostedSessions hosted, IHostApplicationLifetime life,
    ILogger<Tray> log)
{
    const int PollMs = 3000;
    readonly SessionLanes _watch = new(store, hosted);
    System.Threading.Timer? _timer;

    /// <summary>Tarayıcı bildirimi tekrar etmesin diye panel sayfası bunu okur.</summary>
    public bool Notifies => _timer is not null;

    public void Start()
    {
        _ = baseUrl;
        _timer = new System.Threading.Timer(_ => Poll(), null, 1000, PollMs);
        life.ApplicationStopping.Register(() => _timer?.Dispose());
    }

    /// <summary>Oturum dışı kaynakların bildirimi (Takip → GitHub).</summary>
    public void Notify(string title, string text) =>
        Sh.Osa("on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run", [title, text]);

    void Poll()
    {
        if (!Monitor.TryEnter(_watch)) return;
        try
        {
            foreach (var (name, cwd) in _watch.NewlyIdle())
                Sh.Osa("on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run",
                    [$"{name} bekliyor", $"İşi bitti ya da cevabınızı bekliyor. {cwd}"]);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            log.LogDebug("Bildirim yoklaması atlandı: {Msg}", ex.Message);
        }
        finally { Monitor.Exit(_watch); }
    }
}

namespace ClaudePanel;

/// <summary>
/// Oturumların çalışıyor/bekliyor durumunu izler; çalışıyordan bekliyora geçenleri verir (sistem bildirimi için,
/// panel sayfasındaki mantığın aynısı). İlk turda yalnız durum öğrenilir, bildirim çıkmaz.
/// </summary>
sealed class SessionLanes(SessionStore store, HostedSessions hosted)
{
    readonly Dictionary<string, string> _lanes = new();
    bool _first = true;

    public List<(string Name, string Cwd)> NewlyIdle()
    {
        var result = new List<(string, string)>();
        var now = new Dictionary<string, (string Lane, string Name, string Cwd)>();
        var hostedList = hosted.List();
        var hostedIds = hostedList.Select(h => h.SessionId).Where(s => s is not null).ToHashSet();
        foreach (var h in hostedList)
            now["h:" + h.Key] = (h.Status is "busy" or "starting" ? "busy" : "idle", h.Name ?? Folder(h.Cwd), h.Cwd);
        foreach (var s in store.List().Where(s => !hostedIds.Contains(s.SessionId)))
            now[s.SessionId] = (s.Status is "idle" or "waiting" ? "idle" : "busy", s.CustomName ?? Folder(s.Cwd), s.Cwd);

        foreach (var (id, cur) in now)
        {
            if (!_first && _lanes.GetValueOrDefault(id) == "busy" && cur.Lane == "idle") result.Add((cur.Name, cur.Cwd));
            _lanes[id] = cur.Lane;
        }
        foreach (var gone in _lanes.Keys.Except(now.Keys).ToList()) _lanes.Remove(gone);
        _first = false;
        return result;
    }

    public static string Folder(string cwd) => Path.GetFileName(cwd.TrimEnd('\\', '/')) is { Length: > 0 } n ? n : cwd;
}

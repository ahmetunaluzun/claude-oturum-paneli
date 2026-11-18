namespace ClaudePanel;

/// <summary>
/// Aynı oturum başlatma isteği kısa sürede yinelenirse (yanıt gecikince düğmeye birkaç kez basılması, eşzamanlı istek)
/// ikinci süreç açılmaz; ilk başlatmanın sonucu döner. Anahtar: tür + klasör + istem + sürdürülen oturum.
/// Başlatmalar kilit altında sırayla yapılır: eşzamanlı gelen aynı istekler ilkini bekler.
/// </summary>
public static class StartOnce
{
    static readonly TimeSpan Window = TimeSpan.FromSeconds(20);
    static readonly object Lock = new();
    static readonly Dictionary<string, (DateTime At, string? Result)> Recent = new();

    /// <param name="stillValid">Önceki sonuç hâlâ geçerli mi (ör. oturum kapatılmadı); değilse yeniden başlatılır.</param>
    /// <returns>Sonuç ve isteğin yineleme olup olmadığı.</returns>
    public static (string? Result, bool Repeated) Run(string kind, string? cwd, string? prompt, string? resumeId,
        Func<string?> start, Func<string?, bool>? stillValid = null)
    {
        var key = string.Join('\u001f', kind, cwd?.TrimEnd('\\', '/').ToLowerInvariant(), prompt?.Trim(), resumeId);
        lock (Lock)
        {
            var now = DateTime.UtcNow;
            foreach (var old in Recent.Where(e => now - e.Value.At > Window).Select(e => e.Key).ToList()) Recent.Remove(old);
            if (Recent.TryGetValue(key, out var hit) && (stillValid?.Invoke(hit.Result) ?? true))
            {
                RemoteLog.Info($"Yinelenen oturum başlatma isteği yok sayıldı ({kind}, {(now - hit.At).TotalSeconds:0.0} sn sonra): {cwd}");
                return (hit.Result, true);
            }
            var result = start();
            Recent[key] = (DateTime.UtcNow, result);
            return (result, false);
        }
    }
}

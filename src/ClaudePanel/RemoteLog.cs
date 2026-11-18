using System.Globalization;

namespace ClaudePanel;

/// <summary>
/// Telefondan erişim olaylarının dosya logu: %LOCALAPPDATA%\ClaudePanel\logs\remote-YYYYMMDD.log.
/// Eşleşme, cihaz silme (nedeniyle), reddedilen istek (çerez yok / tanınmayan çerez) yazılır.
/// Çerez ya da kod DEĞERİ yazılmaz. 14 günden eski dosyalar açılışta silinir.
/// </summary>
public static class RemoteLog
{
    static readonly string Dir = Path.Combine(Handoff.DataDir, "logs");
    static readonly object Lock = new();
    static readonly TimeSpan Keep = TimeSpan.FromDays(14);
    static DateTime _lastDenied = DateTime.MinValue;
    static string _lastDeniedKey = "";

    public static void Info(string message) => Write("INFO", message);
    public static void Warn(string message) => Write("WARN", message);

    /// <summary>Reddedilen istek; aynı neden + yol dakikada bir kez yazılır (telefon her 3 sn'de sorar).</summary>
    public static void Denied(string reason, string path)
    {
        var key = reason + "|" + path;
        lock (Lock)
        {
            var now = DateTime.Now;
            if (key == _lastDeniedKey && now - _lastDenied < TimeSpan.FromMinutes(1)) return;
            _lastDenied = now; _lastDeniedKey = key;
        }
        Write("INFO", $"İstek reddedildi ({reason}): {path}");
    }

    public static void Prune()
    {
        try
        {
            if (!Directory.Exists(Dir)) return;
            foreach (var f in Directory.GetFiles(Dir, "remote-*.log"))
                if (DateTime.Now - File.GetLastWriteTime(f) > Keep) File.Delete(f);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }

    static void Write(string level, string message)
    {
        var now = DateTime.Now;
        var line = $"[{now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture)}] [{level}] [pid {Environment.ProcessId}] {message}{Environment.NewLine}";
        lock (Lock)
        {
            try
            {
                Directory.CreateDirectory(Dir);
                File.AppendAllText(Path.Combine(Dir, $"remote-{now.ToString("yyyyMMdd", CultureInfo.InvariantCulture)}.log"), line);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        }
    }
}

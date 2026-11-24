using System.Diagnostics;

namespace ClaudePanel;

/// <summary>
/// Terminalde açık bir claude oturumunu panelin devralması için kapatır: "Panele al" ve "öteki hesapta devam et" aynı yolu
/// kullanır. Yalnız boştaki (idle) oturum kapatılır; konuşma kaydı diskte kalır, devralan `--resume` ile sürdürür.
/// </summary>
public static class TerminalSessions
{
    /// <summary>Hata kodu ("busy", "generic") ya da başarıda null.</summary>
    public static async Task<string?> Close(SessionInfo s)
    {
        if (s.Status != "idle") return "busy";
        if (!Guid.TryParse(s.SessionId, out _)) return "generic";
        try
        {
            using var p = Process.GetProcessById(s.Pid);
            // Mac'te npm ile kurulan claude "node" adıyla görünür; pid zaten claude'un kendi oturum dosyasından geliyor.
            if (!p.ProcessName.Equals("claude", StringComparison.OrdinalIgnoreCase)
                && !(!OperatingSystem.IsWindows() && p.ProcessName == "node"))
                return "generic";
            int shell = TerminalTab.FindOwnedShell(s.Pid); // claude kapanmadan önce: sonra ebeveyni okunamaz
            p.Kill();
            await p.WaitForExitAsync(new CancellationTokenSource(5000).Token);
            TerminalTab.CloseIfIdle(shell); // boş kalan terminal sekmesi de kapansın
        }
        catch (ArgumentException) { /* zaten kapanmış */ }
        catch (OperationCanceledException) { return "generic"; }
        return null;
    }
}

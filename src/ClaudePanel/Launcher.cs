using System.Diagnostics;

namespace ClaudePanel;

/// <summary>Panel penceresini, terminali ve yeni Claude oturumlarını başlatır.
/// Pencere, terminal ve claude yolu platforma özel: Platform\Windows, Platform\Mac.</summary>
public static partial class Launcher
{
    const int MaxPromptLength = 20_000;

    public static string? Validate(NewSessionRequest? req)
    {
        if (req is null) return "empty";
        if (string.IsNullOrWhiteSpace(req.Cwd) || !Directory.Exists(req.Cwd)) return "folder";
        if (string.IsNullOrWhiteSpace(req.Prompt) || req.Prompt.Length > MaxPromptLength) return "prompt";
        if (req.Name is { Length: > 60 }) return "name";
        return null;
    }

    /// <summary>`claude --bg` ile arka planda yeni oturum açar. Argümanlar kabuktan geçmez.</summary>
    public static void StartSession(NewSessionRequest req)
    {
        var psi = new ProcessStartInfo(ClaudeExe())
        {
            WorkingDirectory = req.Cwd!,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        psi.ArgumentList.Add("--bg");
        if (!string.IsNullOrWhiteSpace(req.Name))
        {
            psi.ArgumentList.Add("--name");
            psi.ArgumentList.Add(req.Name.Trim());
        }
        // "--": seçeneklerin sonu. Görev metni "-" ile başlasa seçenek, "update"/"mcp" gibi bir alt komut adı olsa komut
        // sanılmaz. Claude Code 2.1.330'un ayrıştırıcısında doğrulandı (parseOptions: "--" görünce kalan her şey operand).
        psi.ArgumentList.Add("--");
        psi.ArgumentList.Add(req.Prompt!.Trim());
        // Hesap: seçilen, yoksa projenin kayıtlı hesabı (ProjectAccounts.cs), o da yoksa varsayılan.
        ProjectAccounts.ApplyEnv(psi, Accounts.Find(req.Account ?? ProjectAccounts.Of(req.Cwd)));
        var sw = Stopwatch.StartNew();
        Process.Start(psi);
        RemoteLog.Info($"Arka plan oturumu başlatıldı: süreç açılışı {sw.ElapsedMilliseconds} ms, klasör {req.Cwd}");
    }
}

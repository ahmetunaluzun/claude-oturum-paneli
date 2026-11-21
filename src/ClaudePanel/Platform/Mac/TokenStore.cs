using System.ComponentModel;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;

namespace ClaudePanel;

/// <summary>
/// Gizli değerler macOS Anahtar Zinciri'nde (`security` aracı). Değer komut satırına yazılmaz (ps'de görünmesin):
/// ekleme `security -i` ile standart girdiden verilir. Ayrı veri klasörüyle çalışan test kopyası (CLAUDE_PANEL_DATA)
/// kendi servis adını kullanır, gerçek kayıtlara dokunmaz. Değerler loga yazılmaz.
/// </summary>
static class TokenStore
{
    const string Security = "/usr/bin/security";
    static readonly string Service = Environment.GetEnvironmentVariable("CLAUDE_PANEL_DATA") is { Length: > 0 } d
        ? "ClaudePanel-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(d)))[..12] : "ClaudePanel";

    public static bool Save(string name, string value)
    {
        // security -i satırı tırnaklı argüman kabul eder; değer içindeki tırnak ve ters bölü kaçırılır.
        static string Q(string s) => "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        if (value.Contains('\n') || value.Contains('\r')) value = "b64:" + Convert.ToBase64String(Encoding.UTF8.GetBytes(value));
        var psi = new ProcessStartInfo(Security) { UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
        psi.ArgumentList.Add("-i");
        try
        {
            using var p = Process.Start(psi);
            if (p is null) return false;
            _ = p.StandardOutput.ReadToEndAsync();
            _ = p.StandardError.ReadToEndAsync();
            p.StandardInput.WriteLine($"add-generic-password -U -s {Q(Service)} -a {Q(name)} -w {Q(value)}");
            p.StandardInput.Close();
            if (!p.WaitForExit(10_000)) { p.Kill(entireProcessTree: true); return false; }
            return p.ExitCode == 0 && Load(name) is not null;
        }
        catch (Exception ex) when (ex is Win32Exception or IOException or InvalidOperationException) { return false; }
    }

    public static string? Load(string name)
    {
        var r = Sh.Run(Security, ["find-generic-password", "-s", Service, "-a", name, "-w"]);
        if (r.Exit != 0 || r.Out.Length == 0) return null;
        return r.Out.StartsWith("b64:", StringComparison.Ordinal) ? Encoding.UTF8.GetString(Convert.FromBase64String(r.Out[4..])) : r.Out;
    }

    public static void Delete(string name) => Sh.Run(Security, ["delete-generic-password", "-s", Service, "-a", name]);

    /// <summary>Adresi varsayılan tarayıcıda açar (Google girişi).</summary>
    public static void OpenBrowser(string url) => Sh.Run("/usr/bin/open", [url]);
}

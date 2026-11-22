using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.RegularExpressions;

namespace ClaudePanel;

/// <summary>
/// Hesap ekleme sihirbazının 1. adımı: e-posta alan adı Google mı? gmail.com / googlemail.com doğrudan; diğer alan adlarında MX kaydı
/// Google'a işaret ediyorsa (Workspace: aspmx.l.google.com, *.aspmx.l.google.com, smtp.google.com) Google sayılır.
/// MX sorgusu işletim sisteminin `nslookup -type=MX` komutuyla yapılır (yalnız alan adı gönderilir; mail adresi ya da başka bilgi değil).
/// Kaynak: https://support.google.com/a/answer/174125 (Workspace MX kayıtları, 22.11.2026'da doğrulandı).
/// Test: CLAUDE_PANEL_MX_TEST="alan1.com=google;alan2.com=other" ağa çıkmadan yanıt verir (listede olmayan alan adı "other").
/// </summary>
public static partial class MailDomain
{
    static readonly ConcurrentDictionary<string, string> Cache = new();

    [GeneratedRegex(@"^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")] private static partial Regex DomainRx();
    [GeneratedRegex(@"=\s*(?:\d+\s+)?([a-z0-9.-]*\.?(?:aspmx\.l\.google\.com|googlemail\.com|smtp\.google\.com|google\.com))\.?\s*$", RegexOptions.IgnoreCase | RegexOptions.Multiline)] private static partial Regex GoogleMxRx();
    [GeneratedRegex(@"mail exchanger|\bMX\b", RegexOptions.IgnoreCase)] private static partial Regex AnyMxRx();

    /// <summary>Genel posta alan adı: "kendi alan adındaki adresler" bir kurumu göstermez (grup önerisi yapılmaz).</summary>
    public static bool IsConsumer(string domain) => domain.ToLowerInvariant() is "gmail.com" or "googlemail.com";

    /// <returns>"google" | "other" | "unknown" (MX denetlenemedi: ağ yok / komut yok).</returns>
    public static async Task<string> Provider(string email, CancellationToken ct)
    {
        var at = email.LastIndexOf('@');
        var domain = at < 0 ? "" : email[(at + 1)..].Trim().ToLowerInvariant();
        if (!DomainRx().IsMatch(domain)) return "other";
        if (domain is "gmail.com" or "googlemail.com") return "google";
        if (Environment.GetEnvironmentVariable("CLAUDE_PANEL_MX_TEST") is { Length: > 0 } t)
            return t.Split(';').Select(x => x.Split('=')).Where(x => x.Length == 2 && x[0].Trim() == domain).Select(x => x[1].Trim()).FirstOrDefault("other");
        if (Cache.TryGetValue(domain, out var c)) return c;
        var r = await Lookup(domain, ct);
        if (r != "unknown") Cache[domain] = r;
        return r;
    }

    static async Task<string> Lookup(string domain, CancellationToken ct)
    {
        try
        {
            using var p = Process.Start(new ProcessStartInfo("nslookup", $"-type=MX {domain}")
            { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true });
            if (p is null) return "unknown";
            using var to = CancellationTokenSource.CreateLinkedTokenSource(ct);
            to.CancelAfter(TimeSpan.FromSeconds(6));
            var output = await p.StandardOutput.ReadToEndAsync(to.Token);
            await p.WaitForExitAsync(to.Token);
            if (GoogleMxRx().IsMatch(output)) return "google";
            return AnyMxRx().IsMatch(output) ? "other" : "unknown";
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or OperationCanceledException or IOException or InvalidOperationException)
        {
            return "unknown";
        }
    }
}

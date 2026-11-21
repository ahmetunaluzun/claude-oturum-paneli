using System.ComponentModel;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace ClaudePanel;

/// <param name="Kind">"file" (gönderilmemesi gereken dosya) | "pattern" (anahtar/parola kalıbı).</param>
/// <param name="What">Dosya türünün ya da kalıbın kodu (arayüz metne çevirir: fuSec_*). Bulunan DEĞER hiçbir yere yazılmaz.</param>
/// <param name="Fp">Parmak izi: SHA256(depo kökü + dosya + kural + eşleşen metin), onaltılık ilk 20 hane. "Test verisi" izni bununla tutulur.</param>
/// <param name="Hint">Eşleşen metnin ilk 4 karakteri + "***" (değerin kendisi değil; kalıplar anahtar adıyla ya da önekle başlar).</param>
/// <param name="Line">Satırın eklendiği commit'teki satır numarası; dosya bulgusunda 0.</param>
public sealed record SecretFinding(string Kind, string File, string What, string Fp = "", string Hint = "", int Line = 0);

/// <param name="Code">"ok" | "secret" | "nothing" | "noremote" | "rejected" | "auth" | "timeout" | "nogit" | "failed".</param>
public sealed record PushResult(string Code, int Pushed, IReadOnlyList<SecretFinding> Findings, string? Detail)
{
    public bool Ok => Code == "ok";
}

/// <summary>
/// Takip sekmesinin doğrudan yaptığı git işleri (claude yok, kota harcamaz): gönderim öncesi gizli bilgi denetimi, push,
/// ayrı çalışma kopyası (worktree). Çıktı metni kullanıcıya gösterilmeden önce adres içindeki kimlik bilgisinden arındırılır.
/// </summary>
public static partial class GitOps
{
    const int LocalTimeoutMs = 15_000, PushTimeoutMs = 90_000, DiffMaxChars = 8_000_000, MaxFindings = 50;

    public sealed record Out(int Exit, string StdOut, string StdErr, bool TimedOut)
    {
        public bool Ok => Exit == 0 && !TimedOut;
    }

    /// <summary>git'i depo klasöründe çalıştırır. git yoksa Win32Exception fırlatır.</summary>
    public static Out Run(string root, int timeoutMs, params string[] args)
    {
        var psi = new ProcessStartInfo("git")
        {
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        foreach (var a in new[] { "-c", "core.quotepath=false" }.Concat(args)) psi.ArgumentList.Add(a);
        psi.Environment["GIT_TERMINAL_PROMPT"] = "0"; // parola sorusu sürecin asılı kalmasına yol açmasın
        psi.Environment["GCM_INTERACTIVE"] = "never";
        using var p = Process.Start(psi) ?? throw new Win32Exception("git başlatılamadı");
        var so = p.StandardOutput.ReadToEndAsync();
        var se = p.StandardError.ReadToEndAsync();
        if (!p.WaitForExit(timeoutMs))
        {
            try { p.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            return new Out(-1, "", "", true);
        }
        Task.WaitAll([so, se], 2000);
        return new Out(p.ExitCode, so.IsCompletedSuccessfully ? so.Result : "", se.IsCompletedSuccessfully ? se.Result : "", false);
    }

    // ---- Gönderim öncesi denetim ----

    static readonly (Regex Re, string What)[] BadFiles =
    [
        (F(@"(^|/)\.claude/settings\.local\.json$"), "claudeLocal"),
        (F(@"(^|/)\.env(\.(?!example$|sample$|template$|dist$)[^/]*)?$"), "env"),
        (F(@"\.(pem|pfx|p12|key|keystore|jks)$"), "keyfile"),
        (F(@"(^|/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)$"), "sshkey"),
        (F(@"(^|/)\.?credentials\.json$"), "credentials"),
    ];

    static readonly (Regex Re, string What)[] BadPatterns =
    [
        (P(@"gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}"), "github"),
        (P(@"sk-ant-[A-Za-z0-9_\-]{20,}"), "anthropic"),
        (P(@"\bsk-(proj-)?[A-Za-z0-9_\-]{32,}"), "sk"),
        (P(@"\bAKIA[0-9A-Z]{16}\b"), "aws"),
        (P(@"\bAIza[0-9A-Za-z_\-]{35}\b"), "google"),
        (P(@"\bxox[baprs]-[A-Za-z0-9\-]{10,}"), "slack"),
        (P(@"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "privatekey"),
        (P(@"://[^/\s:@'""]+:[^/\s:@'""]{3,}@"), "urlcreds"),
        (P(@"(?i)\b(password|passwd|pwd|parola|sifre|şifre|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*[""'][^""'\s${}<>]{8,}[""']"), "assign"),
    ];

    static Regex F(string p) => new(p, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    static Regex P(string p) => new(p, RegexOptions.CultureInvariant);
    [GeneratedRegex(@"://[^/\s@]+@")] private static partial Regex UrlCreds();
    [GeneratedRegex(@"^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")] private static partial Regex Hunk();

    /// <summary>Bulgunun parmak izi. Kök büyük/küçük harf ve bölü farkından bağımsız (aynı depo iki yazımla gelebilir).</summary>
    public static string Fingerprint(string root, string file, string what, string match)
    {
        var key = ProjectRoots.Normalize(root).ToLowerInvariant() + "\n" + file + "\n" + what + "\n" + match;
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..20];
    }

    static string HintOf(string match) => (match.Length > 4 ? match[..4] : match[..Math.Min(1, match.Length)]) + "***";

    /// <summary>Gönderilecek commit aralığı: izlenen dal varsa ondan sonrası, yoksa hiçbir uzak dalda olmayanlar.</summary>
    static string[] PushRange(string root) =>
        Run(root, LocalTimeoutMs, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}").Ok
            ? ["@{u}..HEAD"] : ["HEAD", "--not", "--remotes"];

    /// <summary>
    /// Gönderilecek commit'lerde depoya girmemesi gereken dosya ya da anahtar/parola kalıbı var mı. Yalnız eklenen satırlara
    /// bakılır. Kalıp bulguları eşleşme başına ayrıdır (parmak izine göre tekil, en çok 50); kullanıcının "test verisi" dediği
    /// parmak izleri (PushAllow) atlanır ve Allowed'da sayılır. Dosya bulgusu hiçbir zaman atlanmaz.
    /// Bulgu: dosya, satır, kalıp adı, parmak izi, maskeli ipucu; değer döndürülmez, loglanmaz.
    /// </summary>
    public static (int Commits, List<SecretFinding> Findings, bool Failed, int Allowed) PushCheck(string root)
    {
        var range = PushRange(root);
        var findings = new List<SecretFinding>();
        var count = Run(root, LocalTimeoutMs, ["rev-list", "--count", .. range]);
        if (!count.Ok || !int.TryParse(count.StdOut.Trim(), out var commits)) return (0, findings, true, 0);
        if (commits == 0) return (0, findings, false, 0);

        var names = Run(root, LocalTimeoutMs, ["log", "--format=", "--name-status", "--no-renames", .. range]);
        if (!names.Ok) return (commits, findings, true, 0);
        foreach (var line in names.StdOut.Split('\n'))
        {
            var parts = line.TrimEnd('\r').Split('\t');
            if (parts.Length < 2 || parts[0].Length == 0 || parts[0][0] is not ('A' or 'M')) continue;
            var file = parts[^1];
            foreach (var (re, what) in BadFiles)
                if (re.IsMatch(file) && !findings.Any(f => f.File == file && f.What == what))
                    findings.Add(new SecretFinding("file", file, what, Fingerprint(root, file, what, "")));
        }

        var diff = Run(root, LocalTimeoutMs * 2, ["log", "-p", "--format=", "--no-color", "--no-ext-diff", "--unified=0", .. range]);
        if (!diff.Ok) return (commits, findings, true, 0);
        var (allowed, skipped) = (PushAllow.Fps(), new HashSet<string>(StringComparer.Ordinal));
        var text = diff.StdOut.Length > DiffMaxChars ? diff.StdOut[..DiffMaxChars] : diff.StdOut;
        var current = "";
        int oldLeft = 0, newLeft = 0, lineNo = 0;
        foreach (var rawLine in text.Split('\n'))
        {
            var raw = rawLine.TrimEnd('\r');
            if (oldLeft <= 0 && newLeft <= 0) // hunk dışı: başlık satırları (eklenen satır "+++ " ile başlasa da başlık sayılmaz)
            {
                if (raw.StartsWith("+++ ", StringComparison.Ordinal)) current = raw.Length > 6 && raw[4..].StartsWith("b/", StringComparison.Ordinal) ? raw[6..] : "";
                else if (Hunk().Match(raw) is { Success: true } h)
                {
                    oldLeft = h.Groups[1].Success ? int.Parse(h.Groups[1].Value) : 1;
                    newLeft = h.Groups[3].Success ? int.Parse(h.Groups[3].Value) : 1;
                    lineNo = int.Parse(h.Groups[2].Value);
                }
                continue;
            }
            if (raw.StartsWith('-')) { oldLeft--; continue; }
            if (!raw.StartsWith('+')) continue; // "\ No newline at end of file"
            newLeft--;
            var at = lineNo++;
            foreach (var (re, what) in BadPatterns)
                foreach (Match m in re.Matches(raw))
                {
                    var fp = Fingerprint(root, current, what, m.Value);
                    if (allowed.Contains(fp)) { skipped.Add(fp); continue; }
                    if (findings.Count < MaxFindings && !findings.Any(f => f.Fp == fp))
                        findings.Add(new SecretFinding("pattern", current, what, fp, HintOf(m.Value), at));
                }
        }
        return (commits, findings, false, skipped.Count);
    }

    /// <summary>Denetim temizse `git push` (izlenen dal yoksa `-u <uzak> <dal>`). Sonuç kodla döner; metin kimlik bilgisinden arındırılır.</summary>
    public static PushResult Push(string root)
    {
        try
        {
            var (commits, findings, failed, _) = PushCheck(root);
            if (failed) return new PushResult("failed", 0, [], "gönderilecek commit'ler okunamadı");
            if (findings.Count > 0) return new PushResult("secret", 0, findings, null);
            var hasUpstream = Run(root, LocalTimeoutMs, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}").Ok;
            if (hasUpstream && commits == 0) return new PushResult("nothing", 0, [], null);
            Out push;
            if (hasUpstream) push = Run(root, PushTimeoutMs, "push");
            else
            {
                var remotes = Run(root, LocalTimeoutMs, "remote").StdOut.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                var remote = remotes.Contains("origin") ? "origin" : remotes.Length == 1 ? remotes[0] : null;
                var branch = Run(root, LocalTimeoutMs, "symbolic-ref", "--short", "HEAD").StdOut.Trim();
                if (remote is null || branch.Length == 0) return new PushResult("noremote", 0, [], null);
                push = Run(root, PushTimeoutMs, "push", "-u", remote, branch);
            }
            if (push.TimedOut) return new PushResult("timeout", 0, [], null);
            if (push.Ok) return new PushResult("ok", commits, [], null);
            var err = push.StdErr;
            var code = Regex.IsMatch(err, @"\[rejected\]|non-fast-forward|fetch first|\[remote rejected\]", RegexOptions.IgnoreCase) ? "rejected"
                : Regex.IsMatch(err, @"Authentication failed|could not read Username|Permission denied|access denied|\b40[13]\b|terminal prompts disabled", RegexOptions.IgnoreCase) ? "auth"
                : "failed";
            return new PushResult(code, 0, [], Scrub(LastLine(err)));
        }
        catch (Win32Exception) { return new PushResult("nogit", 0, [], null); }
    }

    static string LastLine(string s) =>
        s.Split('\n').Select(l => l.Trim()).LastOrDefault(l => l.Length > 0 && !l.StartsWith("hint:", StringComparison.Ordinal)) ?? "";

    /// <summary>Uzak adres içindeki kullanıcı:parola kısmını siler, metni kısaltır.</summary>
    public static string Scrub(string s)
    {
        s = UrlCreds().Replace(s, "://***@");
        return s.Length > 240 ? s[..240] + "…" : s;
    }

    // ---- Depo durumu (iş öncesi/sonrası) ----

    /// <summary>(commit'lenmemiş dosya, gönderilmemiş commit, uzak depo var mı, HEAD); okunamazsa null.</summary>
    public static (int Dirty, int Ahead, bool HasRemote, string Head)? Status(string root)
    {
        try
        {
            var st = Run(root, LocalTimeoutMs, "status", "--porcelain");
            if (!st.Ok) return null;
            var dirty = st.StdOut.Split('\n').Count(l => l.Trim().Length > 0);
            var hasRemote = Run(root, LocalTimeoutMs, "remote").StdOut.Trim().Length > 0;
            var ahead = 0;
            if (hasRemote && Run(root, LocalTimeoutMs, ["rev-list", "--count", .. PushRange(root)]) is { Ok: true } c) int.TryParse(c.StdOut.Trim(), out ahead);
            var head = Run(root, LocalTimeoutMs, "rev-parse", "HEAD");
            return (dirty, ahead, hasRemote, head.Ok ? head.StdOut.Trim() : "");
        }
        catch (Win32Exception) { return null; }
    }

    public static int CommitsSince(string root, string oldHead)
    {
        if (oldHead.Length == 0) return 0;
        var c = Run(root, LocalTimeoutMs, "rev-list", "--count", $"{oldHead}..HEAD");
        return c.Ok && int.TryParse(c.StdOut.Trim(), out var n) ? n : 0;
    }

    // ---- Ayrı çalışma kopyası ----

    /// <summary>
    /// Deponun yanına (kardeş klasör) `<ad>-kopya-N` adıyla ayrı çalışma kopyası açar, dalı `panel/kopya-<zaman>`.
    /// Böylece ikinci oturum aynı dosyalara yazmaz. Dönen yol yeni kopyanın kökü.
    /// </summary>
    public static (string? Path, string? Error) AddWorktree(string root)
    {
        try
        {
            var parent = Path.GetDirectoryName(root);
            if (string.IsNullOrEmpty(parent)) return (null, "noparent");
            var name = Path.GetFileName(root);
            string? target = null;
            for (var n = 1; n <= 50 && target is null; n++)
            {
                var candidate = Path.Combine(parent, $"{name}-kopya-{n}");
                if (!Directory.Exists(candidate) && !File.Exists(candidate)) target = candidate;
            }
            if (target is null) return (null, "toomany");
            var branch = $"panel/kopya-{DateTime.Now:yyyyMMdd-HHmmss}";
            var r = Run(root, LocalTimeoutMs * 2, "worktree", "add", "-b", branch, target, "HEAD");
            if (!r.Ok) return (null, Scrub(LastLine(r.StdErr)));
            ProjectRoots.Forget();
            return (target, null);
        }
        catch (Win32Exception) { return (null, "nogit"); }
    }
}

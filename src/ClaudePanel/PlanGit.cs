using System.ComponentModel;

namespace ClaudePanel;

/// <summary>"Düzelt, kontrolüme bırak" işinin dalı: farkı göster, ana çalışma klasörüne birleştir ya da at. Hepsi yereldir, push yok.</summary>
public static class PlanGit
{
    const int TimeoutMs = 30_000, DiffMax = 400_000;

    /// <summary>Dalın tabandan bu yana farkı (özet + yama; çok uzunsa kısaltılır).</summary>
    public static (string? Text, bool Cut) Diff(PlanRun r)
    {
        if (r.Worktree is null || r.Base is null || !Directory.Exists(r.Worktree)) return (null, false);
        var stat = GitOps.Run(r.Worktree, TimeoutMs, "diff", "--stat", r.Base + "..HEAD");
        var patch = GitOps.Run(r.Worktree, TimeoutMs, "diff", r.Base + "..HEAD");
        if (!stat.Ok || !patch.Ok) return (null, false);
        var text = stat.StdOut.TrimEnd() + "\n\n" + patch.StdOut;
        return text.Length > DiffMax ? (text[..DiffMax], true) : (text, false);
    }

    /// <summary>
    /// Dalı ana çalışma klasörünün o anki dalına birleştirir (merge commit). Çakışırsa birleştirme geri alınır, hiçbir şey değişmez.
    /// Başarıda kopya ve dal silinir. Dönen: null (tamam) ya da hata kodu + ayrıntı.
    /// </summary>
    public static (string? Code, string? Detail) Merge(PlanRun r)
    {
        if (r.Root is null || r.Branch is null || !Directory.Exists(r.Root)) return ("norepo", null);
        try
        {
            var m = GitOps.Run(r.Root, TimeoutMs, "merge", "--no-ff", "--no-edit", r.Branch);
            if (!m.Ok)
            {
                // Çakışma ya da kirli çalışma alanı: yarım birleştirme bırakılmaz.
                GitOps.Run(r.Root, TimeoutMs, "merge", "--abort");
                var why = (m.StdOut + "\n" + m.StdErr).Contains("CONFLICT", StringComparison.Ordinal) ? "conflict" : "mergefail";
                return (why, GitOps.Scrub(LastLine(m.StdErr.Length > 0 ? m.StdErr : m.StdOut)));
            }
            Discard(r);
            return (null, null);
        }
        catch (Win32Exception) { return ("nogit", null); }
    }

    /// <summary>Kopyayı ve dalını siler (birleştirildikten sonra ya da kullanıcı "At" dediğinde).</summary>
    public static void Discard(PlanRun r)
    {
        if (r.Root is null || r.Worktree is null) return;
        try
        {
            GitOps.Run(r.Root, TimeoutMs, "worktree", "remove", "--force", r.Worktree);
            if (!string.IsNullOrEmpty(r.Branch) && r.Branch.StartsWith("panel/", StringComparison.Ordinal))
                GitOps.Run(r.Root, TimeoutMs, "branch", "-D", r.Branch);
            GitOps.Run(r.Root, TimeoutMs, "worktree", "prune");
        }
        catch (Win32Exception) { }
        ProjectRoots.Forget();
    }

    static string LastLine(string s) => s.Split('\n').Select(l => l.Trim()).LastOrDefault(l => l.Length > 0) ?? "";
}

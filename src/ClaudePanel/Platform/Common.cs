namespace ClaudePanel;

/// <summary>Çalışan claude süreci (oturum kimliği komut satırında --resume ile geçer).</summary>
sealed record RunningProc(int Pid, string CommandLine, bool IsOrphanPanelProcess);

/// <summary>Terminal penceresini öne getirme sonucu.</summary>
public sealed record FocusResult(bool Ok, string? Error = null, IReadOnlyList<string>? Tabs = null, string? Tab = null);

namespace ClaudePanel;

/// <summary>Çalışan claude süreci (oturum kimliği komut satırında --resume ile geçer).</summary>
sealed record RunningProc(int Pid, string CommandLine, bool IsOrphanPanelProcess);

/// <summary>Terminal penceresini öne getirme sonucu.</summary>
/// TabId: Windows Terminal sekmesinin UI Automation kimliği; sekme adı (claude başlığı değiştirdikçe) değişse de aynı kalır.
public sealed record FocusResult(bool Ok, string? Error = null, IReadOnlyList<string>? Tabs = null, string? Tab = null, string? TabId = null);

/// <summary>Sanal masaüstü: sıra numarası (1'den) ve kullanıcının verdiği ad (yoksa null).</summary>
public sealed record DesktopRef(int Number, string? Name);

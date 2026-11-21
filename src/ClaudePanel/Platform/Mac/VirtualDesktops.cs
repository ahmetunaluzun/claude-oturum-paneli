namespace ClaudePanel;

/// <summary>macOS Spaces için genel bir API yok; kartta masaüstü numarası gösterilmez.</summary>
public static class VirtualDesktops
{
    public static Task<Dictionary<int, DesktopRef>> Of(IReadOnlyList<(int Pid, string Cwd)> sessions) => Task.FromResult(new Dictionary<int, DesktopRef>());
}

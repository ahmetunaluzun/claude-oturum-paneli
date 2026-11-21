namespace ClaudePanel;

/// <summary>
/// Bir claude sürecinin iTerm2 ya da Terminal sekmesini öne getirir. Eşleme kesindir: claude sürecinin
/// tty'si (ör. /dev/ttys003) sekmenin tty'siyle karşılaştırılır; sekme adı tahmini gerekmez.
/// İlk kullanımda macOS "Otomasyon" izni sorar (Sistem Ayarları → Gizlilik ve Güvenlik → Otomasyon).
/// </summary>
public static class WindowFocus
{
    const string ITermScript = """
        on run argv
          set t to item 1 of argv
          tell application "iTerm2"
            repeat with w in windows
              repeat with tb in tabs of w
                repeat with s in sessions of tb
                  if tty of s is t then
                    select w
                    select tb
                    select s
                    activate
                    return name of s
                  end if
                end repeat
              end repeat
            end repeat
          end tell
          return ""
        end run
        """;

    const string TerminalScript = """
        on run argv
          set t to item 1 of argv
          tell application "Terminal"
            repeat with w in windows
              repeat with tb in tabs of w
                if tty of tb is t then
                  set selected of tb to true
                  set index of w to 1
                  activate
                  return t
                end if
              end repeat
            end repeat
          end tell
          return ""
        end run
        """;

    public static FocusResult Focus(int pid, string folder, string? preferredTab, string? preferredTabId = null)
    {
        var tty = Sh.Run("/bin/ps", ["-o", "tty=", "-p", pid.ToString(System.Globalization.CultureInfo.InvariantCulture)]).Out;
        if (tty.Length == 0 || tty.StartsWith('?')) return new(false, "no-window");
        if (!tty.StartsWith("/dev/", StringComparison.Ordinal)) tty = "/dev/" + tty;

        var procs = Sh.ProcessTable().Values.Select(v => v.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        // Uygulama çalışmıyorsa betik onu başlatmasın diye önce süreç listesine bakılır.
        if (procs.Contains("iTerm2") && Sh.Osa(ITermScript, [tty]).Out is { Length: > 0 } name)
            return new(true, Tab: name);
        if (procs.Contains("Terminal") && Sh.Osa(TerminalScript, [tty]).Out is { Length: > 0 })
            return new(true);
        return new(false, "no-window");
    }
}

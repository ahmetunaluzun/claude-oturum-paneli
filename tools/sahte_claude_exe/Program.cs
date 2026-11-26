using System.Diagnostics;

// Sahte claude.exe: argümanları kaydeder, davranışı tools/sahte_claude.py'ye bırakır (stdin/stdout/stderr devralınır).
if (Environment.GetEnvironmentVariable("SAHTE_CLAUDE_ARGS") is { Length: > 0 } argFile)
    File.AppendAllLines(argFile, args.Prepend("---"));
var script = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "sahte_claude.py"));
if (Environment.GetEnvironmentVariable("SAHTE_CLAUDE_PY") is { Length: > 0 } p) script = p;
var psi = new ProcessStartInfo("py") { UseShellExecute = false };
psi.ArgumentList.Add("-3.13");
psi.ArgumentList.Add(script);
using var proc = Process.Start(psi)!;
proc.WaitForExit();
return proc.ExitCode;

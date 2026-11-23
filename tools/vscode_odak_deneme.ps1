# Issue #1 madde 4: VS Code oturumunda "VS Code'a git" gerçekten doğru pencereyi öne getiriyor mu? (ölçüm, ekranda pencere açar)
# Ayrı VS Code profili (geçici --user-data-dir / --extensions-dir; kullanıcının VS Code'una dokunmaz), iki pencere
# ("vsdeneme alfa", "vsdeneme beta"), panelin test kopyası (--no-window, geçici CLAUDE_PANEL_CLAUDE_DIR). Oturum dosyaları
# bu VS Code'un süreç ağacındaki süreçlere bağlanır (claude'un eklentide olduğu gibi Code ana sürecinin torunu).
# Her /api/focus sonrası GetForegroundWindow ölçülür. Kullanım: pwsh -File tools/vscode_odak_deneme.ps1 [panel.exe]
param([string]$Exe = "$PSScriptRoot\..\dist\ClaudePanel.exe")
$ErrorActionPreference = 'Stop'
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
}
'@
$code = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
$T = Join-Path $env:TEMP ("vsodak-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$A = "$T\p\vsdeneme alfa"; $B = "$T\p\vsdeneme beta"
New-Item -ItemType Directory -Force "$A\alt", $B, "$T\ud", "$T\ext", "$T\claude\sessions", "$T\data", "$T\tmp" | Out-Null
'{"Notify":false,"Introduced":true}' | Set-Content "$T\data\tray.json"
$sonuc = [System.Collections.Generic.List[string]]::new(); $fail = 0
function Check($ad, $gelen, $beklenen) {
  if ("$gelen" -eq "$beklenen") { $script:sonuc.Add("GEÇTİ  $ad") } else { $script:sonuc.Add("KALDI  $ad (beklenen $beklenen, gelen $gelen)"); $script:fail = 1 }
  Write-Host $script:sonuc[-1]
}
function CodeProcs { Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -like "*$T*" } }
function Windows($pid0) {
  $l = [System.Collections.Generic.List[IntPtr]]::new()
  [W]::EnumWindows({ param($h, $x) $p = 0; [void][W]::GetWindowThreadProcessId($h, [ref]$p)
    if ($p -eq $pid0 -and [W]::IsWindowVisible($h) -and [W]::Title($h).Length -gt 0) { $l.Add($h) }; $true }, [IntPtr]::Zero) | Out-Null
  , $l
}
try {
  $ud = "--user-data-dir=$T\ud"; $ex = "--extensions-dir=$T\ext"
  Start-Process $code -ArgumentList $ud, $ex, '--new-window', '--disable-workspace-trust', '--skip-welcome', "`"$A`""
  Start-Sleep 6
  Start-Process $code -ArgumentList $ud, $ex, '--new-window', '--disable-workspace-trust', '--skip-welcome', "`"$B`""
  $main = $null; $wins = $null
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep 0.5
    $main = CodeProcs | Where-Object { $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1
    if ($main) {
      $wins = Windows $main.ProcessId
      # Başlıklar yüklenmeden ("Visual Studio Code") pencere eşlemesi yapılmaz.
      if (@($wins | Where-Object { [W]::Title($_) -like '*vsdeneme alfa*' }).Count -eq 1 -and @($wins | Where-Object { [W]::Title($_) -like '*vsdeneme beta*' }).Count -eq 1) { break }
    }
  }
  Check "iki VS Code penceresi açıldı" $wins.Count 2
  $wA = $wins | Where-Object { [W]::Title($_) -like '*vsdeneme alfa*' } | Select-Object -First 1
  $wB = $wins | Where-Object { [W]::Title($_) -like '*vsdeneme beta*' } | Select-Object -First 1
  Write-Host ("başlıklar: " + (($wins | ForEach-Object { [W]::Title($_) }) -join ' | '))
  # Oturumlar: Code ana sürecinin iki farklı çocuğu (eklentideki claude da ana sürecin torunudur; odak yolu ataya çıkar).
  $kids = @(CodeProcs | Where-Object { $_.ParentProcessId -eq $main.ProcessId } | Sort-Object ProcessId)
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  function Oturum($proc, $cwd, $ad) {
    $ft = (Get-Process -Id $proc.ProcessId).StartTime.ToFileTimeUtc()
    $j = [ordered]@{ pid = $proc.ProcessId; sessionId = [guid]::NewGuid().ToString(); cwd = $cwd; startedAt = $now - 60000; procStart = "$ft"
      version = '2.1.330'; kind = 'interactive'; entrypoint = 'claude-vscode'; name = $ad; nameSource = 'derived'; updatedAt = $now; status = 'idle'; statusUpdatedAt = $now - 30000 }
    $j | ConvertTo-Json -Compress | Set-Content -Encoding utf8 "$T\claude\sessions\$($proc.ProcessId).json"
    $proc.ProcessId
  }
  $pA = Oturum $kids[0] $A 'alfa'; $pB = Oturum $kids[1] $B 'beta'; $pSub = Oturum $kids[2] "$A\alt" 'alfa-alt'
  $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0); $l.Start(); $port = $l.LocalEndpoint.Port; $l.Stop()
  $env:CLAUDE_PANEL_PORT = $port; $env:CLAUDE_PANEL_DATA = "$T\data"; $env:CLAUDE_PANEL_CLAUDE_DIR = "$T\claude"; $env:CLAUDE_PANEL_CLAUDE_EXE = "$T\yok.cmd"
  $panel = Start-Process (Resolve-Path $Exe) -ArgumentList '--no-window' -PassThru -WindowStyle Hidden
  $base = "http://127.0.0.1:$port"
  for ($i = 0; $i -lt 60 -and -not (Test-Path "$T\data\panel-$port.token"); $i++) { Start-Sleep 0.25 }
  Start-Sleep 1
  $tok = (Get-Content "$T\data\panel-$port.token" -Raw).Trim()
  function Focus($p) {
    $r = Invoke-RestMethod -Uri "$base/api/focus/$p" -Method Post -Headers @{ 'X-Panel-Token' = $tok; Origin = $base } -ContentType 'application/json' -Body '{}' -SkipHttpErrorCheck
    Start-Sleep 1.2; $r
  }
  function Fg { $h = [W]::GetForegroundWindow(); if ($h -eq $wA) { 'alfa' } elseif ($h -eq $wB) { 'beta' } else { 'başka: ' + [W]::Title($h) } }

  $r = Focus $pB; Check "1) beta'ya git: yanıt ok" $r.ok True; Check "1) öndeki pencere beta" (Fg) 'beta'
  $r = Focus $pA; Check "2) alfa'ya git (beta öndeyken): yanıt ok" $r.ok True; Check "2) öndeki pencere alfa" (Fg) 'alfa'
  $r = Focus $pB; Check "3) tekrar beta" (Fg) 'beta'
  [void][W]::ShowWindow($wA, 6); Start-Sleep 1   # alfa simge durumunda
  $r = Focus $pA; Check "4) simge durumundaki alfa: öne geldi" (Fg) 'alfa'; Check "4) alfa artık simge değil" ([W]::IsIconic($wA)) False
  $r = Focus $pB; Start-Sleep 0.5
  $r = Focus $pSub; Check "5) alt klasördeki oturum (başlıkta 'alt' yok): yanıt ok" $r.ok True; Check "5) öndeki pencere alfa" (Fg) 'alfa'
  # 6) Başlık klasör adını içermiyor (window.title ayarı / ayrı dosya penceresi): beta öndeyken alfa istenir.
  $r = Focus $pB
  Write-Host ("son başlıklar: " + (($wins | ForEach-Object { [W]::Title($_) }) -join ' | '))
}
finally {
  if ($panel) { Stop-Process -Id $panel.Id -Force -ErrorAction SilentlyContinue }
  CodeProcs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep 1.5
  $kalan = @(CodeProcs).Count
  Write-Host "temizlik: kalan VS Code test süreci $kalan"
  Remove-Item -Recurse -Force $T -ErrorAction SilentlyContinue
  Write-Host ($(if ($fail) { 'HATA VAR' } else { 'TÜMÜ GEÇTİ' }))
}

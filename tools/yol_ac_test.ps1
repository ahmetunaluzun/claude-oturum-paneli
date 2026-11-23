# Konuşmadaki yol bağlantısı → Gezgin testi (/api/reveal, Native.RevealFolder). Test kopyası --no-window, boş port, geçici veri klasörü.
# Her biçim için açılan Gezgin penceresinin klasörünü Shell.Application'dan okur ve pencereyi kapatır. Ekranda kısa süre Gezgin açılır.
# Kök neden (23.11.2026): sonu "\" olan yol Belgeler'i açıyordu. Kullanım: pwsh tools/yol_ac_test.ps1 [exe]
param([string]$Exe = "$PSScriptRoot\..\src\ClaudePanel\bin\Release\net10.0-windows\win-x64\ClaudePanel.exe")
$ErrorActionPreference = 'Stop'
$T = Join-Path ([IO.Path]::GetTempPath()) ("yolac-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force "$T\data", "$T\claude", "$T\tmp" | Out-Null
'{"Notify":false,"Introduced":true}' | Set-Content "$T\data\tray.json" -Encoding utf8
$l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0); $l.Start(); $port = $l.LocalEndpoint.Port; $l.Stop()
$B = "http://127.0.0.1:$port"
$env:CLAUDE_PANEL_PORT = $port; $env:CLAUDE_PANEL_DATA = "$T\data"; $env:CLAUDE_PANEL_CLAUDE_DIR = "$T\claude"; $env:CLAUDE_PANEL_CLAUDE_EXE = "$T\yok.cmd"; $env:CLAUDE_PANEL_GH_EXE = "$T\yok.cmd"
$p = Start-Process $Exe -ArgumentList '--no-window' -PassThru -WindowStyle Hidden
$fail = 0
try {
  for ($i = 0; $i -lt 60 -and -not (Test-Path "$T\data\panel-$port.token"); $i++) { Start-Sleep -Milliseconds 250 }
  $tok = (Get-Content "$T\data\panel-$port.token" -Raw).Trim()
  $h = @{ 'X-Panel-Token' = $tok; 'Origin' = $B }
  $proje = 'C:\AI Projeleri\Simphony\Simphony Ai ile Eğitim Dokümanları\Protel Loyalty\03 Müşteri Projeleri\01 Divan Erbil\2 Mail taslakları'
  $kisa = (Resolve-Path "$PSScriptRoot\..").Path
  $vakalar = @(
    @{ ad = 'boşluklu + Türkçe, sonda \ yok'; yol = $proje; beklenen = $proje },
    @{ ad = 'boşluklu + Türkçe, sonda \';     yol = "$proje\"; beklenen = $proje },
    @{ ad = 'proje kökü, sonda \';            yol = "$kisa\"; beklenen = $kisa },
    @{ ad = 'sürücü kökü C:\';                yol = 'C:\'; beklenen = 'C:\' }
  )
  if (-not (Test-Path $proje)) { $vakalar = $vakalar | Where-Object { $_.yol -notlike "$proje*" } }
  $sh = New-Object -ComObject Shell.Application
  foreach ($v in $vakalar) {
    $once = @($sh.Windows() | ForEach-Object { $_.HWND })
    $body = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json @{ path = $v.yol } -Compress))
    Invoke-RestMethod "$B/api/reveal" -Method Post -Headers $h -ContentType 'application/json; charset=utf-8' -Body $body | Out-Null
    $acilan = $null
    for ($i = 0; $i -lt 30 -and -not $acilan; $i++) {
      Start-Sleep -Milliseconds 200
      $w = $sh.Windows() | Where-Object { $once -notcontains $_.HWND } | Select-Object -First 1
      if ($w) { try { $acilan = $w.Document.Folder.Self.Path } catch { $acilan = $null } }
    }
    $sh.Windows() | Where-Object { $once -notcontains $_.HWND } | ForEach-Object { $_.Quit() }
    if ($acilan -eq $v.beklenen) { "GEÇTİ  $($v.ad)" } else { "KALDI  $($v.ad) (beklenen $($v.beklenen), açılan $acilan)"; $fail = 1 }
  }
} finally {
  try { Invoke-RestMethod "$B/api/quit?force=1" -Method Post -Headers $h | Out-Null } catch { }
  Start-Sleep 1
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
  Remove-Item -Recurse -Force $T -ErrorAction SilentlyContinue
}
if ($fail) { "HATA VAR"; exit 1 } else { "TÜMÜ GEÇTİ" }

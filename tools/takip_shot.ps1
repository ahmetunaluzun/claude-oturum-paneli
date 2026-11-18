# Takip sekmesi görüntüleri: uydurma ortam + test kopyası (--no-window, boş port) + başsız Chrome (kendi profili, boş port).
# _onizleme\takip_*.png üretir; iş bitince süreçleri kapatır, geçici klasörü siler. Kullanım: pwsh -File tools\takip_shot.ps1
$ErrorActionPreference = 'Stop'
$proj = Split-Path $PSScriptRoot -Parent
$free = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB, 1)
"Boş RAM: $free GB"
if ($free -lt 4) { "Boş RAM 4 GB altında, başlatılmadı"; exit 3 }
function Get-FreePort { $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0); $l.Start(); $p = $l.LocalEndpoint.Port; $l.Stop(); $p }
$T = Join-Path $env:TEMP ("takip-shot-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $T | Out-Null
$panel = $null; $chrome = $null
try {
  & 'C:\Program Files\Git\bin\bash.exe' "$proj\tools\takip_ortam.sh" ($T -replace '\\', '/')
  if ($LASTEXITCODE -ne 0) { throw "ortam kurulamadı" }
  $port = Get-FreePort
  $env:CLAUDE_PANEL_PORT = $port; $env:CLAUDE_PANEL_DATA = "$T\data"; $env:CLAUDE_PANEL_CLAUDE_DIR = "$T\claude"
  $oldTmp = $env:TMP; $oldTemp = $env:TEMP
  $env:TMP = "$T\tmp"; $env:TEMP = "$T\tmp"
  $panel = Start-Process "$proj\src\ClaudePanel\bin\Release\net10.0-windows\win-x64\ClaudePanel.exe" -ArgumentList '--no-window' -PassThru -WindowStyle Hidden
  $env:TMP = $oldTmp; $env:TEMP = $oldTemp
  Remove-Item Env:CLAUDE_PANEL_PORT, Env:CLAUDE_PANEL_DATA, Env:CLAUDE_PANEL_CLAUDE_DIR
  1..50 | ForEach-Object { if (-not (Test-Path "$T\data\panel-$port.token")) { Start-Sleep -Milliseconds 200 } }
  $dbg = Get-FreePort
  $prof = "$T\chrome-profil"
  $chrome = Start-Process 'C:\Program Files\Google\Chrome\Application\chrome.exe' -ArgumentList "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--user-data-dir=`"$prof`"", "--remote-debugging-port=$dbg", "about:blank" -PassThru
  $ok = $false
  1..40 | ForEach-Object { if (-not $ok) { try { Invoke-RestMethod "http://127.0.0.1:$dbg/json/version" -TimeoutSec 1 | Out-Null; $ok = $true } catch { Start-Sleep -Milliseconds 300 } } }
  if (-not $ok) { throw "Chrome hata ayıklama portu açılmadı" }
  # Port gerçekten bizim başlattığımız Chrome'un mu (headless-browser.md)
  $owner = (Get-NetTCPConnection -LocalPort $dbg -State Listen | Select-Object -First 1).OwningProcess
  $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$owner").CommandLine
  if ($cmd -notlike "*$prof*") { throw "Port $dbg başka bir sürece ait, komut gönderilmedi" }
  New-Item -ItemType Directory -Force "$proj\_onizleme" | Out-Null
  Remove-Item "$proj\_onizleme\takip_*.png" -ErrorAction SilentlyContinue
  & node "$proj\tools\takip_shot.mjs" $dbg "http://127.0.0.1:$port/" "$proj\_onizleme\takip" "$T\projeler" 'C:\Projeler'
}
finally {
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$T*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($panel) { Stop-Process -Id $panel.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  Remove-Item -Recurse -Force $T -ErrorAction SilentlyContinue
  "Kalan test süreci: " + @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$T*" }).Count
  "Geçici klasör duruyor mu: " + (Test-Path $T)
}

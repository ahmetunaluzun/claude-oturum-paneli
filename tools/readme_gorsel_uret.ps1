# README görselleri (docs/img/*.png): uydurma ortam + test kopyası (--no-window, boş port) + başsız Chrome (kendi profili, boş port).
# Gerçek ~/.claude'a dokunmaz, gerçek claude çalıştırmaz (`claude --version` yerine fake-claude.cmd). İş bitince süreçleri kapatır,
# geçici klasörü siler. Kullanım: pwsh -File tools\readme_gorsel_uret.ps1   (önce: dotnet publish ... -o dist)
$ErrorActionPreference = 'Stop'
$proj = Split-Path $PSScriptRoot -Parent
$exe = "$proj\dist\ClaudePanel.exe"
if (-not (Test-Path $exe)) { "dist\ClaudePanel.exe yok; önce README'deki derleme komutunu çalıştırın"; exit 2 }
$free = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB, 1)
"Boş RAM: $free GB"
if ($free -lt 4) { "Boş RAM 4 GB altında, başlatılmadı"; exit 3 }
function Get-FreePort { $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0); $l.Start(); $p = $l.LocalEndpoint.Port; $l.Stop(); $p }
$T = Join-Path $env:TEMP ("readme-shot-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $T | Out-Null
$panel = $null; $code = 1
try {
  & 'C:\Program Files\Git\bin\bash.exe' "$proj\tools\takip_ortam.sh" ($T -replace '\\', '/')
  if ($LASTEXITCODE -ne 0) { throw "takip ortamı kurulamadı" }
  & py -3.13 "$proj\tools\readme_ortam.py" $T
  if ($LASTEXITCODE -ne 0) { throw "readme ortamı kurulamadı" }
  $port = Get-FreePort
  $env:CLAUDE_PANEL_PORT = $port; $env:CLAUDE_PANEL_DATA = "$T\data"; $env:CLAUDE_PANEL_CLAUDE_DIR = "$T\claude"
  $env:CLAUDE_PANEL_CLAUDE_EXE = "$T\fake-claude.cmd"
  $oldTmp = $env:TMP; $oldTemp = $env:TEMP
  $env:TMP = "$T\tmp"; $env:TEMP = "$T\tmp"   # panel geçici klasördeki projeleri listelemez; uydurma projeler onun dışında
  $panel = Start-Process $exe -ArgumentList '--no-window' -PassThru -WindowStyle Hidden
  $env:TMP = $oldTmp; $env:TEMP = $oldTemp
  Remove-Item Env:CLAUDE_PANEL_PORT, Env:CLAUDE_PANEL_DATA, Env:CLAUDE_PANEL_CLAUDE_DIR, Env:CLAUDE_PANEL_CLAUDE_EXE
  1..50 | ForEach-Object { if (-not (Test-Path "$T\data\panel-$port.token")) { Start-Sleep -Milliseconds 200 } }
  $dbg = Get-FreePort
  $prof = "$T\chrome-profil"
  Start-Process 'C:\Program Files\Google\Chrome\Application\chrome.exe' -ArgumentList "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--lang=tr", "--user-data-dir=`"$prof`"", "--remote-debugging-port=$dbg", "about:blank" | Out-Null
  $ok = $false
  1..40 | ForEach-Object { if (-not $ok) { try { Invoke-RestMethod "http://127.0.0.1:$dbg/json/version" -TimeoutSec 1 | Out-Null; $ok = $true } catch { Start-Sleep -Milliseconds 300 } } }
  if (-not $ok) { throw "Chrome hata ayıklama portu açılmadı" }
  # Port gerçekten bizim başlattığımız Chrome'un mu (headless-browser.md)
  $owner = (Get-NetTCPConnection -LocalPort $dbg -State Listen | Select-Object -First 1).OwningProcess
  $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$owner").CommandLine
  if ($cmd -notlike "*$prof*") { throw "Port $dbg başka bir sürece ait, komut gönderilmedi" }
  $out = "$proj\docs\img"
  New-Item -ItemType Directory -Force $out | Out-Null
  # Kullanıcı adı, makine adı ve kullanıcı klasörü her zaman; ek sözcükler README_YASAKLI'dan (readme_shot.mjs)
  $banned = @($env:USERNAME, $env:COMPUTERNAME, $env:USERPROFILE) -join ','
  & node "$proj\tools\readme_shot.mjs" $dbg "http://127.0.0.1:$port/" $out $T "$T\demo.json" $banned
  $code = $LASTEXITCODE
}
finally {
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$T*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($panel) { Stop-Process -Id $panel.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  Remove-Item -Recurse -Force $T -ErrorAction SilentlyContinue
  "Kalan test süreci: " + @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$T*" }).Count
  "Geçici klasör duruyor mu: " + (Test-Path $T)
}
exit $code

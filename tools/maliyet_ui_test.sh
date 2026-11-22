#!/usr/bin/env bash
# Proje maliyeti + açılış yükü arayüz testi: sahte ağaç tools/maliyet_ortam.py, arayüz tools/maliyet_ui_test.mjs (başsız Chrome,
# tek işçi). Gerçek ~/.claude'a ve canlı panele dokunmaz: geçici klasör, boş portlar (hata ayıklama portunun bizim Chrome'umuza
# ait olduğu denetlenir), --user-data-dir, test kopyası --no-window. Görüntüler: _onizleme/maliyet_*.png.
# Kullanım: tools/maliyet_ui_test.sh [exe]
set -u
cd "$(dirname "$0")/.."
EXE="${1:-src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe}"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
T="$(mktemp -d)"; TW=$(cygpath -w "$T")
fail=0
export PYTHONUTF8=1
check() { if [ "$2" = "$3" ]; then echo "GEÇTİ  $1"; else echo "KALDI  $1 (beklenen $3, gelen $2)"; fail=1; fi; }
freeport() { pwsh -NoProfile -c '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()' | tr -d '\r'; }
FREE=$(pwsh -NoProfile -c '[math]::Floor((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB)' | tr -d '\r')
[ "$FREE" -lt 4 ] && { echo "Boş RAM $FREE GB (< 4 GB): tarayıcı testi başlatılmadı"; pwsh -NoProfile -c "Remove-Item -LiteralPath '$TW' -Recurse -Force"; exit 3; }
mkdir -p "$T/claude/sessions" "$T/data" "$T/tmp" "$T/chrome" _onizleme
rm -f _onizleme/maliyet_*.png
printf '{"Notify":false,"Introduced":true}' > "$T/data/tray.json"
py -3.13 -I tools/maliyet_ortam.py "$TW" >/dev/null || { echo "ortam kurulamadı"; exit 1; }

# Oturumlar görünümünde Alfa projesinde açık bir oturum: yer tutucu süreç + oturum dosyası (codex_ui_test.sh deseni).
py -3.13 -c "import time; time.sleep(900)  # $TW" >/dev/null 2>&1 & YP=$!
sleep 0.3; WPID=$(cat /proc/$YP/winpid)
FT=$(pwsh -NoProfile -c "(Get-Process -Id $WPID).StartTime.ToFileTimeUtc()" | tr -d '\r')
NOW=$(( $(date +%s) * 1000 ))
CWD=$(cygpath -w "$T/p/Alfa Projesi" | sed 's/\\/\\\\/g')
printf '{"pid":%s,"sessionId":"%s","cwd":"%s","startedAt":%s,"procStart":"%s","version":"2.1.330","kind":"interactive","entrypoint":"cli","name":"claude","nameSource":"derived","updatedAt":%s,"status":"idle","statusUpdatedAt":%s}' \
  "$WPID" "00000000-0000-0000-0000-000000000001" "$CWD" "$((NOW-600000))" "$FT" "$NOW" "$((NOW-120000))" > "$T/claude/sessions/$WPID.json"

PORT=$(freeport); DPORT=$(freeport); B="http://127.0.0.1:$PORT"
CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" \
  TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && break; sleep 0.2; done
TOK=$(cat "$T/data/panel-$PORT.token")

"$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$TW\\chrome" --remote-debugging-port="$DPORT" about:blank >/dev/null 2>&1 &
for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$DPORT/json/version" >/dev/null 2>&1 && break; sleep 0.2; done
check "hata ayıklama portu bizim Chrome'da" "$(pwsh -NoProfile -c "\$p=(Get-NetTCPConnection -LocalPort $DPORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if (\$p -and (Get-CimInstance Win32_Process -Filter \"ProcessId=\$p\").CommandLine -like '*$TW*') { 1 } else { 0 }" | tr -d '\r')" 1
[ $fail = 0 ] && { node tools/maliyet_ui_test.mjs "$DPORT" "$B/" "_onizleme/maliyet" || fail=1; }

curl -s -o /dev/null -X POST "$B/api/quit?force=1" -H "X-Panel-Token: $TOK" -H "Origin: $B"
for _ in $(seq 1 40); do curl -s -o /dev/null "$B/api/ping" || break; sleep 0.25; done
kill $PID $YP 2>/dev/null; wait $PID 2>/dev/null
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and \$_.CommandLine -like '*$TW*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
kalan() { pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and \$_.CommandLine -like '*$TW*' }).Count" | tr -d '\r'; }
for _ in $(seq 1 10); do [ "$(kalan)" = 0 ] && break; sleep 1; done
check "test süreci kalmadı" "$(kalan)" 0
pwsh -NoProfile -c "Remove-Item -LiteralPath '$TW' -Recurse -Force -ErrorAction SilentlyContinue"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail

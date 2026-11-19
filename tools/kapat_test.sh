#!/usr/bin/env bash
# Paneli kapat testi (0.13.0'da: sunucu kapanıyor, Edge uygulama penceresi window.close()'u yok sayıp açık kalıyordu;
# kısayoldan açılan yeni sunucu o eski pencereyi öne getiriyor, eski sürümün sayfası yeni sunucuyla bozuk görünüyordu).
#  1) /api/quit → panelin uygulama penceresi (Edge --app, test kopyasının kendi profili, EKRAN DIŞINDA) kapanır.
#  2) Sunucu aynı portta yeniden açılınca açık sayfa kendini yeniler (açılış kimliği "boot").
#  3) Paneli kapat düğmesi: tarayıcı window.close()'u reddederse "Panel kapandı" yazısı, sonrasında sayfa hatası yok.
# Gerçek ~/.claude'a ve canlı panele dokunmaz: geçici klasör, boş portlar, test kopyası --no-window, sahte claude.
# Kullanım: tools/kapat_test.sh [exe]   (varsayılan: Release derlemesi)
set -u
cd "$(dirname "$0")/.."
EXE="${1:-src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe}"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
T="$(mktemp -d)"; TW=$(cygpath -w "$T")
fail=0
check() { if [ "$2" = "$3" ]; then echo "GEÇTİ  $1"; else echo "KALDI  $1 (beklenen $3, gelen $2)"; fail=1; fi; }
freeport() { pwsh -NoProfile -c '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()' | tr -d '\r'; }
count() { pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { $1 }).Count" | tr -d '\r'; }
mkdir -p "$T/claude" "$T/data" "$T/tmp" "$T/chrome" "$T/edge"
printf '@echo off\r\necho 0.0.0 (test)\r\n' > "$T/sahte-claude.cmd"
PORT=$(freeport); DPORT=$(freeport); URL="http://127.0.0.1:$PORT"

start_panel() {
  CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CLAUDE_EXE="$TW\\sahte-claude.cmd" \
    TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
  PID=$!
  for _ in $(seq 1 50); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/state")" = 200 ] && break; sleep 0.2; done
}
quit_panel() {
  local tok; tok=$(cat "$T/data/panel-$PORT.token" 2>/dev/null)
  curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/api/quit" -H "X-Panel-Token: $tok" -H "Origin: $URL"
}
gone() { for _ in $(seq 1 40); do kill -0 "$1" 2>/dev/null || { echo 1; return; }; sleep 0.25; done; echo 0; }

# ---- 1) Paneli kapat uygulama penceresini de kapatır ----
start_panel
check "test kopyası açıldı" "$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/state")" 200
"$EDGE" --app="$URL" --user-data-dir="$TW\\edge" --no-first-run --window-position=-3000,-3000 --window-size=800,600 >/dev/null 2>&1 &
APPQ="\$_.Name -eq 'msedge.exe' -and \$_.CommandLine -like '*--app=$URL*' -and \$_.CommandLine -notlike '*--type=*'"
for _ in $(seq 1 40); do [ "$(count "$APPQ")" = 1 ] && break; sleep 0.25; done
sleep 2 # pencere tutamacı oluşsun
check "uygulama penceresi açıldı (ekran dışında)" "$(pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { $APPQ } | Where-Object { (Get-Process -Id \$_.ProcessId).MainWindowHandle -ne 0 }).Count" | tr -d '\r')" 1
check "kapatma isteği kabul edildi" "$(quit_panel)" 200
check "sunucu süreci kapandı" "$(gone $PID)" 1
for _ in $(seq 1 20); do [ "$(count "$APPQ")" = 0 ] && break; sleep 0.25; done
check "uygulama penceresi de kapandı" "$(count "$APPQ")" 0
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.CommandLine -like '*$TW\\edge*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"

# ---- 2) ve 3) sayfa tarafı (başsız Chrome) ----
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$TW\\chrome" --remote-debugging-port="$DPORT" about:blank >/dev/null 2>&1 &
for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$DPORT/json/version" >/dev/null 2>&1 && break; sleep 0.2; done
check "hata ayıklama portu bizim Chrome'da" "$(pwsh -NoProfile -c "\$p=(Get-NetTCPConnection -LocalPort $DPORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if (\$p -and (Get-CimInstance Win32_Process -Filter \"ProcessId=\$p\").CommandLine -like '*$TW*') { 1 } else { 0 }" | tr -d '\r')" 1
if [ $fail = 0 ]; then
  start_panel
  node tools/kapat_test.mjs "$DPORT" "$URL/" yenile "$T/yeniden.ok" > "$T/yenile.out" 2>&1 &
  NODE=$!
  for _ in $(seq 1 120); do grep -q HAZIR "$T/yenile.out" && break; sleep 0.25; done
  quit_panel >/dev/null; gone $PID >/dev/null
  start_panel; touch "$T/yeniden.ok"
  wait $NODE || fail=1; grep -v HAZIR "$T/yenile.out"
  node tools/kapat_test.mjs "$DPORT" "$URL/" kapat || fail=1
  check "düğmeyle kapatınca sunucu kapandı" "$(gone $PID)" 1
fi

# ---- temizlik ----
kill $PID 2>/dev/null; wait $PID 2>/dev/null
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.CommandLine -like '*$TW*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
sleep 1
check "test süreci kalmadı" "$(count "\$_.Name -ne 'pwsh.exe' -and \$_.CommandLine -like '*$TW*'")" 0
rm -rf "$T"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail

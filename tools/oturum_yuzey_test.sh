#!/usr/bin/env bash
# Issue #1 madde 4-7 testi: oturumun nerede açık olduğu (masaüstü uygulaması / VS Code / terminal), soru bekleyen oturum
# ("waiting" → bekleyenler şeridi, "cevap bekliyor"), masaüstü uygulamasında "Panele al" öne çıkmaz, sanal masaüstü rozeti,
# sekme kimliği isteği. Sunucu tarafı curl ile, arayüz tools/oturum_yuzey_test.mjs ile başsız Chrome'da.
# Gerçek ~/.claude'a ve canlı panele dokunmaz: geçici klasör, boş portlar, test kopyası --no-window. Oturum dosyaları
# yer tutucu süreçlere (py uyku) bağlanır; panel PID + başlangıç zamanıyla canlı sayar. Görüntüler: _onizleme/yuzey_*.png.
# Kullanım: tools/oturum_yuzey_test.sh [exe]
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
[ "$FREE" -lt 4 ] && { echo "Boş RAM $FREE GB (< 4 GB): tarayıcı testi başlatılmadı"; rm -rf "$T"; exit 3; }
mkdir -p "$T/claude/sessions" "$T/data" "$T/tmp" "$T/chrome" "$T/p/Masaustu Projesi" "$T/p/Kod Projesi" "$T/p/Soru Projesi" _onizleme
rm -f _onizleme/yuzey_*.png
printf '{"Notify":false,"Introduced":true}' > "$T/data/tray.json"

# Yer tutucu süreç + oturum dosyası. $1 ad, $2 klasör, $3 entrypoint, $4 status, $5 waitingFor (boş olabilir)
oturum() {
  py -3.13 -c "import time; time.sleep(600)  # $TW" >/dev/null 2>&1 & local p=$!
  sleep 0.3; local wpid; wpid=$(cat /proc/$p/winpid)
  local ft; ft=$(pwsh -NoProfile -c "(Get-Process -Id $wpid).StartTime.ToFileTimeUtc()" | tr -d '\r')
  local now=$(( $(date +%s) * 1000 ))
  local wf=""; [ -n "$5" ] && wf=",\"waitingFor\":\"$5\""
  local cwd; cwd=$(cygpath -w "$T/p/$2" | sed 's/\\/\\\\/g')
  printf '{"pid":%s,"sessionId":"%s","cwd":"%s","startedAt":%s,"procStart":"%s","version":"2.1.330","kind":"interactive","entrypoint":"%s","name":"%s","nameSource":"derived","updatedAt":%s,"status":"%s","statusUpdatedAt":%s%s}' \
    "$wpid" "$(py -3.13 -c 'import uuid;print(uuid.uuid4())')" "$cwd" "$((now-600000))" "$ft" "$3" "$1" "$now" "$4" "$((now-120000))" "$wf" \
    > "$T/claude/sessions/$wpid.json"
  echo "$wpid"
}
P_DESK=$(oturum masaustu "Masaustu Projesi" claude-desktop idle "")
P_CODE=$(oturum kod "Kod Projesi" claude-vscode idle "")
P_SORU=$(oturum soru "Soru Projesi" cli waiting "dialog open")

PORT=$(freeport); DPORT=$(freeport); B="http://127.0.0.1:$PORT"
CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && break; sleep 0.2; done
ST=$(curl -s "$B/api/state")
check "test kopyası açıldı, 3 oturum" "$(echo "$ST" | grep -o '"sessionId"' | wc -l | tr -d ' ')" 3
check "entrypoint geçiyor (masaüstü)" "$(echo "$ST" | grep -c '"entrypoint":"claude-desktop"')" 1
check "entrypoint geçiyor (VS Code)" "$(echo "$ST" | grep -c '"entrypoint":"claude-vscode"')" 1
check "waitingFor yalnız bekleyen oturumda" "$(echo "$ST" | grep -o '"waitingFor":"[^"]*"' | tr '\n' ' ')" '"waitingFor":"dialog open" '
check "desktops alanı var (tek masaüstünde boş)" "$(echo "$ST" | grep -c '"desktops":{')" 1
TOK=$(cat "$T/data/panel-$PORT.token")
check "soru bekleyen oturum panele alınmaz (409 busy)" "$(curl -s -X POST "$B/api/adopt/$P_SORU" -H "X-Panel-Token: $TOK" -H "Origin: $B" -w ' %{http_code}')" '{"error":"busy"} 409'
# Odak isteği tabId alanını kabul eder (pencere yok: yer tutucu süreç → no-window).
check "odak isteği tabId ile (pencere yok)" "$(curl -s -X POST "$B/api/focus/$P_CODE" -H "X-Panel-Token: $TOK" -H "Origin: $B" -H 'Content-Type: application/json' -d '{"tab":null,"tabId":"42.1.2"}')" '{"ok":false,"error":"no-window","tabs":null,"tab":null,"tabId":null}'

"$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$TW\\chrome" --remote-debugging-port="$DPORT" about:blank >/dev/null 2>&1 &
for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$DPORT/json/version" >/dev/null 2>&1 && break; sleep 0.2; done
check "hata ayıklama portu bizim Chrome'da" "$(pwsh -NoProfile -c "\$p=(Get-NetTCPConnection -LocalPort $DPORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if (\$p -and (Get-CimInstance Win32_Process -Filter \"ProcessId=\$p\").CommandLine -like '*$TW*') { 1 } else { 0 }" | tr -d '\r')" 1
[ $fail = 0 ] && { node tools/oturum_yuzey_test.mjs "$DPORT" "$B/" "_onizleme/yuzey" "$P_DESK" "$P_CODE" "$P_SORU" || fail=1; }

# ---- temizlik ----
curl -s -o /dev/null -X POST "$B/api/quit?force=1" -H "X-Panel-Token: $TOK" -H "Origin: $B"
for _ in $(seq 1 40); do curl -s -o /dev/null "$B/api/ping" || break; sleep 0.25; done
kill $PID 2>/dev/null; wait $PID 2>/dev/null
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and \$_.CommandLine -like '*$TW*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
kalan() { pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and \$_.CommandLine -like '*$TW*' }).Count" | tr -d '\r'; }
for _ in $(seq 1 10); do [ "$(kalan)" = 0 ] && break; sleep 1; done # Chrome alt süreçleri birkaç sn'de kapanır
check "test süreci kalmadı" "$(kalan)" 0
rm -rf "$T" 2>/dev/null
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail

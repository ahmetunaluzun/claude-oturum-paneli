#!/usr/bin/env bash
# Codex oturumları (salt okuma) testi: /api/codex* sunucu tarafı curl ile, arayüz tools/codex_ui_test.mjs ile başsız Chrome'da.
# Gerçek ~/.codex'e, ~/.claude'a ve canlı panele dokunmaz: geçici klasör, boş portlar, test kopyası --no-window.
# Sahte Codex ağacı tools/codex_ortam.py (önce YOK: Codex kurulu değil → hiçbir öğe; sonra mjs kurar). Codex çalıştırılmaz.
# Görüntüler: _onizleme/codex_*.png. Kullanım: tools/codex_ui_test.sh [exe]
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
mkdir -p "$T/claude/sessions" "$T/data" "$T/tmp" "$T/chrome" "$T/p/Claude Projesi" _onizleme
rm -f _onizleme/codex_*.png
printf '{"Notify":false,"Introduced":true}' > "$T/data/tray.json"

# Claude kartı yanında görünsün diye tek Claude oturumu: yer tutucu süreç + oturum dosyası (oturum_yuzey_test.sh deseni).
py -3.13 -c "import time; time.sleep(900)  # $TW" >/dev/null 2>&1 & YP=$!
sleep 0.3; WPID=$(cat /proc/$YP/winpid)
FT=$(pwsh -NoProfile -c "(Get-Process -Id $WPID).StartTime.ToFileTimeUtc()" | tr -d '\r')
NOW=$(( $(date +%s) * 1000 ))
CWD=$(cygpath -w "$T/p/Claude Projesi" | sed 's/\\/\\\\/g')
printf '{"pid":%s,"sessionId":"%s","cwd":"%s","startedAt":%s,"procStart":"%s","version":"2.1.330","kind":"interactive","entrypoint":"cli","name":"claude","nameSource":"derived","updatedAt":%s,"status":"idle","statusUpdatedAt":%s}' \
  "$WPID" "$(py -3.13 -c 'import uuid;print(uuid.uuid4())')" "$CWD" "$((NOW-600000))" "$FT" "$NOW" "$((NOW-120000))" > "$T/claude/sessions/$WPID.json"

PORT=$(freeport); DPORT=$(freeport); B="http://127.0.0.1:$PORT"
CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CODEX_HOME="$TW\\codex" \
  TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && break; sleep 0.2; done
TOK=$(cat "$T/data/panel-$PORT.token")
check "Codex klasörü yok → installed:false" "$(curl -s "$B/api/codex")" '{"installed":false}'
check "Codex yokken okuma 404" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/codex/transcript/abc")" 404

"$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$TW\\chrome" --remote-debugging-port="$DPORT" about:blank >/dev/null 2>&1 &
for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$DPORT/json/version" >/dev/null 2>&1 && break; sleep 0.2; done
check "hata ayıklama portu bizim Chrome'da" "$(pwsh -NoProfile -c "\$p=(Get-NetTCPConnection -LocalPort $DPORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if (\$p -and (Get-CimInstance Win32_Process -Filter \"ProcessId=\$p\").CommandLine -like '*$TW*') { 1 } else { 0 }" | tr -d '\r')" 1
[ $fail = 0 ] && { node tools/codex_ui_test.mjs "$DPORT" "$B/" "_onizleme/codex" "$TW\\codex" || fail=1; }

# ---- sunucu: ağaç mjs'te kuruldu ----
CAL=019a2b3c-0000-7000-8000-00000000c0de; BIT=019a2b3c-0000-7000-8000-0000000b1771
J=$(curl -s "$B/api/codex")
check "kurulu, 3 oturum" "$(echo "$J" | grep -o '"state":"[a-z]*"' | sort | tr '\n' ' ')" '"state":"ended" "state":"open" "state":"working" '
check "devam komutu yalnız bitmiş oturumda" "$(echo "$J" | grep -o '"resume":"[^"]*"' | tr '\n' ' ')" "\"resume\":\"codex resume $BIT\" "
check "dosya yolu yanıtta yok" "$(echo "$J" | grep -c 'rollout-')" 0
TR=$(curl -s "$B/api/codex/transcript/$BIT")
check "okuma: 4 mesaj" "$(echo "$TR" | grep -o '"kind":"[a-z]*"' | tr '\n' ' ')" '"kind":"user" "kind":"assistant" "kind":"user" "kind":"assistant" '
check "okuma: developer ve ortam metni yok" "$(echo "$TR" | grep -c 'GIZLI-SISTEM\|environment_context')" 0
check "bilinmeyen kimlik 404" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/codex/transcript/..%5C..%5Cauth")" 404
check "klasörü aç: anahtarsız 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/codex/open-folder" -H 'Content-Type: application/json' -d "{\"id\":\"$CAL\"}")" 403
check "klasörü aç: klasör yok 404 (pencere açılmaz)" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/codex/open-folder" -H "X-Panel-Token: $TOK" -H "Origin: $B" -H 'Content-Type: application/json' -d "{\"id\":\"$CAL\"}")" 404
check "klasörü aç: bilinmeyen kimlik 404" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/codex/open-folder" -H "X-Panel-Token: $TOK" -H "Origin: $B" -H 'Content-Type: application/json' -d '{"id":"C:\\Windows"}')" 404
# Panel Codex klasörüne hiçbir şey yazmaz: yalnız ortam betiğinin yazdığı 3 oturum + 2 kilit
check "Codex klasörüne yazılmadı" "$(cd "$T/codex" && find . -type f | sort | tr '\n' ' ')" "./sessions/2026/11/22/rollout-2026-11-22T01-00-00-bitti.jsonl ./sessions/2026/11/22/rollout-2026-11-22T02-00-00-acik.jsonl ./sessions/2026/11/22/rollout-2026-11-22T03-00-00-calisan.jsonl ./thread-writer-locks/$CAL.lock ./thread-writer-locks/019a2b3c-0000-7000-8000-0000000a91c0.lock "

# ---- temizlik ----
curl -s -o /dev/null -X POST "$B/api/quit?force=1" -H "X-Panel-Token: $TOK" -H "Origin: $B"
for _ in $(seq 1 40); do curl -s -o /dev/null "$B/api/ping" || break; sleep 0.25; done
kill $PID 2>/dev/null; wait $PID 2>/dev/null
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and \$_.CommandLine -like '*$TW*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
kalan() { pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and \$_.CommandLine -like '*$TW*' }).Count" | tr -d '\r'; }
for _ in $(seq 1 10); do [ "$(kalan)" = 0 ] && break; sleep 1; done
check "test süreci kalmadı" "$(kalan)" 0
pwsh -NoProfile -c "Remove-Item -LiteralPath '$TW' -Recurse -Force -ErrorAction SilentlyContinue"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail

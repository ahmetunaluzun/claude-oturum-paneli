#!/usr/bin/env bash
# Gönderilmemiş mesaj taslağı testi (kullanıcı 26.11: "yazıp gönderilmeyen metin çekmece kapanınca siliniyor"): iki panel oturumu,
# taslak oturum başına saklanır, ✕ ile kapatıp açınca ve sayfa yenilenince geri gelir, gönderince silinir. Arayüz tools/taslak_test.mjs.
# Gerçek ~/.claude'a ve canlı panele dokunmaz: geçici klasör, boş portlar, test kopyası --no-window, sahte claude.
# Kullanım: tools/taslak_test.sh [exe]
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
mkdir -p "$T/claude/sessions" "$T/data" "$T/tmp" "$T/chrome" "$T/p/Taslak A" "$T/p/Taslak B"
printf '{"Notify":false,"Introduced":true}' > "$T/data/tray.json"
printf '@echo off\r\npy -3.13 "%s"\r\n' "$(cygpath -w "$PWD/tools/sahte_claude.py")" > "$T/sahte-claude.cmd"
printf '{"_test":"gece-modu-koruma quota-guard project-guard"}' > "$T/claude/settings.json"

PORT=$(freeport); DPORT=$(freeport); B="http://127.0.0.1:$PORT"
CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CLAUDE_EXE="$TW\\sahte-claude.cmd" \
  SAHTE_CLAUDE_LOG="$TW\\sahte.log" TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && break; sleep 0.2; done
TOK=$(cat "$T/data/panel-$PORT.token")
check "test kopyası açıldı" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/state")" 200
for P in "Taslak A" "Taslak B"; do
  CWD=$(cygpath -w "$T/p/$P" | sed 's/\\/\\\\/g')
  check "panelde oturum açıldı ($P)" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/hosted" -H "X-Panel-Token: $TOK" -H "Origin: $B" -H 'Content-Type: application/json' -d "{\"cwd\":\"$CWD\",\"prompt\":\"merhaba\"}")" 200
done
for _ in $(seq 1 60); do [ "$(curl -s "$B/api/state" | grep -o '"status":"idle"' | wc -l)" -ge 2 ] && break; sleep 0.25; done

"$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$TW\\chrome" --remote-debugging-port="$DPORT" about:blank >/dev/null 2>&1 &
for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$DPORT/json/version" >/dev/null 2>&1 && break; sleep 0.2; done
check "hata ayıklama portu bizim Chrome'da" "$(pwsh -NoProfile -c "\$p=(Get-NetTCPConnection -LocalPort $DPORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if (\$p -and (Get-CimInstance Win32_Process -Filter \"ProcessId=\$p\").CommandLine -like '*$TW*') { 1 } else { 0 }" | tr -d '\r')" 1
if [ $fail = 0 ]; then
  node tools/taslak_test.mjs "$DPORT" "$B/" || fail=1
fi

# ---- temizlik ----
for k in $(curl -s "$B/api/state" | grep -o '"key":"[0-9a-f]*"' | cut -d'"' -f4); do
  curl -s -o /dev/null -X POST "$B/api/hosted/$k/stop" -H "X-Panel-Token: $TOK" -H "Origin: $B"; done
curl -s -o /dev/null -X POST "$B/api/quit?force=1" -H "X-Panel-Token: $TOK" -H "Origin: $B"
for _ in $(seq 1 40); do curl -s -o /dev/null "$B/api/ping" || break; sleep 0.25; done
kill $PID 2>/dev/null; wait $PID 2>/dev/null
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and \$_.CommandLine -like '*$TW*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
kalan() { pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and (\$_.CommandLine -like '*$TW*' -or \$_.CommandLine -like '*sahte_claude.py*') }).Count" | tr -d '\r'; }
for _ in $(seq 1 10); do [ "$(kalan)" = 0 ] && break; sleep 1; done
check "test süreci kalmadı" "$(kalan)" 0
rm -rf "$T" 2>/dev/null
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail

#!/usr/bin/env bash
# Gizli bilgi engelinin tarayıcı testi (0.18.0): ortamı kurar (tools/gizli_ortam.sh), tools/gizli_ui_test.mjs'i başsız
# Chrome'da koşturur. Gerçek ~/.claude'a ve canlı panele dokunmaz: geçici klasör, boş portlar, test kopyası --no-window,
# sahte claude (tools/sahte_claude.py), uzak = yerel bare depo. Görüntüler: _onizleme/secret_*.png.
# Kullanım: tools/gizli_ui_test.sh [exe]
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
tools/gizli_ortam.sh "$T" || { echo "ortam kurulamadı"; rm -rf "$T"; exit 1; }
G=(git -c user.name=Demo -c user.email=demo@example.invalid -c core.autocrlf=false -c commit.gpgsign=false)
PAROLA="p@ss""1234test"; ANAHTAR="zz99""88776655aa"
printf '@echo off\r\npy -3.13 "%s"\r\n' "$(cygpath -w "$PWD/tools/sahte_claude.py")" > "$T/sahte-claude.cmd"
printf '{"_test":"gece-modu-koruma quota-guard project-guard"}' > "$T/claude/settings.json"
mkdir -p "$T/chrome" _onizleme; rm -f _onizleme/secret_*.png

PORT=$(freeport); DPORT=$(freeport); B="http://127.0.0.1:$PORT"
CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CLAUDE_EXE="$TW\\sahte-claude.cmd" \
  CLAUDE_PANEL_GH_EXE="$TW\\yok.cmd" SAHTE_CLAUDE_LOG="$TW\\sahte.log" SAHTE_CLAUDE_GECIKME=1 TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && break; sleep 0.2; done
TOK=$(cat "$T/data/panel-$PORT.token")
check "test kopyası açıldı, gerçek oturumlar okunmuyor" "$(curl -s "$B/api/state" | grep -c '"sessions":\[\]')" 1
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$TW\\chrome" --remote-debugging-port="$DPORT" about:blank >/dev/null 2>&1 &
for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$DPORT/json/version" >/dev/null 2>&1 && break; sleep 0.2; done
check "hata ayıklama portu bizim Chrome'da" "$(pwsh -NoProfile -c "\$p=(Get-NetTCPConnection -LocalPort $DPORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if (\$p -and (Get-CimInstance Win32_Process -Filter \"ProcessId=\$p\").CommandLine -like '*$TW*') { 1 } else { 0 }" | tr -d '\r')" 1

if [ $fail = 0 ]; then
  node tools/gizli_ui_test.mjs "$DPORT" "$B/" "_onizleme/secret" "$TW\\projeler" 'C:\Projeler' || fail=1
  check "izin yalnız onaylanan deponun iki bulgusu (Telefon Depo'da Vazgeç)" "$(py -3.13 -c "import json,sys;print(sorted(e['File'] for e in json.load(open(sys.argv[1],encoding='utf-8'))))" "$T/data/push-allow.json")" "['test/kimlik.test.ts', 'test/kimlik.test.ts']"
  check "Test Kimlik uzağa gitti, ötekiler gitmedi" "$("${G[@]}" -C "$T/uzak/test-kimlik.git" rev-list --count main) $("${G[@]}" -C "$T/uzak/env-depo.git" rev-list --count main) $("${G[@]}" -C "$T/uzak/telefon-depo.git" rev-list --count main)" "2 1 1"
  check "inceleme istemi bulguları taşıyor (dosya:satır + kural), değer yok" "$(grep -c 'ayar.py:1 — parola/anahtar ataması' "$T/sahte.log") $(grep -c '\.env — \.env dosyası' "$T/sahte.log") $(grep -c -e "$PAROLA" -e "$ANAHTAR" "$T/sahte.log")" "1 1 0"
  check "inceleme oturumu Env Depo klasöründe açıldı" "$(grep '^ACILIS' "$T/sahte.log" | grep -c 'Env Depo')" 1
  check "değerler logda yok" "$(cat "$T"/data/logs/*.log | grep -c -e "$PAROLA" -e "$ANAHTAR")" 0
fi

# ---- temizlik ----
for k in $(curl -s "$B/api/state" | grep -o '"key":"[0-9a-f]*"' | cut -d'"' -f4); do
  curl -s -o /dev/null -X POST "$B/api/hosted/$k/stop" -H "X-Panel-Token: $TOK" -H "Origin: $B"; done
curl -s -o /dev/null -X POST "$B/api/quit?force=1" -H "X-Panel-Token: $TOK" -H "Origin: $B"
for _ in $(seq 1 40); do curl -s -o /dev/null "$B/api/ping" || break; sleep 0.25; done
kill $PID 2>/dev/null; wait $PID 2>/dev/null
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.CommandLine -like '*$TW*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
sleep 1
check "test süreci kalmadı" "$(pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and (\$_.CommandLine -like '*$TW*' -or \$_.CommandLine -like '*sahte_claude.py*') }).Count" | tr -d '\r')" 0
rm -rf "$T"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail

#!/usr/bin/env bash
# Takip → GitHub tarayıcı testi: ortamı kurar, tools/github_ui_test.mjs'i başsız Chrome'da koşturur (ayrıntı o dosyada).
# Gerçek gh'ye, GitHub'a, gerçek ~/.claude'a ve canlı panele dokunmaz: geçici klasör, boş portlar, test kopyası --no-window,
# sahte gh (tools/sahte_gh.py), sahte claude (tools/sahte_claude.py), tepsi bildirimi kapalı. Görüntüler: _onizleme/github_*.png.
# Kullanım: tools/github_ui_test.sh [exe]
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
tools/takip_ortam.sh "$T" || { echo "ortam kurulamadı"; rm -rf "$T"; exit 1; }
git -C "$T/projeler/Demo Mağaza" remote add origin https://github.com/testkul/demo-magaza.git
git -C "$T/projeler/Temiz Kütüphane" remote add origin git@github.com:TestKul/temiz-kutuphane.git
SGH="$(cygpath -w "$PWD/tools/sahte_gh.py")"
printf '@echo off\r\npy -3.13 "%s" %%*\r\n' "$SGH" > "$T/sahte-gh.cmd"
printf '@echo off\r\npy -3.13 "%s"\r\n' "$(cygpath -w "$PWD/tools/sahte_claude.py")" > "$T/sahte-claude.cmd"
printf '{"_test":"gece-modu-koruma quota-guard project-guard"}' > "$T/claude/settings.json"
printf '{"Notify":false,"Introduced":true}' > "$T/data/tray.json"
py -3.13 "$SGH" --senaryo ilk "$TW\\gh.json"
mkdir -p "$T/chrome" _onizleme; rm -f _onizleme/github_*.png

PORT=$(freeport); DPORT=$(freeport); B="http://127.0.0.1:$PORT"
CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CLAUDE_EXE="$TW\\sahte-claude.cmd" CLAUDE_PANEL_GH_EXE="$TW\\sahte-gh.cmd" \
  SAHTE_GH_DOSYA="$TW\\gh.json" SAHTE_GH_LOG="$TW\\gh.log" SAHTE_CLAUDE_LOG="$TW\\sahte.log" SAHTE_CLAUDE_KAYIT="$TW\\claude\\projects\\sahte-oturum" TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && break; sleep 0.2; done
check "test kopyası açıldı" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/state")" 200
check "canlı oturum listesi boş (gerçek ~/.claude okunmuyor)" "$(curl -s "$B/api/state" | grep -c '"sessions":\[\]')" 1
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$TW\\chrome" --remote-debugging-port="$DPORT" about:blank >/dev/null 2>&1 &
for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$DPORT/json/version" >/dev/null 2>&1 && break; sleep 0.2; done
# Hata ayıklama portu gerçekten bizim açtığımız Chrome'un mu (başka oturumun tarayıcısına komut gitmesin).
check "hata ayıklama portu bizim Chrome'da" "$(pwsh -NoProfile -c "\$p=(Get-NetTCPConnection -LocalPort $DPORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if (\$p -and (Get-CimInstance Win32_Process -Filter \"ProcessId=\$p\").CommandLine -like '*$TW*') { 1 } else { 0 }" | tr -d '\r')" 1

if [ $fail = 0 ]; then
  node tools/github_ui_test.mjs "$DPORT" "$B/" "_onizleme/github" "$TW" 'C:\Projeler' || fail=1
  check "GitHub'a hiçbir yazma çağrısı yok" "$(grep -c '^YAZMA' "$T/gh.log")" 0
fi

# ---- temizlik ----
TOK=$(cat "$T/data/panel-$PORT.token" 2>/dev/null)
for k in $(curl -s "$B/api/state" | grep -o '"key":"[0-9a-f]*"' | cut -d'"' -f4); do
  curl -s -o /dev/null -X POST "$B/api/hosted/$k/stop" -H "X-Panel-Token: $TOK" -H "Origin: $B"; done
curl -s -o /dev/null -X POST "$B/api/quit?force=1" -H "X-Panel-Token: $TOK" -H "Origin: $B"
for _ in $(seq 1 40); do curl -s -o /dev/null "$B/api/ping" || break; sleep 0.25; done
kill $PID 2>/dev/null; wait $PID 2>/dev/null
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and \$_.CommandLine -like '*$TW*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
sleep 1
check "test süreci kalmadı" "$(pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and (\$_.CommandLine -like '*$TW*' -or \$_.CommandLine -like '*sahte_claude.py*' -or \$_.CommandLine -like '*sahte_gh.py*') }).Count" | tr -d '\r')" 0
rm -rf "$T"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail

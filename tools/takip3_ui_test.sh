#!/usr/bin/env bash
# Takip 3. aşama tarayıcı testi: ortamı kurar, tools/takip3_ui_test.mjs'i başsız Chrome'da koşturur (ayrıntı o dosyada).
# Gerçek ~/.claude'a ve canlı panele dokunmaz: geçici klasör, boş portlar, test kopyası --no-window, sahte claude
# (tools/sahte_claude.py), uydurma kütükler (tools/takip_ortam.sh <klasör> kutuk). Görüntüler: _onizleme/takip3_*.png.
# Kullanım: tools/takip3_ui_test.sh [exe]
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
tools/takip_ortam.sh "$T" kutuk || { echo "ortam kurulamadı"; rm -rf "$T"; exit 1; }
G=(git -c user.name=Demo -c user.email=demo@example.invalid -c core.autocrlf=false -c commit.gpgsign=false)
printf '@echo off\r\npy -3.13 "%s"\r\n' "$(cygpath -w "$PWD/tools/sahte_claude.py")" > "$T/sahte-claude.cmd"
printf '{"_test":"gece-modu-koruma quota-guard project-guard"}' > "$T/claude/settings.json"
mkdir -p "$T/chrome" _onizleme; rm -f _onizleme/takip3_*.png

PORT=$(freeport); DPORT=$(freeport)
CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CLAUDE_EXE="$TW\\sahte-claude.cmd" \
  SAHTE_CLAUDE_GECIKME=3 TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && break; sleep 0.2; done
check "test kopyası açıldı" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/state")" 200
check "canlı oturum listesi boş (gerçek ~/.claude okunmuyor)" "$(curl -s "http://127.0.0.1:$PORT/api/state" | grep -c '"sessions":\[\]')" 1
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$TW\\chrome" --remote-debugging-port="$DPORT" about:blank >/dev/null 2>&1 &
for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$DPORT/json/version" >/dev/null 2>&1 && break; sleep 0.2; done
# Hata ayıklama portu gerçekten bizim açtığımız Chrome'un mu (başka oturumun tarayıcısına komut gitmesin).
check "hata ayıklama portu bizim Chrome'da" "$(pwsh -NoProfile -c "\$p=(Get-NetTCPConnection -LocalPort $DPORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if (\$p -and (Get-CimInstance Win32_Process -Filter \"ProcessId=\$p\").CommandLine -like '*$TW*') { 1 } else { 0 }" | tr -d '\r')" 1

if [ $fail = 0 ]; then
  node tools/takip3_ui_test.mjs "$DPORT" "http://127.0.0.1:$PORT/" "_onizleme/takip3" "$TW\\projeler" 'C:\Projeler' || fail=1
  check "kütüğü oturum güncelledi: kapatılan dosya KAPATILDI bölümünde, öteki AÇIK bölümde" "$(py -3.13 -c "
import sys
s=open(sys.argv[1],encoding='utf-8').read(); a,b=s.split('## KAPATILDI — DRIVE',1)
print('yardim.html' in b, 'yardim.html' in a.split('## KAPANDI')[0], 'egitim.html' in a.split('## KAPANDI')[0])" "$T/projeler/Yardım Sitesi/GUNCELLEME_KUTUGU.md")" "True False True"
  check "toplu işle Örnek API uzak depoya gönderildi (3 commit)" "$("${G[@]}" -C "$T/uzak/ornek-api.git" rev-list --count main)" 3
fi

# ---- temizlik ----
TOK=$(cat "$T/data/panel-$PORT.token" 2>/dev/null)
for k in $(curl -s "http://127.0.0.1:$PORT/api/state" | grep -o '"key":"[0-9a-f]*"' | cut -d'"' -f4); do
  curl -s -o /dev/null -X POST "http://127.0.0.1:$PORT/api/hosted/$k/stop" -H "X-Panel-Token: $TOK" -H "Origin: http://127.0.0.1:$PORT"; done
kill $PID 2>/dev/null; wait $PID 2>/dev/null
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.CommandLine -like '*$TW*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
sleep 1
check "test süreci kalmadı" "$(pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and (\$_.CommandLine -like '*$TW*' -or \$_.CommandLine -like '*sahte_claude.py*') }).Count" | tr -d '\r')" 0
rm -rf "$T"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail

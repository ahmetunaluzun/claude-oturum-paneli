#!/usr/bin/env bash
# Onay penceresi testi: ortamı kurar, tools/confirm_test.mjs'i başsız Chrome'da koşturur (ayrıntı o dosyada).
# Gerçek ~/.claude'a ve canlı panele dokunmaz: geçici klasör, boş port, test kopyası --no-window, sahte claude betiği.
# Kullanım: tools/confirm_test.sh [exe]   (varsayılan: Release derlemesi). Görüntüler: _onizleme/cbox_*.png
set -u
cd "$(dirname "$0")/.."
EXE="${1:-src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe}"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
T="$(mktemp -d)"; TW=$(cygpath -w "$T")
fail=0
check() { if [ "$2" = "$3" ]; then echo "GEÇTİ  $1"; else echo "KALDI  $1 (beklenen $3, gelen $2)"; fail=1; fi; }
freeport() { pwsh -NoProfile -c '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()' | tr -d '\r'; }
mkdir -p "$T/claude" "$T/data" "$T/tmp" "$T/chrome" _onizleme
printf '@echo off\r\necho 0.0.0 (test)\r\n' > "$T/sahte-claude.cmd"
# Mevcut durum satırı: "Terminal oturumlarında kota" açılırken değişim sorusu çıksın (uzun satır: taşma ölçümü için).
cat > "$T/claude/settings.json" <<'JSON'
{ "statusLine": { "type": "command", "command": "python \"C:\\eski\\araclar\\durum_satiri\\cok_uzun_bir_klasor_adi\\statusline.py\" --renkli --kota --baglam" } }
JSON
cp "$T/claude/settings.json" "$T/orijinal.json"
rm -f _onizleme/cbox_*.png

PORT=$(freeport); DPORT=$(freeport)
CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CLAUDE_EXE="$TW\\sahte-claude.cmd" \
  TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && break; sleep 0.2; done
check "test kopyası açıldı" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/state")" 200
check "canlı oturum listesi boş (gerçek ~/.claude okunmuyor)" "$(curl -s "http://127.0.0.1:$PORT/api/state" | grep -c '"sessions":\[\]')" 1

"$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$TW\\chrome" --remote-debugging-port="$DPORT" about:blank >/dev/null 2>&1 &
for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$DPORT/json/version" >/dev/null 2>&1 && break; sleep 0.2; done
# Hata ayıklama portu gerçekten bizim açtığımız Chrome'un mu (başka oturumun tarayıcısına komut gitmesin).
check "hata ayıklama portu bizim Chrome'da" "$(pwsh -NoProfile -c "\$p=(Get-NetTCPConnection -LocalPort $DPORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if (\$p -and (Get-CimInstance Win32_Process -Filter \"ProcessId=\$p\").CommandLine -like '*$TW*') { 1 } else { 0 }" | tr -d '\r')" 1

if [ $fail = 0 ]; then
  node tools/confirm_test.mjs "$DPORT" "http://127.0.0.1:$PORT/" "_onizleme/cbox" || fail=1
  sleep 1
  check "panel süreci kapandı (Paneli kapat onayı)" "$(kill -0 $PID 2>/dev/null && echo açık || echo kapalı)" kapalı
  py -3.13 -c "import json,sys;a=json.load(open(sys.argv[1],encoding='utf-8'));b=json.load(open(sys.argv[2],encoding='utf-8'));sys.exit(0 if a==b else 1)" "$T/claude/settings.json" "$T/orijinal.json"
  check "settings.json test sonunda ilk hâlinde (kota açılıp geri kapatıldı)" $? 0
fi

# ---- temizlik ----
kill $PID 2>/dev/null; wait $PID 2>/dev/null
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.CommandLine -like '*$TW*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
sleep 1
check "test süreci kalmadı" "$(pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.CommandLine -like '*$TW*' }).Count" | tr -d '\r')" 0
rm -rf "$T"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail

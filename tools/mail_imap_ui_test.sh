#!/usr/bin/env bash
# Mail ve takvim: adım adım hesap ekleme sihirbazı (Gmail IMAP + uygulama şifresi + iCal) tarayıcı testi. Ortamı kurar,
# tools/mail_imap_ui_test.mjs'i başsız Chrome'da koşturur (ayrıntı o dosyada). Gerçek Google'a, gerçek ~/.claude'a ve canlı panele
# dokunmaz: geçici klasör, boş portlar, test kopyası --no-window, sahte IMAP + iCal (tools/sahte_imap.py), sahte claude, tepsi bildirimi
# kapalı; "sayfa aç" uçları gerçek tarayıcı açmaz (CLAUDE_PANEL_MAIL_OPEN_LOG dosyaya yazar). En fazla 1 başsız Chrome, profili geçici
# klasörde, hata ayıklama portu boş porttan alınır ve sahibinin bizim Chrome olduğu doğrulanır.
# Görüntüler: _onizleme/mail_imap_*.png. Kullanım: tools/mail_imap_ui_test.sh [exe]
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
tools/takip_ortam.sh "$T" >/dev/null || { echo "ortam kurulamadı"; rm -rf "$T"; exit 1; }
printf '@echo off\r\npy -3.13 "%s"\r\n' "$(cygpath -w "$PWD/tools/sahte_claude.py")" > "$T/sahte-claude.cmd"
printf '{"_test":"gece-modu-koruma quota-guard project-guard"}' > "$T/claude/settings.json"
printf '{"Notify":false,"Introduced":true}' > "$T/data/tray.json"
MSYS2_ARG_CONV_EXCL="*" openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TW\\anahtar.pem" -out "$TW\\sertifika.pem" -days 2 -subj "/CN=127.0.0.1" >/dev/null 2>&1
KISI=test.kul@ornek.com; SIRK=ali.veli@sirket.com.tr
printf '{"hesaplar":{"%s":{"parola":"qwertyuiopasdfgh","mod":"ok","set":"kisisel"},"%s":{"parola":"zxcvbnmlkjhgfdsa","mod":"ok","set":"sirket"}},"ical":{"kisisel-ICALGIZLI1":{"durum":200,"icerik":"kisisel"},"sirket-ICALGIZLI2":{"durum":200,"icerik":"sirket"}}}' "$KISI" "$SIRK" > "$T/senaryo.json"
: > "$T/imap.log"; : > "$T/acilan.txt"
IP=$(freeport); CP=$(freeport)
py -3.13 "$(cygpath -w "$PWD/tools/sahte_imap.py")" "$IP" "$CP" "$TW\\sertifika.pem" "$TW\\anahtar.pem" "$TW\\senaryo.json" "$TW\\imap.log" &
SPID=$!
for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$CP/x" && break; sleep 0.2; done
mkdir -p "$T/chrome" _onizleme; rm -f _onizleme/mail_imap_*.png

PORT=$(freeport); DPORT=$(freeport); B="http://127.0.0.1:$PORT"
CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CLAUDE_EXE="$TW\\sahte-claude.cmd" \
  CLAUDE_PANEL_IMAP_BASE="127.0.0.1:$IP" CLAUDE_PANEL_ICAL_TEST_BASE="http://127.0.0.1:$CP" CLAUDE_PANEL_MAIL_NO_BROWSER=1 \
  CLAUDE_PANEL_MX_TEST="ornek.com=google;sirket.com.tr=google;diger.net=other" CLAUDE_PANEL_MAIL_OPEN_LOG="$TW\\acilan.txt" \
  SAHTE_CLAUDE_LOG="$TW\\sahte.log" SAHTE_CLAUDE_KAYIT="$TW\\claude\\projects\\sahte-oturum" TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && break; sleep 0.2; done
check "test kopyası açıldı" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/state")" 200
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$TW\\chrome" --remote-debugging-port="$DPORT" about:blank >/dev/null 2>&1 &
for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$DPORT/json/version" >/dev/null 2>&1 && break; sleep 0.2; done
check "hata ayıklama portu bizim Chrome'da" "$(pwsh -NoProfile -c "\$p=(Get-NetTCPConnection -LocalPort $DPORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if (\$p -and (Get-CimInstance Win32_Process -Filter \"ProcessId=\$p\").CommandLine -like '*$TW*') { 1 } else { 0 }" | tr -d '\r')" 1

if [ $fail = 0 ]; then
  ICAL_PORT=$CP node tools/mail_imap_ui_test.mjs "$DPORT" "$B/" "_onizleme/mail_imap" "$TW" || fail=1
  check "yazma komutu hiç gelmedi" "$(grep -c '^YASAK' "$T/imap.log")" 0
  check "düz şifre / iCal anahtarı veri klasöründe yok" "$(grep -rlE 'qwertyuiopasdfgh|zxcvbnmlkjhgfdsa|ICALGIZLI' "$T/data" 2>/dev/null | wc -l)" 0
fi

# ---- temizlik ----
TOK=$(cat "$T/data/panel-$PORT.token" 2>/dev/null)
curl -s -o /dev/null -X POST "$B/api/quit?force=1" -H "X-Panel-Token: $TOK" -H "Origin: $B"
for _ in $(seq 1 40); do curl -s -o /dev/null "$B/api/ping" || break; sleep 0.25; done
kill $PID $SPID 2>/dev/null; wait $PID 2>/dev/null
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and \$_.CommandLine -like '*$TW*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
sleep 1
check "test süreci kalmadı" "$(pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and (\$_.CommandLine -like '*$TW*' -or \$_.CommandLine -like '*sahte_imap.py*') }).Count" | tr -d '\r')" 0
rm -rf "$T"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail

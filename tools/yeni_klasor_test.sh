#!/usr/bin/env bash
# Yeni klasör testi (kullanıcı 26.11: "seçilen klasörün içinde yeni klasör oluşturup oturumu orada başlat"): API ad denetimleri,
# var olan klasörü ezmeme, üst klasör dışına çıkmama + arayüz (tools/yeni_klasor_test.mjs, geniş ve telefon).
# Gerçek ~/.claude'a ve canlı panele dokunmaz: geçici klasör, boş portlar, test kopyası --no-window, sahte claude.
# Kullanım: tools/yeni_klasor_test.sh [exe]   Görüntüler: _onizleme/yeni_klasor_*.png
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
mkdir -p "$T/claude/sessions" "$T/data" "$T/tmp" "$T/chrome" "$T/p/Var Olan" _onizleme
echo icerik > "$T/p/Var Olan/dosya.txt"
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

# ---- API ----
PJ=$(cygpath -w "$T/p" | sed 's/\\/\\\\/g')
mk() { curl -s -w ' %{http_code}' -X POST "$B/api/dirs/create" -H "X-Panel-Token: ${3:-$TOK}" -H "Origin: $B" -H 'Content-Type: application/json; charset=utf-8' --data-binary @- <<<"{\"path\":\"$1\",\"name\":\"$2\"}"; }
code() { echo "$1" | awk '{print $NF}'; }
errof() { echo "$1" | grep -o '"error":"[a-z]*"' | cut -d'"' -f4; }
r=$(mk "$PJ" "Api Klasör"); check "API: geçerli ad 200" "$(code "$r")" 200
check "API: klasör diskte" "$([ -d "$T/p/Api Klasör" ] && echo var)" var
r=$(mk "$PJ" "  Boşluklu  "); check "API: baş/son boşluk kırpılır" "$([ -d "$T/p/Boşluklu" ] && echo var)" var
r=$(mk "$PJ" "Var Olan"); check "API: var olan klasör 409" "$(code "$r") $(errof "$r")" "409 exists"
check "API: var olan klasörün içi bozulmadı" "$(cat "$T/p/Var Olan/dosya.txt")" icerik
r=$(mk "$PJ" "var olan"); check "API: büyük/küçük harf farkı da var sayılır" "$(code "$r") $(errof "$r")" "409 exists"
for bad in 'a:b' 'a\\\\b' 'a/b' '..' '.' 'a*' 'a?' 'a<b' 'a|b' '..\\\\kacis' '../kacis'; do
  r=$(mk "$PJ" "$bad"); check "API: geçersiz ad reddedildi ($bad)" "$(code "$r")" 400
done
check "API: üst klasöre kaçış olmadı" "$([ -e "$T/kacis" ] && echo var || echo yok)" yok
r=$(mk "$PJ" "nokta."); check "API: noktayla biten ad" "$(errof "$r")" dots
r=$(mk "$PJ" "CON"); check "API: ayrılmış ad (CON)" "$(errof "$r")" reserved
r=$(mk "$PJ" "nul.txt"); check "API: ayrılmış ad (nul.txt)" "$(errof "$r")" reserved
r=$(mk "$PJ" "CONSOLE"); check "API: CONSOLE ayrılmış değil" "$(code "$r")" 200
r=$(mk "$PJ" ""); check "API: boş ad" "$(errof "$r")" empty
r=$(mk "$PJ" "$(printf 'x%.0s' $(seq 1 121))"); check "API: 121 karakter" "$(errof "$r")" long
r=$(mk "$PJ\\\\yok" "a"); check "API: olmayan üst klasör 404" "$(code "$r") $(errof "$r")" "404 notfound"
r=$(mk "$PJ" "izinsiz" "yanlis"); check "API: yanlış anahtar 403" "$(code "$r")" 403
check "API: yanlış anahtarla klasör açılmadı" "$([ -e "$T/p/izinsiz" ] && echo var || echo yok)" yok
r=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/dirs/create" -H "X-Panel-Token: $TOK" -H "Origin: http://kotu.example" -H 'Content-Type: application/json' -d "{\"path\":\"$PJ\",\"name\":\"csrf\"}")
check "API: yabancı köken 403" "$r" 403
check "log satırı yazıldı" "$(grep -rh 'Yeni klasör açıldı' "$T/data/logs" 2>/dev/null | grep -c 'Api Klasör')" 1

# ---- Arayüz ----
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$TW\\chrome" --remote-debugging-port="$DPORT" about:blank >/dev/null 2>&1 &
for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$DPORT/json/version" >/dev/null 2>&1 && break; sleep 0.2; done
check "hata ayıklama portu bizim Chrome'da" "$(pwsh -NoProfile -c "\$p=(Get-NetTCPConnection -LocalPort $DPORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if (\$p -and (Get-CimInstance Win32_Process -Filter \"ProcessId=\$p\").CommandLine -like '*$TW*') { 1 } else { 0 }" | tr -d '\r')" 1
if [ $fail = 0 ]; then
  SHOT_DIR="$(cygpath -w "$PWD/_onizleme")" node tools/yeni_klasor_test.mjs "$DPORT" "$B/" "$(cygpath -w "$T/p")" || fail=1
  check "arayüz: klasör diskte (geniş)" "$([ -d "$T/p/Yeni Proje İşi" ] && echo var)" var
  check "arayüz: klasör diskte (telefon)" "$([ -d "$T/p/Telefon Projesi" ] && echo var)" var
fi

# ---- temizlik ----
curl -s -o /dev/null -X POST "$B/api/quit?force=1" -H "X-Panel-Token: $TOK" -H "Origin: $B"
for _ in $(seq 1 40); do curl -s -o /dev/null "$B/api/ping" || break; sleep 0.25; done
kill $PID 2>/dev/null; wait $PID 2>/dev/null
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and \$_.CommandLine -like '*$TW*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
kalan() { pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and \$_.CommandLine -like '*$TW*' }).Count" | tr -d '\r'; }
for _ in $(seq 1 10); do [ "$(kalan)" = 0 ] && break; sleep 1; done
check "test süreci kalmadı" "$(kalan)" 0
rm -rf "$T" 2>/dev/null
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail

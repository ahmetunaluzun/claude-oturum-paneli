#!/usr/bin/env bash
# Planlı işler (0.16.0) tarayıcı testi: ortamı kurar (git deposu, sahte claude, API ile planlar: biten oturum işi, kontrol bekleyen
# dal, kota ısıtma), tools/plan_ui_test.mjs'i başsız Chrome'da koşturur (ayrıntı o dosyada). Gerçek ~/.claude'a ve canlı panele
# dokunmaz: geçici klasör, boş portlar, test kopyası --no-window. Görüntüler: _onizleme/plan_*.png.
# Kullanım: tools/plan_ui_test.sh [exe]
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
G=(git -c user.name=Demo -c user.email=demo@example.invalid -c core.autocrlf=false -c commit.gpgsign=false)
mkdir -p "$T/claude" "$T/data" "$T/tmp" "$T/chrome" "$T/projeler/Demo Mağaza" "$T/projeler/Notlar" _onizleme
rm -f _onizleme/plan_*.png
printf '@echo off\r\npy -3.13 "%s"\r\n' "$(cygpath -w "$PWD/tools/sahte_claude.py")" > "$T/sahte-claude.cmd"
# Kanca işareti: panel gece korumasını --settings ile satır içi JSON olarak vermesin (.cmd onu ayrıştıramıyor).
printf '{"_test":"gece-modu-koruma quota-guard project-guard"}' > "$T/claude/settings.json"
( cd "$T/projeler/Demo Mağaza" && "${G[@]}" init -q -b main && git config core.autocrlf false && printf 'ilk\n' > ortak.txt && "${G[@]}" add -A && "${G[@]}" commit -q -m ilk )
DEPO=$(cygpath -w "$T/projeler/Demo Mağaza" | sed 's/\\/\\\\/g'); NOT=$(cygpath -w "$T/projeler/Notlar" | sed 's/\\/\\\\/g')

PORT=$(freeport); DPORT=$(freeport); B="http://127.0.0.1:$PORT"
CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CLAUDE_EXE="$TW\\sahte-claude.cmd" \
  SAHTE_CLAUDE_LOG="$TW\\sahte.log" TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && break; sleep 0.2; done
TOK=$(cat "$T/data/panel-$PORT.token")
post() { printf '%s' "$2" > "$T/govde.json"; curl -s -o "$T/son.json" -w '%{http_code}' -X POST "$B$1" -H "X-Panel-Token: $TOK" -H "Origin: $B" -H "Content-Type: application/json" --data-binary @"$T/govde.json"; }
id() { py -3.13 -c "import json,sys;print(json.load(open(sys.argv[1],encoding='utf-8'))['id'])" "$TW\\son.json"; }
state() { curl -s "$B/api/plans" | py -3.13 -c "import json,sys;print(next(j for j in json.load(sys.stdin)['jobs'] if j['id']=='$1')['last']['state'])"; }
bekle() { for _ in $(seq 1 80); do [ "$(state "$1" 2>/dev/null)" = "$2" ] && return 0; sleep 0.5; done; return 1; }
check "test kopyası açıldı" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/plans")" 200

# Planlar: biten oturum işi (Notlar), kontrol bekleyen dal (Demo Mağaza), kota ısıtma, uzun adlı tek seferlik iş.
post /api/plans "{\"kind\":\"session\",\"cwd\":\"$NOT\",\"name\":\"Sabah özeti\",\"prompt\":\"Dünkü notları özetle\",\"time\":\"07:30\",\"repeat\":\"weekdays\"}" >/dev/null; S1=$(id)
post /api/plans/run "{\"id\":\"$S1\"}" >/dev/null; bekle "$S1" done; check "oturum işi bitti" "$(state "$S1")" done
post /api/plans "{\"kind\":\"review\",\"cwd\":\"$DEPO\",\"name\":\"Bağımlılık güncellemesi\",\"prompt\":\"PLAN-DOSYA bağımlılıkları güncelle, testleri çalıştır\",\"model\":\"sonnet\",\"time\":\"02:00\",\"repeat\":\"daily\"}" >/dev/null; R1=$(id)
post /api/plans/run "{\"id\":\"$R1\"}" >/dev/null; bekle "$R1" review; check "kontrol bekleyen dal hazır" "$(state "$R1")" review
post /api/plans '{"kind":"warmup","time":"05:00","repeat":"weekdays"}' >/dev/null
post /api/plans "{\"kind\":\"session\",\"cwd\":\"$NOT\",\"name\":\"Çok uzun adlı bir planlı iş: yıl sonu raporu için tüm projelerdeki açık maddeleri topla ve sırala\",\"prompt\":\"$(printf 'uzun istem %.0s' $(seq 1 40))\",\"time\":\"23:45\",\"repeat\":\"once\",\"date\":\"$(date -d '+3 day' +%Y-%m-%d)\"}" >/dev/null

"$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$TW\\chrome" --remote-debugging-port="$DPORT" about:blank >/dev/null 2>&1 &
for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$DPORT/json/version" >/dev/null 2>&1 && break; sleep 0.2; done
# Hata ayıklama portu gerçekten bizim açtığımız Chrome'un mu (başka oturumun tarayıcısına komut gitmesin).
check "hata ayıklama portu bizim Chrome'da" "$(pwsh -NoProfile -c "\$p=(Get-NetTCPConnection -LocalPort $DPORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if (\$p -and (Get-CimInstance Win32_Process -Filter \"ProcessId=\$p\").CommandLine -like '*$TW*') { 1 } else { 0 }" | tr -d '\r')" 1

if [ $fail = 0 ]; then
  node tools/plan_ui_test.mjs "$DPORT" "$B/" "_onizleme/plan" "$TW" 'C:\Projeler' || fail=1
  check "Birleştir: ana depoda dosya" "$([ -f "$T/projeler/Demo Mağaza/plan.txt" ] && echo var || echo yok)" var
fi

# ---- temizlik ----
for k in $(curl -s "$B/api/state" | grep -o '"key":"[0-9a-f]*"' | cut -d'"' -f4); do
  curl -s -o /dev/null -X POST "$B/api/hosted/$k/stop" -H "X-Panel-Token: $TOK" -H "Origin: $B"; done
kill $PID 2>/dev/null; wait $PID 2>/dev/null
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.CommandLine -like '*$TW*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
sleep 1
check "test süreci kalmadı" "$(pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and (\$_.CommandLine -like '*$TW*' -or \$_.CommandLine -like '*sahte_claude.py*') }).Count" | tr -d '\r')" 0
rm -rf "$T"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail

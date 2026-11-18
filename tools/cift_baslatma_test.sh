#!/usr/bin/env bash
# Çift başlatma testi (0.11.0): aynı oturum başlatma isteği art arda/eşzamanlı gelince tek süreç açılmalı.
# Gerçek claude ÇALIŞMAZ: CLAUDE_PANEL_CLAUDE_EXE ile stdin'i okuyup açık kalan zararsız bir betik verilir (her açılışta
# baslatma.log'a bir satır yazar → açılan süreç sayısı ölçülür). Test kopyası --no-window, boş portta; gerçek ~/.claude'a dokunmaz.
# Tarayıcı bölümü (Başlat'a 3 tık → tek istek) başsız Chrome ister; yoksa atlanır.
# Kullanım: tools/cift_baslatma_test.sh [exe]   (20 sn'lik pencereyi beklediği için ~40 sn sürer)
set -u
cd "$(dirname "$0")/.."
EXE="${1:-src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe}"
T="$(mktemp -d)"; TW=$(cygpath -w "$T")
mkdir -p "$T/claude" "$T/data" "$T/projeler/Demo Mağaza" "$T/tmp"
fail=0
export PYTHONUTF8=1
check() { if [ "$2" = "$3" ]; then echo "GEÇTİ  $1"; else echo "KALDI  $1 (beklenen $3, gelen $2)"; fail=1; fi; }
freeport() { pwsh -NoProfile -c '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()'; }
printf '@echo off\r\necho x>>"%%~dp0baslatma.log"\r\n"%%SystemRoot%%\\System32\\sort.exe" >nul\r\n' > "$T/sahte-claude.cmd"
# Panel, oturuma --settings ile satır içi JSON verir; .cmd betiği o argümanı (tırnak, |) ayrıştıramaz. Test ayar dosyasında
# iki koruma "zaten kayıtlı" göründüğü için panel --settings eklemez (NightGuard.SettingsArg).
printf '{"_test":"gece-modu-koruma quota-guard"}' > "$T/claude/settings.json"
starts() { [ -f "$T/baslatma.log" ] && grep -c x "$T/baslatma.log" || echo 0; }

PORT=$(freeport); B="http://127.0.0.1:$PORT"
CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CLAUDE_EXE="$TW\\sahte-claude.cmd" \
  TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && break; sleep 0.2; done
TOK=$(cat "$T/data/panel-$PORT.token")
CWD=$(cygpath -w "$T/projeler/Demo Mağaza" | sed 's/\\/\\\\/g')
# Gövde dosyadan gönderilir: Windows'ta curl'e argümanla verilen Türkçe karakter UTF-8 gitmez (sunucu 400 verir).
post() { local f="$T/govde.$BASHPID.json"; printf '%s' "$2" > "$f"; curl -s -X POST "$B$1" -H "X-Panel-Token: $TOK" -H "Origin: $B" -H "Content-Type: application/json" --data-binary @"$f"; }
hosted() { curl -s "$B/api/state" | py -3.13 -c "import json,sys;print(len(json.load(sys.stdin)['hosted']))"; }
BODY="{\"cwd\":\"$CWD\",\"prompt\":\"aynı görev\"}"

# ---- panel oturumu: eşzamanlı 5 istek ----
pids=(); for i in 1 2 3 4 5; do post /api/hosted "$BODY" > "$T/r$i.json" & pids+=($!); done; wait "${pids[@]}"
check "eşzamanlı 5 istek: tek anahtar" "$(cat "$T"/r?.json | grep -o '"key":"[0-9a-f]*"' | sort -u | wc -l | tr -d ' ')" 1
check "eşzamanlı 5 istek: 4'ü yineleme diye işaretli" "$(cat "$T"/r?.json | grep -o '"repeated":true' | wc -l | tr -d ' ')" 4
check "panelde tek oturum" "$(hosted)" 1
for _ in $(seq 1 20); do [ "$(starts)" != 0 ] && break; sleep 0.5; done # sahte betiğin ilk açılışı birkaç saniye sürebiliyor
sleep 1; check "tek süreç açıldı" "$(starts)" 1
T0=$(date +%s)
post /api/hosted "$BODY" >/dev/null
check "art arda aynı istek: yine tek oturum" "$(hosted)" 1
post /api/hosted "{\"cwd\":\"$CWD\",\"prompt\":\"başka görev\"}" >/dev/null
check "farklı istem: ikinci oturum açılır" "$(hosted)" 2

# ---- arka plan oturumu (/api/sessions): eşzamanlı 5 istek ----
before=$(starts)
pids=(); for i in 1 2 3 4 5; do post /api/sessions "{\"cwd\":\"$CWD\",\"prompt\":\"arka plan görevi\"}" >/dev/null & pids+=($!); done; wait "${pids[@]}"
for _ in $(seq 1 20); do [ "$(starts)" != "$before" ] && break; sleep 0.5; done
sleep 1; check "arka plan: 5 istekte tek süreç" "$(( $(starts) - before ))" 1

# ---- kapatılan oturum yeniden açılabilir (pencere içinde olsa da) ----
K=$(post /api/hosted "{\"cwd\":\"$CWD\",\"prompt\":\"kapat aç\"}" | grep -o '"key":"[0-9a-f]*"' | cut -d'"' -f4)
post "/api/hosted/$K/stop" "" >/dev/null
K2=$(post /api/hosted "{\"cwd\":\"$CWD\",\"prompt\":\"kapat aç\"}" | grep -o '"key":"[0-9a-f]*"' | cut -d'"' -f4)
[ -n "$K2" ] && [ "$K" != "$K2" ] && check "kapatılan oturumun isteği yeniden başlatır" 1 1 || check "kapatılan oturumun isteği yeniden başlatır" 0 1

# ---- başlatma süresi dosya logunda ----
grep -q "Panel oturumu başlatıldı .*süreç açılışı [0-9]* ms" "$T"/data/logs/*.log && check "başlatma süresi logda (ms)" 1 1 || check "başlatma süresi logda (ms)" 0 1
grep -q "Yinelenen oturum başlatma isteği yok sayıldı" "$T"/data/logs/*.log && check "yinelenen istek logda" 1 1 || check "yinelenen istek logda" 0 1
grep -q "aynı görev" "$T"/data/logs/*.log && check "istem metni loga yazılmıyor" 0 1 || check "istem metni loga yazılmıyor" 1 1

# ---- tarayıcı: Başlat'a 3 tık → tek istek ----
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
if [ -x "$CHROME" ] && command -v node >/dev/null; then
  DBG=$(freeport)
  "$CHROME" --headless=new --disable-gpu --no-first-run --user-data-dir="$TW\\chrome" --remote-debugging-port=$DBG about:blank >/dev/null 2>&1 &
  for _ in $(seq 1 40); do curl -s "http://127.0.0.1:$DBG/json/version" >/dev/null && break; sleep 0.3; done
  # Port bizim açtığımız Chrome'un mu (başka oturumun tarayıcısına komut gitmesin)
  OWN=$(pwsh -NoProfile -c "\$o=(Get-NetTCPConnection -LocalPort $DBG -State Listen | Select-Object -First 1).OwningProcess; ((Get-CimInstance Win32_Process -Filter \"ProcessId=\$o\").CommandLine -like '*$TW\\chrome*')")
  if [ "$(echo "$OWN" | tr -d '\r')" = "True" ]; then
    before=$(hosted)
    OUT=$(node tools/cift_tik_test.mjs "$DBG" "$B/" "$(cygpath -w "$T/projeler/Demo Mağaza")")
    echo "  tarayıcı: $OUT"
    j() { echo "$OUT" | py -3.13 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
    check "3 tık: sunucuya tek istek" "$(j "d['sonra']['istek']")" 1
    check "istek sürerken düğme kilitli, 'Başlatılıyor…'" "$(j "d['sirasinda']['kilitli'], d['sirasinda']['metin']")" "True Başlatılıyor…"
    check "bitince düğme açık, 'Başlat', pencere kapandı" "$(j "d['sonra']['kilitli'], d['sonra']['metin'], d['sonra']['pencereAcik'], d['sonra']['hata']")" "False Başlat False "
    check "3 tık: panelde tek yeni oturum" "$(( $(hosted) - before ))" 1
  else
    check "hata ayıklama portu bizim Chrome'umuzun" "$OWN" True
  fi
  pwsh -NoProfile -c "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { \$_.CommandLine -like '*$TW\\chrome*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
else
  echo "ATLANDI  tarayıcı bölümü (Chrome ya da node yok)"
fi

# ---- 20 sn'lik pencere geçince aynı istek yeni oturum açar ----
left=$(( 21 - ($(date +%s) - T0) )); [ $left -gt 0 ] && sleep $left
before=$(hosted)
post /api/hosted "$BODY" | grep -q '"repeated":false' && check "21 sn sonra aynı istek yineleme sayılmaz" 1 1 || check "21 sn sonra aynı istek yineleme sayılmaz" 0 1
check "21 sn sonra yeni oturum" "$(( $(hosted) - before ))" 1

# ---- temizlik: sahte oturumları kapat, paneli durdur ----
for k in $(curl -s "$B/api/state" | grep -o '"key":"[0-9a-f]*"' | cut -d'"' -f4); do post "/api/hosted/$k/stop" "" >/dev/null; done
check "oturumlar kapatıldı" "$(hosted)" 0
kill $PID 2>/dev/null; wait $PID 2>/dev/null
sleep 1
check "sahte süreç kalmadı" "$(pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.CommandLine -like '*$TW*' }).Count" | tr -d '\r')" 0
rm -rf "$T"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail

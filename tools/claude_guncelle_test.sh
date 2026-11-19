#!/usr/bin/env bash
# Claude Code güncellemesi testi (panel `claude update`'i kendisi çalıştırır, ClaudeUpdater.cs):
# yeni sürüm görülünce kendiliğinden güncelleme (aynı sürüm için bir kez), "Şimdi güncelle" (202 / sürüyorsa 409),
# yeni sürüm kurmayan güncelleme, başarısız güncelleme ve hata metni, yarıda kalmış güncellemenin panel açılışında "interrupted" olması.
# Gerçek claude ÇALIŞMAZ: sahte claude.cmd yalnız --version ve update'i taklit eder. Ağa çıkılmaz (güncelleme denetimi
# önbelleği önceden yazılır: son sürüm 9.9.9). Test kopyası --no-window ve boş portta. Kullanım: tools/claude_guncelle_test.sh [exe]
set -u
cd "$(dirname "$0")/.."
EXE="${1:-src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe}"
T="$(mktemp -d)"; TW=$(cygpath -w "$T")
fail=0
PID=""
check() { if [ "$2" = "$3" ]; then echo "GEÇTİ  $1"; else echo "KALDI  $1 (beklenen $3, gelen $2)"; fail=1; fi; }
freeport() { pwsh -NoProfile -c '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()' | tr -d '\r'; }
temizle() { [ -n "$PID" ] && kill $PID 2>/dev/null; wait 2>/dev/null; rm -rf "$T"; }
trap temizle EXIT

mkdir -p "$T/data" "$T/claude/projects" "$T/bin" "$T/tmp"
cat > "$T/bin/claude.cmd" <<'EOF'
@echo off
echo %*>>"%~dp0cagri.log"
if "%~1"=="--version" goto ver
if "%~1"=="update" goto upd
exit /b 0
:ver
if exist "%~dp0kurulu" (type "%~dp0kurulu") else (echo 2.1.0 ^(Claude Code^))
exit /b 0
:upd
if exist "%~dp0yavas" ping -n 4 127.0.0.1 >nul
if exist "%~dp0bozuk" (echo Checking for updates 1>&2 & echo Network error: registry unreachable 1>&2 & exit /b 1)
if exist "%~dp0kurulu" (echo Claude Code is up to date & exit /b 0)
echo Current version: 2.1.0
echo Successfully updated from 2.1.0 to version 9.9.9
echo 9.9.9 (Claude Code)>"%~dp0kurulu"
exit /b 0
EOF
sed -i 's/$/\r/' "$T/bin/claude.cmd"
# Güncelleme denetimi önbelleği: ağa çıkılmasın, son Claude Code sürümü 9.9.9, panelin yeni sürümü yok.
onbellek() { NOW=$(date +%s); printf '{"PanelAt":%s,"PanelOk":true,"PanelLatest":null,"PanelUrl":null,"ClaudeAt":%s,"ClaudeOk":true,"ClaudeLatest":"9.9.9"}' "$NOW" "$NOW" > "$T/data/update-check.json"; }

baslat() {
  PORT=$(freeport); B="http://127.0.0.1:$PORT"
  CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CLAUDE_EXE="$TW\\bin\\claude.cmd" \
    TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
  PID=$!
  for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && break; sleep 0.2; done
  TOK=$(cat "$T/data/panel-$PORT.token")
}
kapat() { kill $PID 2>/dev/null; wait $PID 2>/dev/null; PID=""; rm -f "$T"/data/panel-*.token; sleep 0.5; }
post() { curl -s -o "$T/son.json" -w '%{http_code}' -X POST "$B$1" -H "X-Panel-Token: $TOK" -H "Origin: $B" -H "Content-Type: application/json" --data-binary '{}'; }
# cu <python ifadesi>: /api/followup yanıtında c = claudeUpdate, u = updates.claude
cu() { curl -s "$B/api/followup" > "$T/fu.json"; py -3.13 -c "
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'));c=d.get('claudeUpdate') or {};u=d['updates']['claude']
print($1)" "$T/fu.json" 2>&1; }
# bekle <ifade> <beklenen>: en çok ~20 sn
bekle() { for _ in $(seq 1 60); do [ "$(cu "$1")" = "$2" ] && return 0; curl -s -o /dev/null -X POST "$B/api/followup/refresh" -H "X-Panel-Token: $TOK" -H "Origin: $B"; sleep 0.35; done; return 1; }
guncelleme_sayisi() { cat "$T/bin/cagri.log" 2>/dev/null | grep -c '^update'; }

# ---- 1. yeni sürüm görülünce panel kendisi günceller ----
onbellek; baslat
bekle "c.get('state')" done; check "kendiliğinden güncelleme bitti" $? 0
check "kurulan sürüm ve önceki sürüm" "$(cu "c['from'], c['to'], c['error']")" "2.1.0 9.9.9 None"
check "hedef sürüm kaydedildi (aynı sürüm için tekrar denenmez)" "$(cu "c['autoFor']")" 9.9.9
bekle "u['current']" 9.9.9; check "kurulu sürüm yeniden okundu: 9.9.9, artık yeni sürüm yok" "$(cu "u['current'], u['newer']")" "9.9.9 False"
check "claude update bir kez çalıştı" "$(guncelleme_sayisi)" 1
curl -s -o /dev/null -X POST "$B/api/followup/refresh" -H "X-Panel-Token: $TOK" -H "Origin: $B"; sleep 1.5
check "yeniden tarama yeni güncelleme başlatmadı" "$(guncelleme_sayisi)" 1

# ---- 2. Şimdi güncelle: yeni sürüm kurmayan güncelleme ----
check "Şimdi güncelle: 202" "$(post /api/follow/claude-update)" 202
bekle "c.get('state'), c.get('to')" "done None"; check "güncel sürümde: bitti, yeni sürüm kurulmadı" $? 0
check "claude update iki kez çalıştı" "$(guncelleme_sayisi)" 2
check "belirteçsiz istek reddedilir" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/follow/claude-update" -H "Origin: $B")" 403

# ---- 3. sürerken ikinci istek 409 ----
touch "$T/bin/yavas"
check "yavaş güncelleme başladı: 202" "$(post /api/follow/claude-update)" 202
check "sürüyor: running" "$(cu "c['state']")" running
check "sürerken ikinci istek: 409 busy" "$(post /api/follow/claude-update) $(py -3.13 -c "import json;print(json.load(open(r'$TW\\son.json'))['error'])")" "409 busy"
bekle "c.get('state')" done; check "yavaş güncelleme bitti" $? 0
rm -f "$T/bin/yavas"
kapat

# ---- 4. başarısız güncelleme: hata metni; aynı sürüm için kendiliğinden yeniden denenmez ----
rm -f "$T/bin/kurulu" "$T/bin/cagri.log" "$T/data/claude-update.json"; touch "$T/bin/bozuk"; onbellek; baslat
bekle "c.get('state')" failed; check "güncelleme başarısız" $? 0
check "hata: claude çıktısının son satırı" "$(cu "c['error']")" "Network error: registry unreachable"
check "kurulu sürüm değişmedi, yeni sürüm hâlâ görünüyor" "$(cu "u['current'], u['newer']")" "2.1.0 True"
curl -s -o /dev/null -X POST "$B/api/followup/refresh" -H "X-Panel-Token: $TOK" -H "Origin: $B"; sleep 1.5
check "başarısızlıktan hemen sonra kendiliğinden yeniden denenmedi" "$(guncelleme_sayisi)" 1

# ---- 4b. tarayıcıda: hata metni, Şimdi güncelle, Güncelleniyor…, kuruldu notu (tools/claude_guncelle_ui.mjs) ----
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
FREE=$(pwsh -NoProfile -c '[math]::Floor((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB)' | tr -d '\r')
if [ "$FREE" -lt 4 ]; then echo "KALDI  tarayıcı aşaması: boş RAM $FREE GB (< 4 GB)"; fail=1; else
  DPORT=$(freeport); mkdir -p "$T/chrome" _onizleme; rm -f _onizleme/claude_guncelle_*.png
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$TW\chrome" --remote-debugging-port="$DPORT" about:blank >/dev/null 2>&1 &
  for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$DPORT/json/version" >/dev/null 2>&1 && break; sleep 0.2; done
  # Hata ayıklama portu bizim açtığımız Chrome'un mu (başka oturumun tarayıcısına komut gitmesin).
  check "hata ayıklama portu bizim Chrome'da" "$(pwsh -NoProfile -c "\$p=(Get-NetTCPConnection -LocalPort $DPORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if (\$p -and (Get-CimInstance Win32_Process -Filter \"ProcessId=\$p\").CommandLine -like '*$TW*') { 1 } else { 0 }" | tr -d '\r')" 1
  [ $fail = 0 ] && { node tools/claude_guncelle_ui.mjs "$DPORT" "$B/" "_onizleme/claude_guncelle" "$TW\bin" || fail=1; }
  pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'chrome.exe' -and \$_.CommandLine -like '*$TW*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
fi
kapat

# ---- 5. panel güncelleme sürerken kapandıysa açılışta "yarıda kaldı" ----
rm -f "$T/bin/bozuk" "$T/bin/yavas" "$T/bin/kurulu" "$T/bin/cagri.log"
printf '{"State":"running","From":null,"To":null,"Error":null,"At":%s,"AutoFor":"9.9.9"}' "$(date +%s)" > "$T/data/claude-update.json"
onbellek; baslat
bekle "c.get('state'), c.get('error')" "failed interrupted"; check "yarıda kalmış güncelleme: failed / interrupted" $? 0
check "yarıda kalan için kendiliğinden yeniden denenmedi (6 saat sonra)" "$(guncelleme_sayisi)" 0
check "Şimdi güncelle ile elle yeniden: 202" "$(post /api/follow/claude-update)" 202
bekle "c.get('state'), c.get('to')" "done 9.9.9"; check "elle güncelleme kurdu" $? 0
kapat

sleep 0.5
check "test süreci kalmadı" "$(pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.CommandLine -like '*$TW*' }).Count" | tr -d '\r')" 0
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail

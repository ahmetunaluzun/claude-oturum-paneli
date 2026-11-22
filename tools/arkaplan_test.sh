#!/usr/bin/env bash
# Arka plan işi görünürlüğü testi (BackgroundWork.cs, /api/state "background", /api/restart, /api/quit). Gerçek ~/.claude'a ve canlı panele
# dokunmaz: geçici klasör, boş port, test kopyası --no-window, kendi CLAUDE_PANEL_DATA ve CLAUDE_PANEL_CLAUDE_DIR'i, sahte claude.
# Konuşma kayıtları UYDURMA (tools/arkaplan_kayit.py; gerçek kayıtların yalnız yapısı taklit edilir).
# Kapsam: alt ajan / arka plan komutu başlangıcı ve bitişi (completed|failed|killed|stopped, kullanıcı ve kuyruk satırı), bildirimi gelmemiş,
# bayat (6 saat+; alt ajan kaydı yazılıyorsa bayat değil), subagents kaydından güvence, eşzamanlı alt ajan sayılmaz, yarım satır, artımlı okuma,
# restart/quit 409 (oturum boşta olsa da) + "background" listesi, force, when=idle (bekle → iş bitince kendisi yeniden başlar, iptal),
# iş yokken when=idle hemen yeniden başlatır, restart sonrası beklemenin sıfırlanması.
# Kullanım: tools/arkaplan_test.sh [exe]
set -u
cd "$(dirname "$0")/.."
EXE="${1:-src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe}"
T="$(mktemp -d)"; TW=$(cygpath -w "$T")
fail=0; n=0
export PYTHONUTF8=1
check() { n=$((n+1)); if [ "$2" = "$3" ]; then echo "GEÇTİ  $1"; else echo "KALDI  $1 (beklenen $3, gelen $2)"; fail=1; fi; }
freeport() { pwsh -NoProfile -c '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()' | tr -d '\r'; }
alive() { pwsh -NoProfile -c "if (Get-Process -Id $1 -ErrorAction SilentlyContinue) { 1 } else { 0 }" | tr -d '\r'; }
j() { py -3.13 -c "import json,sys;d=json.load(open(sys.argv[1],encoding='utf-8'));print($1)" "${2:-$T/son.json}" 2>&1; }
FREE=$(pwsh -NoProfile -c '[math]::Floor((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB)' | tr -d '\r')
[ "$FREE" -lt 4 ] && { echo "Boş RAM $FREE GB (< 4 GB): test başlatılmadı"; rm -rf "$T"; exit 3; }
mkdir -p "$T/claude/projects/proje" "$T/data" "$T/tmp" "$T/proje"
printf '@echo off\r\npy -3.13 "%s"\r\n' "$(cygpath -w "$PWD/tools/sahte_claude.py")" > "$T/sahte-claude.cmd"
printf '{"_test":"gece-modu-koruma quota-guard project-guard"}' > "$T/claude/settings.json"
printf '{"Notify":false,"Introduced":true}' > "$T/data/tray.json"
PORT=$(freeport); B="http://127.0.0.1:$PORT"; DATA="$T/data"; TOK=""
KAYIT_PY="$(cygpath -w "$PWD/tools/arkaplan_kayit.py")"

baslat() {
  CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CLAUDE_EXE="$TW\\sahte-claude.cmd" \
    CLAUDE_PANEL_GH_EXE="$TW\\yok.cmd" TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
  for _ in $(seq 1 60); do [ -f "$DATA/panel-$PORT.token" ] && curl -s -o /dev/null "$B/api/ping" && break; sleep 0.25; done
  TOK=$(cat "$DATA/panel-$PORT.token")
}
ver() { curl -s "$B/api/version" > "$T/ver.json" 2>/dev/null; j "$1" "$T/ver.json"; }
post() { curl -s -o "$T/son.json" -w '%{http_code}' -X POST "$B$1" -H "X-Panel-Token: $TOK" -H "Origin: $B" -H "Content-Type: application/json" ${2:+--data-binary "$2"}; }
durum() { curl -s "$B/api/state" > "$T/st.json"; j "$1" "$T/st.json"; }
bekle_durum() { for _ in $(seq 1 80); do [ "$(durum "$1")" = "$2" ] && return; sleep 0.25; done; }
yeni_pid() { local p; for _ in $(seq 1 160); do p=$(ver "d['pid']"); [ -n "$p" ] && [ "$p" != "$1" ] && case "$p" in *[!0-9]*) ;; *) echo "$p"; return;; esac; sleep 0.25; done; echo "$1"; }
retok() { for _ in $(seq 1 40); do [ -f "$DATA/panel-$PORT.token" ] && [ "$(cat "$DATA/panel-$PORT.token")" != "$1" ] && break; sleep 0.25; done; TOK=$(cat "$DATA/panel-$PORT.token"); }
kapat() {
  curl -s -o /dev/null -X POST "$B/api/quit?force=1" -H "X-Panel-Token: $TOK" -H "Origin: $B"
  for _ in $(seq 1 60); do curl -s -o /dev/null "$B/api/ping" || break; sleep 0.25; done
}
trap 'pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne \"pwsh.exe\" -and \$_.CommandLine -like \"*$TW*\" } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1' EXIT
# bg: ilk panel oturumunun background listesi → "tür:etiket:bayat" sıralı
bg() { durum "sorted(b['kind']+':'+b['label']+':'+str(b['stale']) for b in d['hosted'][0]['background'])"; }
bekle_bg() { for _ in $(seq 1 40); do [ "$(bg)" = "$1" ] && return; sleep 0.25; done; }
kayit() { py -3.13 "$KAYIT_PY" "$KAYIT" "$@"; }

baslat
PJ=$(cygpath -w "$T/proje" | sed 's/\\/\\\\/g')
check "test kopyası açıldı" "$(curl -s "$B/api/ping")" "claude-panel"
check "panel oturumu açıldı" "$(post /api/hosted "{\"cwd\":\"$PJ\",\"prompt\":\"merhaba\",\"name\":\"Deneme oturumu\"}")" 200
bekle_durum "[h['status'] for h in d['hosted']]" "['idle']"
SIDX=$(durum "d['hosted'][0]['sessionId']")
KAYIT="$T/claude/projects/proje/$SIDX.jsonl"; ALT="$T/claude/projects/proje/$SIDX/subagents"
check "oturum boşta ve oturum kimliği var" "$(durum "d['hosted'][0]['status'], len(d['hosted'][0]['sessionId'])")" "idle 36"
check "kayıt yokken (henüz yazılmadı) arka plan işi yok" "$(bg)" "[]"

# ================= 1. Alt ajan: başlangıç, bitiş =================
kayit agent aAAA1111 "Deneme ajanı"
check "alt ajan başlatıldı (bildirim yok): arka planda 1 alt ajan, bayat değil" "$(bg)" "['agent:Deneme ajanı:False']"
check "oturum nesnesinde kind/label/since/stale" "$(durum "sorted(d['hosted'][0]['background'][0].keys())")" "['kind', 'label', 'since', 'stale']"
check "oturum 'boşta' ama arka plan işi var (kart bunu gösterecek)" "$(durum "d['hosted'][0]['status']")" "idle"
kayit sync aSYNC999
check "eşzamanlı (isAsync yok) alt ajan arka plan işi sayılmaz" "$(bg)" "['agent:Deneme ajanı:False']"
kayit bitti aAAA1111 completed
check "bitiş bildirimi (completed, kullanıcı satırı): iş kalktı" "$(bg)" "[]"
kayit agent aBBB2222 "İkinci ajan"; kayit agent aCCC3333 "Üçüncü ajan"
check "iki alt ajan" "$(bg)" "['agent:Üçüncü ajan:False', 'agent:İkinci ajan:False']"
kayit bitti aBBB2222 failed kuyruk
check "bitiş: failed (kuyruk satırı) da bitirir" "$(bg)" "['agent:Üçüncü ajan:False']"
kayit bitti aCCC3333 killed
check "bitiş: killed" "$(bg)" "[]"
kayit agent aDDD4444 "Durdurulan"; kayit bitti aDDD4444 stopped
check "bitiş: stopped" "$(bg)" "[]"
kayit agent aEEE5555 "Sonra bitecek"; kayit bitti aEEE5555 running
check "bitiş olmayan durum (running) işi bitirmez" "$(bg)" "['agent:Sonra bitecek:False']"
kayit bitti aEEE5555 completed

# ================= 2. Arka plan komutu =================
kayit bash bFFF6666 "Sunucuyu izle"
check "arka plan komutu: etiket = komutun açıklaması" "$(bg)" "['bash:Sunucuyu izle:False']"
kayit bitti bFFF6666 completed kuyruk
check "komut bitti" "$(bg)" "[]"
kayit bitti bGGG7777 completed
kayit agent bGGG7777 "Bildirimi önce gelmiş"
check "bildirim başlangıçtan önce geldiyse iş açılmaz (yeniden canlanmaz)" "$(bg)" "[]"

# ================= 3. Bayat / güvence =================
kayit agent aOLD00001 "Eski ajan" 7
check "6 saatten eski, bildirim yok, kayıt yazılmıyor: bayat (bitti sayılmaz)" "$(bg)" "['agent:Eski ajan:True']"
kayit alt "$ALT" aOLD00001 0
check "alt ajan kaydı az önce yazıldı: çalışıyor, bayat değil (güvence)" "$(bg)" "['agent:Eski ajan:False']"
kayit bitti aOLD00001 completed
kayit bash bOLD00002 "Takılan komut" 7
check "6 saatten eski arka plan komutu: bayat" "$(bg)" "['bash:Takılan komut:True']"
kayit bitti bOLD00002 killed
kayit alt "$ALT" aZZZ9999 0
check "bildirimi/başlangıcı hiç görülmemiş ama az önce yazılan alt ajan kaydı: çalışıyor sayılır" "$(bg)" "['agent::False']"
kayit alt "$ALT" aZZZ9999 10
check "10 dk önce yazılmış kayıt: çalışıyor sayılmaz" "$(bg)" "[]"
kayit alt "$ALT" aSYNC999 0
check "eşzamanlı ajanın (sonucu görülmüş) kaydı güvenceyle iş sayılmaz" "$(bg)" "[]"

# ================= 4. Artımlı okuma / yarım satır =================
kayit agent aINC11111 "Artımlı"
check "artımlı: yalnız eklenen satır okundu" "$(bg)" "['agent:Artımlı:False']"
kayit yarim aINC11111
check "yarım bitiş satırı (satır sonu yok) henüz işi bitirmez" "$(bg)" "['agent:Artımlı:False']"
kayit tamamla
check "satır tamamlanınca iş biter" "$(bg)" "[]"

# ================= 5. Yeniden başlat / Kapat: oturum boşta ama arka plan işi var =================
kayit agent aRES00001 "Uzun araştırma"; kayit bash bRES00002 "Derleme izleyici"
P0=$(ver "d['pid']")
check "restart 409 (oturum boşta olsa da)" "$(post /api/restart)" 409
check "yanıt: error busy, çalışan oturum yok, background listesi (oturum adı, tür, etiket)" "$(j "d['error'], d['sessions'], sorted((b['session'], b['kind'], b['label']) for b in d['background'])")" "busy [] [('Deneme oturumu', 'agent', 'Uzun araştırma'), ('Deneme oturumu', 'bash', 'Derleme izleyici')]"
check "background satırında since ve stale var" "$(j "sorted(d['background'][0].keys())")" "['kind', 'label', 'session', 'since', 'stale']"
check "quit 409 + aynı liste" "$(post /api/quit) $(j "d['error'], len(d['background'])")" "409 busy 2"
sleep 1
check "süreç değişmedi" "$(ver "d['pid']")" "$P0"
check "restartWaiting başta yok" "$(durum "d['restartWaiting']")" "False"

# ================= 6. İşler bitince yeniden başlat =================
check "when=idle: bekletmeye alındı (200, waiting)" "$(post '/api/restart?when=idle') $(j "d['waiting']")" "200 True"
check "state: restartWaiting" "$(durum "d['restartWaiting']")" "True"
sleep 7
check "iş sürerken yeniden başlatılmadı (aynı süreç)" "$(ver "d['pid']")" "$P0"
check "iptal: 200, bekleme kalktı" "$(post /api/restart/cancel) $(durum "d['restartWaiting']")" "200 False"
check "iptal edilmiş beklemeyle de yeniden başlatılmaz" "$(sleep 6; ver "d['pid']")" "$P0"
post '/api/restart?when=idle' >/dev/null
kayit bitti aRES00001 completed
sleep 5
check "bir iş bitti, diğeri sürüyor: hâlâ yeniden başlatılmadı" "$(ver "d['pid']")" "$P0"
kayit bitti bRES00002 completed
P1=$(yeni_pid "$P0")
check "iş bitince panel kendisi yeniden başlatıldı (yeni PID, aynı port)" "$([ "$P1" != "$P0" ] && echo farklı || echo aynı)" farklı
retok "$TOK"
bekle_durum "len(d['hosted'])" 1
check "yeniden başlatma sonrası: bekleme sıfırlandı, oturum geri geldi" "$(durum "d['restartWaiting'], len(d['hosted'])")" "False 1"
check "logda bekleme (iki kez) + işler bitti (bir kez) satırları" "$(grep -c 'işler bitti\|İşler bitti' "$DATA/logs/restart.log") $(grep -c 'bekletiliyor' "$DATA/logs/restart.log")" "1 2"

# ================= 7. İş yokken when=idle hemen; force =================
bekle_durum "[h['status'] for h in d['hosted']]" "['idle']"
check "iş yokken when=idle: bekletmeden yeniden başlatır (200)" "$(post '/api/restart?when=idle')" 200
P2=$(yeni_pid "$P1")
check "yeni PID" "$([ "$P2" != "$P1" ] && echo farklı || echo aynı)" farklı
retok "$TOK"
bekle_durum "len(d['hosted'])" 1
SIDX=$(durum "d['hosted'][0]['sessionId']"); KAYIT="$T/claude/projects/proje/$SIDX.jsonl"
kayit agent aFRC00001 "Zorla"
check "yeniden başlatma sonrası da (yeni oturum kaydında) arka plan işi görülür" "$(bg)" "['agent:Zorla:False']"
check "force=1: arka plan işine rağmen yeniden başlatır (200)" "$(post '/api/restart?force=1')" 200
P3=$(yeni_pid "$P2")
check "zorla yeniden başladı" "$([ "$P3" != "$P2" ] && echo farklı || echo aynı)" farklı
retok "$TOK"
bekle_durum "len(d['hosted'])" 1
SIDX=$(durum "d['hosted'][0]['sessionId']"); KAYIT="$T/claude/projects/proje/$SIDX.jsonl"
kayit bash bQUI00001 "Kapatılırken"
check "quit?force=1 arka plan işine rağmen kapatır (200)" "$(post '/api/quit?force=1')" 200
for _ in $(seq 1 60); do curl -s -o /dev/null "$B/api/ping" || break; sleep 0.25; done
check "panel kapandı" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/ping")" "000"

# ---- temizlik ----
sleep 1
Q="\$_.Name -ne 'pwsh.exe' -and (\$_.CommandLine -like '*$TW*' -or \$_.CommandLine -like '*sahte_claude.py*')"
check "test süreci kalmadı" "$(pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { $Q }).Count" | tr -d '\r')" 0
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { $Q } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
pwsh -NoProfile -c "Remove-Item -Recurse -Force -LiteralPath '$TW' -ErrorAction SilentlyContinue"
echo "$n denetim"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail

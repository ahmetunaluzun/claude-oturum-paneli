#!/usr/bin/env bash
# Planlı işler API testi (0.16.0): kayıt doğrulaması, sonraki çalışma zamanı (her gün / hafta içi / bir kez), aç-kapat-sil,
# "şimdi çalıştır" ile oturum işi (görünür oturum, karar/bitti işareti), projede oturum varken ve kota düşükken bekleme,
# "kontrolüme bırak" (ayrı çalışma kopyası + dal: farkı gör, birleştir, çakışma, at, değişiklik yok, karar), kota ısıtma
# (pencere açıkken atlanır), panel yeniden açılınca yarım iş ve kaçırılan iş, vakti gelen işin kendiliğinden çalışması.
# Gerçek ~/.claude'a, gerçek projelere dokunmaz: geçici klasör, boş port, test kopyası --no-window, sahte claude
# (tools/sahte_claude.py; istemdeki PLAN-DOSYA / PLAN-KARAR / PLAN-CAKIS işaretlerine göre davranır), kota önbelleği elle yazılır.
# Kullanım: tools/plan_test.sh [exe]
set -u
cd "$(dirname "$0")/.."
EXE="${1:-src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe}"
T="$(mktemp -d)"; TW=$(cygpath -w "$T")
fail=0
export PYTHONUTF8=1
check() { if [ "$2" = "$3" ]; then echo "GEÇTİ  $1"; else echo "KALDI  $1 (beklenen $3, gelen $2)"; fail=1; fi; }
freeport() { pwsh -NoProfile -c '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()' | tr -d '\r'; }
G=(git -c user.name=Demo -c user.email=demo@example.invalid -c core.autocrlf=false -c commit.gpgsign=false)
mkdir -p "$T/claude" "$T/data" "$T/tmp" "$T/depo/alt" "$T/duz"
printf '@echo off\r\npy -3.13 "%s"\r\n' "$(cygpath -w "$PWD/tools/sahte_claude.py")" > "$T/sahte-claude.cmd"
( cd "$T/depo" && "${G[@]}" init -q -b main && git config core.autocrlf false && printf 'ilk\n' > ortak.txt && printf 'x\n' > alt/a.txt && "${G[@]}" add -A && "${G[@]}" commit -q -m ilk )
# Kanca işareti: panel gece korumasını --settings ile satır içi JSON olarak vermesin (.cmd onu ayrıştıramıyor).
printf '{"_test":"gece-modu-koruma quota-guard project-guard"}' > "$T/claude/settings.json"
DEPO=$(cygpath -w "$T/depo"); DUZ=$(cygpath -w "$T/duz")
PID=""
baslat() {
  PORT=$(freeport); B="http://127.0.0.1:$PORT"
  CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CLAUDE_EXE="$TW\\sahte-claude.cmd" \
    SAHTE_CLAUDE_LOG="$TW\\sahte.log" TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
  PID=$!
  for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && break; sleep 0.2; done
  TOK=$(cat "$T/data/panel-$PORT.token")
}
kapat() {
  for k in $(curl -s "$B/api/state" | grep -o '"key":"[0-9a-f]*"' | cut -d'"' -f4); do post "/api/hosted/$k/stop" "" /dev/null >/dev/null; done
  kill $PID 2>/dev/null; wait $PID 2>/dev/null; sleep 0.5
}
trap '[ -n "$PID" ] && kill $PID 2>/dev/null' EXIT
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g'; }
post() { local f="$T/govde.$BASHPID.json"; printf '%s' "$2" > "$f"; curl -s -o "${3:-$T/son.json}" -w '%{http_code}' -X POST "$B$1" -H "X-Panel-Token: $TOK" -H "Origin: $B" -H "Content-Type: application/json" --data-binary @"$f"; }
j() { py -3.13 -c "import json,sys,datetime;d=json.load(open(sys.argv[1],encoding='utf-8'));print($1)" "${2:-$T/son.json}" 2>&1; }
plans() { curl -s "$B/api/plans" > "$T/plans.json"; }
# p <id> <ifade>: o planın kaydı x'te
p() { plans; py -3.13 -c "
import json,sys,datetime,os
d=json.load(open(sys.argv[1],encoding='utf-8'));x=next((j for j in d['jobs'] if j['id']==sys.argv[2]),None);r=(x or {}).get('last') or {}
print($2)" "$T/plans.json" "$1" 2>&1; }
# bekle <id> <durum...>: son çalışma bu durumlardan birine gelene kadar (en çok 40 sn)
bekle() { local id=$1; shift; for _ in $(seq 1 80); do local s; s=$(p "$id" "r.get('state')"); for w in "$@"; do [ "$s" = "$w" ] && return 0; done; sleep 0.5; done; return 1; }
# yeni <json gövde> → id (yanıt kodu 200 değilse boş)
yeni() { [ "$(post /api/plans "$1")" = 200 ] && j "d['id']"; }
cache() { # $1 = 5 saatlik kullanım, $2 = sıfırlanmaya kalan sn (eksiyse geçmiş)
  local now; now=$(date +%s); local reset; reset=$(date -u -d "@$((now + $2))" +%Y-%m-%dT%H:%M:%SZ)
  printf '{"_cached_at":%s,"five_hour":{"utilization":%s,"resets_at":"%s"},"seven_day":{"utilization":40,"resets_at":"%s"}}' "$now" "$1" "$reset" "$reset" > "$T/claude/usage-cache.json"; }
yarin=$(date -d tomorrow +%Y-%m-%d); dun=$(date -d yesterday +%Y-%m-%d)

baslat
check "test kopyası açıldı" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/plans")" 200
check "boş liste + ayarlar" "$(curl -s "$B/api/plans" > "$T/son.json"; j "len(d['jobs']), d['graceMin'], d['warmupGraceMin'], d['awakeAheadH']")" "0 180 60 12"

# ---- kayıt doğrulaması ----
check "anahtarsız: 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/plans" -H "Content-Type: application/json" -d '{"kind":"warmup","time":"07:00","repeat":"daily"}')" 403
check "geçersiz tür" "$(post /api/plans '{"kind":"yok","time":"07:00","repeat":"daily"}') $(j "d['error']")" "400 plan"
check "geçersiz tekrar" "$(post /api/plans '{"kind":"warmup","time":"07:00","repeat":"hourly"}') $(j "d['error']")" "400 plan"
check "geçersiz saat" "$(post /api/plans '{"kind":"warmup","time":"25:00","repeat":"daily"}') $(j "d['error']")" "400 time"
check "olmayan klasör" "$(post /api/plans "{\"kind\":\"session\",\"cwd\":\"$(esc "$TW")\\\\yok\",\"prompt\":\"x\",\"time\":\"07:00\",\"repeat\":\"daily\"}") $(j "d['error']")" "400 folder"
check "boş istem" "$(post /api/plans "{\"kind\":\"session\",\"cwd\":\"$(esc "$DEPO")\",\"prompt\":\"  \",\"time\":\"07:00\",\"repeat\":\"daily\"}") $(j "d['error']")" "400 prompt"
check "geçersiz model" "$(post /api/plans "{\"kind\":\"session\",\"cwd\":\"$(esc "$DEPO")\",\"prompt\":\"x\",\"model\":\"gpt\",\"time\":\"07:00\",\"repeat\":\"daily\"}") $(j "d['error']")" "400 model"
check "kontrolüme bırak git ister" "$(post /api/plans "{\"kind\":\"review\",\"cwd\":\"$(esc "$DUZ")\",\"prompt\":\"x\",\"time\":\"07:00\",\"repeat\":\"daily\"}") $(j "d['error']")" "400 nogit"
check "bir kez: geçmiş tarih" "$(post /api/plans "{\"kind\":\"warmup\",\"time\":\"07:00\",\"repeat\":\"once\",\"date\":\"$dun\"}") $(j "d['error']")" "400 past"
check "bir kez: tarihsiz" "$(post /api/plans '{"kind":"warmup","time":"07:00","repeat":"once"}') $(j "d['error']")" "400 past"
check "hatalı kayıtlar listeye girmedi" "$(plans; j "len(d['jobs'])" "$T/plans.json")" 0

# ---- sonraki çalışma zamanı ----
GUN=$(yeni '{"kind":"warmup","time":"07:00","repeat":"daily","name":"Isıtma"}')
check "her gün: sonraki 07:00, 24 saat içinde" "$(p "$GUN" "(lambda t:(t.strftime('%H:%M'), 0 < (t-datetime.datetime.now()).total_seconds() <= 86400))(datetime.datetime.fromtimestamp(x['nextAt']/1000))")" "('07:00', True)"
check "kota ısıtma: klasör/istem yok, model haiku" "$(p "$GUN" "x['cwd'], x['prompt'], x['model'], x['name'], x['enabled']")" "None None haiku Isıtma True"
HI=$(yeni '{"kind":"warmup","time":"06:15","repeat":"weekdays"}')
check "hafta içi: Cmt/Paz değil" "$(p "$HI" "(lambda t:(t.strftime('%H:%M'), t.weekday()<5))(datetime.datetime.fromtimestamp(x['nextAt']/1000))")" "('06:15', True)"
BIR=$(yeni "{\"kind\":\"session\",\"cwd\":\"$(esc "$DEPO")\",\"prompt\":\"merhaba\",\"time\":\"09:30\",\"repeat\":\"once\",\"date\":\"$yarin\",\"lang\":\"tr\"}")
check "bir kez: tam tarih ve saat" "$(p "$BIR" "datetime.datetime.fromtimestamp(x['nextAt']/1000).strftime('%Y-%m-%d %H:%M')")" "$yarin 09:30"
check "güncelleme: aynı kimlik, yeni saat" "$(post /api/plans "{\"id\":\"$BIR\",\"kind\":\"session\",\"cwd\":\"$(esc "$DEPO")\",\"prompt\":\"merhaba\",\"time\":\"10:45\",\"repeat\":\"once\",\"date\":\"$yarin\"}") $(p "$BIR" "len(d['jobs']), datetime.datetime.fromtimestamp(x['nextAt']/1000).strftime('%H:%M')")" "200 3 10:45"
check "kapat" "$(post /api/plans/enable "{\"id\":\"$HI\",\"on\":false}") $(p "$HI" "x['enabled']")" "200 False"
check "aç: sonraki zaman yeniden hesaplandı" "$(post /api/plans/enable "{\"id\":\"$HI\",\"on\":true}") $(p "$HI" "x['enabled'], x['nextAt']>0")" "200 True True"
check "olmayan iş: 404 noplan" "$(post /api/plans/delete '{"id":"yok"}') $(j "d['error']")" "404 noplan"
check "sil" "$(post /api/plans/delete "{\"id\":\"$HI\"}") $(p "$HI" "x")" "200 None"
check "kimliksiz: 400" "$(post /api/plans/run '{}' /dev/null)" 400

# ---- oturum işi ----
OT=$(yeni "{\"kind\":\"session\",\"cwd\":\"$(esc "$DEPO")\",\"prompt\":\"durumu özetle\",\"name\":\"Sabah özeti\",\"time\":\"07:00\",\"repeat\":\"daily\"}")
check "şimdi çalıştır: oturum işi" "$(post /api/plans/run "{\"id\":\"$OT\"}")" 200
bekle "$OT" done; check "oturum işi bitti" "$(p "$OT" "r.get('state'), r.get('code'), bool(r.get('sessionKey'))")" "done None True"
check "özet = son yanıt (işaretli)" "$(p "$OT" "r['summary'].splitlines()[0]")" "[GECE-BITTI]"
check "istem planlı iş başlığı + kurallarla gitti" "$(grep '^MESAJ' "$T/sahte.log" | grep -c '\[Planlı iş: .*durumu özetle.*\[GECE-BITTI\]')" 1
check "görünür oturum açık kaldı, adı 'Planlı: Sabah özeti'" "$(curl -s "$B/api/state" | grep -c 'Planlı: Sabah özeti')" 1
check "her gün işi açık kaldı, sonraki zaman ileride" "$(p "$OT" "x['enabled'], x['nextAt'] > r['at']")" "True True"
check "projede açık oturum varken: 409 insession" "$(post /api/plans/run "{\"id\":\"$BIR\"}") $(j "d['error']")" "409 insession"
KR=$(yeni "{\"kind\":\"session\",\"cwd\":\"$(esc "$DUZ")\",\"prompt\":\"PLAN-KARAR seç\",\"time\":\"07:00\",\"repeat\":\"daily\"}")
post /api/plans/run "{\"id\":\"$KR\"}" /dev/null >/dev/null
bekle "$KR" decision; check "karar işareti: decision" "$(p "$KR" "r.get('state')")" decision
check "karar bekleyen oturum gece durumunda işaretli" "$(curl -s "$B/api/state" | py -3.13 -c "import json,sys;d=json.load(sys.stdin);print([h.get('night') for h in d['hosted'] if h['key']=='$(p "$KR" "r['sessionKey']")'])")" "['decision']"

# ---- kota ----
cache 97 3600
check "kota düşükken: 409 quota" "$(post /api/plans/run "{\"id\":\"$KR\"}") $(j "d['error']")" "409 quota"
rm -f "$T/claude/usage-cache.json"

# ---- kontrolüme bırak: birleştir ----
RV=$(yeni "{\"kind\":\"review\",\"cwd\":\"$(esc "$DEPO")\\\\alt\",\"prompt\":\"PLAN-DOSYA ekle\",\"time\":\"07:00\",\"repeat\":\"daily\"}")
post /api/plans/run "{\"id\":\"$RV\"}" /dev/null >/dev/null
bekle "$RV" review; check "kontrolünü bekliyor" "$(p "$RV" "r.get('state'), r.get('commits'), r.get('files'), r['branch'].startswith('panel/')")" "review 1 ['A\\talt/plan.txt'] True"
WT=$(p "$RV" "r['worktree']")
check "ayrı çalışma kopyası var, ana klasöre dokunulmadı" "$([ -d "$WT" ] && echo 1)$([ -f "$T/depo/alt/plan.txt" ] || echo 0)" 10
check "iş alt klasörde çalıştı" "$(grep '^ACILIS' "$T/sahte.log" | tail -1 | cut -f3 | grep -c '\\alt$')" 1
check "oturum kapatıldı" "$(p "$RV" "r.get('sessionKey')")" None
check "kontrol beklerken silinemez: 409 planbusy" "$(post /api/plans/delete "{\"id\":\"$RV\"}") $(j "d['error']")" "409 planbusy"
check "kontrol beklerken yeniden çalışmaz" "$(post /api/plans/run "{\"id\":\"$RV\"}") $(j "d['error']")" "409 planbusy"
check "fark: dosya adı ve satır" "$(post /api/plans/diff "{\"id\":\"$RV\"}") $(j "'alt/plan.txt' in d['text'] and '+planlı işin yazdığı satır' in d['text'], d['cut']")" "200 True False"
check "fark: kontrol bekleyen yok → 404" "$(post /api/plans/diff "{\"id\":\"$OT\"}") $(j "d['error']")" "404 noreview"
BR=$(p "$RV" "r['branch']")
check "birleştir" "$(post /api/plans/merge "{\"id\":\"$RV\"}") $(p "$RV" "r.get('state'), r.get('worktree')")" "200 merged None"
check "ana klasörde dosya + birleştirme commit'i" "$([ -f "$T/depo/alt/plan.txt" ] && echo 1)$(git -C "$T/depo" log -1 --format=%P | wc -w)" 12
check "çalışma kopyası silindi" "$([ -d "$WT" ] && echo var || echo yok)" yok
check "birleştirilen iş yeniden çalıştırılabilir" "$(p "$RV" "x['enabled']")" True

# ---- kontrolüme bırak: değişiklik yok / karar ----
NC=$(yeni "{\"kind\":\"review\",\"cwd\":\"$(esc "$DEPO")\",\"prompt\":\"bak yeter\",\"time\":\"07:00\",\"repeat\":\"daily\"}")
post /api/plans/run "{\"id\":\"$NC\"}" /dev/null >/dev/null
bekle "$NC" nochange failed; check "değişiklik yok: kopya silindi" "$(p "$NC" "r.get('state'), r.get('commits')") $(git -C "$T/depo" worktree list | wc -l)" "nochange 0 1"
RK=$(yeni "{\"kind\":\"review\",\"cwd\":\"$(esc "$DEPO")\",\"prompt\":\"PLAN-KARAR\",\"time\":\"07:00\",\"repeat\":\"daily\"}")
post /api/plans/run "{\"id\":\"$RK\"}" /dev/null >/dev/null
bekle "$RK" decision; check "kontrolüme bırak + karar: oturum açık kalır" "$(p "$RK" "r.get('state'), bool(r.get('sessionKey'))")" "decision True"

# ---- kontrolüme bırak: çakışma ve at ----
CK=$(yeni "{\"kind\":\"review\",\"cwd\":\"$(esc "$DEPO")\",\"prompt\":\"PLAN-CAKIS\",\"time\":\"07:00\",\"repeat\":\"daily\"}")
post /api/plans/run "{\"id\":\"$CK\"}" /dev/null >/dev/null
bekle "$CK" review; check "çakışacak dal hazır" "$(p "$CK" "r.get('state')")" review
( cd "$T/depo" && printf 'ana dal değişti\n' > ortak.txt && "${G[@]}" commit -q -am "ana" )
check "çakışma: 409 conflict" "$(post /api/plans/merge "{\"id\":\"$CK\"}") $(j "d['error']")" "409 conflict"
check "çakışmada ana klasör eski hâlinde (birleştirme geri alındı)" "$(git -C "$T/depo" status --porcelain | wc -l) $([ -f "$T/depo/.git/MERGE_HEAD" ] && echo var || echo yok) $(cat "$T/depo/ortak.txt")" "0 yok ana dal değişti"
check "çakışmadan sonra hâlâ kontrol bekliyor" "$(p "$CK" "r.get('state')")" review
CBR=$(p "$CK" "r['branch']"); CWT=$(p "$CK" "r['worktree']")
check "at" "$(post /api/plans/discard "{\"id\":\"$CK\"}") $(p "$CK" "r.get('state')")" "200 discarded"
check "atınca dal ve kopya silindi" "$(git -C "$T/depo" branch --list "$CBR" | wc -l) $([ -d "$CWT" ] && echo var || echo yok)" "0 yok"
check "atılan iş için birleştir: 404" "$(post /api/plans/merge "{\"id\":\"$CK\"}") $(j "d['error']")" "404 noreview"

# ---- kota ısıtma ----
cache 20 3600
post /api/plans/run "{\"id\":\"$GUN\"}" /dev/null >/dev/null
bekle "$GUN" skipped done failed; check "pencere açıkken atlanır" "$(p "$GUN" "r.get('state'), r.get('code')")" "skipped active"
cache 20 -60
post /api/plans/run "{\"id\":\"$GUN\"}" /dev/null >/dev/null
bekle "$GUN" done failed; check "pencere kapalıyken tek kısa istem" "$(p "$GUN" "r.get('state')")" done
rm -f "$T/claude/usage-cache.json"

# ---- panel yeniden açılınca ----
kapat
cat > "$T/ekle.py" <<'EOF'
import json, sys, time, uuid
path, duz = sys.argv[1], sys.argv[2]
d = json.load(open(path, encoding="utf-8"))
now = int(time.time() * 1000)
def job(i, **k):
    base = {"id": i, "kind": "session", "cwd": duz, "prompt": "yarım", "model": None, "time": "07:00", "repeat": "daily", "date": None,
            "lang": "tr", "enabled": True, "createdAt": now, "nextAt": now + 86_400_000, "last": None, "name": None}
    base.update(k); return base
d.append(job("yarimkaldi", last={"at": now - 60_000, "state": "running", "files": []}))
d.append(job("kacirildi", nextAt=now - 4 * 3_600_000))
d.append(job("vakti", nextAt=now - 60_000, prompt="vakti gelen iş"))
json.dump(d, open(path, "w", encoding="utf-8"), ensure_ascii=False)
EOF
py -3.13 "$TW\\ekle.py" "$TW\\data\\planned.json" "$DUZ"
: > "$T/sahte.log"
baslat
check "panel kapanırken süren iş: olmadı (restart)" "$(p yarimkaldi "r.get('state'), r.get('code')")" "failed restart"
bekle kacirildi missed; check "3 saatten çok gecikmiş iş: kaçırıldı, sonraki güne geçti" "$(p kacirildi "r.get('state'), x['nextAt'] > r['at']")" "missed True"
bekle vakti done; check "vakti gelen iş kendiliğinden çalıştı" "$(p vakti "r.get('state')") $(grep '^MESAJ' "$T/sahte.log" | grep -c 'vakti gelen iş')" "done 1"
check "kaçırılan iş çalıştırılmadı" "$(grep -c 'yarım' "$T/sahte.log")" 0
check "kayıtlar korundu" "$(p "$OT" "x['name'], x['enabled']")" "Sabah özeti True"

kapat
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.CommandLine -like '*$TW*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
sleep 1
check "test süreci kalmadı" "$(pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and (\$_.CommandLine -like '*$TW*' -or \$_.CommandLine -like '*sahte_claude.py*') }).Count" | tr -d '\r')" 0
rm -rf "$T"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail

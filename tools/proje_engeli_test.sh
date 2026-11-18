#!/usr/bin/env bash
# Aynı projede birden çok oturum engeli (0.12.0): önleme (/api/hosted 409 + mode send|later|worktree|force) ve son savunma
# (--project-guard hook, doğrudan stdin ile). Gerçek claude ÇALIŞMAZ: CLAUDE_PANEL_CLAUDE_EXE = tools/sahte_claude.py'yi
# çağıran .cmd. Test kopyası --no-window, boş portta, geçici veri klasörüyle; gerçek ~/.claude'a dokunmaz.
# Kullanım: tools/proje_engeli_test.sh [exe]
set -u
cd "$(dirname "$0")/.."
EXE="${1:-src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe}"
T="$(mktemp -d)"; TW=$(cygpath -w "$T")
fail=0
export PYTHONUTF8=1
check() { if [ "$2" = "$3" ]; then echo "GEÇTİ  $1"; else echo "KALDI  $1 (beklenen $3, gelen $2)"; fail=1; fi; }
freeport() { pwsh -NoProfile -c '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()' | tr -d '\r'; }
G=(git -c user.name=Demo -c user.email=demo@example.invalid -c init.defaultBranch=main -c core.autocrlf=false -c commit.gpgsign=false)
mkdir -p "$T/claude" "$T/data" "$T/tmp" "$T/hook" "$T/projeler/Demo Mağaza/src" "$T/projeler/Örnek API" "$T/projeler/Düz Klasör"
for d in "Demo Mağaza" "Örnek API"; do
  "${G[@]}" -C "$T/projeler/$d" init -q; echo "# $d" > "$T/projeler/$d/README.md"; echo x > "$T/projeler/$d/src.txt"
  [ -d "$T/projeler/$d/src" ] && echo y > "$T/projeler/$d/src/a.txt"
  "${G[@]}" -C "$T/projeler/$d" add -A; "${G[@]}" -C "$T/projeler/$d" commit -q -m "İlk commit"
done
printf '@echo off\r\npy -3.13 "%s"\r\n' "$(cygpath -w "$PWD/tools/sahte_claude.py")" > "$T/sahte-claude.cmd"
# Üç koruma "zaten kayıtlı" görünür: panel --settings eklemez (sahte .cmd satır içi JSON argümanını ayrıştıramaz).
printf '{"_test":"gece-modu-koruma quota-guard project-guard"}' > "$T/claude/settings.json"

PORT=$(freeport); B="http://127.0.0.1:$PORT"
CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CLAUDE_EXE="$TW\\sahte-claude.cmd" \
  SAHTE_CLAUDE_LOG="$TW\\sahte.log" TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && break; sleep 0.2; done
TOK=$(cat "$T/data/panel-$PORT.token")
WINPID=$(cat /proc/$PID/winpid)
esc() { cygpath -w "$1" | sed 's/\\/\\\\/g'; }
DEMO=$(esc "$T/projeler/Demo Mağaza"); DEMOSRC=$(esc "$T/projeler/Demo Mağaza/src"); API=$(esc "$T/projeler/Örnek API"); DUZ=$(esc "$T/projeler/Düz Klasör")
# post <yol> <gövde> → yanıt gövdesi $T/son.json, HTTP kodu stdout
post() { local f="$T/govde.$BASHPID.json"; printf '%s' "$2" > "$f"; curl -s -o "${3:-$T/son.json}" -w '%{http_code}' -X POST "$B$1" -H "X-Panel-Token: $TOK" -H "Origin: $B" -H "Content-Type: application/json" --data-binary @"$f"; }
j() { py -3.13 -c "import json,sys;d=json.load(open(sys.argv[1],encoding='utf-8'));print($1)" "${2:-$T/son.json}" 2>&1; }
state() { curl -s "$B/api/state" > "$T/state.json"; j "$1" "$T/state.json"; }
hosted() { state "len(d['hosted'])"; }
waitidle() { for _ in $(seq 1 40); do [ "$(state "[h['status'] for h in d['hosted'] if h['key']=='$1']")" = "['idle']" ] && return 0; sleep 0.3; done; return 1; }
msgs() { grep -c "^MESAJ.*$1" "$T/sahte.log" 2>/dev/null || true; }

# ---- önleme: aynı projeye farklı istekler ----
check "ilk oturum açılır (çalışır durumda kalır)" "$(post /api/hosted "{\"cwd\":\"$DEMO\",\"prompt\":\"BEKLE ilk iş\"}")" 200
K1=$(j "d['key']")
check "aynı klasöre farklı istem: 409" "$(post /api/hosted "{\"cwd\":\"$DEMO\",\"prompt\":\"ikinci iş\"}")" 409
check "409 gövdesi: çakışma, çalışan oturum listede" "$(j "d['error'], [(s['kind'], s['key'], s['status']) for s in d['sessions']]")" "conflict [('panel', '$K1', 'busy')]"
check "seçenekler: çalışan oturumda 'iş bitince', kopya, yine de aç ('mevcut oturuma gönder' yok)" "$(j "d['options']")" "['later', 'worktree', 'force']"
check "alt klasör = aynı proje: 409" "$(post /api/hosted "{\"cwd\":\"$DEMOSRC\",\"prompt\":\"alt klasör işi\"}")" 409
check "panelde hâlâ tek oturum" "$(hosted)" 1
check "kök eşlemesi /api/state.roots içinde" "$(state "len(set(v.lower() for v in d['roots'].values())), list(d['roots'].values())[0].endswith('Demo Mağaza')")" "1 True"

# ---- eşzamanlı 5 FARKLI istek aynı projeye → tek oturum ----
pids=(); for i in 1 2 3 4 5; do post /api/hosted "{\"cwd\":\"$API\",\"prompt\":\"eşzamanlı iş $i\"}" "$T/e$i.json" > "$T/e$i.kod" & pids+=($!); done; wait "${pids[@]}"
check "eşzamanlı 5 farklı istek: biri 200, dördü 409" "$(cat "$T"/e?.kod | tr -d '\n' | fold -w3 | sort | uniq -c | tr -s ' ' | tr '\n' ';')" " 1 200; 4 409;"
check "panelde iki oturum (proje başına bir)" "$(hosted)" 2
K2=$(state "[h['key'] for h in d['hosted'] if h['cwd'].endswith('API')][0]")
waitidle "$K2"; check "ikinci projenin oturumu boşta" $? 0

# ---- mode=send: boştaki oturuma mesaj ----
check "boştaki oturum varken yeni istek: 409" "$(post /api/hosted "{\"cwd\":\"$API\",\"prompt\":\"yeni istek\"}")" 409
check "seçenekler: 'mevcut oturuma gönder' var" "$(j "d['options']")" "['send', 'worktree', 'force']"
check "mode=send: 200" "$(post /api/hosted "{\"cwd\":\"$API\",\"prompt\":\"mevcut oturuma giden mesaj\",\"mode\":\"send\"}")" 200
check "mode=send: aynı oturumun anahtarı, sent" "$(j "d['key']=='$K2', d.get('sent')")" "True True"
for _ in $(seq 1 20); do [ "$(msgs 'mevcut oturuma giden mesaj')" = 1 ] && break; sleep 0.3; done
check "mesaj mevcut oturuma ulaştı (yeni süreç açılmadı)" "$(msgs 'mevcut oturuma giden mesaj') $(grep -c '^ACILIS' "$T/sahte.log")" "1 2"
check "oturum sayısı değişmedi" "$(hosted)" 2
check "mode=send, boşta oturum yokken: 409" "$(post /api/hosted "{\"cwd\":\"$DEMO\",\"prompt\":\"gönder\",\"mode\":\"send\"}")" 409

# ---- mode=later: çalışan oturumda kuyruk ----
check "mode=later: 200" "$(post /api/hosted "{\"cwd\":\"$DEMO\",\"prompt\":\"iş bitince yapılacak\",\"mode\":\"later\"}")" 200
check "mode=later: çalışan oturumun anahtarı, queued" "$(j "d['key']=='$K1', d.get('queued')")" "True True"
check "oturumda 'iş bitince' kuyruğu bekliyor, mesaj henüz gitmedi" "$(state "[h['task'] for h in d['hosted'] if h['key']=='$K1']") $(msgs 'iş bitince yapılacak')" "['continuing'] 0"
check "oturum sayısı değişmedi" "$(hosted)" 2

# ---- mode=worktree: kardeş klasörde ayrı çalışma kopyası ----
check "mode=worktree (alt klasörden): 200" "$(post /api/hosted "{\"cwd\":\"$DEMOSRC\",\"prompt\":\"BEKLE kopyada iş\",\"mode\":\"worktree\"}")" 200
KW=$(j "d['key']")
check "kopya kardeş klasörde: <ad>-kopya-1" "$(j "d['worktree'].endswith('Demo Mağaza-kopya-1')")" True
[ -f "$T/projeler/Demo Mağaza-kopya-1/src/a.txt" ] && check "kopyada dosyalar var" 1 1 || check "kopyada dosyalar var" 0 1
check "kopyanın dalı panel/kopya-…" "$("${G[@]}" -C "$T/projeler/Demo Mağaza-kopya-1" symbolic-ref --short HEAD | cut -c1-12)" "panel/kopya-"
check "oturum kopyanın aynı alt klasöründe" "$(state "[h['cwd'].endswith('Demo Mağaza-kopya-1\\\\src') for h in d['hosted'] if h['key']=='$KW']")" "[True]"
check "kopya ayrı proje sayılır (kökü farklı)" "$(state "len(set(v.lower() for v in d['roots'].values()))")" 3
check "depo olmayan klasörde kopya seçeneği yok" "$(post /api/hosted "{\"cwd\":\"$DUZ\",\"prompt\":\"düz 1\"}") $(post /api/hosted "{\"cwd\":\"$DUZ\",\"prompt\":\"düz 2\"}") $(j "'worktree' in d['options'], 'force' in d['options']")" "200 409 False True"
check "depo olmayan klasörde mode=worktree: 409" "$(post /api/hosted "{\"cwd\":\"$DUZ\",\"prompt\":\"düz 3\",\"mode\":\"worktree\"}")" 409

# ---- mode=force: bilerek ikinci oturum ----
before=$(hosted)
check "mode=force: 200" "$(post /api/hosted "{\"cwd\":\"$DEMO\",\"prompt\":\"BEKLE zorla açılan\",\"mode\":\"force\"}")" 200
KF=$(j "d['key']")
[ "$KF" != "$K1" ] && check "mode=force: yeni oturum" "$(( $(hosted) - before ))" 1 || check "mode=force: yeni oturum" 0 1
check "aynı istek yinelenirse (çift tık) 409 değil, ilk oturumun anahtarı" "$(post /api/hosted "{\"cwd\":\"$DEMO\",\"prompt\":\"BEKLE ilk iş\"}") $(j "d['key']=='$K1', d['repeated']")" "200 True True"
check "geçersiz mod yok sayılır (409)" "$(post /api/hosted "{\"cwd\":\"$DEMO\",\"prompt\":\"başka\",\"mode\":\"hepsi\"}")" 409
check "arka plan oturumu (/api/sessions) da 409, kopya seçeneği yok" "$(post /api/sessions "{\"cwd\":\"$DEMO\",\"prompt\":\"terminalde\"}") $(j "d['error'], 'worktree' in d['options']")" "409 conflict False"
check "anahtarsız istek 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/hosted" -H "Content-Type: application/json" -d '{}')" 403

# ---- panelin hook için yazdığı dosya ----
sleep 2.5
check "project-sessions.json: panel pid'i, oturumlar kökleriyle" "$(j "d['pid']==$WINPID, len(d['sessions'])>=4, all(s['root'] and s['id'] for s in d['sessions'])" "$T/data/project-sessions.json")" "True True True"
check "çalışan oturumun başlangıcı yazılı, boştakinin 0" "$(j "sorted(set(s['busySince']>0 for s in d['sessions']))" "$T/data/project-sessions.json")" "[False, True]"

# ---- son savunma: --project-guard hook, doğrudan stdin ----
R=$(esc "$T/projeler/Demo Mağaza"); OTHER=$(esc "$T/projeler/Örnek API")
now=$(date +%s)
veri() { # $1 = at, $2 = pid → $T/hook/project-sessions.json
  printf '{"at":%s,"pid":%s,"sessions":[{"id":"A","root":"%s","name":"Birinci oturum","busySince":1000},{"id":"B","root":"%s","name":"İkinci oturum","busySince":2000},{"id":"C","root":"%s","name":"Boşta","busySince":0},{"id":"X","root":"%s","name":"Başka proje","busySince":500}]}' \
    "$1" "$2" "$R" "$R" "$R" "$OTHER" > "$T/hook/project-sessions.json"
}
hook() { # $1 = oturum, $2 = araç, $3 = komut ("" = yok), $4 = cwd → çıkış kodu; stderr $T/hook/err.txt
  printf '{"session_id":"%s","tool_name":"%s","tool_input":{"command":"%s","file_path":"x"},"cwd":"%s"}' "$1" "$2" "$3" "${4:-$R}" > "$T/hook/olay.json"
  CLAUDE_PANEL_DATA="$TW\\hook" "$EXE" --project-guard < "$T/hook/olay.json" 2> "$T/hook/err.txt"; echo $?
}
veri "$now" "$WINPID"
check "hook: sonra başlayan oturumun Edit'i bekletilir (exit 2)" "$(hook B Edit "")" 2
check "hook: neden stderr'de, engelleyen oturumun adıyla" "$(grep -c 'Bu projede başka bir oturum şu an çalışıyor (Birinci oturum)' "$T/hook/err.txt")" 1
check "hook: önce başlayan oturum engellenmez (kilitlenme yok)" "$(hook A Write "")" 0
check "hook: okuma serbest (Read)" "$(hook B Read "")" 0
check "hook: git status serbest" "$(hook B Bash "git status")" 0
check "hook: git commit bekletilir" "$(hook B Bash "git commit -m x")" 2
check "hook: PowerShell'de git push bekletilir" "$(hook B PowerShell "git -C . push")" 2
check "hook: git log serbest (commit kelimesi dosya adında değil)" "$(hook B Bash "git log --oneline")" 0
check "hook: MultiEdit / NotebookEdit bekletilir" "$(hook B MultiEdit "") $(hook B NotebookEdit "")" "2 2"
check "hook: başka projedeki oturum serbest" "$(hook X Edit "" "$OTHER")" 0
check "hook: dosyada boşta görünen oturum yazarsa, çalışanlar önceliklidir" "$(hook C Edit "")" 2
check "hook: listede olmayan oturum, alt klasörden (kök = git kökü)" "$(hook YENI Edit "" "$(esc "$T/projeler/Demo Mağaza/src")")" 2
check "hook: listede olmayan oturum, başka klasörde" "$(hook YENI Edit "" "$DUZ")" 0
veri "$((now - 60))" "$WINPID"
check "hook: panel verisi eski (60 sn) → engelleme yok" "$(hook B Edit "")" 0
veri "$now" 999999
check "hook: panel süreci yok → engelleme yok" "$(hook B Edit "")" 0
printf 'bozuk{' > "$T/hook/project-sessions.json"
check "hook: bozuk veri → engelleme yok" "$(hook B Edit "")" 0
rm "$T/hook/project-sessions.json"
check "hook: veri dosyası yok → engelleme yok" "$(hook B Edit "")" 0

# ---- temizlik ----
for k in $(curl -s "$B/api/state" | grep -o '"key":"[0-9a-f]*"' | cut -d'"' -f4); do post "/api/hosted/$k/stop" "" /dev/null >/dev/null; done
check "oturumlar kapatıldı" "$(hosted)" 0
kill $PID 2>/dev/null; wait $PID 2>/dev/null
sleep 1
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.CommandLine -like '*$TW*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
check "test süreci kalmadı" "$(pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and (\$_.CommandLine -like '*$TW*' -or \$_.CommandLine -like '*sahte_claude.py*') }).Count" | tr -d '\r')" 0
rm -rf "$T"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail

#!/usr/bin/env bash
# Takip'in arka plan işleri (0.12.0): Gönder = panelin doğrudan `git push`u + gizli bilgi ön denetimi; Commit et = gizli
# oturum (kart yok). Gerçek claude ÇALIŞMAZ (tools/sahte_claude.py), gerçek uzak depoya gidilmez (uzak = geçici klasörde
# yerel bare depo). Test kopyası --no-window, boş portta; gerçek ~/.claude'a dokunmaz.
# Kullanım: tools/takip_is_test.sh [exe]
set -u
cd "$(dirname "$0")/.."
EXE="${1:-src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe}"
T="$(mktemp -d)"; TW=$(cygpath -w "$T")
fail=0
export PYTHONUTF8=1
check() { if [ "$2" = "$3" ]; then echo "GEÇTİ  $1"; else echo "KALDI  $1 (beklenen $3, gelen $2)"; fail=1; fi; }
freeport() { pwsh -NoProfile -c '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()' | tr -d '\r'; }
tools/takip_ortam.sh "$T" || { echo "ortam kurulamadı"; rm -rf "$T"; exit 1; }
G=(git -c user.name=Demo -c user.email=demo@example.invalid -c init.defaultBranch=main -c core.autocrlf=false -c commit.gpgsign=false)
P="$T/projeler"
proje() { # takip_ortam.sh ile aynı kalıp: klasör + konuşma kaydı
  local dir="$P/$1" id; mkdir -p "$dir" "$T/claude/projects/$2"
  id=$(printf '%08x-0000-4000-8000-%012x' "$RANDOM" "$RANDOM")
  printf '{"type":"user","uuid":"%s","timestamp":"2026-11-18T09:00:00Z","cwd":"%s","message":{"role":"user","content":"Demo görev"}}\n' \
    "$id" "$(cygpath -w "$dir" | sed 's/\\/\\\\/g')" > "$T/claude/projects/$2/$id.jsonl"
}
depo() { # $1 = ad, $2 = uzak ad: ilk commit'i gönderilmiş depo
  "${G[@]}" -C "$P/$1" init -q; echo "# $1" > "$P/$1/README.md"
  "${G[@]}" -C "$P/$1" add -A; "${G[@]}" -C "$P/$1" commit -q -m "İlk commit"
  "${G[@]}" init -q --bare "$T/uzak/$2.git"; "${G[@]}" -C "$P/$1" remote add origin "$T/uzak/$2.git"; "${G[@]}" -C "$P/$1" push -q -u origin main
}
# Gizli Depo: gönderilmemiş commit'lerde izin dosyası + belirteç kalıbı. Değer uydurmadır ve burada parça parça kurulur
# (bu betiğin kendisinde belirteç biçimli sabit durmasın).
SAHTE="gh""p_$(printf 'A%.0s' $(seq 1 36))"
proje "Gizli Depo" gizli-depo; depo "Gizli Depo" gizli-depo
mkdir -p "$P/Gizli Depo/.claude"; echo '{"permissions":{"allow":["Bash(curl:*)"]}}' > "$P/Gizli Depo/.claude/settings.local.json"
"${G[@]}" -C "$P/Gizli Depo" add -f .claude/settings.local.json; "${G[@]}" -C "$P/Gizli Depo" commit -q -m "Ayar"
echo "TOKEN = $SAHTE" > "$P/Gizli Depo/ayar.txt"
"${G[@]}" -C "$P/Gizli Depo" add -A; "${G[@]}" -C "$P/Gizli Depo" commit -q -m "Anahtar"
# Kirli Uzak: 1 gönderilmemiş commit + commit'lenmemiş dosya → "Commit et ve gönder"
proje "Kirli Uzak" kirli-uzak; depo "Kirli Uzak" kirli-uzak
echo a > "$P/Kirli Uzak/a.txt"; "${G[@]}" -C "$P/Kirli Uzak" add -A; "${G[@]}" -C "$P/Kirli Uzak" commit -q -m "A"
echo b > "$P/Kirli Uzak/b.txt"
# Karar Depo: sahte claude burada [PANEL-KARAR] der
proje "Karar Depo" karar-depo; depo "Karar Depo" karar-depo
echo k > "$P/Karar Depo/k.txt"; echo "/.sahte-karar" >> "$P/Karar Depo/.git/info/exclude"; touch "$P/Karar Depo/.sahte-karar"
# Oturumlu Depo: içinde açık oturum varken commit işi başlamaz
proje "Oturumlu Depo" oturumlu-depo; depo "Oturumlu Depo" oturumlu-depo; echo o > "$P/Oturumlu Depo/o.txt"

printf '@echo off\r\npy -3.13 "%s"\r\n' "$(cygpath -w "$PWD/tools/sahte_claude.py")" > "$T/sahte-claude.cmd"
printf '{"_test":"gece-modu-koruma quota-guard project-guard"}' > "$T/claude/settings.json"
PORT=$(freeport); B="http://127.0.0.1:$PORT"
CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CLAUDE_EXE="$TW\\sahte-claude.cmd" \
  SAHTE_CLAUDE_LOG="$TW\\sahte.log" SAHTE_CLAUDE_GECIKME=6 TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && break; sleep 0.2; done
TOK=$(cat "$T/data/panel-$PORT.token")
esc() { cygpath -w "$1" | sed 's/\\/\\\\/g'; }
post() { local f="$T/govde.$BASHPID.json"; printf '%s' "$2" > "$f"; curl -s -o "${3:-$T/son.json}" -w '%{http_code}' -X POST "$B$1" -H "X-Panel-Token: $TOK" -H "Origin: $B" -H "Content-Type: application/json" --data-binary @"$f"; }
j() { py -3.13 -c "import json,sys;d=json.load(open(sys.argv[1],encoding='utf-8'));print($1)" "${2:-$T/son.json}" 2>&1; }
hosted() { curl -s "$B/api/state" > "$T/state.json"; j "len(d['hosted'])" "$T/state.json"; }
starts() { grep -c '^ACILIS' "$T/sahte.log" 2>/dev/null || true; }
# it <depo adı> <ifade>: o deponun en son iş kaydı i sözlüğünde
it() { curl -s "$B/api/follow/jobs" > "$T/jobs.json"; py -3.13 -c "import json,sys;d=json.load(open(sys.argv[1],encoding='utf-8'));i=[x for job in d for x in job['items'] if x['name']==sys.argv[2]][-1];print($2)" "$T/jobs.json" "$1" 2>&1; }
bitir() { for _ in $(seq 1 80); do case "$(it "$1" "i['state']")" in done|failed|decision|skipped) return 0;; esac; sleep 0.3; done; return 1; }
for _ in $(seq 1 60); do curl -s "$B/api/followup" > "$T/fu.json"; [ "$(j "d['scanning'] or d['checkedAt']==0" "$T/fu.json")" = "False" ] && break; sleep 0.5; done
check "tarama: 7 bekleyen depo" "$(j "len(d['git']['repos'])" "$T/fu.json")" 7
S0=$(starts) # güncelleme denetimi `claude --version` için sahte betiği bir kez açar; sayım buradan başlar
check "sıradaki işlerde proje kökü var" "$(j "all(n['root'] for n in d['next'])" "$T/fu.json")" True

# ---- Gönder: doğrudan git push, claude yok ----
check "Gönder (Örnek API): 200" "$(post /api/follow/push "{\"path\":\"$(esc "$P/Örnek API")\"}")" 200
bitir "Örnek API"; check "iş bitti" $? 0
check "2 commit gönderildi" "$(it "Örnek API" "i['state'], i['code'], i['pushed']")" "done ok 2"
check "uzak depoda 3 commit" "$("${G[@]}" -C "$T/uzak/ornek-api.git" rev-list --count main)" 3
check "Gönder claude başlatmadı, oturum açılmadı" "$(( $(starts) - S0 )) $(hosted)" "0 0"

# ---- ön denetim: izin dosyası + belirteç kalıbı → push yok ----
check "Gönder (Gizli Depo): 200 (iş kuyruğa alındı)" "$(post /api/follow/push "{\"path\":\"$(esc "$P/Gizli Depo")\"}")" 200
bitir "Gizli Depo"
check "gönderim reddedildi: gizli bilgi" "$(it "Gizli Depo" "i['state'], i['code'], i['pushed']")" "failed secret 0"
check "neden: izin dosyası (dosya adıyla)" "$(it "Gizli Depo" "[(f['what'], f['file']) for f in i['findings'] if f['kind']=='file']")" "[('claudeLocal', '.claude/settings.local.json')]"
check "neden: belirteç kalıbı (kalıp adı + dosya)" "$(it "Gizli Depo" "[(f['file'], f['what']) for f in i['findings'] if f['kind']=='pattern']")" "[('ayar.txt', 'github')]"
check "uzak depoya hiçbir şey gitmedi" "$("${G[@]}" -C "$T/uzak/gizli-depo.git" rev-list --count main)" 1
check "değer yanıtta yok" "$(grep -c "$SAHTE" "$T/jobs.json")" 0
check "değer logda yok, durdurma kaydı var" "$(cat "$T"/data/logs/*.log | grep -c "$SAHTE") $(cat "$T"/data/logs/*.log | grep -c 'gönderim durduruldu')" "0 1"

# ---- uzak dalı olmayan depo: push -u ----
post /api/follow/push "{\"path\":\"$(esc "$P/Rapor Aracı")\"}" >/dev/null; bitir "Rapor Aracı"
check "uzak dalı olmayan depo gönderildi" "$(it "Rapor Aracı" "i['state'], i['code']") $("${G[@]}" -C "$P/Rapor Aracı" rev-parse --abbrev-ref '@{u}')" "done ok origin/main"

# ---- Commit et ve gönder: gizli oturum, kart yok ----
check "Commit et ve gönder (Kirli Uzak): 200" "$(post /api/follow/commit "{\"path\":\"$(esc "$P/Kirli Uzak")\",\"push\":true}")" 200
for _ in $(seq 1 40); do [ "$(it "Kirli Uzak" "i['state']")" = committing ] && [ "$(( $(starts) - S0 ))" = 1 ] && break; sleep 0.2; done
check "iş sürüyor: 'committing'" "$(it "Kirli Uzak" "i['state']")" committing
check "gizli iş oturum listesinde yok (kart çizilmez)" "$(hosted)" 0
check "gizli iş hook verisinde var (aynı projede ikinci oturum sayılır)" "$(sleep 2.2; j "len(d['sessions'])" "$T/data/project-sessions.json")" 1
check "iş sürerken o projede oturum açılamaz: 409" "$(post /api/hosted "{\"cwd\":\"$(esc "$P/Kirli Uzak")\",\"prompt\":\"araya giren\"}") $(j "[s['kind'] for s in d['sessions']], d['options']")" "409 ['job'] ['worktree', 'force']"
check "aynı depoya ikinci iş alınmaz: 409" "$(post /api/follow/push "{\"path\":\"$(esc "$P/Kirli Uzak")\"}") $(j "d['error']")" "409 jobactive"
bitir "Kirli Uzak"; check "iş bitti" $? 0
check "1 commit yapıldı, 2 commit gönderildi" "$(it "Kirli Uzak" "i['state'], i['code'], i['committed'], i['pushed']")" "done ok 1 2"
check "özet satırda, işaret satırı atılmış" "$(it "Kirli Uzak" "i['summary']")" "Değişiklikler commit edildi."
check "çalışma ağacı temiz, uzakta 3 commit" "$("${G[@]}" -C "$P/Kirli Uzak" status --porcelain | wc -l | tr -d ' ') $("${G[@]}" -C "$T/uzak/kirli-uzak.git" rev-list --count main)" "0 3"
check "gizli oturum kendiliğinden kapandı" "$(hosted)" 0
check "oturum diske yazılmadı (açılışta geri gelmez)" "$(cat "$T/data/hosted.json" 2>/dev/null | tr -d '[] \r\n' | wc -c | tr -d ' ')" 0

# ---- uzak deposu olmayan depoda Commit et ----
post /api/follow/commit "{\"path\":\"$(esc "$P/Demo Mağaza")\"}" >/dev/null; bitir "Demo Mağaza"
check "Commit et (uzak depo yok): commit yapıldı, gönderim yok" "$(it "Demo Mağaza" "i['state'], i['code'], i['committed'], i['pushed']")" "done ok 1 0"

# ---- karar gerekirse: oturum görünür olur ----
post /api/follow/commit "{\"path\":\"$(esc "$P/Karar Depo")\",\"push\":true}" >/dev/null; bitir "Karar Depo"
check "karar gerekiyor: iş durdu, gönderim yok" "$(it "Karar Depo" "i['state'], i['code'], i['pushed'], bool(i['sessionKey'])")" "decision decision 0 True"
KK=$(it "Karar Depo" "i['sessionKey']")
check "oturum artık görünür (Konuşmayı aç)" "$(hosted) $(j "d['hosted'][0]['key']=='$KK'" "$T/state.json")" "1 True"
check "karar deposunda commit yapılmadı" "$("${G[@]}" -C "$P/Karar Depo" status --porcelain | wc -l | tr -d ' ')" 1
post "/api/hosted/$KK/stop" "" /dev/null >/dev/null

# ---- açık oturumu olan projede commit işi başlamaz ----
check "Oturumlu Depo'da oturum aç" "$(post /api/hosted "{\"cwd\":\"$(esc "$P/Oturumlu Depo")\",\"prompt\":\"merhaba\"}")" 200
KO=$(j "d['key']")
before=$(starts)
post /api/follow/commit "{\"path\":\"$(esc "$P/Oturumlu Depo")\"}" >/dev/null; bitir "Oturumlu Depo"
check "açık oturum varken commit işi atlanır, ikinci süreç açılmaz" "$(it "Oturumlu Depo" "i['state'], i['code']") $(( $(starts) - before ))" "skipped insession 0"
post "/api/hosted/$KO/stop" "" /dev/null >/dev/null

# ---- Tümünü commit et ve gönder: tek iş, depo başına sonuç ----
curl -s -o /dev/null -X POST "$B/api/followup/refresh" -H "X-Panel-Token: $TOK" -H "Origin: $B"
for _ in $(seq 1 60); do sleep 0.5; curl -s "$B/api/followup" > "$T/fu.json"; [ "$(j "d['scanning']" "$T/fu.json")" = "False" ] && break; done
check "yeniden tarama: kalan depolar" "$(j "sorted(r['name'] for r in d['git']['repos'])" "$T/fu.json")" "['Gizli Depo', 'Karar Depo', 'Oturumlu Depo']"
rm "$P/Karar Depo/.sahte-karar"
check "Tümü: 200, tek iş 3 depo" "$(post /api/follow/all "{\"paths\":[\"$(esc "$P/Gizli Depo")\",\"$(esc "$P/Karar Depo")\",\"$(esc "$P/Oturumlu Depo")\"]}") $(j "len(d['items'])")" "200 3"
JOB=$(j "d['id']")
bitir "Oturumlu Depo"; bitir "Karar Depo"; bitir "Gizli Depo"
check "tek iş kimliği altında depo başına sonuç" "$(py -3.13 -c "import json,sys;d=json.load(open(sys.argv[1],encoding='utf-8'));print([(i['name'], i['state'], i['code']) for job in d if job['id']=='$JOB' for i in job['items']])" "$T/jobs.json")" "[('Gizli Depo', 'failed', 'secret'), ('Karar Depo', 'done', 'ok'), ('Oturumlu Depo', 'done', 'ok')]"
check "sorunlu depo atlandı, ötekiler gönderildi" "$("${G[@]}" -C "$T/uzak/gizli-depo.git" rev-list --count main) $("${G[@]}" -C "$T/uzak/karar-depo.git" rev-list --count main) $("${G[@]}" -C "$T/uzak/oturumlu-depo.git" rev-list --count main)" "1 2 2"

# ---- yetki ve doğrulama ----
check "bilinmeyen klasör: 404" "$(post /api/follow/push "{\"path\":\"C:\\\\Windows\"}") $(j "d['error']")" "404 norepo"
check "anahtarsız: 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/follow/push" -H "Content-Type: application/json" -d '{}')" 403
check "yabancı köken: 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/follow/all" -H "X-Panel-Token: $TOK" -H "Origin: https://evil.example" -H "Content-Type: application/json" -d '{"paths":["x"]}')" 403
check "boş liste: 400" "$(post /api/follow/all '{"paths":[]}' /dev/null)" 400

# ---- temizlik ----
for k in $(curl -s "$B/api/state" | grep -o '"key":"[0-9a-f]*"' | cut -d'"' -f4); do post "/api/hosted/$k/stop" "" /dev/null >/dev/null; done
check "oturum kalmadı" "$(hosted)" 0
kill $PID 2>/dev/null; wait $PID 2>/dev/null
sleep 1
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.CommandLine -like '*$TW*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
check "test süreci kalmadı" "$(pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and (\$_.CommandLine -like '*$TW*' -or \$_.CommandLine -like '*sahte_claude.py*') }).Count" | tr -d '\r')" 0
rm -rf "$T"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail

#!/usr/bin/env bash
# Gizli bilgi engelinin çıkış yolu (0.18.0): bulguda parmak izi + maskeli ipucu + satır, POST /api/follow/push-allow,
# push-allow.json, telefondan izin, yeniden başlatma sonrası izin. Gerçek git; uzak = geçici klasörde yerel bare depo
# (gerçek uzağa gidilmez). Test kopyası --no-window, boş portta, kendi CLAUDE_PANEL_DATA'sı; gerçek ~/.claude'a dokunmaz.
# Kullanım: tools/gizli_izin_test.sh [exe]
set -u
cd "$(dirname "$0")/.."
EXE="${1:-src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe}"
T="$(mktemp -d)"; TW=$(cygpath -w "$T")
fail=0
export PYTHONUTF8=1
check() { if [ "$2" = "$3" ]; then echo "GEÇTİ  $1"; else echo "KALDI  $1 (beklenen $3, gelen $2)"; fail=1; fi; }
freeport() { pwsh -NoProfile -c '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()' | tr -d '\r'; }
tools/gizli_ortam.sh "$T" || { echo "ortam kurulamadı"; rm -rf "$T"; exit 1; }
G=(git -c user.name=Demo -c user.email=demo@example.invalid -c core.autocrlf=false -c commit.gpgsign=false)
P="$T/projeler"; DATA="$T/data"; RH=test.ts.net
PAROLA="p@ss""1234test"; ANAHTAR="zz99""88776655aa"; YENI="yeni""-anahtar-42x"
printf '@echo off\r\npy -3.13 "%s"\r\n' "$(cygpath -w "$PWD/tools/sahte_claude.py")" > "$T/sahte-claude.cmd"
printf '{"_test":"gece-modu-koruma quota-guard project-guard"}' > "$T/claude/settings.json"

PID=""; PORT=""; B=""; TOK=""
baslat() {
  PORT=$(freeport); B="http://127.0.0.1:$PORT"
  CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CLAUDE_EXE="$TW\\sahte-claude.cmd" \
    CLAUDE_PANEL_GH_EXE="$TW\\yok.cmd" CLAUDE_PANEL_REMOTE_HOST=$RH TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
  PID=$!
  for _ in $(seq 1 50); do [ -f "$DATA/panel-$PORT.token" ] && break; sleep 0.2; done
  TOK=$(cat "$DATA/panel-$PORT.token")
  for _ in $(seq 1 60); do curl -s "$B/api/followup" > "$T/fu.json"; [ "$(j "d['scanning'] or d['checkedAt']==0" "$T/fu.json")" = "False" ] && break; sleep 0.5; done
}
kapat() {
  curl -s -o /dev/null -X POST "$B/api/quit?force=1" -H "X-Panel-Token: $TOK" -H "Origin: $B"
  for _ in $(seq 1 40); do curl -s -o /dev/null "$B/api/ping" || break; sleep 0.25; done
  kill $PID 2>/dev/null; wait $PID 2>/dev/null; PID=""
}
trap '[ -n "$PID" ] && kill $PID 2>/dev/null' EXIT
esc() { cygpath -w "$1" | sed 's/\\/\\\\/g'; }
post() { local f="$T/govde.$BASHPID.json"; printf '%s' "$2" > "$f"; curl -s -o "${3:-$T/son.json}" -w '%{http_code}' -X POST "$B$1" -H "X-Panel-Token: $TOK" -H "Origin: $B" -H "Content-Type: application/json" --data-binary @"$f"; }
j() { py -3.13 -c "import json,sys;d=json.load(open(sys.argv[1],encoding='utf-8'));print($1)" "${2:-$T/son.json}" 2>&1; }
it() { curl -s "$B/api/follow/jobs" > "$T/jobs.json"; py -3.13 -c "import json,sys;d=json.load(open(sys.argv[1],encoding='utf-8'));i=[x for job in d for x in job['items'] if x['name']==sys.argv[2]][-1];print($2)" "$T/jobs.json" "$1" 2>&1; }
bitir() { for _ in $(seq 1 80); do case "$(it "$1" "i['state']")" in done|failed|decision|skipped) return 0;; esac; sleep 0.3; done; return 1; }
gonder() { post /api/follow/push "{\"path\":\"$(esc "$P/$1")\"}" >/dev/null; sleep 0.3; bitir "$1"; }
izin() { post /api/follow/push-allow "{\"path\":\"$(esc "$P/$1")\",\"fps\":$2}" "${3:-$T/son.json}"; }
fps() { it "$1" "json.dumps([f['fp'] for f in i['findings']])"; }
yenile() { post /api/followup/refresh '{}' /dev/null >/dev/null; sleep 0.5
  for _ in $(seq 1 60); do curl -s "$B/api/followup" > "$T/fu.json"; [ "$(j "d['scanning']" "$T/fu.json")" = "False" ] && break; sleep 0.5; done; }
uzak() { "${G[@]}" -C "$T/uzak/$1.git" rev-list --count main; }
degerler() { cat "$T/jobs.json" "$DATA"/logs/*.log "$DATA/push-allow.json" 2>/dev/null | grep -c -e "$PAROLA" -e "$ANAHTAR" -e "$YENI"; }

baslat
check "tarama: 3 bekleyen depo" "$(j "sorted(r['name'] for r in d['git']['repos'])" "$T/fu.json")" "['Env Depo', 'Telefon Depo', 'Test Kimlik']"

# ---- (a) kalıp bulgusu: gönderim durur; bulguda fp, ipucu, satır var; değer yok ----
gonder "Test Kimlik"
check "(a) gönderim durdu: secret" "$(it "Test Kimlik" "i['state'], i['code'], i['pushed']")" "failed secret 0"
check "(a) iki ayrı bulgu (eşleşme başına), dosya:satır + kural + ipucu" \
  "$(it "Test Kimlik" "[(f['kind'], f['file'], f['line'], f['what'], f['hint']) for f in i['findings']]")" \
  "[('pattern', 'test/kimlik.test.ts', 2, 'assign', 'pass***'), ('pattern', 'test/kimlik.test.ts', 3, 'assign', 'api_***')]"
check "(a) parmak izi 20 hane onaltılık, bulgular farklı" "$(it "Test Kimlik" "[len(f['fp']) == 20 and all(c in '0123456789abcdef' for c in f['fp']) for f in i['findings']], len({f['fp'] for f in i['findings']})")" "[True, True] 2"
check "(a) değer yanıtta ve logda yok" "$(degerler)" 0
check "(a) uzak depoya bir şey gitmedi" "$(uzak test-kimlik)" 1

# ---- (b) yanlış/eksik parmak izi: 409, izin dosyası yazılmaz ----
FA=$(fps "Test Kimlik"); F1=$(it "Test Kimlik" "json.dumps([i['findings'][0]['fp']])")
check "(b) uydurma parmak izi: 409 secretchanged" "$(izin "Test Kimlik" '["00000000000000000000"]') $(j "d['error']")" "409 secretchanged"
check "(b) bulguların yalnız biri: 409 (kullanıcı tüm bulguları görüp onaylar)" "$(izin "Test Kimlik" "$F1") $(j "d['error']")" "409 secretchanged"
check "(b) boş liste: 400" "$(izin "Test Kimlik" '[]' /dev/null)" 400
check "(b) bilinmeyen depo: 404" "$(post /api/follow/push-allow '{"path":"C:\\Windows","fps":["x"]}') $(j "d['error']")" "404 norepo"
check "(b) anahtarsız: 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/follow/push-allow" -H "Content-Type: application/json" -d '{}')" 403
check "(b) izin dosyası oluşmadı" "$([ -e "$DATA/push-allow.json" ] && echo var || echo yok)" yok
check "(b) uzak depoya bir şey gitmedi" "$(uzak test-kimlik)" 1

# ---- (c) doğru parmak izleri: izin yazılır, gönderilir ----
check "(c) doğru parmak izleri: 200, iş kuyrukta" "$(izin "Test Kimlik" "$FA")" 200
sleep 0.3; bitir "Test Kimlik"
check "(c) gönderildi" "$(it "Test Kimlik" "i['state'], i['code'], i['pushed']")" "done ok 1"
check "(c) uzakta commit var" "$(uzak test-kimlik)" 2
check "(c) izin dosyasında iki kayıt (fp, dosya, kural; değer yok)" "$(j "[(e['Fp'] in $FA, e['File'], e['What']) for e in d]" "$DATA/push-allow.json")" \
  "[(True, 'test/kimlik.test.ts', 'assign'), (True, 'test/kimlik.test.ts', 'assign')]"
check "(c) izin logda (sayı + dosya adı), değer hiçbir yerde yok" "$(cat "$DATA"/logs/*.log | grep -c 'test verisi olarak izinlendi: test/kimlik.test.ts') $(degerler)" "1 0"

# ---- (d) yeni, farklı bulgu: yine durur; izinli olanlar listede yok ----
printf 'const ikinci = { access_token: "%s", password: "%s" };\n' "$YENI" "$PAROLA" > "$P/Test Kimlik/test/ikinci.test.ts"
"${G[@]}" -C "$P/Test Kimlik" add -A; "${G[@]}" -C "$P/Test Kimlik" commit -q -m "İkinci test"
yenile # depo gönderildikten sonra listeden düşmüştü; yeni commit taramayla geri gelir
gonder "Test Kimlik"
check "(d) yeni bulgu: yine durdu" "$(it "Test Kimlik" "i['state'], i['code']") $(uzak test-kimlik)" "failed secret 2"
check "(d) başka dosyadaki aynı parola ayrı bulgu (parmak izi dosyaya bağlı)" "$(it "Test Kimlik" "sorted((f['file'], f['line'], f['hint']) for f in i['findings'])")" \
  "[('test/ikinci.test.ts', 1, 'acce***'), ('test/ikinci.test.ts', 1, 'pass***')]"
check "(d) değer yine yok" "$(degerler)" 0

# ---- (e) .env dosyası: izin verilmez; dosya değişmez ----
gonder "Env Depo"
check "(e) .env + kalıp: durdu, dosya bulgusu var" "$(it "Env Depo" "i['code'], sorted(f['kind'] + ':' + f['what'] for f in i['findings'])")" "secret ['file:env', 'pattern:assign']"
cp "$DATA/push-allow.json" "$T/izin-once.json"
check "(e) dosya bulgusu varken izin: 409 secretfile" "$(izin "Env Depo" "$(fps "Env Depo")") $(j "d['error']")" "409 secretfile"
check "(e) izin dosyası değişmedi, uzağa gitmedi" "$(cmp -s "$T/izin-once.json" "$DATA/push-allow.json" && echo ayni) $(uzak env-depo)" "ayni 1"

# ---- (f) telefondan (uzak erişim çereziyle) izin ----
check "(f) uzak erişimi aç" "$(post /api/remote/enable '{"enabled":true}' /dev/null)" 200
PC=$(curl -s -X POST "$B/api/remote/pair" -H "X-Panel-Token: $TOK" -H "Origin: $B" -H "Content-Type: application/json" | grep -o '"code":"[0-9]*' | cut -d'"' -f4)
curl -s -D "$T/hdr" -o /dev/null -X POST "$B/api/remote/claim" -H "Host: $RH" -H "Origin: https://$RH" -H "Content-Type: application/json" -d "{\"code\":\"$PC\",\"name\":\"Test\"}"
CK=$(grep -i "^set-cookie: cp_dev" "$T/hdr" | tr -d '\r' | sed -E 's/^[^:]*: (cp_dev=[^;]*).*/\1/')
RT=$(curl -s -H "Host: $RH" -b "$CK" "$B/" | grep -o 'panel-token" content="[^"]*' | cut -d'"' -f3)
rpost() { printf '%s' "$2" > "$T/rgovde.json"; curl -s -o "$T/son.json" -w '%{http_code}' -X POST "$B$1" -H "Host: $RH" -H "Origin: https://$RH" -H "X-Panel-Token: $RT" -b "$CK" -H "Content-Type: application/json" --data-binary @"$T/rgovde.json"; }
check "(f) telefondan Gönder: durdu" "$(rpost /api/follow/push "{\"path\":\"$(esc "$P/Telefon Depo")\"}")" 200
sleep 0.3; bitir "Telefon Depo"; check "(f) bulgu: tek kalıp" "$(it "Telefon Depo" "i['code'], [(f['file'], f['line'], f['hint']) for f in i['findings']]")" "secret [('ornek.py', 1, 'auth***')]"
check "(f) telefondan izin çerezsiz: 401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/follow/push-allow" -H "Host: $RH" -H "Origin: https://$RH" -H "Content-Type: application/json" -d '{}')" 401
check "(f) telefondan izin: 200" "$(rpost /api/follow/push-allow "{\"path\":\"$(esc "$P/Telefon Depo")\",\"fps\":$(fps "Telefon Depo")}")" 200
sleep 0.3; bitir "Telefon Depo"
check "(f) telefondan gönderildi" "$(it "Telefon Depo" "i['state'], i['code'], i['pushed']") $(uzak telefon-depo)" "done ok 1 2"

# ---- (g) yeniden başlatma: izin kalır; aynı satır aynı dosyaya yeniden eklenirse izinli ----
kapat; baslat
check "(g) yeniden başlatma sonrası izin dosyası: 3 kayıt" "$(j "len(d)" "$DATA/push-allow.json")" 3
"${G[@]}" -C "$P/Test Kimlik" reset -q --hard HEAD~1 # (d)'deki yeni bulgulu commit atılır
printf '// yeniden\n  password: "%s",\n' "$PAROLA" >> "$P/Test Kimlik/test/kimlik.test.ts"
"${G[@]}" -C "$P/Test Kimlik" add -A; "${G[@]}" -C "$P/Test Kimlik" commit -q -m "Aynı test kimliği yeniden"
gonder "Test Kimlik"
check "(g) izinli bulgu atlandı, gönderildi" "$(it "Test Kimlik" "i['state'], i['code'], i['pushed']") $(uzak test-kimlik)" "done ok 1 3"
check "(g) logda 'izinli bulgu atlandı', değer yok" "$(cat "$DATA"/logs/*.log | grep -c "1 izinli (test verisi) bulgu atlandı.*Test Kimlik") $(degerler)" "1 0"

# ---- temizlik ----
kapat
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.CommandLine -like '*$TW*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
sleep 1
check "test süreci kalmadı" "$(pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and (\$_.CommandLine -like '*$TW*' -or \$_.CommandLine -like '*sahte_claude.py*') }).Count" | tr -d '\r')" 0
rm -rf "$T"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail

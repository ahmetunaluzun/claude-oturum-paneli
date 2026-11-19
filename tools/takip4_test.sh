#!/usr/bin/env bash
# Takip 4. aşama API testi (0.14.0, Zamanlanmış işler): zamanlayıcı görevleri (proje eşleşmesi, süzme, devre dışı bırakma;
# telefondan kapalı), Claude görev dosyaları (yalnız varlık + tarih), masaüstü görevleri, TAKİP sözleri, açık oturumlardaki
# CronCreate / ScheduleWakeup / /loop tespiti (token, ardışık boş tur), Durdur mesajı, kota uyarısı, macOS plist okuyucusu.
# Gerçek ~/.claude'a, gerçek projelere ve kullanıcının zamanlayıcı görevlerine dokunmaz:
#   1. aşama: sahte zamanlayıcı (CLAUDE_PANEL_TASKS_FILE), sahte claude (tools/sahte_claude.py)
#   2. aşama: plist klasörü (CLAUDE_PANEL_LAUNCHAGENTS_DIR)
#   3. aşama: gerçek Görev Zamanlayıcı, yalnız testin KENDİ oluşturduğu geçici görev devre dışı bırakılır ve sonunda silinir
# Test kopyası --no-window ve boş portta. Kullanım: tools/takip4_test.sh [exe]
set -u
cd "$(dirname "$0")/.."
EXE="${1:-src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe}"
T="$(mktemp -d)"; TW=$(cygpath -w "$T")
fail=0
export PYTHONUTF8=1
TASK="ClaudePanelTest-$RANDOM$RANDOM"
check() { if [ "$2" = "$3" ]; then echo "GEÇTİ  $1"; else echo "KALDI  $1 (beklenen $3, gelen $2)"; fail=1; fi; }
freeport() { pwsh -NoProfile -c '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()' | tr -d '\r'; }
tools/takip_ortam.sh "$T" || { echo "ortam kurulamadı"; rm -rf "$T"; exit 1; }
py -3.13 tools/takip4_ortam.py "$TW" || { echo "zamanlanmış iş ortamı kurulamadı"; rm -rf "$T"; exit 1; }
P="$T/projeler"
printf '@echo off\r\npy -3.13 "%s"\r\n' "$(cygpath -w "$PWD/tools/sahte_claude.py")" > "$T/sahte-claude.cmd"
printf '{"_test":"gece-modu-koruma quota-guard project-guard"}' > "$T/claude/settings.json"
RH=test.ts.net
PID=""
# baslat <ek ortam değişkeni>... : test kopyasını yeni boş portta açar
baslat() {
  PORT=$(freeport); B="http://127.0.0.1:$PORT"
  env "$@" CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CLAUDE_EXE="$TW\\sahte-claude.cmd" \
    CLAUDE_PANEL_REMOTE_HOST=$RH SAHTE_CLAUDE_LOG="$TW\\sahte.log" SAHTE_CLAUDE_KAYIT="$TW\\claude\\projects\\sahte-oturum" TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
  PID=$!
  for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && break; sleep 0.2; done
  TOK=$(cat "$T/data/panel-$PORT.token")
}
kapat() {
  for k in $(curl -s "$B/api/state" | grep -o '"key":"[0-9a-f]*"' | cut -d'"' -f4); do post "/api/hosted/$k/stop" "" /dev/null >/dev/null; done
  kill $PID 2>/dev/null; wait $PID 2>/dev/null; sleep 0.5
}
temizle() {
  pwsh -NoProfile -c "Unregister-ScheduledTask -TaskName '$TASK' -Confirm:\$false -ErrorAction SilentlyContinue" >/dev/null 2>&1
  [ -n "$PID" ] && kill $PID 2>/dev/null
}
trap temizle EXIT
esc() { cygpath -w "$1" | sed 's/\\/\\\\/g'; }
post() { local f="$T/govde.$BASHPID.json"; printf '%s' "$2" > "$f"; curl -s -o "${3:-$T/son.json}" -w '%{http_code}' -X POST "$B$1" -H "X-Panel-Token: $TOK" -H "Origin: $B" -H "Content-Type: application/json" --data-binary @"$f"; }
j() { py -3.13 -c "import json,sys;d=json.load(open(sys.argv[1],encoding='utf-8'));print($1)" "${2:-$T/son.json}" 2>&1; }
# q <ifade>: son /api/followup yanıtı d'de; S = sched, G = görev adı → görev, L = döngüler (türe, sonra zamanlamaya göre)
q() { py -3.13 -c "
import json,sys,os,datetime
d=json.load(open(sys.argv[1],encoding='utf-8'));S=d['sched'];G={t['name']:t for t in S['os']['tasks']}
L=sorted(d['loops'],key=lambda x:(x['type'],x['schedule'] or ''))
ad=lambda p: os.path.basename(p) if p else None
gun=lambda ms: (datetime.date.fromtimestamp(ms/1000)-datetime.date.today()).days if ms is not None else None
print($1)" "$T/fu.json" 2>&1; }
snap() { for _ in $(seq 1 60); do curl -s "$B/api/followup" > "$T/fu.json"; [ "$(j "d['scanning'] or d['checkedAt']==0" "$T/fu.json")" = "False" ] && return 0; sleep 0.5; done; return 1; }
refresh() { local before; before=$(j "d['checkedAt']" "$T/fu.json"); curl -s -o /dev/null -X POST "$B/api/followup/refresh" -H "X-Panel-Token: $TOK" -H "Origin: $B"
  for _ in $(seq 1 60); do snap; [ "$(j "d['checkedAt']" "$T/fu.json")" != "$before" ] && return 0; sleep 0.3; done; return 1; }

# ================= 1. aşama: sahte zamanlayıcı =================
baslat CLAUDE_PANEL_TASKS_FILE="$TW\\gorevler.json"
snap; check "tarama bitti" $? 0

# ---- zamanlayıcı görevleri ----
check "kaynak: test; okundu" "$(q "S['os']['kind'], S['os']['state']")" "test ok"
check "ilgili 5 görev listede; sistem görevi ve ilgisiz program yok" "$(q "sorted(G)")" "['Demo Yedek', 'Kanca Temizliği', 'Kapalı Görev', 'Rapor Gönder', 'Yetkisiz Görev']"
check "proje eşleşmesi: betik yolundan, cmd argümanından, çalışma klasöründen; ~/.claude betiği projesiz" \
  "$(q "[G[n]['project'] for n in sorted(G)]")" "['Demo Mağaza', None, 'Stok Sayım', 'Rapor Aracı', 'Örnek API']"
check "proje kökü tam yol" "$(q "all(G[n]['root'] is None or os.path.isdir(G[n]['root']) for n in G)")" True
check "klasörde göster hedefi: betik dosyası" "$(q "[ad(G[n]['reveal']) for n in sorted(G)]")" "['yedek.py', 'temizlik.ps1', 'kontrol.py', 'gonder.cmd', 'saglik.py']"
check "son sonuç kodu olduğu gibi" "$(q "[G[n]['lastResult'] for n in sorted(G)]")" "[0, 267009, 267011, 1, 2147942402]"
check "devre dışı görev: açık değil, sonraki çalışma yok" "$(q "G['Kapalı Görev']['enabled'], G['Kapalı Görev']['nextRun'], G['Kapalı Görev']['lastRun']")" "False None None"
check "sonraki / son çalışma zamanı" "$(q "G['Demo Yedek']['nextRun'] > d['checkedAt'] > G['Demo Yedek']['lastRun']")" True
check "komut satırı kısa: program adı + argüman" "$(q "G['Demo Yedek']['command'].startswith('python.exe ') and G['Demo Yedek']['command'].endswith('--tam')")" True

# ---- devre dışı bırak ----
check "anahtarsız: 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/schedule/disable" -H "Content-Type: application/json" -d '{"id":"\\Demo Yedek"}')" 403
check "kimliksiz: 400" "$(post /api/schedule/disable '{}' /dev/null)" 400
check "listede olmayan görev: 404" "$(post /api/schedule/disable '{"id":"\\Yok"}') $(j "d['error']")" "404 notask"
check "Takip'in süzdüğü (ilgisiz) görev kapatılamaz: 404" "$(post /api/schedule/disable '{"id":"\\Disk Bakımı"}') $(j "d['error']")" "404 notask"
check "sistem görevi kapatılamaz: 404" "$(post /api/schedule/disable '{"id":"\\Microsoft\\Windows\\Bakım\\Sistem Betiği"}') $(j "d['error']")" "404 notask"
check "kaynak izin vermiyorsa: 400" "$(post /api/schedule/disable '{"id":"\\Yetkisiz Görev"}') $(j "d['error']")" "400 taskunsupported"
check "dosya henüz değişmedi (reddedilen istekler yazmadı)" "$(j "[t['enabled'] for t in d]" "$T/gorevler.json")" "[True, True, True, True, True, False, True]"
check "devre dışı bırak: 200" "$(post /api/schedule/disable '{"id":"\\Demo Yedek"}') $(j "d['ok']")" "200 True"
check "yalnız o görev kapandı" "$(j "[t['name'] for t in d if not t['enabled']]" "$T/gorevler.json")" "['Demo Yedek', 'Kapalı Görev']"
for _ in $(seq 1 40); do snap; [ "$(q "G['Demo Yedek']['enabled']")" = False ] && break; sleep 0.3; done
check "yeniden tarandı: görev listede devre dışı" "$(q "G['Demo Yedek']['enabled'], G['Demo Yedek']['nextRun'], G['Rapor Gönder']['enabled']")" "False None True"

# ---- telefondan: liste açık, devre dışı bırakma ve klasörde göster kapalı ----
L=(-H "X-Panel-Token: $TOK" -H "Content-Type: application/json")
curl -s -o /dev/null -X POST "${L[@]}" -d '{"enabled":true}' "$B/api/remote/enable"
PC=$(curl -s -X POST "${L[@]}" "$B/api/remote/pair" | grep -o '"code":"[0-9]*' | cut -d'"' -f4)
HDR="$T/hdr.txt"
curl -s -o /dev/null -D "$HDR" -X POST -H "Host: $RH" -H "Origin: https://$RH" -H 'Content-Type: application/json' -d "{\"code\":\"$PC\",\"name\":\"Test\"}" "$B/api/remote/claim"
CK=$(grep -i "^set-cookie: cp_dev" "$HDR" | tr -d '\r' | sed -E 's/^[^:]*: (cp_dev=[^;]*).*/\1/')
RTOK=$(curl -s -H "Host: $RH" -b "$CK" "$B/" | grep -o 'panel-token" content="[^"]*' | cut -d'"' -f3)
R=(-H "Host: $RH" -H "Origin: https://$RH" -b "$CK" -H "X-Panel-Token: $RTOK" -H "Content-Type: application/json")
check "telefon eşleşti, sayfa REMOTE=1" "$(curl -s -H "Host: $RH" -b "$CK" "$B/" | grep -c 'panel-remote" content="1')" 1
check "telefondan /api/followup okunur (zamanlanmış işler içinde)" "$(curl -s -H "Host: $RH" -b "$CK" "$B/api/followup" | grep -c '"sched"')" 1
check "telefondan devre dışı bırak: 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${R[@]}" -d '{"id":"\\Rapor Gönder"}' "$B/api/schedule/disable")" 403
check "telefondan klasörde göster: 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${R[@]}" -d "{\"path\":\"$(esc "$P/Rapor Aracı")\"}" "$B/api/reveal")" 403
check "telefon isteği görevi kapatmadı" "$(j "[t['name'] for t in d if not t['enabled']]" "$T/gorevler.json")" "['Demo Yedek', 'Kapalı Görev']"
check "telefondan Durdur ucu açık (bilinmeyen oturum: 404)" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${R[@]}" -d '{"key":"yok"}' "$B/api/schedule/stop")" 404

# ---- Claude görev dosyaları: içerik ayrıştırılmaz ----
check "scheduled_tasks dosyaları: json (bozuk içerikle) ve yalnız kilit" "$(q "sorted((f['name'], f['hasJson'], f['hasLock'], ad(f['path'])) for f in S['files'])")" \
  "[('Demo Mağaza', True, False, 'scheduled_tasks.json'), ('Örnek API', False, True, 'scheduled_tasks.lock')]"
check "dosya tarihi var, içerikten alan yok" "$(q "all(f['mtime'] > 0 for f in S['files']), sorted(S['files'][0])")" "True ['hasJson', 'hasLock', 'mtime', 'name', 'path', 'root']"
check "masaüstü görevleri: ad + istemin ilk satırı (ön bilgi atlanır); SKILL.md'siz klasör yok" "$(q "[(x['name'], x['prompt']) for x in S['desktop']]")" \
  "[('haftalik-rapor', 'Haftalık raporu hazırla'), ('sabah-ozeti', \"Dünkü commit'leri özetle ve açık işleri listele.\")]"

# ---- verilmiş sözler ----
check "5 söz: okunamayan 2 + tarihli 3; satır ortası ve kod bloğu alınmadı" "$(q "[gun(p['date']) for p in S['promises']]")" "[None, None, -3, 0, 10]"
check "söz metinleri (tarih ve işaretler ayrılmış)" "$(q "[p['text'] for p in S['promises'] if p['date']]")" \
  "['Ödeme sağlayıcısının yanıtını kontrol et', 'Yayın sonrası hata kayıtlarına bak', 'Sertifika yenilemesini doğrula']"
check "geçersiz tarih ve biçimsiz satır sessiz atlanmaz: ham metniyle döner" "$(q "sorted(p['text'] for p in S['promises'] if not p['date'])")" "['2026-13-45 — Tarihi bozuk söz', 'yarın — Biçimsiz söz']"
check "söz: proje, dosya, satır numarası" "$(q "all(p['name']=='Örnek API' and ad(p['file'])=='NEXT_SESSION.md' and p['line']>0 and os.path.isdir(p['root']) for p in S['promises'])")" True

# ---- açık oturumdaki tekrarlı işler ----
check "oturum yokken döngü yok, kota uyarısı yok" "$(q "len(L), d['quotaLow']")" "0 None"
check "panel oturumu başladı" "$(post /api/hosted "{\"cwd\":\"$(esc "$P/Demo Mağaza")\",\"prompt\":\"ZAMANLA\"}")" 200
KEY=$(j "d['key']")
for _ in $(seq 1 60); do snap; [ "$(q "len(L)")" = 3 ] && break; sleep 0.5; done
check "3 tekrarlı iş: 2 cron + 1 uyanma zinciri" "$(q "[(x['type'], x['schedule'], x['recurring']) for x in L]")" \
  "[('cron', '*/30 * * * *', True), ('cron', '0 9 * * *', False), ('wakeup', '5m dağıtım durumunu denetle', True)]"
check "panel oturumunun anahtarı ve projesi satırda" "$(q "all(x['key']=='$KEY' and x['pid'] is None and ad(x['root'])=='Demo Mağaza' for x in L)")" True
check "başlangıçtan beri token (önbellekten okunan sayılmaz, aynı yanıt çift sayılmaz)" "$(q "[x['tokens'] for x in L]")" "[1420, 120, 90]"
check "uyanma zinciri: gecikme, tur sayısı, ardışık boş tur, gerekçe" "$(q "L[2]['delaySeconds'], L[2]['runs'], L[2]['noopStreak'], L[2]['prompt']")" "300 4 3 Dağıtım sürüyor mu diye bakılacak"
check "cron istemi satırda" "$(q "[x['prompt'] for x in L[:2]]")" "['Derleme durumunu denetle', 'Sabah raporunu gönder']"
check "başlangıç zamanı yakın geçmişte" "$(q "all(0 <= __import__('time').time()*1000 - x['startedAt'] < 600000 for x in L)")" True

# ---- kota düşükken uyarı ----
py -3.13 -c "
import json,sys,time,datetime
r=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=3)).isoformat()
json.dump({'five_hour':{'utilization':85,'resets_at':r},'seven_day':{'utilization':40,'resets_at':r},'_cached_at':time.time()},open(sys.argv[1],'w'))" "$TW\\claude\\usage-cache.json"
snap
check "kota düşük: kalan yüzdeler döner" "$(q "d['quotaLow']")" "{'fiveLeft': 15, 'weekLeft': 60}"

# ---- Durdur: panel oturumuna mesaj ----
check "Durdur anahtarsız: 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/schedule/stop" -H "Content-Type: application/json" -d "{\"key\":\"$KEY\"}")" 403
check "döngüsü olmayan / bilinmeyen oturum: 404" "$(post /api/schedule/stop '{"key":"yok"}') $(j "d['error']")" "404 noloop"
M0=$(grep -c '^MESAJ' "$T/sahte.log")
check "Durdur: 200, hemen gönderildi" "$(post /api/schedule/stop "{\"key\":\"$KEY\"}") $(j "d['ok'], d['queued']")" "200 True False"
for _ in $(seq 1 60); do snap; [ "$(q "len(L)")" = 0 ] && break; sleep 0.5; done
check "oturuma tek mesaj gitti: durdurma istemi" "$(( $(grep -c '^MESAJ' "$T/sahte.log") - M0 )) $(grep '^MESAJ' "$T/sahte.log" | tail -1 | grep -c 'CronDelete')" "1 1"
check "oturum durdurdu: kayıtta tekrarlı iş kalmadı" "$(q "len(L)")" 0
check "panel oturumu kapatmadı (yalnız mesaj gönderdi)" "$(curl -s "$B/api/state" | grep -c "\"key\":\"$KEY\"")" 1

# ---- Kaydet ve kapat istemi verilmiş söz kuralını taşır ----
check "Kaydet ve kapat: 200" "$(post "/api/hosted/$KEY/wrap" '{"close":true}' /dev/null)" 200
for _ in $(seq 1 40); do grep -q 'CLAUDE_MEMORY.md' "$T/sahte.log" && break; sleep 0.3; done
check "kayıt isteminde söz satırı biçimi yazıyor" "$(grep '^MESAJ' "$T/sahte.log" | grep 'CLAUDE_MEMORY.md' | grep -c 'TAKİP: YYYY-AA-GG — yapılacak iş')" 1
for _ in $(seq 1 40); do [ "$(curl -s "$B/api/state" | grep -c "\"key\":\"$KEY\"")" = 0 ] && break; sleep 0.3; done
check "oturum kaydedip kapandı" "$(curl -s "$B/api/state" | grep -c "\"key\":\"$KEY\"")" 0

# ---- terminal oturumu: listelenir, panel mesaj gönderemez ----
WPID=$(cat /proc/$PID/winpid)
SID="11111111-2222-4333-8444-555555555555"
mkdir -p "$T/claude/sessions"
py -3.13 -c "
import json,sys,time,os
t,sid,pid,cwd=sys.argv[1:5]
z=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
json.dump({'pid':int(pid),'sessionId':sid,'cwd':cwd,'name':'Terminal Demo','kind':'interactive','status':'idle','startedAt':int(time.time()*1000)},open(os.path.join(t,'claude','sessions','t.json'),'w',encoding='utf-8'))
with open(os.path.join(t,'claude','projects','sahte-oturum',sid+'.jsonl'),'w',encoding='utf-8',newline='\n') as f:
    f.write(json.dumps({'type':'user','uuid':'u1','timestamp':z,'cwd':cwd,'message':{'role':'user','content':'başla'}},ensure_ascii=False)+'\n')
    f.write(json.dumps({'type':'assistant','timestamp':z,'message':{'id':'m1','usage':{'input_tokens':7,'output_tokens':3},'content':[{'type':'tool_use','id':'w1','name':'ScheduleWakeup','input':{'delaySeconds':1200,'reason':'Sıra bekleniyor','prompt':'devam'}}]}},ensure_ascii=False)+'\n')
    f.write(json.dumps({'type':'assistant','timestamp':z,'message':{'id':'m2','usage':{'input_tokens':20,'output_tokens':5},'content':[{'type':'text','text':'bekliyorum'}]}},ensure_ascii=False)+'\n')
" "$TW" "$SID" "$WPID" "$(cygpath -w "$P/Rapor Aracı")"
snap
check "terminal oturumundaki döngü listede: anahtar yok, pid var" "$(q "[(x['type'], x['key'], x['pid']==$WPID, x['name'], x['delaySeconds'], x['tokens'], x['noopStreak']) for x in L]")" \
  "[('wakeup', None, True, 'Terminal Demo', 1200, 25, 0)]"
check "terminal oturumu için Durdur ucu yok (anahtarsız istek: 400)" "$(post /api/schedule/stop '{"key":null}' /dev/null)" 400
rm "$T/claude/sessions/t.json"
kapat

# ================= 2. aşama: macOS LaunchAgents okuyucusu =================
baslat CLAUDE_PANEL_LAUNCHAGENTS_DIR="$TW\\agents"
snap
check "mac: kaynak türü" "$(q "S['os']['kind'], S['os']['state']")" "mac ok"
check "mac: ilgili 2 ajan + okunamayan ikili plist; ilgisiz ajan yok" "$(q "sorted((t['name'], t['unreadable']) for t in S['os']['tasks'])")" "[('ikili', True), ('ornek.rapor', False), ('ornek.yedek', False)]"
check "mac: proje, devre dışı anahtarı, zamanlama metni" "$(q "[(G[n]['project'], G[n]['enabled'], G[n]['schedule']) for n in ('ornek.rapor','ornek.yedek')]")" \
  "[('Rapor Aracı', False, 'StartCalendarInterval Hour=3 Minute=0'), ('Demo Mağaza', True, 'StartInterval=3600; RunAtLoad')]"
check "mac: son/sonraki çalışma uydurulmaz; devre dışı bırakma sunulmaz" "$(q "all(t['nextRun'] is None and t['lastRun'] is None and not t['canDisable'] for t in S['os']['tasks'])")" True
check "mac: devre dışı bırak isteği reddedilir" "$(post /api/schedule/disable "{\"id\":\"$(esc "$T/agents/ornek.yedek.plist")\"}") $(j "d['error']")" "400 taskunsupported"
kapat

# ---- uydurma ortamda kaynak verilmezse gerçek zamanlayıcı okunmaz (gerçek görev adı teste / görüntüye sızmaz) ----
baslat
snap
check "uydurma ortam: gerçek zamanlayıcı okunmadı, liste boş" "$(q "S['os']['kind'], S['os']['state'], len(S['os']['tasks'])")" "windows ok 0"
kapat

# ================= 3. aşama: gerçek Görev Zamanlayıcı (yalnız testin kendi görevi) =================
pwsh -NoProfile -c "Register-ScheduledTask -TaskName '$TASK' -Action (New-ScheduledTaskAction -Execute 'pwsh.exe' -Argument '-NoProfile -File \"$TW\\claude\\hooks\\temizlik.ps1\"') -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date).AddDays(300)) | Out-Null"
check "geçici görev oluşturuldu" "$(pwsh -NoProfile -c "(Get-ScheduledTask -TaskName '$TASK').State" | tr -d '\r')" Ready
baslat CLAUDE_PANEL_TASKS_REAL=1
snap
check "windows: zamanlayıcı okundu" "$(q "S['os']['kind'], S['os']['state']")" "windows ok"
check "windows: geçici görev listede (betik ~/.claude altında), açık, hiç çalışmamış, sonraki çalışma var" \
  "$(q "(lambda t: (t['enabled'], t['lastRun'], t['lastResult'], t['nextRun'] is not None, ad(t['reveal']), t['canDisable']))(G['$TASK'])")" "(True, None, 267011, True, 'temizlik.ps1', True)"
check "windows: Microsoft sistem görevleri listede yok" "$(q "any(t['folder'].lower().startswith('\\\\\\\\microsoft') and not t['root'] for t in S['os']['tasks'])")" False
check "windows: devre dışı bırak 200" "$(post /api/schedule/disable "{\"id\":\"\\\\$TASK\"}") $(j "d.get('ok')")" "200 True"
check "windows: görev zamanlayıcıda gerçekten devre dışı" "$(pwsh -NoProfile -c "(Get-ScheduledTask -TaskName '$TASK').State" | tr -d '\r')" Disabled
for _ in $(seq 1 40); do snap; [ "$(q "G['$TASK']['enabled']")" = False ] && break; sleep 0.3; done
check "windows: yeniden taramada devre dışı görünüyor" "$(q "G['$TASK']['enabled']")" False
kapat
pwsh -NoProfile -c "Unregister-ScheduledTask -TaskName '$TASK' -Confirm:\$false"
check "geçici görev silindi" "$(pwsh -NoProfile -c "@(Get-ScheduledTask -TaskName '$TASK' -ErrorAction SilentlyContinue).Count" | tr -d '\r')" 0

# ---- temizlik ----
PID=""
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.CommandLine -like '*$TW*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
sleep 1
check "test süreci kalmadı" "$(pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and (\$_.CommandLine -like '*$TW*' -or \$_.CommandLine -like '*sahte_claude.py*') }).Count" | tr -d '\r')" 0
rm -rf "$T"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail

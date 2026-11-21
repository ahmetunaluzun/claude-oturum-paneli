#!/usr/bin/env bash
# Takip → GitHub API testi: cevap bekliyor / sakin / kendi issue'su, yerel klasör eşleşmesi (https ve ssh origin), son yorumcu
# önbelleği (değişmeyen öğe için yeniden sorulmaz), Takip taraması gh'yi çağırmaz, ağ hatasında son liste korunur (boş liste
# ile "alamadım" ayrı), giriş yok / gh yok ipucu durumu, yeni yorumla öğe yeniden cevap bekler, bildirim (ilk denetimde toplu,
# sonra yalnız yeni öğe), aç/kapat anahtarı (kalıcı, yeniden başlatmada da), GitHub'a hiçbir yazma çağrısı yok.
# Gerçek gh ÇAĞRILMAZ: CLAUDE_PANEL_GH_EXE = tools/sahte_gh.py'yi çağıran .cmd. Gerçek ~/.claude'a ve canlı panele dokunmaz;
# test kopyası --no-window, boş portta, kendi veri klasöründe; tepsi bildirimi kapalı (tray.json), bildirim logdan doğrulanır.
# Kullanım: tools/github_test.sh [exe]
set -u
cd "$(dirname "$0")/.."
EXE="${1:-src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe}"
T="$(mktemp -d)"; TW=$(cygpath -w "$T")
fail=0; n=0
export PYTHONUTF8=1
check() { n=$((n+1)); if [ "$2" = "$3" ]; then echo "GEÇTİ  $1"; else echo "KALDI  $1 (beklenen $3, gelen $2)"; fail=1; fi; }
freeport() { pwsh -NoProfile -c '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()' | tr -d '\r'; }
tools/takip_ortam.sh "$T" || { echo "ortam kurulamadı"; rm -rf "$T"; exit 1; }
P="$T/projeler"
# Yerel klasör eşleşmesi: biri https, biri ssh biçiminde (ve farklı harf büyüklüğünde) origin adresi.
git -C "$P/Demo Mağaza" remote add origin https://github.com/testkul/demo-magaza.git
git -C "$P/Temiz Kütüphane" remote add origin git@github.com:TestKul/temiz-kutuphane.git
SGH="$(cygpath -w "$PWD/tools/sahte_gh.py")"
printf '@echo off\r\npy -3.13 "%s" %%*\r\n' "$SGH" > "$T/sahte-gh.cmd"
printf '@echo off\r\npy -3.13 "%s"\r\n' "$(cygpath -w "$PWD/tools/sahte_claude.py")" > "$T/sahte-claude.cmd"
senaryo() { py -3.13 "$SGH" --senaryo "$1" "$TW\\gh.json"; }
PID=""; PORT=""; B=""; TOK=""
# baslat <veri klasörü adı> <gh yolu>
baslat() {
  mkdir -p "$T/$1"; [ -f "$T/$1/tray.json" ] || printf '{"Notify":false,"Introduced":true}' > "$T/$1/tray.json"
  DATA="$T/$1"; PORT=$(freeport); B="http://127.0.0.1:$PORT"
  CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\$1" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CLAUDE_EXE="$TW\\sahte-claude.cmd" CLAUDE_PANEL_GH_EXE="$2" \
    SAHTE_GH_DOSYA="$TW\\gh.json" SAHTE_GH_LOG="$TW\\gh.log" TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
  PID=$!
  for _ in $(seq 1 50); do [ -f "$DATA/panel-$PORT.token" ] && break; sleep 0.2; done
  TOK=$(cat "$DATA/panel-$PORT.token")
}
kapat() {
  [ -n "$B" ] && curl -s -o /dev/null -X POST "$B/api/quit?force=1" -H "X-Panel-Token: $TOK" -H "Origin: $B"
  for _ in $(seq 1 40); do curl -s -o /dev/null "$B/api/ping" || break; sleep 0.25; done
  kill $PID 2>/dev/null; wait $PID 2>/dev/null; PID=""
}
trap '[ -n "$PID" ] && kill $PID 2>/dev/null' EXIT
post() { printf '%s' "$2" > "$T/govde.json"; curl -s -o "$T/son.json" -w '%{http_code}' -X POST "$B$1" -H "X-Panel-Token: $TOK" -H "Origin: $B" -H "Content-Type: application/json" --data-binary @"$T/govde.json"; }
j() { py -3.13 -c "import json,sys;d=json.load(open(sys.argv[1],encoding='utf-8'));print($1)" "${2:-$T/son.json}" 2>&1; }
# q <ifade>: son /api/followup yanıtında G = github, I = "depo#no" → öğe
q() { py -3.13 -c "
import json,sys,os
d=json.load(open(sys.argv[1],encoding='utf-8'));G=d['github'];I={i['repo'].split('/')[1]+'#'+str(i['number']):i for i in (G or {}).get('items',[])}
ad=lambda p: os.path.basename(p) if p else None
print($1)" "$T/fu.json" 2>&1; }
snap() { for _ in $(seq 1 80); do curl -s "$B/api/followup" > "$T/fu.json"; [ "$(j "d['scanning'] or d['checkedAt']==0 or bool(d['github'] and d['github']['fetching'])" "$T/fu.json")" = "False" ] && return 0; sleep 0.5; done; return 1; }
# bekle <durum>: ilk denetim (açılıştan birkaç saniye sonra) bitene kadar
bekle() { for _ in $(seq 1 60); do snap; [ "$(q "G['state']")" = "$1" ] && return 0; sleep 0.5; done; return 1; }
# yenile: "Yenile" düğmesinin yaptığı (GitHub'ı şimdi denetle) + deneme zamanı değişene kadar bekle
yenile() { local before; snap; before=$(q "G['triedAt']"); post /api/github/refresh '{}' >/dev/null
  for _ in $(seq 1 80); do snap; [ "$(q "G['triedAt']")" != "$before" ] && return 0; sleep 0.3; done; return 1; }
cagri() { grep -c "^CAGRI	$1" "$T/gh.log" 2>/dev/null; }
bildirim() { cat "$DATA"/logs/remote-*.log 2>/dev/null | grep -c "GitHub bildirimi"; }
sonbildirim() { cat "$DATA"/logs/remote-*.log 2>/dev/null | grep "GitHub bildirimi" | tail -1 | sed 's/.*GitHub bildirimi: //' | tr -d '\r'; }

# ================= 1. İlk denetim =================
senaryo ilk
baslat data "$TW\\sahte-gh.cmd"
check "açılışta anahtar varsayılan açık" "$(curl -s "$B/api/github" | grep -c '"enabled":true')" 1
bekle ok; check "ilk denetim kendiliğinden yapıldı (açılıştan sonra)" $? 0
check "giriş adı gh'den" "$(q "G['login'], G['stale']")" "testkul False"
check "5 öğe; bozuk kayıt atlandı, liste düşmedi" "$(q "sorted(I)")" "['Temiz-Kutuphane#7', 'demo-magaza#1', 'demo-magaza#2', 'demo-magaza#9', 'ornek-kitaplik#5']"
check "cevap bekliyor: başkası açtı + yorum yok" "$(q "I['demo-magaza#1']['waiting'], I['demo-magaza#1']['lastBy'], I['demo-magaza#1']['comments']")" "True misafir1 0"
check "sakin: son yorum kullanıcıda" "$(q "I['demo-magaza#2']['waiting'], I['demo-magaza#2']['lastBy'], I['demo-magaza#2']['comments']")" "False testkul 3"
check "cevap bekliyor: PR, son yorum başkasında" "$(q "I['ornek-kitaplik#5']['waiting'], I['ornek-kitaplik#5']['lastBy'], I['ornek-kitaplik#5']['pr']")" "True misafir3 True"
check "sakin: kendi açtığı yorumsuz issue" "$(q "I['Temiz-Kutuphane#7']['waiting'], I['Temiz-Kutuphane#7']['author'], I['Temiz-Kutuphane#7']['pr']")" "False testkul False"
check "cevap bekliyor: kendi issue'su, son yorum başkasında" "$(q "I['demo-magaza#9']['waiting'], I['demo-magaza#9']['lastBy']")" "True misafir1"
check "satır alanları: başlık, açan, bağlantı, son hareket" "$(q "(lambda i: (i['title'], i['author'], i['url'], 0 < i['updatedAt'] < d['checkedAt']))(I['demo-magaza#1'])")" \
  "('Gece modu koruması için birkaç öneri', 'misafir1', 'https://github.com/testkul/demo-magaza/issues/1', True)"
check "PR bağlantısı" "$(q "I['ornek-kitaplik#5']['url']")" "https://github.com/testkul/ornek-kitaplik/pull/5"
check "yerel klasör: https origin eşleşti" "$(q "ad(I['demo-magaza#1']['root']), os.path.isdir(I['demo-magaza#1']['root'])")" "Demo Mağaza True"
check "yerel klasör: ssh origin, harf büyüklüğü farklı" "$(q "ad(I['Temiz-Kutuphane#7']['root'])")" "Temiz Kütüphane"
check "yerel klasörü olmayan depo: eşleşme yok" "$(q "I['ornek-kitaplik#5']['root']")" "None"
check "gh çağrıları: user 1, arama 1, yorum 3 (yalnız yorumlu öğeler)" "$(cagri user) $(cagri search/issues) $(cagri repos/)" "1 1 3"
check "arama: yalnız kullanıcının açık öğeleri, GET" "$(grep '^CAGRI	search' "$T/gh.log" | grep -c '"q": "user:testkul is:open"')" 1
check "son yorum: tek öğelik son sayfa" "$(grep -c 'issues/2/comments	{"page": "3", "per_page": "1"}' "$T/gh.log")" 1
check "ilk denetim: tek toplu bildirim" "$(bildirim)" 1
check "toplu bildirimde üç bekleyen öğe" "$(sonbildirim)" "testkul/demo-magaza#1, testkul/ornek-kitaplik#5, testkul/demo-magaza#9"
check "durum dosyası yazıldı" "$(j "d['Enabled'], d['Login'], len(d['Items'])" "$DATA/github-watch.json")" "True testkul 5"

# ================= 2. Sıklık ve önbellek =================
B0="$(cagri user) $(cagri search/issues) $(cagri repos/)"
for _ in 1 2; do post /api/followup/refresh '' >/dev/null; sleep 1.5; snap; done
check "Takip taraması gh'yi çağırmaz" "$(cagri user) $(cagri search/issues) $(cagri repos/)" "$B0"
yenile; check "Yenile: yeniden denetlendi" $? 0
check "değişmeyen öğeler için yorum yeniden sorulmadı" "$(cagri user) $(cagri search/issues) $(cagri repos/)" "2 2 3"
check "değişiklik yokken yeni bildirim yok" "$(bildirim)" 1

# ================= 3. Yeni yorum =================
T2=$(q "I['demo-magaza#2']['updatedAt']")
senaryo yeniyorum; yenile
check "yeni yorum: öğe cevap bekliyor oldu" "$(q "I['demo-magaza#2']['waiting'], I['demo-magaza#2']['lastBy'], I['demo-magaza#2']['comments']")" "True misafir2 4"
check "son hareket zamanı ilerledi (gizlenen satır geri gelir: imza budur)" "$(q "I['demo-magaza#2']['updatedAt'] > $T2")" True
check "yalnız değişen öğenin yorumu soruldu" "$(cagri repos/) $(grep -c 'issues/2/comments	{"page": "4"' "$T/gh.log")" "4 1"
check "yeni bekleyen için tek bildirim, yalnız o öğe" "$(bildirim) $(sonbildirim)" "2 testkul/demo-magaza#2"
senaryo cevapladim; yenile
check "kullanıcı cevap yazınca sakinleşir" "$(q "I['demo-magaza#1']['waiting'], I['demo-magaza#1']['lastBy']")" "False testkul"
check "sakinleşen öğe bildirim vermez" "$(bildirim)" 2

# ================= 4. Ağ hatası: son liste korunur =================
OK0=$(q "G['checkedAt']"); senaryo ag; yenile
check "ağ hatası: durum ok + bayat, 5 öğe duruyor" "$(q "G['state'], G['stale'], len(G['items'])")" "ok True 5"
check "alınma zamanı değişmedi, deneme zamanı ilerledi" "$(q "G['checkedAt'] == $OK0, G['triedAt'] > G['checkedAt']")" "True True"
check "ağ hatasında yerel klasör eşleşmesi de duruyor" "$(q "ad(I['demo-magaza#9']['root'])")" "Demo Mağaza"
senaryo bos; yenile
check "gerçekten boş liste: 0 öğe, bayat değil" "$(q "G['state'], G['stale'], len(G['items'])")" "ok False 0"
senaryo ag; yenile
check "boş listeden sonra ağ hatası: boş + bayat (ikisi ayrı)" "$(q "G['state'], G['stale'], len(G['items'])")" "ok True 0"
senaryo ilk; yenile
check "ağ gelince liste yenilendi" "$(q "G['stale'], len(G['items']), I['demo-magaza#1']['waiting']")" "False 5 True"
check "yeniden çıkan bekleyenler için tek toplu bildirim" "$(bildirim)" 3

# ================= 5. Giriş yok =================
senaryo giris; yenile
check "giriş yok: ipucu durumu, hata değil; liste gösterilmez" "$(q "G['state'], len(G['items']), G['stale']")" "noauth 0 False"
check "ayar ucu da durumu verir" "$(curl -s "$B/api/github" | grep -c '"state":"noauth"')" 1
senaryo ilk; yenile
check "giriş yapılınca liste geri gelir" "$(q "G['state'], len(G['items'])")" "ok 5"

# ================= 6. Aç/kapat anahtarı =================
check "anahtarsız istek: 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/github" -H "Content-Type: application/json" -d '{"enabled":false}')" 403
check "anahtarsız yenile: 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/github/refresh")" 403
check "gövdesiz: 400" "$(post /api/github '{}')" 400
check "kapat: 200" "$(post /api/github '{"enabled":false}') $(j "d['enabled'], d['state']")" "200 False off"
snap; check "kapalıyken Takip'te GitHub yok" "$(q "G['state'], len(G['items'])")" "off 0"
C0="$(cagri user)"; post /api/github/refresh '{}' >/dev/null; sleep 2
check "kapalıyken Yenile gh'yi çağırmaz" "$(cagri user)" "$C0"
kapat
baslat data "$TW\\sahte-gh.cmd"; sleep 6; snap
check "yeniden başlatma: kapalı kaldı, gh çağrılmadı" "$(q "G['state']") $(cagri user)" "off $C0"
check "aç: 200" "$(post /api/github '{"enabled":true}') $(j "d['enabled']")" "200 True"
bekle ok; check "açılınca hemen denetlendi" "$(q "G['state'], len(G['items'])") $(cagri user)" "ok 5 $((C0+1))"
kapat
C1="$(cagri user)"
baslat data "$TW\\sahte-gh.cmd"; sleep 6; snap
check "yeniden başlatma: açık kaldı, son liste dosyadan (15 dk dolmadan gh çağrılmaz)" "$(q "G['state'], len(G['items'])") $(cagri user)" "ok 5 $C1"
check "yeniden başlatmada ve yeniden açmada var olanlar için bildirim yinelenmez" "$(bildirim)" 3
kapat

# ================= 7. gh yok / hiç alınamadı =================
baslat data "$TW\\yok\\gh.exe"; yenile
check "gh yok: ipucu durumu" "$(q "G['state'], len(G['items'])")" "nogh 0"
kapat
senaryo ag
baslat data2 "$TW\\sahte-gh.cmd"
bekle failed; check "ilk denetim ağ hatası: 'alınamadı' (boş liste değil)" "$(q "G['state'], G['checkedAt'], len(G['items'])")" "failed 0 0"
check "alınamayınca bildirim yok" "$(bildirim)" 0
kapat
# Sahte gh verilmemiş test kopyası (diğer testlerin durumu): gerçek gh'ye gitmesin diye varsayılan kapalı.
C2="$(cagri user)"
baslat data3 ""; sleep 6; snap
check "sahte gh'siz test kopyası: varsayılan kapalı, gh çağrılmaz" "$(curl -s "$B/api/github" | grep -c '"enabled":false') $(q "G['state']") $(cagri user)" "1 off $C2"
kapat

check "GitHub'a hiçbir yazma çağrısı yok" "$(grep -c '^YAZMA' "$T/gh.log")" 0
check "yalnız üç uç çağrıldı (user, search/issues, yorumlar)" "$(cut -f2 "$T/gh.log" | sed -E 's#^repos/.*/comments$#yorum#' | sort -u | tr '\n' ' ')" "search/issues user yorum "

# ---- temizlik ----
panel_sayisi() { pwsh -NoProfile -c "@(Get-CimInstance Win32_Process -Filter \"Name='ClaudePanel.exe'\" | Where-Object { \$_.ExecutablePath -notlike '*\\dist\\*' }).Count" | tr -d '\r'; }
for _ in $(seq 1 10); do [ "$(panel_sayisi)" = 0 ] && break; sleep 1; done
check "test süreci kalmadı" "$(pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and (\$_.CommandLine -like '*$TW*' -or \$_.CommandLine -like '*sahte_gh.py*') }).Count" | tr -d '\r')" 0
check "test panelleri kapandı (yalnız canlı panel kalabilir)" "$(panel_sayisi)" 0
rm -rf "$T"
echo "$n denetim"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail

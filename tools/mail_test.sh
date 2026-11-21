#!/usr/bin/env bash
# Mail ve takvim API testi (sahte Google: tools/sahte_google.py; gerçek Google'a HİÇ bağlanılmaz).
# Kapsam: istemci dosyası doğrulama (masaüstü türü, web reddi, bozuk JSON) ve şifreli saklama; hesap ekleme akışı (PKCE S256,
# loopback 127.0.0.1 boş port, state doğrulama, yanlış state reddi, izin reddi, yalnız seçilen kapsam); belirteç DPAPI ile şifreli
# (veri klasöründe düz belirteç yok); süzgeç kuralları (her kural için olumlu/olumsuz, anında, ağa çıkmadan); gövde hiç istenmiyor
# (sahte sunucu logunda format=full/raw yok); takvim (24 saat, iptal edilen yok, toplantı bağlantısı, güvenli bağlantı);
# ağ yok → son liste + "güncellenemedi" (kalıcı kilitlenmez); iptal edilmiş belirteç → yeniden giriş; telefondan yazma uçları
# kapalı, okuma açık; kaldır → belirteç silinir; yeniden başlatma sonrası ayarlar ve hesap korunur.
# Test kopyası --no-window, boş portta, kendi veri klasöründe; tarayıcı açılmaz (CLAUDE_PANEL_MAIL_NO_BROWSER=1).
# Kullanım: tools/mail_test.sh [exe]
set -u
cd "$(dirname "$0")/.."
EXE="${1:-src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe}"
T="$(mktemp -d)"; TW=$(cygpath -w "$T")
fail=0; n=0
export PYTHONUTF8=1
RH=test.ts.net
check() { n=$((n+1)); if [ "$2" = "$3" ]; then echo "GEÇTİ  $1"; else echo "KALDI  $1 (beklenen $3, gelen $2)"; fail=1; fi; }
freeport() { pwsh -NoProfile -c '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()' | tr -d '\r'; }
tools/takip_ortam.sh "$T" >/dev/null || { echo "ortam kurulamadı"; rm -rf "$T"; exit 1; }
printf '@echo off\r\npy -3.13 "%s"\r\n' "$(cygpath -w "$PWD/tools/sahte_claude.py")" > "$T/sahte-claude.cmd"
SG="$(cygpath -w "$PWD/tools/sahte_google.py")"
senaryo() { py -3.13 "$SG" --senaryo "$1" "$TW\\google.json"; }
senaryo ilk
GP=$(freeport); G="http://127.0.0.1:$GP"
py -3.13 "$SG" --sunucu "$GP" "$TW\\google.json" "$TW\\google.log" &
GPID=$!
for _ in $(seq 1 40); do curl -s -o /dev/null "$G/x" && break; sleep 0.2; done

PID=""; PORT=""; B=""; TOK=""; DATA="$T/data"
baslat() {
  [ -f "$DATA/tray.json" ] || printf '{"Notify":false,"Introduced":true}' > "$DATA/tray.json"
  PORT=$(freeport); B="http://127.0.0.1:$PORT"
  CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CLAUDE_EXE="$TW\\sahte-claude.cmd" \
    CLAUDE_PANEL_GH_EXE="$TW\\yok.cmd" CLAUDE_PANEL_REMOTE_HOST=$RH CLAUDE_PANEL_GOOGLE_BASE="$G" CLAUDE_PANEL_GOOGLE_AUTH_BASE="$G" CLAUDE_PANEL_MAIL_NO_BROWSER=1 \
    TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
  PID=$!
  for _ in $(seq 1 50); do [ -f "$DATA/panel-$PORT.token" ] && break; sleep 0.2; done
  TOK=$(cat "$DATA/panel-$PORT.token")
}
kapat() {
  curl -s -o /dev/null -X POST "$B/api/quit?force=1" -H "X-Panel-Token: $TOK" -H "Origin: $B"
  for _ in $(seq 1 40); do curl -s -o /dev/null "$B/api/ping" || break; sleep 0.25; done
  kill $PID 2>/dev/null; wait $PID 2>/dev/null; PID=""
}
trap '[ -n "$PID" ] && kill $PID 2>/dev/null; kill $GPID 2>/dev/null' EXIT
post() { printf '%s' "$2" > "$T/govde.json"; curl -s -o "$T/son.json" -w '%{http_code}' -X POST "$B$1" -H "X-Panel-Token: $TOK" -H "Origin: $B" -H "Content-Type: application/json" --data-binary @"$T/govde.json"; }
j() { py -3.13 -c "import json,sys;d=json.load(open(sys.argv[1],encoding='utf-8'));print($1)" "${2:-$T/son.json}" 2>&1; }
mailget() { curl -s "$B/api/mail" > "$T/mail.json"; }
# q <ifade>: son /api/followup yanıtında M = mail, K = konuşma kimliği → satır, E = etkinlik kimlikleri
q() { py -3.13 -c "
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'));M=d['mail'] or {};K={m['threadId']:m for m in M.get('mails',[])};E=[e['id'] for e in M.get('events',[])]
print($1)" "$T/fu.json" 2>&1; }
snap() { curl -s "$B/api/followup" > "$T/fu.json"; }
# yenile: "Yenile" + hesabın son deneme zamanı değişene kadar bekle
yenile() { local before; snap; before=$(q "M['accounts'][0]['triedAt'] if M.get('accounts') else 0"); post /api/mail/refresh '{}' >/dev/null
  for _ in $(seq 1 80); do snap; [ "$(q "M['accounts'][0]['triedAt'] if M.get('accounts') else 0")" != "$before" ] && [ "$(q "M['fetching']")" = False ] && return 0; sleep 0.3; done; return 1; }
istek() { grep -c "$1" "$T/google.log" 2>/dev/null; }
# konular <süzgeç json>: süzgeci ayarla, listedeki konuşmaları sırala
konular() { post /api/mail/filter "$1" >/dev/null; snap; q "sorted(K)"; }
# akis <add gövdesi>: girişi başlatır, yetki adresini $AUTH'a yazar
akis() { post /api/mail/accounts/add "$1" > "$T/akis.kod"; AUTH=$(j "d.get('url','')"); }
url_param() { py -3.13 -c "import sys,urllib.parse as u;print(u.parse_qs(u.urlparse(sys.argv[1]).query).get(sys.argv[2],[''])[0])" "$AUTH" "$1"; }
bekle_giris() { for _ in $(seq 1 60); do mailget; s=$(j "(d['login'] or {}).get('state')" "$T/mail.json"); [ "$s" != waiting ] && echo "$s" && return; sleep 0.25; done; echo zamanasimi; }

baslat
# ================= 1. Başlangıç: istemci yok =================
mailget
check "başlangıç: istemci yok, hesap yok" "$(j "d['client'], d['accounts'], d['login']" "$T/mail.json")" "False [] None"
check "varsayılan süzgeç: bana doğrudan + cevap bekleyen" "$(j "d['filter']['direct'], d['filter']['cc'], d['filter']['awaiting']" "$T/mail.json")" "True False True"
snap; check "hesap yokken Takip'te mail bölümü yok" "$(q "M['state']")" "off"
check "istemci yokken hesap ekle: 400" "$(post /api/mail/accounts/add '{"mail":true,"cal":true}') $(j "d['error']")" "400 mail_noclient"

# ================= 2. İstemci dosyası =================
SIR="ISTEMCI-SIRRI-$RANDOM"
check "bozuk JSON reddedilir" "$(post /api/mail/client '{"json":"{bozuk"}') $(j "d['error']")" "400 client_invalid"
check "web uygulaması türü reddedilir" "$(post /api/mail/client '{"json":"{\"web\":{\"client_id\":\"123456789.apps.googleusercontent.com\"}}"}') $(j "d['error']")" "400 client_web"
check "client_id'siz masaüstü dosyası reddedilir" "$(post /api/mail/client '{"json":"{\"installed\":{\"client_secret\":\"x\"}}"}') $(j "d['error']")" "400 client_invalid"
check "masaüstü istemci dosyası kabul" "$(post /api/mail/client "{\"json\":\"{\\\"installed\\\":{\\\"client_id\\\":\\\"123456789-test.apps.googleusercontent.com\\\",\\\"client_secret\\\":\\\"$SIR\\\",\\\"redirect_uris\\\":[\\\"http://localhost\\\"]}}\"}") $(j "d['client']")" "200 True"
check "yanıtta istemci içeriği yok" "$(grep -c "$SIR\|123456789-test" "$T/son.json")" 0
check "istemci sırrı veri klasöründe düz metin değil" "$(grep -rl "$SIR" "$DATA" 2>/dev/null | wc -l)" 0
check "istemci dosyası şifreli (secrets/google-client.bin)" "$([ -s "$DATA/secrets/google-client.bin" ] && echo var)" var
check "istemci içeriği loglarda yok" "$(cat "$DATA"/logs/*.log 2>/dev/null | grep -c "$SIR\|123456789-test")" 0

# ================= 3. Hesap ekleme akışı =================
check "kaynaksız ekleme: 400" "$(post /api/mail/accounts/add '{"mail":false,"cal":false}') $(j "d['error']")" "400 mail_nosource"
akis '{"mail":true,"cal":true}'
check "giriş başladı: 200, yetki adresi" "$(cat "$T/akis.kod") $(echo "$AUTH" | grep -c "^$G/o/oauth2/v2/auth?")" "200 1"
RED=$(url_param redirect_uri); LPORT=${RED##*:}
check "dönüş adresi 127.0.0.1 + boş port (yolsuz)" "$(echo "$RED" | grep -cE '^http://127\.0\.0\.1:[0-9]+$')" 1
check "PKCE: S256, 43 karakter challenge" "$(url_param code_challenge_method) $(url_param code_challenge | tr -d '\r\n' | wc -c)" "S256 43"
check "response_type=code, client_id dosyadan" "$(url_param response_type) $(url_param client_id)" "code 123456789-test.apps.googleusercontent.com"
check "kapsam: yalnız gmail.readonly + calendar.readonly" "$(url_param scope)" "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly"
STATE=$(url_param state)
check "state rastgele (22+ karakter)" "$([ ${#STATE} -ge 22 ] && echo evet)" evet
check "adreste client_secret yok" "$(echo "$AUTH" | grep -c "$SIR")" 0
mailget; check "giriş sürüyor (waiting)" "$(j "d['login']['state']" "$T/mail.json")" waiting
check "yanlış state: 400" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$LPORT/?code=kod-sahte&state=yanlis")" 400
check "state'siz dönüş: 400" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$LPORT/?code=kod-sahte")" 400
mailget; check "yanlış state sonrası hesap eklenmedi, giriş sürüyor" "$(j "len(d['accounts']), d['login']['state']" "$T/mail.json")" "0 waiting"
check "yanlış state belirteç değişimi denemedi" "$(istek 'POST	/token')" 0
PAGE=$(curl -s -L "$AUTH")
check "tarayıcı yerine yetki adresi: giriş tamamlandı sayfası" "$(echo "$PAGE" | grep -c 'Giriş tamamlandı')" 1
check "giriş bitti, adres girişten geldi" "$(bekle_giris) $(j "d['login']['email']" "$T/mail.json")" "done test.kul@ornek.com"
check "hesap: mail + takvim açık ve izinli" "$(j "[(a['email'], a['mail'], a['cal'], a['mailGranted'], a['calGranted']) for a in d['accounts']]" "$T/mail.json")" "[('test.kul@ornek.com', True, True, True, True)]"
check "belirteç değişimi PKCE ile (sahte sunucu doğruladı) ve adres profile'dan" "$(istek 'POST	/token') $(istek 'users/me/profile')" "1 1"
ACC=$(j "d['accounts'][0]['id']" "$T/mail.json")
check "yenileme belirteci şifreli dosyada" "$([ -s "$DATA/secrets/mail-token-$ACC.bin" ] && echo var)" var
check "veri klasöründe düz belirteç yok (yenileme + erişim)" "$(grep -rlE 'YENILEME-GIZLI|erisim-[0-9a-f]{12}' "$DATA" 2>/dev/null | wc -l)" 0
check "loglarda belirteç ve yetki kodu yok" "$(cat "$DATA"/logs/*.log 2>/dev/null | grep -cE 'YENILEME-GIZLI|erisim-|kod-[0-9a-f]')" 0
check "ayar dosyasında belirteç yok, adres var" "$(grep -c 'YENILEME' "$DATA/mail-settings.json") $(grep -c 'test.kul@ornek.com' "$DATA/mail-settings.json")" "0 1"
check "giriş bitince dönüş portu kapandı" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$LPORT/?state=$STATE")" 000

# ================= 4. İlk denetim: mail + takvim =================
for _ in $(seq 1 60); do snap; [ "$(q "M['state'], M['checkedAt'] > 0, M['fetching']")" = "ok True False" ] && break; sleep 0.3; done
check "giriş sonrası hemen denetlendi" "$(q "M['state'], M['checkedAt'] > 0, M['stale']")" "ok True False"
check "varsayılan süzgeç: 4 konuşma (doğrudan + cevap bekleyen)" "$(q "sorted(K)")" "['t1', 't2', 't3', 't6']"
check "cevap bekleyen: son mesaj bende değil + alıcıyım; cevapladığım (t3) değil" "$(q "sorted(k for k,m in K.items() if m['awaiting'])")" "['t1', 't2', 't6']"
check "uyan kurallar satırda" "$(q "K['t1']['rules'], K['t2']['rules'], K['t3']['rules']")" "['awaiting', 'direct'] ['awaiting'] ['direct']"
check "konuşmanın en yeni mesajı" "$(q "K['t6']['subject'], K['t6']['id']")" "Destek kaydı #42 güncellendi m6b"
check "satır: gönderen adı/adresi, hesap, tarih" "$(q "K['t1']['fromName'], K['t1']['fromAddr'], K['t1']['account'], 0 < d['mail']['checkedAt'] - K['t1']['date'] < 3*3600_000")" "Ali Kaya ali@musteri.com test.kul@ornek.com True"
check "Gmail'de aç adresi" "$(q "K['t1']['url']")" "https://mail.google.com/mail/?authuser=test.kul%40ornek.com#all/t1"
check "cevap bekleyenler önce" "$(q "[m['threadId'] for m in M['mails']][:3]")" "['t1', 't2', 't6']"
check "takvim: 24 saat içi, iptal edilen ve 30 saat sonrası yok, sıralı" "$(q "E")" "['e2', 'e1', 'e5']"
check "etkinlik: başlık, yer, toplantı bağlantısı" "$(q "[(e['title'], e['location'], e['join']) for e in M['events'] if e['id']=='e1']")" "[('Proje toplantısı', 'Toplantı odası 2', 'https://meet.google.com/abc-defg-hij')]"
check "conferenceData video girişi; yabancı htmlLink yerine takvim adresi" "$(q "[(e['join'], e['url']) for e in M['events'] if e['id']=='e5']")" "[('https://zoom.us/j/123', 'https://calendar.google.com/calendar/r')]"
check "tüm gün etkinliği" "$(q "[e['allDay'] for e in M['events'] if e['id']=='e2']")" "[True]"
check "gövde hiç istenmedi: format=full/raw yok" "$(grep -ciE 'format=(full|raw|minimal)' "$T/google.log")" 0
check "her mesaj isteği format=metadata" "$(grep -E 'users/me/messages/[a-z0-9]+' "$T/google.log" | grep -vc 'format=metadata')" 0
check "yalnız GET (Google'a yazma yok; POST yalnız /token)" "$(grep -c '^ISTEK	POST' "$T/google.log")" "$(grep -c '^ISTEK	POST	/token' "$T/google.log")"
check "liste sorguları: gelen ve giden kutusu, 14 gün" "$(grep -c 'q=in%3Ainbox%20newer_than%3A14d' "$T/google.log") $(grep -c 'q=in%3Asent%20newer_than%3A14d' "$T/google.log")" "1 1"
check "mail listesi diske belirteçsiz yazıldı" "$(grep -c 'Teklif revizyonu' "$DATA/mail-watch.json") $(grep -cE 'YENILEME|erisim-' "$DATA/mail-watch.json")" "1 0"

# ================= 5. Süzgeç kuralları (yerel, anında) =================
N0=$(wc -l < "$T/google.log")
check "hiçbir kural yok: liste boş + not" "$(konular '{"direct":false,"cc":false,"awaiting":false,"senders":[],"keywords":[],"labels":[]}') $(q "M['filterEmpty']")" "[] True"
check "bana doğrudan: t1 t3 t6 (CC'li t2 ve bana olmayan t4 yok)" "$(konular '{"direct":true}')" "['t1', 't3', 't6']"
check "CC: yalnız t2" "$(konular '{"direct":false,"cc":true}')" "['t2']"
check "cevap bekleyen: t1 t2 t6 (cevapladığım t3, kendi mesajım t5 yok)" "$(konular '{"cc":false,"awaiting":true}')" "['t1', 't2', 't6']"
post /api/mail/filter '{"awaiting":false}' >/dev/null
check "gönderen alan adı @musteri.com: t1 t3" "$(konular '{"senders":["@musteri.com"]}')" "['t1', 't3']"
check "alan adı @'siz: aynı sonuç" "$(konular '{"senders":["musteri.com"]}')" "['t1', 't3']"
check "tam adres: yalnız t1" "$(konular '{"senders":["ALI@musteri.com"]}')" "['t1']"
check "alt alan adı: ornek.com → destek.ornek.com (t6); kendi mesajım (t5, ornek.com) listelenmez" "$(konular '{"senders":["ornek.com"]}')" "['t6']"
check "olumsuz: usteri.com alan adı eşleşmez" "$(konular '{"senders":["usteri.com"]}')" "[]"
check "anahtar kelime: acil → ACİL (Türkçe büyük harf)" "$(konular '{"senders":[],"keywords":["acil"]}')" "['t4']"
check "anahtar kelime: rapor" "$(konular '{"keywords":["Rapor"]}')" "['t2']"
check "olumsuz: fatura" "$(konular '{"keywords":["fatura"]}')" "[]"
check "Gmail etiketi adıyla: BÜLTEN" "$(konular '{"keywords":[],"labels":["BÜLTEN"]}')" "['t4']"
check "olumsuz: Müşteri etiketi" "$(konular '{"labels":["Müşteri"]}')" "[]"
check "kurallar VEYA ile: etiket + cc" "$(konular '{"labels":["Bülten"],"cc":true}') $(q "K['t4']['rules'], K['t2']['rules']")" "['t2', 't4'] ['label'] ['cc']"
check "süzgeç değişikliği Google'a gitmedi" "$(wc -l < "$T/google.log")" "$N0"
check "liste temizlenir: boş/yinelenen atılır" "$(post /api/mail/filter '{"senders":[" a@b.com ","","A@B.COM"]}' >/dev/null; mailget; j "d['filter']['senders']" "$T/mail.json")" "['a@b.com']"
post /api/mail/filter '{"direct":true,"cc":false,"awaiting":true,"senders":[],"keywords":["rapor"],"labels":[]}' >/dev/null

# ================= 6. Ağ yok: son liste korunur, kilitlenmez =================
senaryo ag; yenile
check "ağ yok: liste duruyor + bayat, hesap 'net'" "$(q "sorted(K), M['stale'], M['accounts'][0]['state']")" "['t1', 't2', 't3', 't6'] True net"
check "takvim de duruyor" "$(q "E")" "['e2', 'e1', 'e5']"
senaryo ilk; yenile
check "ağ gelince yenilendi (kalıcı kilit yok)" "$(q "M['stale'], M['accounts'][0]['state']")" "False ok"

# ================= 7. Telefondan: okuma açık, yazma uçları kapalı =================
L=(-H "X-Panel-Token: $TOK" -H "Content-Type: application/json")
curl -s -o /dev/null -X POST "${L[@]}" -d '{"enabled":true}' "$B/api/remote/enable"
PC=$(curl -s -X POST "${L[@]}" "$B/api/remote/pair" | grep -o '"code":"[0-9]*' | cut -d'"' -f4)
curl -s -o /dev/null -D "$T/hdr.txt" -X POST -H "Host: $RH" -H "Origin: https://$RH" -H 'Content-Type: application/json' -d "{\"code\":\"$PC\",\"name\":\"Test\"}" "$B/api/remote/claim"
CK=$(grep -i "^set-cookie: cp_dev" "$T/hdr.txt" | tr -d '\r' | sed -E 's/^[^:]*: (cp_dev=[^;]*).*/\1/')
RTOK=$(curl -s -H "Host: $RH" -b "$CK" "$B/" | grep -o 'panel-token" content="[^"]*' | cut -d'"' -f3)
R=(-H "Host: $RH" -H "Origin: https://$RH" -b "$CK" -H "X-Panel-Token: $RTOK" -H "Content-Type: application/json")
rcode() { curl -s -o /dev/null -w '%{http_code}' -X POST "${R[@]}" -d "$2" "$B$1"; }
check "telefon eşleşti" "$(curl -s -H "Host: $RH" -b "$CK" "$B/" | grep -c 'panel-remote" content="1')" 1
check "telefondan okuma: /api/mail ve Takip'te mail" "$(curl -s -H "Host: $RH" -b "$CK" "$B/api/mail" | grep -c 'test.kul@ornek.com') $(curl -s -H "Host: $RH" -b "$CK" "$B/api/followup" | grep -c 'Teklif revizyonu')" "1 1"
check "telefondan hesap ekle: 403" "$(rcode /api/mail/accounts/add '{"mail":true}')" 403
check "telefondan istemci dosyası: 403" "$(rcode /api/mail/client '{"json":"{}"}')" 403
check "telefondan kaldır: 403" "$(rcode /api/mail/accounts/remove "{\"id\":\"$ACC\"}")" 403
check "telefondan kaynak kapat: 403" "$(rcode /api/mail/accounts/sources "{\"id\":\"$ACC\",\"mail\":false,\"cal\":true}")" 403
check "telefondan büyük harfli yol da kapalı" "$(rcode /API/MAIL/ACCOUNTS/REMOVE "{\"id\":\"$ACC\"}")" 403
check "telefondan süzgeç ve Yenile açık" "$(rcode /api/mail/filter '{"cc":false}') $(rcode /api/mail/refresh '{}')" "200 202"
mailget; check "telefon istekleri hesabı silmedi" "$(j "len(d['accounts'])" "$T/mail.json")" 1

# ================= 8. Kaynak kapat/aç, izin reddi, yalnız seçilen kapsam =================
check "takvimi kapat (izin istemez)" "$(post /api/mail/accounts/sources "{\"id\":\"$ACC\",\"mail\":true,\"cal\":false}") $(j "d['accounts'][0]['cal'], d['accounts'][0]['calGranted']")" "200 False True"
snap; check "takvim kapalı: Takip'te etkinlik yok" "$(q "E, M['calOn']")" "[] False"
check "izinli kaynağı yeniden aç: giriş gerekmez" "$(post /api/mail/accounts/sources "{\"id\":\"$ACC\",\"mail\":true,\"cal\":true}")" 200
senaryo red; akis "{\"mail\":true,\"cal\":true,\"id\":\"$ACC\"}"
check "var olan hesaba giriş: login_hint adres" "$(url_param login_hint)" "test.kul@ornek.com"
curl -s -L "$AUTH" > /dev/null
check "izin reddi: giriş başarısız (denied), hesap duruyor" "$(bekle_giris) $(j "d['login']['error'], len(d['accounts'])" "$T/mail.json")" "failed denied 1"
senaryo yalniz_takvim; akis '{"mail":false,"cal":true}'
check "yalnız takvim: kapsam yalnız calendar.readonly" "$(url_param scope)" "https://www.googleapis.com/auth/calendar.readonly"
curl -s -L "$AUTH" > /dev/null
check "yalnız takvimle eklenen hesap adresi takvimden" "$(bekle_giris) $(istek 'calendars/primary[[:space:]]*$')" "done 1"
mailget; check "aynı adres: yeni hesap açılmadı, izinler güncellendi" "$(j "[(a['mail'], a['cal'], a['mailGranted']) for a in d['accounts']]" "$T/mail.json")" "[(False, True, False)]"
check "izni olmayan maili açmak giriş ister: 409 needauth" "$(post /api/mail/accounts/sources "{\"id\":\"$ACC\",\"mail\":true,\"cal\":true}") $(j "d['error']")" "409 needauth"
senaryo ilk; akis "{\"mail\":true,\"cal\":true,\"id\":\"$ACC\"}"; curl -s -L "$AUTH" > /dev/null; bekle_giris >/dev/null
senaryo ikinci; akis '{"mail":true,"cal":false}'; curl -s -L "$AUTH" > /dev/null
check "ikinci hesap" "$(bekle_giris) $(j "sorted(a['email'] for a in d['accounts'])" "$T/mail.json")" "done ['ikinci@firma.com', 'test.kul@ornek.com']"
ACC2=$(j "[a['id'] for a in d['accounts'] if a['email']=='ikinci@firma.com'][0]" "$T/mail.json")
check "giriş iptali" "$(akis '{"mail":true,"cal":false}'; post /api/mail/accounts/cancel '{}' >/dev/null; j "d['login']['state']")" cancelled

# ================= 9. İptal edilmiş belirteç → yeniden giriş =================
senaryo iptal; kapat; baslat
snap; check "yeniden başlatma: listeler diskten (ağa çıkmadan önce)" "$(q "'t1' in K")" True
yenile
check "iptal edilmiş belirteç: hesap 'reauth', liste duruyor" "$(q "M['accounts'][0]['state'], 't1' in K")" "reauth True"
senaryo ilk

# ================= 10. Kaldır + yeniden başlatma =================
check "kaldır: 200, belirteç dosyası silindi" "$(post /api/mail/accounts/remove "{\"id\":\"$ACC2\"}") $([ -e "$DATA/secrets/mail-token-$ACC2.bin" ] && echo var || echo yok)" "200 yok"
check "bilinmeyen hesabı kaldır: 404" "$(post /api/mail/accounts/remove '{"id":"yok"}')" 404
snap; check "kaldırılan hesabın satırı yok" "$(q "sorted({m['account'] for m in M['mails']})")" "['test.kul@ornek.com']"
kapat; baslat
mailget
check "yeniden başlatma: istemci, hesap ve süzgeç korundu" "$(j "d['client'], [a['email'] for a in d['accounts']], d['filter']['keywords'], d['filter']['cc']" "$T/mail.json")" "True ['test.kul@ornek.com'] ['rapor'] False"
yenile; check "yeniden başlatma sonrası yenileme belirteciyle denetlendi" "$(q "M['accounts'][0]['state'], M['stale']")" "ok False"
check "kalan hesabın belirteci duruyor; düz belirteç yok" "$([ -s "$DATA/secrets/mail-token-$ACC.bin" ] && echo var) $(grep -rlE 'YENILEME-GIZLI' "$DATA" | wc -l)" "var 0"
check "test boyunca gövde hiç istenmedi" "$(grep -ciE 'format=(full|raw)' "$T/google.log")" 0
kapat

kill $GPID 2>/dev/null; wait $GPID 2>/dev/null
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and (\$_.CommandLine -like '*$TW*') } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
rm -rf "$T"
echo "$n denetim"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail

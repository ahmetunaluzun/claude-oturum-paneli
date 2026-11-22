#!/usr/bin/env bash
# Mail ve takvim: Gmail IMAP (uygulama şifresi) + Google Takvim iCal adresi API testi. Gerçek Google'a HİÇ bağlanılmaz:
# sahte IMAP (TLS, kendi imzalı sertifika) ve sahte iCal sunucusu = tools/sahte_imap.py.
# Kapsam: giriş doğrulama (doğru/yanlış şifre, IMAP kapalı, Workspace yöneticisi kapatmış, ağ yok, iCal reddi/bozuk), boşluklu şifre,
# iki hesap (kişisel Gmail + Workspace) birlikte, süzgeç kuralları (aynı kurallar, genel süzgeç), cevap bekleyen (Gönderilmiş klasörü
# \Sent özniteliğiyle, dil bağımsız), Gmail bağlantısı (hesaba göre authuser), Gmail uzantısı yoksa pasif kural, iCal (RRULE, EXDATE,
# RECURRENCE-ID, tüm gün, saat dilimi, iptal), yalnız okuma (yazma komutu yok, BODY.PEEK yalnız başlık), gizli değerlerin hiçbir yerde
# (yanıt, log, ayar, disk) düz görünmemesi, telefondan yazma kapalı, kaldırınca gizli dosyaların silinmesi, yeniden başlatma.
# Test kopyası --no-window, boş portta, kendi veri klasöründe; tarayıcı açılmaz. Kullanım: tools/mail_imap_test.sh [exe]
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

# ---- Sahte IMAP + iCal ----
MSYS2_ARG_CONV_EXCL="*" openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TW\anahtar.pem" -out "$TW\sertifika.pem" -days 2 -subj "/CN=127.0.0.1" >/dev/null 2>&1
SI="$(cygpath -w "$PWD/tools/sahte_imap.py")"
IP=$(freeport); CP=$(freeport)
KISI=test.kul@ornek.com; SIRK=ali.veli@sirket.com.tr
PW1="qwer tyui opas dfgh"; PW1S=qwertyuiopasdfgh        # boşluklu yapıştırılan uygulama şifresi / boşluksuz hâli
PW2="zxcv bnml kjhg fdsa"; PW2S=zxcvbnmlkjhgfdsa
ICK="http://127.0.0.1:$CP/ical/kisisel-ICALGIZLI1/basic.ics"; ICS="http://127.0.0.1:$CP/ical/sirket-ICALGIZLI2/basic.ics"
sen() { printf '%s' "$1" > "$T/senaryo.json"; }
# sen_modlar <kişisel mod> <şirket mod> [şirket ical durumu] [şirket ical içeriği]
sen_modlar() { sen "{\"hesaplar\":{\"$KISI\":{\"parola\":\"$PW1S\",\"mod\":\"$1\",\"set\":\"kisisel\"},\"$SIRK\":{\"parola\":\"$PW2S\",\"mod\":\"$2\",\"set\":\"sirket\"}},\"ical\":{\"kisisel-ICALGIZLI1\":{\"durum\":200,\"icerik\":\"kisisel\"},\"sirket-ICALGIZLI2\":{\"durum\":${3:-200},\"icerik\":\"${4:-sirket}\"}}}"; }
sen_modlar ok ok
: > "$T/imap.log"
sunucu_baslat() { py -3.13 "$SI" "$IP" "$CP" "$TW\\sertifika.pem" "$TW\\anahtar.pem" "$TW\\senaryo.json" "$TW\\imap.log" & SPID=$!
  for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$CP/x" && return 0; sleep 0.2; done; return 1; }
sunucu_durdur() { kill $SPID 2>/dev/null; wait $SPID 2>/dev/null; sleep 0.5; }
sunucu_baslat || { echo "sahte sunucu açılmadı"; rm -rf "$T"; exit 1; }

PID=""; PORT=""; B=""; TOK=""; DATA="$T/data"
baslat() {
  [ -f "$DATA/tray.json" ] || printf '{"Notify":false,"Introduced":true}' > "$DATA/tray.json"
  PORT=$(freeport); B="http://127.0.0.1:$PORT"
  CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CLAUDE_EXE="$TW\\sahte-claude.cmd" \
    CLAUDE_PANEL_GH_EXE="$TW\\yok.cmd" CLAUDE_PANEL_REMOTE_HOST=$RH CLAUDE_PANEL_IMAP_BASE="127.0.0.1:$IP" CLAUDE_PANEL_ICAL_TEST_BASE="http://127.0.0.1:$CP" \
    CLAUDE_PANEL_MAIL_NO_BROWSER=1 CLAUDE_PANEL_MX_TEST="ornek.com=google;sirket.com.tr=google;diger.net=other" CLAUDE_PANEL_MAIL_OPEN_LOG="$TW\\acilan.txt" TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
  PID=$!
  for _ in $(seq 1 50); do [ -f "$DATA/panel-$PORT.token" ] && break; sleep 0.2; done
  TOK=$(cat "$DATA/panel-$PORT.token")
}
kapat() {
  curl -s -o /dev/null -X POST "$B/api/quit?force=1" -H "X-Panel-Token: $TOK" -H "Origin: $B"
  for _ in $(seq 1 40); do curl -s -o /dev/null "$B/api/ping" || break; sleep 0.25; done
  kill $PID 2>/dev/null; wait $PID 2>/dev/null; PID=""
}
trap '[ -n "$PID" ] && kill $PID 2>/dev/null; kill $SPID 2>/dev/null' EXIT
post() { printf '%s' "$2" > "$T/govde.json"; curl -s -o "$T/son.json" -w '%{http_code}' -X POST "$B$1" -H "X-Panel-Token: $TOK" -H "Origin: $B" -H "Content-Type: application/json" --data-binary @"$T/govde.json"; echo >> "$T/tum_yanitlar.txt"; cat "$T/son.json" >> "$T/tum_yanitlar.txt"; }
j() { py -3.13 -c "import json,sys;d=json.load(open(sys.argv[1],encoding='utf-8'));print($1)" "${2:-$T/son.json}" 2>&1; }
mailget() { curl -s "$B/api/mail" > "$T/mail.json"; cat "$T/mail.json" >> "$T/tum_yanitlar.txt"; }
# q <ifade>: son /api/followup yanıtında M = mail, K = konuşma kimliği → satır, E = etkinlik başlıkları (sıralı), A = e-posta → hesap durumu, now = şimdi (sn)
q() { py -3.13 -c "
import json,sys,time
d=json.load(open(sys.argv[1],encoding='utf-8'));M=d['mail'] or {};K={m['threadId']:m for m in M.get('mails',[])};EV=M.get('events',[]);E=[e['title'] for e in EV]
A={a['email']:a for a in M.get('accounts',[])};now=time.time()
print($1)" "$T/fu.json" 2>&1; }
snap() { curl -s "$B/api/followup" > "$T/fu.json"; cat "$T/fu.json" >> "$T/tum_yanitlar.txt"; }
# yenile: "Yenile" + tüm hesapların son deneme zamanı değişene kadar bekle
denemeler() { q "sorted(a['triedAt'] for a in M.get('accounts',[]))"; }
yenile() { local before; snap; before=$(denemeler); post /api/mail/refresh '{}' >/dev/null
  for _ in $(seq 1 100); do snap; [ "$(denemeler)" != "$before" ] && [ "$(q "M['fetching']")" = False ] && return 0; sleep 0.3; done; return 1; }
sayi() { grep -c "$1" "$T/imap.log" 2>/dev/null; }
konular() { post /api/mail/filter "$1" >/dev/null; snap; q "sorted(K)"; }
imap_ekle() { post /api/mail/imap/add "{\"email\":\"$1\",\"password\":\"$2\",\"ical\":\"${3:-}\"}"; }
hata() { echo "$(cat "$T/son.json" | py -3.13 -c "import json,sys;print(json.load(sys.stdin).get('error'))")"; }

baslat
# ================= 1. Başlangıç ve doğrulama hataları =================
mailget
check "başlangıç: istemci yok, hesap yok" "$(j "d['client'], d['accounts'], d['login']" "$T/mail.json")" "False [] None"
snap; check "hesap yokken Takip'te mail bölümü yok" "$(q "M['state']")" "off"
check "geçersiz e-posta: 400 imap_email" "$(imap_ekle 'bu bir adres degil' "$PW1") $(hata)" "400 imap_email"
check "birden çok adres: 400 imap_email" "$(imap_ekle 'a@b.com, c@d.com' "$PW1") $(hata)" "400 imap_email"
check "kısa şifre: 400 imap_format" "$(imap_ekle $KISI 'abcd efgh' ) $(hata)" "400 imap_format"
check "16 haneli ama rakamlı (hesap şifresi gibi): 400 imap_format" "$(imap_ekle $KISI 'abcd efgh 1234 ijkl') $(hata)" "400 imap_format"
check "yeni hesapta şifre yok: 400 imap_format" "$(imap_ekle $KISI '') $(hata)" "400 imap_format"
check "geçersiz iCal adresi (başka alan adı): 400 ical_invalid" "$(imap_ekle $KISI "$PW1" 'https://evil.example.com/calendar/ical/x/private-1/basic.ics') $(hata)" "400 ical_invalid"
check "iCal adresi http (güvensiz, Google dışı): 400 ical_invalid" "$(imap_ekle $KISI "$PW1" 'http://calendar.google.com/calendar/ical/x/private-1/basic.ics') $(hata)" "400 ical_invalid"
check "doğrulama hatalarında sunucuya hiç gidilmedi" "$(sayi 'LOGIN')" 0
sen_modlar auth ok
check "yanlış şifre (sunucu AUTHENTICATIONFAILED): 400 imap_auth" "$(imap_ekle $KISI "$PW1") $(hata)" "400 imap_auth"
sen_modlar ok ok
check "başka hesabın şifresi: 400 imap_auth" "$(imap_ekle $KISI 'aaaa bbbb cccc dddd') $(hata)" "400 imap_auth"
sen_modlar disabled ok
check "IMAP hesapta kapalı (\"not enabled for IMAP use\"): 400 imap_disabled" "$(imap_ekle $KISI "$PW1") $(hata)" "400 imap_disabled"
sen_modlar ok domain
check "Workspace: yönetici IMAP'i kapatmış (\"disabled for your domain\"): 400 imap_domain" "$(imap_ekle $SIRK "$PW2") $(hata)" "400 imap_domain"
sen_modlar ok auth
check "Workspace: uygulama şifresi kabul edilmedi: 400 imap_auth" "$(imap_ekle $SIRK "$PW2") $(hata)" "400 imap_auth"
sen_modlar ok ok 404
check "Workspace: dışa iCal paylaşımı kapalı (404): 400 ical_denied" "$(imap_ekle $SIRK "$PW2" "$ICS") $(hata)" "400 ical_denied"
sen_modlar ok ok 200 bozuk
check "iCal adresi iCal döndürmüyor: 400 ical_parse" "$(imap_ekle $SIRK "$PW2" "$ICS") $(hata)" "400 ical_parse"
sen_modlar ok ok
mailget; check "hiçbir hata hesap oluşturmadı, gizli dosya yok" "$(j "len(d['accounts'])" "$T/mail.json") $(ls "$DATA/secrets" 2>/dev/null | wc -l)" "0 0"
sunucu_durdur
check "ağ yok (sunucu kapalı): 400 imap_net" "$(imap_ekle $KISI "$PW1") $(hata)" "400 imap_net"
sunucu_baslat

# ================= 1b. Sihirbaz uçları: alan adı denetimi, Google sayfalarını açma =================
prov() { post /api/mail/imap/provider "{\"email\":\"$1\"}" >/dev/null; j "d.get('provider') or d.get('error')"; }
check "alan adı: gmail.com Google" "$(prov kisi@gmail.com)" google
check "alan adı: googlemail.com Google" "$(prov kisi@googlemail.com)" google
check "alan adı: MX'i Google olan şirket alanı Google" "$(prov $SIRK) $(prov $KISI)" "google google"
check "alan adı: Google olmayan sağlayıcı 'other' (desteklenmiyor)" "$(prov biri@diger.net)" other
check "alan adı: adres değilse 400 imap_email" "$(post /api/mail/imap/provider '{"email":"adres degil"}') $(hata)" "400 imap_email"
: > "$T/acilan.txt"
ac() { post /api/mail/open "{\"target\":\"$1\",\"email\":\"$2\"}"; }
check "uygulama şifresi sayfası (authuser=<e-posta>), tarayıcı açılmadı" "$(ac apppasswords $KISI) $(j "d['url'], d['opened']")" "200 https://myaccount.google.com/apppasswords?authuser=test.kul%40ornek.com True"
check "iki adımlı doğrulama sayfası" "$(ac twosv $SIRK) $(j "d['url']")" "200 https://myaccount.google.com/signinoptions/twosv?authuser=ali.veli%40sirket.com.tr"
check "takvim ayarları sayfası" "$(ac calendar $KISI) $(j "d['url']")" "200 https://calendar.google.com/calendar/r/settings?authuser=test.kul%40ornek.com"
check "açma kaydı: tam bu üç adres, başka hiçbir şey" "$(cat "$T/acilan.txt" | tr '\n' ' ')" "https://myaccount.google.com/apppasswords?authuser=test.kul%40ornek.com https://myaccount.google.com/signinoptions/twosv?authuser=ali.veli%40sirket.com.tr https://calendar.google.com/calendar/r/settings?authuser=test.kul%40ornek.com "
check "keyfi hedef/adres açılmaz: 400" "$(ac 'https://evil.example.com' $KISI) $(ac '../x' $KISI)" "400 400"
check "e-posta içine sokulan sorgu kaçışlanır (ek parametre eklenemez)" "$(ac apppasswords 'a@b.com&x=1' >/dev/null; j "d['url']")" "https://myaccount.google.com/apppasswords?authuser=a%40b.com%26x%3D1"
check "geçersiz e-postayla açma: 400" "$(ac apppasswords 'adres degil')" 400

# ================= 2. Kişisel Gmail: IMAP + iCal =================
check "kişisel hesap eklendi (boşluklu şifre, iCal adresiyle)" "$(imap_ekle $KISI "$PW1" "$ICK") $(j "[(a['email'], a['provider'], a['mail'], a['cal'], a['mailGranted'], a['calGranted']) for a in d['accounts']]")" "200 [('test.kul@ornek.com', 'imap', True, True, True, True)]"
check "bağlan sonucu kanıtı: gelen kutusunda 8 okunmamış, takvimde 5 etkinlik" "$(j "d['result']['unseen'], d['result']['events']")" "8 5"
ACC=$(j "d['accounts'][0]['id']")
for _ in $(seq 1 60); do snap; [ "$(q "M['state'], M['checkedAt'] > 0, M['fetching']")" = "ok True False" ] && break; sleep 0.3; done
check "eklenince hemen denetlendi" "$(q "M['state'], M['stale'], A['$KISI']['state']")" "ok False ok"
check "varsayılan süzgeç: doğrudan + cevap bekleyen (1771 1772 1773 1776 1778)" "$(q "sorted(K)")" "['1771', '1772', '1773', '1776', '1778']"
check "cevap bekleyen: Gönderilmiş klasöründe sonrası cevap olan (1773) ve kendi mesajım yok" "$(q "sorted(k for k,m in K.items() if m['awaiting'])")" "['1771', '1772', '1776', '1778']"
check "uyan kurallar satırda" "$(q "K['1771']['rules'], K['1772']['rules'], K['1773']['rules']")" "['awaiting', 'direct'] ['awaiting'] ['direct']"
check "konuşmanın en yeni mesajı" "$(q "K['1776']['subject'], K['1776']['id']")" "Destek kaydı #42 güncellendi 106"
check "RFC 2047 konu (katlanmış) ve ad çözüldü" "$(q "K['1778']['subject'], K['1778']['fromName'], K['1778']['fromAddr']")" "Türkçe başlık: çğıöşü Şahin Öztürk sahin@musteri.com"
check "satır: hesap ve tarih (INTERNALDATE)" "$(q "K['1771']['account'], 3500*1000 < (now*1000 - K['1771']['date']) < 3*3600_000 or (now*1000 - K['1771']['date'])")" "test.kul@ornek.com True"
check "Gmail'de aç: konuşma kimliği onaltılık, hesaba göre authuser" "$(q "K['1771']['url']")" "https://mail.google.com/mail/?authuser=test.kul%40ornek.com#all/1771"
check "Gmail uzantısı var: bağlantı + cevap bekleyen açık" "$(q "A['$KISI']['gmailLink'], A['$KISI']['awaitingOk']")" "True True"
check "cevap bekleyenler önce, kendi içinde yeniden eskiye" "$(q "[m['threadId'] for m in M['mails']][:4]")" "['1771', '1778', '1772', '1776']"
check "takvim: tüm gün, tek, günlük (RRULE+TZID), sayılı, taşınan tekrar; iptal/uzak/EXDATE/bitmiş yok" "$(q "E")" "['Bayram tatili', 'Proje toplantısı', 'Günlük ekip toplantısı', 'Sayılı tekrar', 'Kayan tekrar (taşındı)']"
check "RRULE + Europe/Istanbul: bugünkü olay şimdi+5 saatte" "$(q "abs(next(e['start'] for e in EV if e['id'].startswith('gunluk'))/1000 - (now+5*3600)) < 120")" True
check "RECURRENCE-ID: taşınan olay şimdi+10 saatte" "$(q "abs(next(e['start'] for e in EV if e['id'].startswith('kayan'))/1000 - (now+10*3600)) < 120")" True
check "tüm gün etkinliği" "$(q "[e['allDay'] for e in EV if e['title']=='Bayram tatili']")" "[True]"
check "etkinlik: yer, toplantı bağlantısı (X-GOOGLE-CONFERENCE), süre" "$(q "[(e['location'], e['join'], round((e['end']-e['start'])/3600000)) for e in EV if e['title']=='Proje toplantısı']")" "[('Toplantı odası 2', 'https://meet.google.com/abc-defg-hij', 1)]"
check "etkinlik adresi: Google Takvim" "$(q "EV[1]['url']")" "https://calendar.google.com/calendar/r"
check "kayan olay yalnız bir kez (eski saat yok)" "$(q "sum(1 for e in EV if e['title'].startswith('Kayan'))")" 1
check "IMAP: yalnız izinli komutlar (CAPABILITY LOGIN STATUS LIST EXAMINE UID SEARCH/FETCH LOGOUT)" "$(grep -P '^IMAP\t' "$T/imap.log" | cut -f3 | awk '{print $1" "($1=="UID"?$2:"")}' | sort -u | tr '\n' ',' | sed 's/ ,/,/g')" "CAPABILITY,EXAMINE,LIST,LOGIN,LOGOUT,STATUS,UID FETCH,UID SEARCH,"
check "yazma/SELECT komutu hiç gelmedi (YASAK satırı yok)" "$(sayi '^YASAK')" 0
check "yalnız EXAMINE (salt okunur); Gönderilmiş klasörü \\Sent özniteliğiyle bulundu (dil bağımsız)" "$(grep -P '\tEXAMINE ' "$T/imap.log" | cut -f3 | sort -u | tr '\n' '|')" "EXAMINE INBOX|EXAMINE [Gmail]/G&APY-nderilmi&AV8- Postalar|"
check "getirme: yalnız BODY.PEEK[HEADER.FIELDS] (gövde, RFC822, TEXT yok)" "$(grep 'UID FETCH' "$T/imap.log" | grep -vcE 'BODY\.PEEK\[HEADER\.FIELDS \(FROM TO CC SUBJECT\)\]|\(UID INTERNALDATE X-GM-THRID\)') $(grep -ciE 'RFC822|BODY\[TEXT|BODY\.PEEK\[\]|BODY\[\]' "$T/imap.log")" "0 0"
check "iCal: yalnız GET (kişisel adres)" "$(grep -c '^ICAL	kisisel-ICALGIZLI1	200' "$T/imap.log")" "$(grep -c '^ICAL	kisisel' "$T/imap.log")"
check "gizli dosyalar şifreli: şifre + iCal adresi" "$([ -s "$DATA/secrets/mail-token-$ACC.bin" ] && echo var) $([ -s "$DATA/secrets/mail-ical-$ACC.bin" ] && echo var)" "var var"
check "veri klasöründe (log, ayar, liste dahil) düz şifre ve iCal anahtarı yok" "$(grep -rlE "$PW1S|ICALGIZLI" "$DATA" 2>/dev/null | wc -l)" 0
check "hiçbir API yanıtında şifre / iCal adresi yok" "$(grep -cE "$PW1S|ICALGIZLI|127.0.0.1:$CP/ical" "$T/tum_yanitlar.txt")" 0
check "ayar dosyasında adres var, gizli değer yok" "$(grep -c "$KISI" "$DATA/mail-settings.json") $(grep -cE 'qwer|ICAL' "$DATA/mail-settings.json")" "1 0"
check "mail listesi diske gizli değersiz yazıldı" "$(grep -c 'Teklif revizyonu' "$DATA/mail-watch.json") $(grep -cE 'qwer|ICAL' "$DATA/mail-watch.json")" "1 0"

# ================= 3. Süzgeç kuralları (aynı kurallar, IMAP verisinde) =================
N0=$(wc -l < "$T/imap.log")
check "hiçbir kural yok: boş + not" "$(konular '{"direct":false,"cc":false,"awaiting":false,"senders":[],"keywords":[],"labels":[]}') $(q "M['filterEmpty']")" "[] True"
check "bana doğrudan" "$(konular '{"direct":true}')" "['1771', '1773', '1776', '1778']"
check "CC: yalnız 1772" "$(konular '{"direct":false,"cc":true}')" "['1772']"
check "cevap bekleyen" "$(konular '{"cc":false,"awaiting":true}')" "['1771', '1772', '1776', '1778']"
post /api/mail/filter '{"awaiting":false}' >/dev/null
check "gönderen alan adı @musteri.com" "$(konular '{"senders":["@musteri.com"]}')" "['1771', '1773', '1778']"
check "tam adres (büyük harf)" "$(konular '{"senders":["ALI@musteri.com"]}')" "['1771']"
check "alt alan adı ornek.com → destek.ornek.com; kendi mesajım listelenmez" "$(konular '{"senders":["ornek.com"]}')" "['1776']"
check "olumsuz: usteri.com" "$(konular '{"senders":["usteri.com"]}')" "[]"
check "anahtar kelime: acil → ACİL (Türkçe büyük harf)" "$(konular '{"senders":[],"keywords":["acil"]}')" "['1774']"
check "anahtar kelime çözülmüş konuda: çğıöşü" "$(konular '{"keywords":["ÇĞIÖŞÜ"]}')" "['1778']"
check "Gmail etiketi: BÜLTEN (kullanıcı etiketi)" "$(konular '{"keywords":[],"labels":["BÜLTEN"]}')" "['1774']"
check "Gmail etiketi mUTF-7 çözüldü: Müşteri" "$(konular '{"labels":["Müşteri"]}')" "['1778']"
check "sistem etiketi: IMPORTANT (\\Important)" "$(konular '{"labels":["important"]}')" "['1771']"
check "olumsuz: Fatura etiketi" "$(konular '{"labels":["Fatura"]}')" "[]"
check "kurallar VEYA ile" "$(konular '{"labels":["Bülten"],"cc":true}') $(q "K['1774']['rules'], K['1772']['rules']")" "['1772', '1774'] ['label'] ['cc']"
check "süzgeç değişikliği IMAP'e gitmedi" "$(wc -l < "$T/imap.log")" "$N0"
post /api/mail/filter '{"direct":true,"cc":false,"awaiting":true,"senders":[],"keywords":[],"labels":[]}' >/dev/null

# ================= 4. İkinci hesap: Workspace (şirket) — iki hesap birlikte =================
check "Workspace hesabı eklendi (kendi şifresi + kendi iCal adresi)" "$(imap_ekle $SIRK "$PW2" "$ICS") $(j "sorted(a['email'] for a in d['accounts'])")" "200 ['ali.veli@sirket.com.tr', 'test.kul@ornek.com']"
check "Workspace bağlan sonucu: 3 okunmamış, 5 etkinlik" "$(j "d['result']['unseen'], d['result']['events']")" "3 5"
ACC2=$(j "[a['id'] for a in d['accounts'] if a['email']=='$SIRK'][0]")
for _ in $(seq 1 80); do snap; [ "$(q "len(M['accounts']), all(a['state']=='ok' for a in M['accounts']), M['fetching']")" = "2 True False" ] && break; sleep 0.3; done
check "iki hesap da okunuyor" "$(q "A['$KISI']['state'], A['$SIRK']['state']")" "ok ok"
check "satırlarda hangi hesaptan geldiği görünür" "$(q "sorted((m['account'], m['threadId']) for m in M['mails'])")" "[('ali.veli@sirket.com.tr', '1b59'), ('ali.veli@sirket.com.tr', '1b5a'), ('ali.veli@sirket.com.tr', '1b5b'), ('test.kul@ornek.com', '1771'), ('test.kul@ornek.com', '1772'), ('test.kul@ornek.com', '1773'), ('test.kul@ornek.com', '1776'), ('test.kul@ornek.com', '1778')]"
check "Gmail'de aç: her satır kendi hesabıyla (authuser=<e-posta>)" "$(q "K['1b59']['url'], K['1771']['url']")" "https://mail.google.com/mail/?authuser=ali.veli%40sirket.com.tr#all/1b59 https://mail.google.com/mail/?authuser=test.kul%40ornek.com#all/1771"
check "Workspace cevap bekleyen: cevapladığım (1b5b) değil" "$(q "sorted(k for k,m in K.items() if m['awaiting'] and m['account']=='$SIRK')")" "['1b59', '1b5a']"
check "takvim: iki hesabın etkinliği, hesap adıyla" "$(q "sorted(set(e['account'] for e in EV)), sum(1 for e in EV if e['title'].startswith('Şirket: '))")" "['ali.veli@sirket.com.tr', 'test.kul@ornek.com'] 5"
check "süzgeç GENEL (hesap başına değil): @sirket.com.tr yalnız şirket satırı" "$(konular '{"direct":false,"awaiting":false,"senders":["@sirket.com.tr"]}')" "['1b59', '1b5a', '1b5b']"
check "aynı süzgeç iki hesapta: @musteri.com yalnız kişisel satır" "$(konular '{"senders":["@musteri.com"]}')" "['1771', '1773', '1778']"
post /api/mail/filter '{"direct":true,"cc":false,"awaiting":true,"senders":[],"keywords":[],"labels":[]}' >/dev/null
check "iki hesabın ayrı gizli dosyaları" "$(ls "$DATA/secrets" | sort | tr '\n' ' ')" "$(printf 'mail-ical-%s.bin mail-ical-%s.bin mail-token-%s.bin mail-token-%s.bin ' $ACC $ACC2 $ACC $ACC2 | tr ' ' '\n' | sort | tr '\n' ' ')"
check "ikinci şifre/iCal anahtarı da düz değil" "$(grep -rlE "$PW2S|ICALGIZLI2" "$DATA" 2>/dev/null | wc -l) $(grep -cE "$PW2S|ICALGIZLI" "$T/tum_yanitlar.txt")" "0 0"

# ================= 5. Workspace yönetici kısıtları (hesap başına, ayrı durum) =================
sen_modlar ok auth; yenile
check "şifre kabul edilmedi: yalnız Workspace 'reauth', kişisel etkilenmedi, liste duruyor" "$(q "A['$SIRK']['state'], A['$KISI']['state'], '1b59' in K, '1771' in K")" "reauth ok True True"
sen_modlar ok domain; yenile
check "yönetici IMAP'i kapatmış: 'domain'" "$(q "A['$SIRK']['state'], A['$KISI']['state']")" "domain ok"
sen_modlar ok disabled; yenile
check "IMAP hesapta kapalı: 'disabled'" "$(q "A['$SIRK']['state']")" "disabled"
sen_modlar ok ok 404; yenile
check "iCal paylaşımı kapalı (404): 'icaldenied'; mail akmaya devam, takvim duruyor" "$(q "A['$SIRK']['state'], '1b59' in K, sum(1 for e in EV if e['title'].startswith('Şirket: '))")" "icaldenied True 5"
sen_modlar ok ok 200 bozuk; yenile
check "iCal yerine başka içerik: 'icaldenied'" "$(q "A['$SIRK']['state']")" "icaldenied"
sen_modlar ok ok; yenile
check "kısıt kalkınca düzeldi (kalıcı kilit yok)" "$(q "A['$SIRK']['state'], A['$KISI']['state'], M['stale']")" "ok ok False"

# ================= 6. Ağ yok =================
sunucu_durdur; yenile
check "ağ yok: listeler duruyor + bayat, iki hesap 'net'" "$(q "'1771' in K, '1b59' in K, M['stale'], A['$KISI']['state'], A['$SIRK']['state'], len(E)")" "True True True net net 10"
sunucu_baslat; yenile
check "ağ gelince yenilendi (kalıcı kilit yok)" "$(q "M['stale'], A['$KISI']['state'], A['$SIRK']['state']")" "False ok ok"

# ================= 7. Gmail uzantısı yok / Gönderilmiş klasörü yok =================
sen_modlar nogm ok; yenile
check "Gmail uzantısı yok: bağlantı ve cevap bekleyen pasif (hesap başına)" "$(q "A['$KISI']['gmailLink'], A['$KISI']['awaitingOk'], A['$SIRK']['gmailLink'], A['$SIRK']['awaitingOk']")" "False False True True"
check "pasifken 'cevap bekliyor' uydurulmaz: doğrudan satırlar, bağlantı boş" "$(q "sorted(k for k,m in K.items() if m['account']=='$KISI' and 'awaiting' in m['rules']), [m['url'] for m in M['mails'] if m['account']=='$KISI'][:1]")" "[] ['']"
check "Takip'e pasif kural bilgisi (süzgeçte cevap bekleyen açık)" "$(q "M['filterAwaiting']")" True
sen_modlar nosent ok; yenile
check "Gönderilmiş klasörü yok: cevap bekleyen pasif, Gmail bağlantısı duruyor" "$(q "A['$KISI']['gmailLink'], A['$KISI']['awaitingOk']")" "True False"
sen_modlar ok ok; yenile
check "uzantı geri gelince kural yeniden etkin" "$(q "A['$KISI']['gmailLink'], A['$KISI']['awaitingOk'], K['1771']['awaiting']")" "True True True"

# ================= 8. Var olan hesabı güncelle =================
check "şifresiz + iCal'siz tekrar kaydet: hesap sayısı aynı" "$(imap_ekle $KISI '') $(j "len(d['accounts'])")" "200 2"
check "şifre değiştir (yeniden giriş)" "$(imap_ekle $KISI "$PW1") $(j "len(d['accounts'])")" "200 2"
check "yalnız iCal adresi güncelle (şifre boş: eskisi kalır; 'Dene' sonucu etkinlik sayısı)" "$(imap_ekle $KISI '' "$ICK") $(j "len(d['accounts']), d['result']['unseen'], d['result']['events']")" "200 2 None 5"
check "yanlış şifreyle güncelleme eskisini bozmaz" "$(imap_ekle $KISI 'aaaa bbbb cccc dddd') $(hata) $(yenile; q "A['$KISI']['state']")" "400 imap_auth ok"

# ================= 9. Telefondan: okuma açık, yazma kapalı =================
L=(-H "X-Panel-Token: $TOK" -H "Content-Type: application/json")
curl -s -o /dev/null -X POST "${L[@]}" -d '{"enabled":true}' "$B/api/remote/enable"
PC=$(curl -s -X POST "${L[@]}" "$B/api/remote/pair" | grep -o '"code":"[0-9]*' | cut -d'"' -f4)
curl -s -o /dev/null -D "$T/hdr.txt" -X POST -H "Host: $RH" -H "Origin: https://$RH" -H 'Content-Type: application/json' -d "{\"code\":\"$PC\",\"name\":\"Test\"}" "$B/api/remote/claim"
CK=$(grep -i "^set-cookie: cp_dev" "$T/hdr.txt" | tr -d '\r' | sed -E 's/^[^:]*: (cp_dev=[^;]*).*/\1/')
RTOK=$(curl -s -H "Host: $RH" -b "$CK" "$B/" | grep -o 'panel-token" content="[^"]*' | cut -d'"' -f3)
R=(-H "Host: $RH" -H "Origin: https://$RH" -b "$CK" -H "X-Panel-Token: $RTOK" -H "Content-Type: application/json")
rcode() { curl -s -o /dev/null -w '%{http_code}' -X POST "${R[@]}" -d "$2" "$B$1"; }
check "telefon eşleşti" "$(curl -s -H "Host: $RH" -b "$CK" "$B/" | grep -c 'panel-remote" content="1')" 1
check "telefondan okuma: /api/mail ve Takip'te mail" "$(curl -s -H "Host: $RH" -b "$CK" "$B/api/mail" | grep -c "$KISI") $(curl -s -H "Host: $RH" -b "$CK" "$B/api/followup" | grep -c 'Teklif revizyonu')" "1 1"
check "telefondan IMAP hesabı ekle: 403" "$(rcode /api/mail/imap/add "{\"email\":\"$KISI\",\"password\":\"$PW1\"}")" 403
check "telefondan büyük harfli yol da kapalı" "$(rcode /API/MAIL/IMAP/ADD "{\"email\":\"$KISI\",\"password\":\"$PW1\"}")" 403
check "telefondan sayfa açma ve alan adı denetimi: 403" "$(rcode /api/mail/open "{\"target\":\"apppasswords\",\"email\":\"$KISI\"}") $(rcode /api/mail/imap/provider "{\"email\":\"$KISI\"}")" "403 403"
check "telefondan kaldır: 403" "$(rcode /api/mail/accounts/remove "{\"id\":\"$ACC\"}")" 403

# ================= 10. Kapat/aç, kaldır, yeniden başlatma =================
sen_modlar ok ok
check "takvimi kapat (izin istemez); adres kayıtlı kalır" "$(post /api/mail/accounts/sources "{\"id\":\"$ACC\",\"mail\":true,\"cal\":false}") $(j "[(a['cal'], a['calGranted']) for a in d['accounts'] if a['id']=='$ACC']")" "200 [(False, True)]"
check "adresi kayıtlı kaynak yeniden açılır (giriş gerekmez)" "$(post /api/mail/accounts/sources "{\"id\":\"$ACC\",\"mail\":true,\"cal\":true}")" 200
kapat; baslat
snap; check "yeniden başlatma: listeler diskten" "$(q "'1771' in K, '1b59' in K")" "True True"
mailget; check "yeniden başlatma: iki hesap ve süzgeç korundu" "$(j "sorted(a['email'] for a in d['accounts']), d['filter']['direct'], d['filter']['awaiting']" "$T/mail.json")" "['ali.veli@sirket.com.tr', 'test.kul@ornek.com'] True True"
yenile; check "yeniden başlatma sonrası kayıtlı şifre + adresle denetlendi" "$(q "A['$KISI']['state'], A['$SIRK']['state'], M['stale'], len(E)")" "ok ok False 10"
check "kaldır: 200, iki gizli dosya silindi" "$(post /api/mail/accounts/remove "{\"id\":\"$ACC2\"}") $([ -e "$DATA/secrets/mail-token-$ACC2.bin" ] && echo var || echo yok) $([ -e "$DATA/secrets/mail-ical-$ACC2.bin" ] && echo var || echo yok)" "200 yok yok"
snap; check "kaldırılan hesabın satırı ve etkinliği yok" "$(q "sorted({m['account'] for m in M['mails']}), sorted({e['account'] for e in EV})")" "['test.kul@ornek.com'] ['test.kul@ornek.com']"
check "kalan hesabın gizli dosyaları duruyor" "$([ -s "$DATA/secrets/mail-token-$ACC.bin" ] && echo var) $([ -s "$DATA/secrets/mail-ical-$ACC.bin" ] && echo var)" "var var"
check "test boyunca: yazma komutu yok, düz şifre/adres hiçbir yerde yok" "$(sayi '^YASAK') $(grep -rlE "$PW1S|$PW2S|ICALGIZLI" "$DATA" 2>/dev/null | wc -l) $(grep -cE "$PW1S|$PW2S|ICALGIZLI" "$T/tum_yanitlar.txt") $(grep -cE "$PW1S|$PW2S" "$T/imap.log")" "0 0 0 0"
kapat

kill $SPID 2>/dev/null; wait $SPID 2>/dev/null
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and (\$_.CommandLine -like '*$TW*') } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
rm -rf "$T"
echo "$n denetim"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail

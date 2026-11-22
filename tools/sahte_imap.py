# Sahte Gmail IMAP (TLS, kendi imzalı sertifika) ve sahte Google Takvim iCal sunucusu: Gmail uygulama şifresi yolu gerçek Google'a
# bağlanmasın diye (tools/mail_imap_test.sh, mail_imap_ui_test.sh). Panel CLAUDE_PANEL_IMAP_BASE ve CLAUDE_PANEL_ICAL_TEST_BASE ile buraya
# yönlendirilir. Python stdlib. Gmail davranışı: https://developers.google.com/workspace/gmail/imap/imap-extensions
#   (X-GM-THRID/X-GM-MSGID/X-GM-LABELS; etiketler değiştirilmiş UTF-7), RFC 6154 (\Sent özniteliği), RFC 3501 (EXAMINE salt okunur).
# Senaryo dosyası her istekte okunur (test çalışırken değiştirilebilir):
#   {"hesaplar": {"<e-posta>": {"parola": "...", "mod": "ok" | "auth" | "disabled" | "domain" | "nogm" | "nosent", "set": "kisisel" | "sirket" | "grup" (120 grup postası) | "cok" (1100 grup postası)}},
#    "ical": {"<anahtar>": {"durum": 200, "icerik": "kisisel" | "sirket" | "bozuk"}}}
#   mod: auth = AUTHENTICATIONFAILED; disabled = "Your account is not enabled for IMAP use"; domain = "IMAP access is disabled for your domain";
#        nogm = Gmail uzantısı (X-GM-EXT-1) yok; nosent = Gönderilmiş klasörü (\Sent) yok.
# Log (her satır SEKME ile): IMAP<TAB>hesap<TAB>komut   |   ICAL<TAB>anahtar<TAB>durum   |   YASAK<TAB>hesap<TAB>komut (yazma komutu geldi: test bunu 0 bekler)
# Parola loga YAZILMAZ (LOGIN satırında yalnız sonucu).
# Kullanım: py -3.13 sahte_imap.py <imap-port> <ical-port> <sertifika.pem> <anahtar.pem> <senaryo.json> <log>
import json, re, socketserver, ssl, sys, threading, time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

AYLAR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
LOCK = threading.Lock()


def logla(satir):
    with LOCK, open(LOG, "a", encoding="utf-8") as f:
        f.write(satir + "\n")


def senaryo():
    try:
        with open(SENARYO, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"hesaplar": {}, "ical": {}}


def utf7(s):
    """Değiştirilmiş UTF-7 (RFC 3501 §5.1.3): ASCII dışı dizileri &base64- olarak yazar."""
    import base64
    out, run = "", ""
    for ch in s + "\0":
        if ch != "\0" and ord(ch) > 126:
            run += ch
            continue
        if run:
            out += "&" + base64.b64encode(run.encode("utf-16-be")).decode().rstrip("=").replace("/", ",") + "-"
            run = ""
        if ch == "&":
            out += "&-"
        elif ch != "\0":
            out += ch
    return out


def rfc2047(s):
    import base64
    return "=?UTF-8?B?" + base64.b64encode(s.encode("utf-8")).decode() + "?="


def grup_seti(me, adet, adim):
    """Grup/liste adresleriyle gelen mailler (Kime/CC'de kullanıcı YOK; Google Workspace saha tespiti). Hesabın alan adı: me'nin alanı.
    i % 5: 0 → ekip@ (Kime), 1 → destek@ (Kime), 2 → ece@ (kişi, Kime), 3 → harici Kime + ekip@ CC, 4 → başka alan adındaki liste (öneri DEĞİL).
    Ayrıca kullanıcıya doğrudan 2 mail (uid 1500, 1501) ve destek@ konuşmalarından birine (i=1) benim cevabım (uid 1600, gönderilmiş)."""
    d = me.split("@")[1]
    out = []
    for i in range(adet):
        k = i % 5
        kime, cc = [(f"ekip@{d}", ""), (f"destek@{d}", ""), (f"ece@{d}", ""), ("dis@harici.com", f"ekip@{d}"), ("liste@baska.com", "")][k]
        out.append((1000 + i, 9000 + i, f"Dış Kişi <dis{i % 7}@musteri.com>", kime, cc, f"Grup postası {i}", i * adim, ["\\Inbox"], "inbox"))
    out.append((1500, 9500, "Müdür <mudur@musteri.com>", me, "", "Doğrudan bana", 1, ["\\Inbox"], "inbox"))
    out.append((1501, 9501, "Ali <ali@musteri.com>", f"ekip@{d}", me, "CC ile bana", 3, ["\\Inbox"], "inbox"))
    out.append((1600, 9001, f"Ben <{me}>", "dis1@musteri.com", "", "Re: Grup postası 1", 0.5, ["\\Sent"], "sent"))
    return out


def iletiler(set_adi, me):
    """(uid, thrid, kimden, kime, cc, konu, saat önce, etiketler, klasör). Konu/etiket örnekleri: RFC 2047, katlanmış başlık, mUTF-7."""
    if set_adi in ("grup", "cok"):
        return grup_seti(me, 120 if set_adi == "grup" else 1100, 2.0 if set_adi == "grup" else 0.3)
    if set_adi == "sirket":
        return [
            (201, 7001, "Müdür <mudur@sirket.com.tr>", me, "", "Bütçe onayı", 1, ["\\Inbox", "\\Important"], "inbox"),
            (202, 7002, "İK <ik@sirket.com.tr>", "herkes@sirket.com.tr", me, "Yıllık izin planı", 4, ["\\Inbox"], "inbox"),
            (203, 7003, "Ece <ece@sirket.com.tr>", me, "", "Sunum dosyası", 9, ["\\Inbox", "Proje"], "inbox"),
            (204, 7003, f"Ben <{me}>", "ece@sirket.com.tr", "", "Re: Sunum dosyası", 8, ["\\Sent"], "sent"),
        ]
    return [
        (101, 6001, "Ali Kaya <ali@musteri.com>", me, "", "Teklif revizyonu", 2, ["\\Inbox", "\\Important"], "inbox"),
        (102, 6002, "Veli <veli@firma.com>", "ekip@firma.com", me, "Haftalık rapor", 5, ["\\Inbox"], "inbox"),
        (106, 6006, "Destek <zeynep@destek.ornek.com>", me, "", "Destek kaydı #42 güncellendi", 6, ["\\Inbox"], "inbox"),
        (103, 6003, "Ayşe <ayse@musteri.com>", me, "", "Sözleşme taslağı", 24, ["\\Inbox"], "inbox"),
        (301, 6003, f"Test Kul <{me}>", "ayse@musteri.com", "", "Re: Sözleşme taslağı", 20, ["\\Sent"], "sent"),
        (104, 6004, "Haber Bülteni <bulten@haber.com>", "liste@haber.com", "", "ACİL indirim bülteni", 30, ["\\Inbox", "Bülten"], "inbox"),
        (105, 6005, f"Test Kul <{me}>", "ali@musteri.com", "", "Kendime not", 40, ["\\Inbox", "\\Sent"], "inbox"),
        (107, 6006, "Destek <zeynep@destek.ornek.com>", me, "", "Destek kaydı #42", 50, ["\\Inbox"], "inbox"),
        (108, 6008, "Şahin Öztürk <sahin@musteri.com>", me, "", "Türkçe başlık: çğıöşü", 3, ["\\Inbox", "Müşteri"], "inbox"),
        (302, 6009, f"Test Kul <{me}>", "kim@x.com", "", "Başka konu", 60, ["\\Sent"], "sent"),
    ]


def tarih(ms):
    t = datetime.fromtimestamp(ms / 1000, timezone.utc)
    return f"{t.day:02d}-{AYLAR[t.month - 1]}-{t.year} {t:%H:%M:%S} +0000"


def baslik_blok(kimden, kime, cc, konu):
    # Konu: ASCII dışıysa RFC 2047, uzunsa katlanmış (satır başında boşlukla devam)
    def adres(a):
        m = re.match(r"^(.*?)\s*<(.+)>$", a)
        if m and re.search(r"[^\x00-\x7f]", m.group(1)):
            return f"{rfc2047(m.group(1))} <{m.group(2)}>"
        return a
    k = rfc2047(konu) if re.search(r"[^\x00-\x7f]", konu) else konu
    if len(k) > 40:
        k = k[:38] + "\r\n " + k[38:]
    satirlar = [f"From: {adres(kimden)}", f"To: {kime}"]
    if cc:
        satirlar.append(f"Cc: {cc}")
    satirlar.append(f"Subject: {k}")
    return ("\r\n".join(satirlar) + "\r\n\r\n").encode("utf-8")


class Imap(socketserver.StreamRequestHandler):
    def yaz(self, b):
        if isinstance(b, str):
            b = b.encode("utf-8")
        self.wfile.write(b)
        self.wfile.flush()

    def handle(self):
        self.hesap, self.kutu, self.giris = None, None, False
        self.yaz("* OK Sahte Gmail IMAP hazir\r\n")
        while True:
            satir = self.rfile.readline()
            if not satir:
                return
            satir = satir.decode("utf-8", "replace").rstrip("\r\n")
            m = re.match(r"^(\S+) (\S+)(?: (.*))?$", satir)
            if not m:
                self.yaz("* BAD tanimsiz\r\n")
                continue
            tag, fiil, arg = m.group(1), m.group(2).upper(), m.group(3) or ""
            if fiil == "LOGOUT":
                logla(f"IMAP\t{self.hesap}\tLOGOUT")
                self.yaz(f"* BYE kapaniyor\r\n{tag} OK LOGOUT tamam\r\n")
                return
            getattr(self, "k_" + fiil.lower(), self.k_yasak)(tag, arg, fiil)

    def ayar(self):
        return senaryo().get("hesaplar", {}).get(self.hesap or "", {})

    def k_yasak(self, tag, arg, fiil):
        # Yazma komutları (STORE, COPY, EXPUNGE, APPEND, SELECT...) ve tanımsızlar: panel göndermemeli
        logla(f"YASAK\t{self.hesap}\t{fiil} {arg}")
        self.yaz(f"{tag} NO {fiil} desteklenmiyor\r\n")

    def k_capability(self, tag, arg, fiil):
        caps = "IMAP4rev1 UNSELECT IDLE NAMESPACE QUOTA ID XLIST CHILDREN X-GM-EXT-1 UIDPLUS COMPRESS=DEFLATE ENABLE MOVE CONDSTORE ESEARCH UTF8=ACCEPT LIST-EXTENDED LIST-STATUS LITERAL- SPECIAL-USE APPENDLIMIT=35651584"
        if self.ayar().get("mod") == "nogm":
            caps = caps.replace(" X-GM-EXT-1", "")
        logla(f"IMAP\t{self.hesap}\tCAPABILITY")
        self.yaz(f"* CAPABILITY {caps}\r\n{tag} OK Success\r\n")

    def k_login(self, tag, arg, fiil):
        m = re.match(r'^"((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"$', arg)
        kul, parola = (m.group(1), m.group(2).replace('\\"', '"').replace("\\\\", "\\")) if m else ("", "")
        self.hesap = kul
        a = senaryo().get("hesaplar", {}).get(kul)
        mod = (a or {}).get("mod", "ok")
        if a is None or mod == "auth" or parola != a.get("parola"):
            sonuc = "RED:auth"
            self.yaz(f"{tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n")
        elif mod == "disabled":
            sonuc = "RED:disabled"
            self.yaz(f"{tag} NO [ALERT] Your account is not enabled for IMAP use. Please visit your Gmail settings page and enable your account for IMAP access. (Failure)\r\n")
        elif mod == "domain":
            sonuc = "RED:domain"
            self.yaz(f"{tag} NO [ALERT] IMAP access is disabled for your domain. Please contact your domain administrator. (Failure)\r\n")
        else:
            sonuc = "KABUL"
            self.giris = True
            self.yaz(f"{tag} OK {kul} authenticated (Success)\r\n")
        logla(f"IMAP\t{kul}\tLOGIN {sonuc}")

    def gerekli(self, tag):
        if not self.giris:
            self.yaz(f"{tag} NO once giris\r\n")
            return False
        return True

    def k_list(self, tag, arg, fiil):
        if not self.gerekli(tag):
            return
        logla(f"IMAP\t{self.hesap}\tLIST")
        satirlar = ['* LIST (\\HasNoChildren) "/" "INBOX"', '* LIST (\\HasNoChildren \\Drafts) "/" "[Gmail]/Taslaklar"',
                    '* LIST (\\HasNoChildren \\All) "/" "[Gmail]/T&APw-m Postalar"']
        if self.ayar().get("mod") != "nosent":
            satirlar.append('* LIST (\\HasNoChildren \\Sent) "/" "[Gmail]/G&APY-nderilmi&AV8- Postalar"')
        self.yaz("\r\n".join(satirlar) + f"\r\n{tag} OK Success\r\n")

    def k_status(self, tag, arg, fiil):
        if not self.gerekli(tag):
            return
        logla(f"IMAP\t{self.hesap}\tSTATUS {arg}")
        a = self.ayar()
        okunmamis = len([x for x in iletiler(a.get("set", "kisisel"), self.hesap) if x[8] == "inbox"])
        self.yaz(f'* STATUS "INBOX" (UNSEEN {okunmamis})\r\n{tag} OK Success\r\n')

    def k_examine(self, tag, arg, fiil):
        if not self.gerekli(tag):
            return
        ad = arg.strip().strip('"')
        logla(f"IMAP\t{self.hesap}\tEXAMINE {ad}")
        if ad == "INBOX":
            self.kutu = "inbox"
        elif ad == '[Gmail]/G&APY-nderilmi&AV8- Postalar' and self.ayar().get("mod") != "nosent":
            self.kutu = "sent"
        else:
            self.yaz(f"{tag} NO [NONEXISTENT] Unknown Mailbox\r\n")
            return
        self.yaz(f"* FLAGS (\\Answered \\Flagged \\Draft \\Deleted \\Seen)\r\n* 10 EXISTS\r\n{tag} OK [READ-ONLY] {ad} selected. (Success)\r\n")

    def liste(self):
        a = self.ayar()
        t = int(time.time() * 1000)
        return [(u, th, kd, km, cc, ko, t - h * 3600_000, et, kutu) for (u, th, kd, km, cc, ko, h, et, kutu) in iletiler(a.get("set", "kisisel"), self.hesap)
                if kutu == self.kutu]

    def k_uid(self, tag, arg, fiil):
        if not self.gerekli(tag) or self.kutu is None:
            self.yaz(f"{tag} NO klasor acik degil\r\n")
            return
        alt = arg.split(" ", 1)
        if alt[0].upper() == "SEARCH":
            logla(f"IMAP\t{self.hesap}\tUID SEARCH {alt[1] if len(alt) > 1 else ''}")
            m = re.search(r"SINCE (\d{1,2})-([A-Za-z]{3})-(\d{4})", arg)
            esik = datetime(int(m.group(3)), AYLAR.index(m.group(2).capitalize()) + 1, int(m.group(1)), tzinfo=timezone.utc).timestamp() * 1000 if m else 0
            uids = sorted(x[0] for x in self.liste() if x[6] >= esik)
            self.yaz(f"* SEARCH {' '.join(map(str, uids))}\r\n{tag} OK SEARCH completed (Success)\r\n")
        elif alt[0].upper() == "FETCH":
            m = re.match(r"^FETCH (\S+) \((.*)\)$", arg)
            if not m:
                self.yaz(f"{tag} BAD FETCH\r\n")
                return
            logla(f"IMAP\t{self.hesap}\tUID FETCH {m.group(1)} ({m.group(2)})")
            istek = m.group(2).upper()
            gm = self.ayar().get("mod") != "nogm"
            istenen = {int(x) for x in m.group(1).split(",") if x.isdigit()}
            sira = 0
            for (u, th, kd, km, cc, ko, ms, et, kutu) in self.liste():
                sira += 1
                if u not in istenen:
                    continue
                parca = [f"UID {u}", f'INTERNALDATE "{tarih(ms)}"']
                if gm and "X-GM-THRID" in istek:
                    parca.append(f"X-GM-THRID {th}")
                if gm and "X-GM-MSGID" in istek:
                    parca.append(f"X-GM-MSGID {th * 10 + 1}")
                if gm and "X-GM-LABELS" in istek:
                    parca.append("X-GM-LABELS (" + " ".join(e if e.startswith("\\") else '"' + utf7(e) + '"' for e in et) + ")")
                govde = None
                if "HEADER.FIELDS" in istek:
                    govde = baslik_blok(kd, km, cc, ko)
                self.yaz(f"* {sira} FETCH (" + " ".join(parca))
                if govde is not None:
                    self.yaz(f" BODY[HEADER.FIELDS (FROM TO CC SUBJECT)] {{{len(govde)}}}\r\n")
                    self.yaz(govde)
                self.yaz(")\r\n")
            self.yaz(f"{tag} OK Success\r\n")
        else:
            self.k_yasak(tag, arg, "UID " + alt[0])

    def k_noop(self, tag, arg, fiil):
        self.yaz(f"{tag} OK NOOP\r\n")


class Sunucu(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def get_request(self):
        ham, adres = super().get_request()
        try:
            return BAGLAM.wrap_socket(ham, server_side=True), adres
        except (ssl.SSLError, OSError):
            ham.close()
            raise


# ---------------- iCal ----------------

def ics_zaman(t):
    return t.strftime("%Y%m%dT%H%M%SZ")


def yerel(t, kayma, ad):
    return f"DTSTART;TZID={ad}:" + (t + timedelta(hours=kayma)).strftime("%Y%m%dT%H%M%S")


def ics(set_adi):
    """Google "basic.ics" benzeri; zamanlar şimdiye göredir (test hangi anda koşarsa koşsun aynı sonuç)."""
    simdi = datetime.now(timezone.utc).replace(microsecond=0)
    h = lambda n: simdi + timedelta(hours=n)
    bugun = datetime.now().strftime("%Y%m%d")
    yarin = (datetime.now() + timedelta(days=1)).strftime("%Y%m%d")
    stamp = ics_zaman(simdi)
    ek = "Şirket: " if set_adi == "sirket" else ""

    def ev(uid, ozet, *satir):
        return ["BEGIN:VEVENT", f"UID:{uid}@sahte", f"DTSTAMP:{stamp}", f"SUMMARY:{ek}{ozet}", f"LAST-MODIFIED:{ics_zaman(h(-3))}", *satir, "END:VEVENT"]

    s = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Sahte//TR", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Sahte"]
    # 1) tek seferlik, toplantı bağlantılı
    s += ev("tek", "Proje toplantısı", f"DTSTART:{ics_zaman(h(1))}", f"DTEND:{ics_zaman(h(2))}", "LOCATION:Toplantı odası 2",
            "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij")
    # 2) tüm gün (bugün)
    s += ev("gun", "Bayram tatili", f"DTSTART;VALUE=DATE:{bugun}", f"DTEND;VALUE=DATE:{yarin}")
    # 3) iptal edilen
    s += ev("iptal", "İptal edilen", f"DTSTART:{ics_zaman(h(2))}", f"DTEND:{ics_zaman(h(3))}", "STATUS:CANCELLED")
    # 4) 30 saat sonra (pencere dışı)
    s += ev("uzak", "Yarından sonra", f"DTSTART:{ics_zaman(h(30))}", f"DTEND:{ics_zaman(h(31))}")
    # 5) günlük tekrar, 10 gün önce başlamış, TZID=Europe/Istanbul (UTC+3): bugünkü olay şimdi+5 saatte
    t0 = h(5) - timedelta(days=10)
    s += ev("gunluk", "Günlük ekip toplantısı", yerel(t0, 3, "Europe/Istanbul"), "DTEND;TZID=Europe/Istanbul:" + (t0 + timedelta(hours=3, minutes=30)).strftime("%Y%m%dT%H%M%S"), "RRULE:FREQ=DAILY")
    # 6) haftalık tekrar, 3 hafta önce, TZID=Asia/Tokyo (UTC+9), bugünkü olay EXDATE ile çıkarılmış: görünmemeli
    t6 = h(6) - timedelta(days=21)
    s += ev("haftalik", "Haftalık (bugün atlandı)", yerel(t6, 9, "Asia/Tokyo"), "DTEND;TZID=Asia/Tokyo:" + (t6 + timedelta(hours=10)).strftime("%Y%m%dT%H%M%S"), "RRULE:FREQ=WEEKLY",
            "EXDATE;TZID=Asia/Tokyo:" + (h(6) + timedelta(hours=9)).strftime("%Y%m%dT%H%M%S"))
    # 7) haftalık tekrar, bugünkü olayı değil (EXDATE yok): COUNT'lu, bugünkü sıra sınırın içinde
    t7 = h(7) - timedelta(days=14)
    s += ev("sayili", "Sayılı tekrar", yerel(t7, 3, "Europe/Istanbul"), "DTEND;TZID=Europe/Istanbul:" + (t7 + timedelta(hours=4)).strftime("%Y%m%dT%H%M%S"), "RRULE:FREQ=WEEKLY;COUNT=3")
    # 8) bitmiş tekrar (UNTIL geçmişte): görünmemeli
    t8 = h(8) - timedelta(days=5)
    s += ev("bitmis", "Bitmiş tekrar", f"DTSTART:{ics_zaman(t8)}", f"DTEND:{ics_zaman(t8 + timedelta(hours=1))}", f"RRULE:FREQ=DAILY;UNTIL={ics_zaman(h(-24))}")
    # 9) tekrar + RECURRENCE-ID ile bugünkü olay 1 saat kaydırılmış ve yeniden adlandırılmış
    t9 = h(9) - timedelta(days=4)
    s += ev("kayan", "Kayan tekrar", f"DTSTART:{ics_zaman(t9)}", f"DTEND:{ics_zaman(t9 + timedelta(hours=1))}", "RRULE:FREQ=DAILY")
    s += ["BEGIN:VEVENT", "UID:kayan@sahte", f"DTSTAMP:{stamp}", f"RECURRENCE-ID:{ics_zaman(h(9))}", f"SUMMARY:{ek}Kayan tekrar (taşındı)",
          f"DTSTART:{ics_zaman(h(10))}", f"DTEND:{ics_zaman(h(11))}", "END:VEVENT"]
    s.append("END:VCALENDAR")
    return "\r\n".join(s) + "\r\n"


class Ical(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        m = re.match(r"^/ical/([A-Za-z0-9_-]+)/basic\.ics$", self.path)
        a = (senaryo().get("ical", {}).get(m.group(1)) if m else None) or {"durum": 404}
        durum = a.get("durum", 200)
        logla(f"ICAL\t{m.group(1) if m else '?'}\t{durum}")
        if durum != 200:
            self.send_response(durum)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        govde = ("BU BIR ICAL DEGIL" if a.get("icerik") == "bozuk" else ics(a.get("icerik", "kisisel"))).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/calendar; charset=UTF-8")
        self.send_header("Content-Length", str(len(govde)))
        self.end_headers()
        self.wfile.write(govde)


if __name__ == "__main__":
    imap_port, ical_port, sertifika, anahtar, SENARYO, LOG = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6]
    BAGLAM = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    BAGLAM.load_cert_chain(sertifika, anahtar)
    threading.Thread(target=lambda: Sunucu(("127.0.0.1", imap_port), Imap).serve_forever(), daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", ical_port), Ical).serve_forever()

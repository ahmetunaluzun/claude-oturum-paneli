# Sahte Google (OAuth + Gmail + Takvim) sunucusu: mail/takvim testleri gerçek Google'a bağlanmasın diye.
# Panel CLAUDE_PANEL_GOOGLE_AUTH_BASE ve CLAUDE_PANEL_GOOGLE_BASE ile buraya yönlendirilir. Python stdlib (http.server).
# Yetki sayfası kullanıcı sormadan loopback adrese yönlendirir (code + state); token ucu PKCE S256'yı gerçekten doğrular.
# Her istek log dosyasına "ISTEK<TAB>YÖNTEM<TAB>yol?sorgu" satırı olarak yazılır (test: format=full/raw hiç yok mu).
# Kullanım:
#   py -3.13 sahte_google.py --sunucu <port> <senaryo.json> <log>
#   py -3.13 sahte_google.py --senaryo <ad> <senaryo.json>     (ad: ilk | red | yalniz_takvim | ag | iptal | ikinci)
import base64, hashlib, json, os, secrets, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

ME = "test.kul@ornek.com"
SENARYO = {
    "ilk": {"email": ME},
    "red": {"email": ME, "deny": True},                  # kullanıcı izin vermedi (error=access_denied)
    "yalniz_takvim": {"email": ME, "grant": "cal"},      # izin ekranında yalnız takvim seçildi
    "ag": {"email": ME, "down": True},                   # API 503 (ağ/sunucu yok)
    "iptal": {"email": ME, "revoked": True},             # yenileme belirteci iptal edilmiş (invalid_grant)
    "ikinci": {"email": "ikinci@firma.com"},             # ikinci hesap
}
MAIL = "https://www.googleapis.com/auth/gmail.readonly"
CAL = "https://www.googleapis.com/auth/calendar.readonly"


def now_ms():
    return int(time.time() * 1000)


def messages(me):
    h = 3600_000
    t = now_ms()
    # (id, thread, from, to, cc, konu, ne kadar önce, etiketler, kutu)
    return [
        ("m1", "t1", "Ali Kaya <ali@musteri.com>", me, "", "Teklif revizyonu", 2 * h, ["INBOX", "UNREAD"], "inbox"),
        ("m2", "t2", "Veli <veli@firma.com>", "ekip@firma.com", me, "Haftalık rapor", 5 * h, ["INBOX"], "inbox"),
        ("m6b", "t6", "Destek <zeynep@destek.ornek.com>", me, "", "Destek kaydı #42 güncellendi", 6 * h, ["INBOX"], "inbox"),
        ("s3", "t3", f"Test Kul <{me}>", "ayse@musteri.com", "", "Re: Sözleşme taslağı", 20 * h, ["SENT"], "sent"),
        ("m3", "t3", "Ayşe <ayse@musteri.com>", me, "", "Sözleşme taslağı", 24 * h, ["INBOX"], "inbox"),
        ("m4", "t4", "Haber Bülteni <bulten@haber.com>", "liste@haber.com", "", "ACİL indirim bülteni", 30 * h, ["INBOX", "Label_9"], "inbox"),
        ("m5", "t5", f"Test Kul <{me}>", "ali@musteri.com", "", "Kendime not", 40 * h, ["INBOX", "SENT"], "inbox"),
        ("m6", "t6", "Destek <zeynep@destek.ornek.com>", me, "", "Destek kaydı #42", 50 * h, ["INBOX"], "inbox"),
        ("s7", "t7", f"Test Kul <{me}>", "kim@x.com", "", "Başka konu", 60 * h, ["SENT"], "sent"),
    ], t


def events():
    t = now_ms()
    iso = lambda ms: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ms / 1000))
    today = time.strftime("%Y-%m-%d", time.localtime())
    tomorrow = time.strftime("%Y-%m-%d", time.localtime(time.time() + 86400))
    h = 3600_000
    return [
        {"id": "e2", "status": "confirmed", "summary": "Bayram tatili", "start": {"date": today}, "end": {"date": tomorrow},
         "htmlLink": "https://www.google.com/calendar/event?eid=e2", "updated": iso(t - 5 * h)},
        {"id": "e1", "status": "confirmed", "summary": "Proje toplantısı", "location": "Toplantı odası 2",
         "start": {"dateTime": iso(t + h)}, "end": {"dateTime": iso(t + 2 * h)}, "hangoutLink": "https://meet.google.com/abc-defg-hij",
         "htmlLink": "https://www.google.com/calendar/event?eid=e1", "updated": iso(t - h)},
        {"id": "e4", "status": "cancelled", "summary": "İptal edilen", "start": {"dateTime": iso(t + 2 * h)}, "end": {"dateTime": iso(t + 3 * h)}},
        {"id": "e5", "status": "confirmed", "summary": "Müşteri görüşmesi", "start": {"dateTime": iso(t + 3 * h)}, "end": {"dateTime": iso(t + 4 * h)},
         "conferenceData": {"entryPoints": [{"entryPointType": "phone", "uri": "tel:+90-555"}, {"entryPointType": "video", "uri": "https://zoom.us/j/123"}]},
         "htmlLink": "https://evil.example.com/x", "updated": iso(t - 2 * h)},
        {"id": "e3", "status": "confirmed", "summary": "Yarından sonra", "start": {"dateTime": iso(t + 30 * h)}, "end": {"dateTime": iso(t + 31 * h)},
         "htmlLink": "https://www.google.com/calendar/event?eid=e3"},
    ]


class State:
    codes = {}      # code -> (challenge, redirect, scope, email)
    access = {}     # access token -> email
    refresh = {}    # refresh token -> (email, scope)


def b64(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def sen(self):
        try:
            with open(self.server.senaryo, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return SENARYO["ilk"]

    def logla(self, method):
        with open(self.server.log, "a", encoding="utf-8") as f:
            f.write(f"ISTEK\t{method}\t{self.path}\n")

    def reply(self, code, obj=None, headers=None):
        body = json.dumps(obj, ensure_ascii=False).encode() if obj is not None else b""
        self.send_response(code)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.logla("GET")
        u = urlparse(self.path)
        q = {k: v for k, v in parse_qs(u.query).items()}
        s = self.sen()
        if u.path == "/o/oauth2/v2/auth":
            one = lambda k: (q.get(k) or [""])[0]
            redirect = one("redirect_uri")
            if not redirect.startswith("http://127.0.0.1:") or one("response_type") != "code" or one("code_challenge_method") != "S256" or not one("code_challenge"):
                return self.reply(400, {"error": "invalid_request"})
            if s.get("deny"):
                return self.reply(302, headers={"Location": redirect + "?" + urlencode({"error": "access_denied", "state": one("state")})})
            asked = one("scope").split(" ")
            grant = [x for x in asked if x in (MAIL, CAL) and (not s.get("grant") or x == {"mail": MAIL, "cal": CAL}[s["grant"]])]
            code = "kod-" + secrets.token_hex(8)
            State.codes[code] = (one("code_challenge"), redirect, " ".join(grant), s.get("email", ME))
            return self.reply(302, headers={"Location": redirect + "?" + urlencode({"code": code, "state": one("state"), "scope": " ".join(grant)})})
        auth = self.headers.get("Authorization", "")
        email = State.access.get(auth[7:]) if auth.startswith("Bearer ") else None
        if email is None:
            return self.reply(401, {"error": {"code": 401}})
        if s.get("down"):
            return self.reply(503, {"error": {"code": 503}})
        if u.path == "/gmail/v1/users/me/profile":
            return self.reply(200, {"emailAddress": email})
        if u.path == "/calendar/v3/calendars/primary":
            return self.reply(200, {"id": email})
        if u.path == "/calendar/v3/calendars/primary/events":
            return self.reply(200, {"items": events()})
        if u.path == "/gmail/v1/users/me/labels":
            return self.reply(200, {"labels": [{"id": "INBOX", "name": "INBOX"}, {"id": "Label_9", "name": "Bülten"}]})
        msgs, t = messages(email)
        if u.path == "/gmail/v1/users/me/messages":
            box = "sent" if "in:sent" in (q.get("q") or [""])[0] else "inbox"
            return self.reply(200, {"messages": [{"id": m[0], "threadId": m[1]} for m in msgs if m[8] == box], "resultSizeEstimate": 9})
        if u.path.startswith("/gmail/v1/users/me/messages/"):
            mid = u.path.rsplit("/", 1)[1]
            m = next((x for x in msgs if x[0] == mid), None)
            if m is None:
                return self.reply(404, {"error": {"code": 404}})
            if (q.get("format") or [""])[0] != "metadata":
                return self.reply(400, {"error": "bu sahte sunucu yalnız metadata verir"})
            wanted = q.get("metadataHeaders") or []
            heads = [{"name": n, "value": v} for n, v in (("From", m[2]), ("To", m[3]), ("Cc", m[4]), ("Subject", m[5])) if n in wanted and v]
            return self.reply(200, {"id": m[0], "threadId": m[1], "labelIds": m[7], "internalDate": str(t - m[6]), "payload": {"headers": heads}})
        return self.reply(404, {"error": {"code": 404}})

    def do_POST(self):
        self.logla("POST")
        n = int(self.headers.get("Content-Length") or 0)
        form = {k: v[0] for k, v in parse_qs(self.rfile.read(n).decode()).items()}
        if urlparse(self.path).path != "/token":
            return self.reply(404, {})
        s = self.sen()
        if form.get("grant_type") == "authorization_code":
            c = State.codes.pop(form.get("code", ""), None)
            if c is None or b64(hashlib.sha256(form.get("code_verifier", "").encode()).digest()) != c[0] or form.get("redirect_uri") != c[1]:
                return self.reply(400, {"error": "invalid_grant"})
            acc, ref = "erisim-" + secrets.token_hex(6), "YENILEME-GIZLI-" + secrets.token_hex(8)
            State.access[acc] = c[3]
            State.refresh[ref] = (c[3], c[2])
            return self.reply(200, {"access_token": acc, "expires_in": 3599, "refresh_token": ref, "scope": c[2], "token_type": "Bearer"})
        if form.get("grant_type") == "refresh_token":
            r = State.refresh.get(form.get("refresh_token", ""))
            if r is None or s.get("revoked"):
                return self.reply(400, {"error": "invalid_grant"})
            if s.get("down"):
                return self.reply(503, {})
            acc = "erisim-" + secrets.token_hex(6)
            State.access[acc] = r[0]
            return self.reply(200, {"access_token": acc, "expires_in": 3599, "scope": r[1], "token_type": "Bearer"})
        return self.reply(400, {"error": "unsupported_grant_type"})


if __name__ == "__main__":
    if sys.argv[1] == "--senaryo":
        with open(sys.argv[3], "w", encoding="utf-8") as f:
            json.dump(SENARYO[sys.argv[2]], f)
    else:
        srv = ThreadingHTTPServer(("127.0.0.1", int(sys.argv[2])), H)
        srv.senaryo, srv.log = sys.argv[3], sys.argv[4]
        srv.serve_forever()

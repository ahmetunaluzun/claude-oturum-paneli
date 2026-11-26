# Testler için sahte anahtar deneme sunucusu: gerçek ElevenLabs / OpenRouter / Gemini'ye GİDİLMEZ, gerçek anahtar kullanılmaz.
# Panel CLAUDE_PANEL_KEYTEST_BASE=http://127.0.0.1:<port> ile deneme isteklerini buraya gönderir (ApiKeys.cs).
#
# Kullanım:  sahte_anahtar.py <port> <log dosyası>
# Uçlar:     /elevenlabs/v1/user/subscription (xi-api-key) · /openrouter/api/v1/key (Authorization: Bearer) · /gemini/v1beta/models (x-goog-api-key)
# Davranış anahtarın önekine göre:
#   sahte-iyi…   → 200 (ElevenLabs: 300.000 karakterden 186.000 kaldı; OpenRouter: limitten 7,5 kaldı; Gemini: 3 model)
#   sahte-sinirsiz… → 200, OpenRouter'da harcama sınırı yok (limit_remaining null)
#   sahte-bos…   → bakiye yok (ElevenLabs: kalan 0; OpenRouter: 402; Gemini: 429)
#   sahte-izin…  → ElevenLabs 401 missing_permissions (anahtar geçerli, okuma izni yok)
#   sahte-ag…    → bağlantı yanıtsız kapatılır (ağ hatası)
#   sahte-500…   → 500
#   başka her şey → anahtar yanlış (ElevenLabs/OpenRouter 401, Gemini 400 API_KEY_INVALID)
#   <log dosyası>.red varken HER anahtar 401 (kayıtlı anahtarın sonradan iptal edilmesi: yeniden deneme testi)
# Log satırı: "<yöntem>\t<yol ve sorgu>\t<anahtar başlığının adı ya da ->". Anahtarın kendisi loga YAZILMAZ; testler adreste (yol/sorgu)
# anahtar geçmediğini bu dosyadan doğrular.
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1])
LOG = sys.argv[2]
KEY_HEADERS = {"elevenlabs": "xi-api-key", "openrouter": "authorization", "gemini": "x-goog-api-key"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # konsola yazma
        pass

    def reply(self, code, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        service = self.path.lstrip("/").split("/")[0]
        header = KEY_HEADERS.get(service)
        raw = self.headers.get(header, "") if header else ""
        with open(LOG, "a", encoding="utf-8", newline="\n") as f:
            f.write(f"GET\t{self.path}\t{header if raw else '-'}\n")
        key = raw[7:] if service == "openrouter" and raw.startswith("Bearer ") else raw
        path = self.path.split("?")[0]
        expected = {"elevenlabs": "/elevenlabs/v1/user/subscription", "openrouter": "/openrouter/api/v1/key", "gemini": "/gemini/v1beta/models"}
        if expected.get(service) != path:
            return self.reply(404, {"error": "not found"})
        if os.path.exists(LOG + ".red"):
            return self.reply(401, {"error": "revoked"})
        if key.startswith("sahte-ag"):
            self.connection.close()  # yanıtsız kapat: istemci ağ hatası görür
            return
        if key.startswith("sahte-500"):
            return self.reply(500, {"error": "server"})
        if key.startswith("sahte-izin") and service == "elevenlabs":
            return self.reply(401, {"detail": {"status": "missing_permissions", "message": "The API key you used is missing the permission user_read"}})
        ok = key.startswith("sahte-iyi") or key.startswith("sahte-sinirsiz")
        empty = key.startswith("sahte-bos")
        if service == "elevenlabs":
            if ok or empty:
                return self.reply(200, {"tier": "creator", "character_count": 300000 if empty else 114000, "character_limit": 300000})
            return self.reply(401, {"detail": {"status": "invalid_api_key", "message": "Invalid API key"}})
        if service == "openrouter":
            if empty:
                return self.reply(402, {"error": {"code": 402, "message": "Insufficient credits"}})
            if ok:
                left = None if key.startswith("sahte-sinirsiz") else 7.5
                return self.reply(200, {"data": {"label": "sk-or-…", "usage": 2.5, "limit": None if left is None else 10, "limit_remaining": left, "is_free_tier": False}})
            return self.reply(401, {"error": {"code": 401, "message": "No auth credentials found"}})
        if empty:
            return self.reply(429, {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED"}})
        if ok:
            return self.reply(200, {"models": [{"name": "models/a"}, {"name": "models/b"}, {"name": "models/c"}]})
        return self.reply(400, {"error": {"code": 400, "status": "INVALID_ARGUMENT", "details": [{"reason": "API_KEY_INVALID"}]}})


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

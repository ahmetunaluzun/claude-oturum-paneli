"""Dikte modeli SHA256 doğrulaması testi (Dictation.cs).

Test kopyası --no-window, boş portta, geçici veri klasörüyle açılır; canlı panelin portuna/veri klasörüne dokunmaz.
İndirme adresi CLAUDE_PANEL_MODEL_URL ile yerel bir HTTP sunucusuna çevrilir (HuggingFace'e gidilmez).
Senaryolar:
  1) Önceden inmiş doğru model: açılışta arka planda doğrulanır → ready, damga dosyası yazılır; yeniden açılışta
     damga sayesinde özet alınmadan anında hazır.
  2) Önceden inmiş bozuk model: ready=false, invalid=true, hata metni; dosya SİLİNMEZ; yazıya çevirme 409.
     Ardından "İndir" → sunucu yanlış dosya veriyor → .part silinir, hata yazılır, model kullanılmaz.
  3) Model yok → "İndir" → sunucu doğru dosyayı veriyor → ready, damga yazılır.
Doğru model bu bilgisayardaki panel veri klasöründen (yalnız okunarak) verilir; yoksa 1 ve 3 atlanır.

Kullanım: uv run python -I tools/dikte_sha_test.py [panel.exe]
"""
from __future__ import annotations

import functools
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
KOK = Path(__file__).resolve().parent.parent
EXE = Path(sys.argv[1]) if len(sys.argv) > 1 else KOK / "src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe"
AD = "ggml-large-v3-turbo-q5_0.bin"
GERCEK = Path(os.environ.get("LOCALAPPDATA", "")) / "ClaudePanel" / "models" / AD
gecen = kalan = 0


def denetle(ad: str, gelen, beklenen) -> None:
    global gecen, kalan
    if gelen == beklenen:
        gecen += 1
        print(f"GEÇTİ  {ad}")
    else:
        kalan += 1
        print(f"KALDI  {ad} (beklenen {beklenen!r}, gelen {gelen!r})")


def bos_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Panel:
    def __init__(self, veri: Path, model_url: str = ""):
        self.port = bos_port()
        self.b = f"http://127.0.0.1:{self.port}"
        env = dict(os.environ, CLAUDE_PANEL_PORT=str(self.port), CLAUDE_PANEL_DATA=str(veri),
                   CLAUDE_PANEL_CLAUDE_DIR=str(veri / "claude"), CLAUDE_PANEL_MODEL_URL=model_url)
        (veri / "claude").mkdir(parents=True, exist_ok=True)
        sahte = veri / "sahte-claude.cmd"  # gerçek claude hiç çalışmasın (güncelleme denetimi vb.)
        sahte.write_text("@exit /b 0\r\n", encoding="ascii")
        env["CLAUDE_PANEL_CLAUDE_EXE"] = str(sahte)
        self.p = subprocess.Popen([str(EXE), "--no-window"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        tok = veri / f"panel-{self.port}.token"
        for _ in range(100):
            if tok.exists() and tok.read_text().strip():
                break
            time.sleep(0.2)
        self.tok = tok.read_text().strip()

    def istek(self, yol: str, govde: bytes | None = None, yontem: str = "GET") -> tuple[int, dict]:
        r = urllib.request.Request(self.b + yol, data=govde, method=yontem,
                                   headers={"X-Panel-Token": self.tok, "Origin": self.b})
        try:
            with urllib.request.urlopen(r, timeout=30) as y:
                return y.status, json.loads(y.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def durum(self) -> dict:
        return self.istek("/api/dictation")[1]

    def bekle(self, kosul, sure=120) -> dict:
        son = {}
        for _ in range(int(sure / 0.25)):
            son = self.durum()
            if kosul(son):
                break
            time.sleep(0.25)
        return son

    def kapat(self) -> None:
        try:
            self.istek("/api/quit", b"", "POST")
            self.p.wait(15)
        except (subprocess.TimeoutExpired, OSError):
            self.p.kill()
            self.p.wait()


def sunucu(klasor: Path) -> tuple[http.server.ThreadingHTTPServer, str]:
    class Sessiz(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

    s = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Sessiz, directory=str(klasor)))
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s, f"http://127.0.0.1:{s.server_address[1]}/{AD}"


def wav() -> bytes:
    veri = b"\0" * 32000
    return (b"RIFF" + (36 + len(veri)).to_bytes(4, "little") + b"WAVEfmt " + (16).to_bytes(4, "little") + (1).to_bytes(2, "little")
            + (1).to_bytes(2, "little") + (16000).to_bytes(4, "little") + (32000).to_bytes(4, "little") + (2).to_bytes(2, "little")
            + (16).to_bytes(2, "little") + b"data" + len(veri).to_bytes(4, "little") + veri)


kok = Path(tempfile.mkdtemp(prefix="dikte-sha-test-"))
try:
    # 1) Önceden inmiş doğru model
    if GERCEK.exists():
        veri = kok / "a"
        (veri / "models").mkdir(parents=True)
        os.link(GERCEK, veri / "models" / AD)  # sabit bağlantı: kopya yok, yalnız okunur
        p = Panel(veri)
        d = p.bekle(lambda d: d.get("ready") or d.get("invalid") or (not d.get("verifying") and d.get("error")))
        p.kapat()
        denetle("1 doğru model açılışta doğrulandı (ready)", d.get("ready"), True)
        denetle("1 invalid=false", d.get("invalid"), False)
        denetle("1 damga dosyası yazıldı", (veri / "models" / (AD + ".verified")).exists(), True)
        p = Panel(veri)
        d = p.durum()
        p.kapat()
        denetle("1 yeniden açılış: damga ile anında hazır, özet alınmadı", (d.get("ready"), d.get("verifying")), (True, False))
        (veri / "models" / AD).unlink()  # bağlantıyı kaldır (asıl dosya yerinde kalır)
    else:
        print("ATLANDI 1 ve 3: bu bilgisayarda inmiş model yok")

    # 2) Önceden inmiş bozuk model
    veri = kok / "b"
    (veri / "models").mkdir(parents=True)
    bozuk = veri / "models" / AD
    bozuk.write_bytes(b"bozuk model " * 1000)
    yanlis = kok / "yanlis"
    yanlis.mkdir()
    (yanlis / AD).write_bytes(b"baska dosya " * 5000)
    s, url = sunucu(yanlis)
    p = Panel(veri, url)
    d = p.bekle(lambda d: d.get("invalid") or d.get("ready"))
    denetle("2 bozuk model: ready=false", d.get("ready"), False)
    denetle("2 bozuk model: invalid=true", d.get("invalid"), True)
    denetle("2 hata metninde SHA256", "SHA256" in (d.get("error") or ""), True)
    denetle("2 bozuk dosya silinmedi", bozuk.exists(), True)
    kod, _ = p.istek("/api/dictation?lang=tr", wav(), "POST")
    denetle("2 bozuk modelle yazıya çevirme 409", kod, 409)
    kod, _ = p.istek("/api/dictation/model", b"", "POST")
    denetle("2 İndir kabul edildi", kod, 200)
    d = p.bekle(lambda d: not d.get("downloading"), 60)
    denetle("2 yanlış indirme: ready=false", d.get("ready"), False)
    denetle("2 yanlış indirme: hata 'İndirilen'", (d.get("error") or "").startswith("İndirilen"), True)
    denetle("2 yanlış indirme: .part silindi", (veri / "models" / (AD + ".part")).exists(), False)
    denetle("2 yanlış indirme: eski dosya yerinde, değişmedi", bozuk.read_bytes()[:12], b"bozuk model ")
    p.kapat()
    s.shutdown()

    # 3) Model yok → doğru dosya iner
    if GERCEK.exists():
        veri = kok / "c"
        veri.mkdir()
        s, url = sunucu(GERCEK.parent)
        p = Panel(veri, url)
        denetle("3 başlangıç: ready=false", p.durum().get("ready"), False)
        p.istek("/api/dictation/model", b"", "POST")
        d = p.bekle(lambda d: not d.get("downloading"), 300)
        p.kapat()
        s.shutdown()
        denetle("3 doğru indirme: ready", d.get("ready"), True)
        denetle("3 doğru indirme: hata yok", d.get("error"), None)
        denetle("3 doğru indirme: damga yazıldı", (veri / "models" / (AD + ".verified")).exists(), True)
        denetle("3 doğru indirme: boyut", (veri / "models" / AD).stat().st_size, GERCEK.stat().st_size)
finally:
    shutil.rmtree(kok, ignore_errors=True)

print(f"Dikte SHA256: {gecen} geçti, {kalan} kaldı")
sys.exit(1 if kalan else 0)

"""README görselleri için uydurma ortamı genişletir (tools/takip_ortam.sh'den SONRA çalışır).

Kullanım: py -3.13 tools/readme_ortam.py <takip_ortam klasörü>

Yazdıkları (hepsi geçici klasörde; gerçek ~/.claude'a dokunulmaz):
  claude/projects/*/<uuid>.jsonl  uydurma konuşmalar (takip_ortam'ın "Demo görev" kayıtlarının yerine)
  claude/skills, skills-disabled, commands  birkaç uydurma skill ve komut
  claude/usage-cache.json         kota önbelleği (makul yüzdeler, panel API'ye çıkmaz)
  data/update-check.json          güncelleme önbelleği (panel güncel, Claude Code'da yeni sürüm var)
  fake-claude.cmd                 `claude --version` yerine (CLAUDE_PANEL_CLAUDE_EXE), gerçek claude çalışmaz
  demo.json                       canlı oturum kartları: readme_shot.mjs /api/state yanıtını bununla kurar
Görünen yollar C:\\Projeler\\... biçimindedir; geçici klasör yolu tarayıcıda bu köke çevrilir.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone

SHOW = "C:\\Projeler"
MODEL_OPUS = "claude-opus-5-5"
MODEL_SONNET = "claude-sonnet-4-5"
CTX_WINDOW = 200_000


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


class Conv:
    """Tek konuşma kaydı (.jsonl) üretir; Transcripts.cs'in okuduğu alanlarla."""

    def __init__(self, cwd: str, start: datetime, model: str, title: str):
        self.id = str(uuid.uuid4())
        self.cwd, self.t, self.model = cwd, start, model
        self.lines = [{"type": "ai-title", "title": title, "sessionId": self.id}]
        self.ctx = 18_000
        self.n = 0
        self.last_text = ""
        self.last_tool: tuple[str, str] | None = None
        self.turns = 0
        self.out_total = 0
        self.in_total = 0

    def _tick(self, sec: int) -> str:
        self.t += timedelta(seconds=sec)
        return iso(self.t)

    def user(self, text: str, sec: int = 40) -> "Conv":
        self.lines.append({"type": "user", "uuid": str(uuid.uuid4()), "timestamp": self._tick(sec), "cwd": self.cwd,
                           "sessionId": self.id, "message": {"role": "user", "content": text}})
        self.turns += 1
        self.last_tool = None
        return self

    def _assistant(self, block: dict, sec: int, out: int) -> None:
        self.n += 1
        self.ctx += out + 900
        self.out_total += out
        self.in_total += 900
        self.lines.append({"type": "assistant", "uuid": str(uuid.uuid4()), "timestamp": self._tick(sec), "cwd": self.cwd,
                           "sessionId": self.id, "message": {
                               "id": f"msg_demo{self.n:04d}", "model": self.model, "role": "assistant", "content": [block],
                               "usage": {"input_tokens": 900, "output_tokens": out, "cache_read_input_tokens": self.ctx - 900 - out,
                                         "cache_creation_input_tokens": 0}}})

    def say(self, text: str, sec: int = 12) -> "Conv":
        self._assistant({"type": "text", "text": text}, sec, 260)
        self.last_text = text
        self.last_tool = None
        return self

    def tool(self, name: str, sec: int = 6, **inp: str) -> "Conv":
        tid = "toolu_" + uuid.uuid4().hex[:20]
        self._assistant({"type": "tool_use", "id": tid, "name": name, "input": inp}, sec, 120)
        self.lines.append({"type": "user", "uuid": str(uuid.uuid4()), "timestamp": self._tick(2), "cwd": self.cwd,
                           "sessionId": self.id, "message": {"role": "user", "content": [
                               {"type": "tool_result", "tool_use_id": tid, "content": "ok"}]}})
        summary = next((inp[k] for k in ("description", "command", "file_path", "pattern", "url", "query", "prompt", "skill")
                        if inp.get(k)), "")
        self.last_tool = (name, summary)
        return self

    def grow(self, tokens: int) -> "Conv":
        """Bağlamı büyütür (uzun oturum izlenimi: dosya okumaları vb.)."""
        self.ctx += tokens
        self.in_total += tokens
        return self

    def save(self, claude_dir: str, folder: str, mtime: datetime | None = None) -> str:
        d = os.path.join(claude_dir, "projects", folder)
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, self.id + ".jsonl")
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            for line in self.lines:
                # Boşluksuz: panel klasörü bulmak için satırda "cwd":" arar (Transcripts.FirstCwd)
                f.write(json.dumps(line, ensure_ascii=False, separators=(",", ":")) + "\n")
        ts = (mtime or self.t).timestamp()
        os.utime(path, (ts, ts))
        return path

    def stats(self) -> dict:
        tool = self.last_tool
        return {"model": self.model, "ctxTokens": self.ctx, "ctxWindow": CTX_WINDOW, "inTok": self.in_total,
                "outTok": self.out_total, "cacheRead": self.ctx * 3, "cacheWrite": 12_000, "turns": self.turns,
                "compactions": 0, "lastText": self.last_text, "lastTool": tool[1] if tool else None,
                "lastToolName": tool[0] if tool else None, "lastIsTool": tool is not None}


def skill(root: str, sub: str, name: str, desc: str) -> None:
    d = os.path.join(root, sub, name)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "SKILL.md"), "w", encoding="utf-8", newline="\n") as f:
        f.write(f"---\nname: {name}\ndescription: {desc}\n---\n\n# {name}\n\nDemo skill.\n")


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    T = os.path.abspath(sys.argv[1])
    claude, data, proj = (os.path.join(T, x) for x in ("claude", "data", "projeler"))
    if not os.path.isdir(proj):
        print("Önce tools/takip_ortam.sh çalıştırılmalı:", proj)
        return 2

    # takip_ortam'ın tek satırlık "Demo görev" kayıtları gider; klasörler (git depoları, NEXT_SESSION.md) kalır.
    shutil.rmtree(os.path.join(claude, "projects"), ignore_errors=True)
    for extra in ("Hava Durumu Botu", "Kişisel Blog", "Fatura Servisi"):
        os.makedirs(os.path.join(proj, extra), exist_ok=True)

    now = datetime.now(timezone.utc)
    p = lambda name: os.path.join(proj, name)  # noqa: E731  (gerçek klasör: kayıttaki cwd)
    s = lambda name, rel: f"{SHOW}\\{name}\\{rel}"  # noqa: E731  (konuşma metninde görünen yol)

    # 1) Demo Mağaza — panel oturumu, bekliyor (konuşma ekranı görüntüsü bunu açar)
    shop = Conv(p("Demo Mağaza"), now - timedelta(minutes=26), MODEL_OPUS, "Sepette indirim iki kez uygulanıyor")
    shop.user("Sepette indirim kodu iki kez uygulanıyor gibi. 100 TL'lik sepette %10 kodla toplam 81 TL çıkıyor. Bulup düzeltir misin?")
    shop.say("Bakıyorum. Önce indirimi uygulayan yerleri bulayım.")
    shop.tool("Grep", pattern="applyDiscount").grow(4_000)
    shop.tool("Read", file_path=s("Demo Mağaza", "src\\cart\\total.js")).grow(9_000)
    shop.tool("Read", file_path=s("Demo Mağaza", "src\\cart\\coupon.js")).grow(7_000)
    shop.say("Sorunu buldum: `applyDiscount()` hem `coupon.js` içinde ara toplama, hem de `total.js` içinde genel toplama "
             "uygulanıyor. 100 TL → 90 TL → 81 TL.\n\nİndirimi yalnız `total.js` içinde bırakıyorum, "
             "`coupon.js` yalnız kodu doğrulayacak.", sec=20)
    shop.tool("Edit", file_path=s("Demo Mağaza", "src\\cart\\coupon.js")).grow(3_000)
    shop.tool("Edit", file_path=s("Demo Mağaza", "src\\cart\\__tests__\\total.test.js")).grow(3_000)
    shop.tool("Bash", command="npm test -- cart", sec=35).grow(6_000)
    shop.say("Düzeltme hazır:\n\n- İndirim artık yalnız `total.js` içinde, bir kez uygulanıyor (100 TL, %10 → **90 TL**).\n"
             "- `total.test.js` dosyasına 3 test eklendi: tek kod, kodsuz sepet, %100 indirim.\n"
             "- `npm test` → 24 test geçti.\n\nCommit atayım mı?", sec=15)
    shop.grow(20_000)
    shop.save(claude, "C--Projeler-Demo-Magaza")

    # 2) Örnek API — panel oturumu, çalışıyor
    api = Conv(p("Örnek API"), now - timedelta(minutes=9), MODEL_SONNET, "Sipariş listesine sayfalama")
    api.user("Sipariş listesine sayfalama ekle (sayfa başına 20) ve testlerini yaz.")
    api.say("Tamam. Önce mevcut uç noktaya ve testlere bakıyorum.")
    api.tool("Read", file_path=s("Örnek API", "src\\routes\\orders.ts")).grow(8_000)
    api.tool("Edit", file_path=s("Örnek API", "src\\routes\\orders.ts")).grow(4_000)
    api.tool("Write", file_path=s("Örnek API", "test\\orders.page.test.ts")).grow(5_000)
    api.tool("Bash", command="npm test -- --runInBand", sec=8).grow(10_000)
    api.save(claude, "C--Projeler-Ornek-API")

    # 3) Rapor Aracı — terminal oturumu, bekliyor
    rep = Conv(p("Rapor Aracı"), now - timedelta(minutes=58), MODEL_OPUS, "PDF tablolarında başlık tekrarı")
    rep.user("PDF raporunda uzun tablolar sayfa sonunda başlıksız devam ediyor, düzeltelim.")
    rep.tool("Read", file_path=s("Rapor Aracı", "templates\\report.css")).grow(30_000)
    rep.tool("Edit", file_path=s("Rapor Aracı", "templates\\report.css")).grow(20_000)
    rep.tool("Bash", command="python build_report.py --sample 40").grow(30_000)
    rep.say("Tablo başlıkları artık her sayfada tekrar ediyor (`thead` + `break-inside: avoid`). 40 sayfalık örnek "
            "raporla denedim, satırlar sayfa arasında bölünmüyor. Sürüm notunu da güncelledim.", sec=30)
    rep.save(claude, "C--Projeler-Rapor-Araci")

    # 4) Stok Sayım — terminal oturumu, çalışıyor
    stok = Conv(p("Stok Sayım"), now - timedelta(minutes=17), MODEL_OPUS, "Barkod okuma düzeltmesi")
    stok.user("Sayım ekranında barkod okuyucu bazen iki kez okuyor, aynı ürün iki kez sayılıyor.")
    stok.tool("Grep", pattern="onScan").grow(5_000)
    stok.tool("Read", file_path=s("Stok Sayım", "src\\barkod.ts")).grow(12_000)
    stok.say("Okuyucu aynı kodu 50 ms arayla iki kez gönderiyor. 300 ms içinde gelen aynı kodu yok sayan bir süzgeç ekliyorum.")
    stok.tool("Edit", file_path=s("Stok Sayım", "src\\barkod.ts")).grow(60_000)
    stok.save(claude, "C--Projeler-Stok-Sayim")

    # 5) Hava Durumu Botu — terminal oturumu, çalışıyor
    hava = Conv(p("Hava Durumu Botu"), now - timedelta(minutes=4), MODEL_SONNET, "Tekrar deneme süresi")
    hava.user("Hava durumu servisi zaman aşımına uğrayınca bot hiç cevap vermiyor. Tekrar deneme ekleyelim.")
    hava.tool("Grep", pattern="fetchForecast").grow(6_000)
    hava.save(claude, "C--Projeler-Hava-Durumu-Botu")

    # 6) Fatura Servisi — panel oturumu, gece modunda karar bekliyor
    fat = Conv(p("Fatura Servisi"), now - timedelta(hours=7), MODEL_OPUS, "E-fatura toplu gönderim")
    fat.user("NEXT_SESSION.md'deki plana göre devam et.")
    fat.tool("Read", file_path=s("Fatura Servisi", "NEXT_SESSION.md")).grow(40_000)
    fat.tool("Bash", command="dotnet test").grow(70_000)
    fat.say("[KARAR-BEKLIYOR]\nToplu gönderim kuyruğu hazır, testler geçti. Sıradaki adım veritabanına `retry_count` "
            "sütununu eklemek; bu bir şema değişikliği.\n\nSütunu ekleyip migration'ı yazayım mı?", sec=40)
    fat.grow(26_000)
    fat.save(claude, "C--Projeler-Fatura-Servisi")

    # Kapanmış oturumlar (Son oturumlar listesi)
    def closed(folder_key: str, name: str, ago: timedelta, title: str, ask: str, answer: str, model: str = MODEL_OPUS) -> None:
        c = Conv(p(name), now - ago, model, title)
        c.user(ask).tool("Read", file_path=s(name, "README.md")).say(answer)
        c.save(claude, folder_key)

    closed("C--Projeler-Temiz-Kutuphane", "Temiz Kütüphane", timedelta(hours=5), "README örneklerini güncelle",
           "README'deki kod örnekleri eski sürümden kalmış, güncelle.", "Örnekler 2.x sürümüne göre güncellendi.")
    closed("C--Projeler-Kisisel-Blog", "Kişisel Blog", timedelta(days=1, hours=3), "RSS beslemesi ekle",
           "Bloga RSS beslemesi ekleyelim.", "`/rss.xml` eklendi, son 20 yazı listeleniyor.", MODEL_SONNET)
    closed("C--Projeler-Demo-Magaza", "Demo Mağaza", timedelta(days=2, hours=6), "Ürün görsellerinde tembel yükleme",
           "Ürün listesi yavaş açılıyor, görselleri tembel yükleyelim.", "Görseller `loading=\"lazy\"` ile yükleniyor.")
    closed("C--Projeler-Ornek-API", "Örnek API", timedelta(days=3, hours=1), "JWT yenileme süresi",
           "Oturum 15 dakikada düşüyor, yenileme anahtarı ekleyelim.", "Yenileme anahtarı eklendi, süre 7 gün.")
    closed("C--Projeler-Hava-Durumu-Botu", "Hava Durumu Botu", timedelta(days=5, hours=2), "Komut listesi",
           "/yardim komutu hangi komutları gösteriyor?", "Beş komut: /bugun, /yarin, /hafta, /sehir, /yardim.", MODEL_SONNET)

    # Skill'ler ve komutlar
    for name, desc in [
        ("code-review", "Review changed code for bugs, readability and missing tests before a commit."),
        ("test-writer", "Write unit and integration tests for the selected module; runs them and fixes failures."),
        ("release-notes", "Draft release notes and a changelog entry from the commits since the last tag."),
        ("frontend-design", "Guidance for distinctive web interfaces: layout, typography, color and motion."),
        ("api-docs", "Generate OpenAPI documentation and request examples from route handlers."),
        ("pdf-tools", "Read, merge, split and fill PDF documents."),
    ]:
        skill(claude, "skills", name, desc)
    for name, desc in [
        ("docker-helper", "Write and debug Dockerfiles and compose files."),
        ("seo-audit", "Check pages for titles, meta descriptions, broken links and sitemap issues."),
        ("data-cleaning", "Clean messy CSV and Excel data: headers, types, duplicates."),
    ]:
        skill(claude, "skills-disabled", name, desc)
    os.makedirs(os.path.join(claude, "commands"), exist_ok=True)
    for name, desc in [("checkpoint", "Save progress to NEXT_SESSION.md"), ("deploy-check", "Pre-deploy checklist")]:
        with open(os.path.join(claude, "commands", name + ".md"), "w", encoding="utf-8", newline="\n") as f:
            f.write(f"---\ndescription: {desc}\n---\n\n{desc}.\n")

    # Kota önbelleği (panel önbellek tazeyken API'ye çıkmaz; kimlik dosyası yok, çıksa da çıkamaz)
    usage = {"five_hour": {"utilization": 38.0, "resets_at": iso(now + timedelta(hours=2, minutes=17))},
             "seven_day": {"utilization": 54.0, "resets_at": iso(now + timedelta(days=3, hours=5))},
             "_cached_at": time.time()}
    with open(os.path.join(claude, "usage-cache.json"), "w", encoding="utf-8") as f:
        json.dump(usage, f)

    # Güncelleme önbelleği: panel güncel, Claude Code'da yeni sürüm (kurulu sürüm fake-claude.cmd'den)
    nows = int(time.time())
    with open(os.path.join(data, "update-check.json"), "w", encoding="utf-8") as f:
        json.dump({"PanelAt": nows, "PanelOk": True, "PanelLatest": "v0.11.0",
                   "PanelUrl": "https://github.com/ahmetunaluzun/claude-oturum-paneli/releases/tag/v0.11.0",
                   "ClaudeAt": nows, "ClaudeOk": True, "ClaudeLatest": "2.1.42"}, f)
    with open(os.path.join(T, "fake-claude.cmd"), "w", encoding="ascii", newline="\r\n") as f:
        f.write("@echo 2.1.40 (Claude Code)\n")

    # Canlı oturum kartları (gösterilen yollar)
    ms = lambda dt: int(dt.timestamp() * 1000)  # noqa: E731
    ago = lambda **kw: ms(now - timedelta(**kw))  # noqa: E731
    sessions = [
        {"pid": 41012, "sessionId": rep.id, "name": "Rapor Aracı", "cwd": f"{SHOW}\\Rapor Aracı", "kind": "interactive",
         "status": "idle", "startedAt": ago(minutes=58), "statusSince": ago(minutes=6), "version": "2.1.40", "customName": None},
        {"pid": 41377, "sessionId": stok.id, "name": "Stok Sayım", "cwd": f"{SHOW}\\Stok Sayım", "kind": "interactive",
         "status": "busy", "startedAt": ago(minutes=17), "statusSince": ago(minutes=2), "version": "2.1.40", "customName": None},
        {"pid": 41820, "sessionId": hava.id, "name": "Hava Durumu Botu", "cwd": f"{SHOW}\\Hava Durumu Botu", "kind": "interactive",
         "status": "busy", "startedAt": ago(minutes=4), "statusSince": ago(seconds=40), "version": "2.1.40", "customName": None},
    ]
    hosted = [
        {"key": "demo-shop", "sessionId": shop.id, "cwd": f"{SHOW}\\Demo Mağaza", "name": "Demo Mağaza", "status": "idle",
         "startedAt": ago(minutes=26), "statusSince": ago(minutes=3), "model": "opus", "lastError": None, "costUsd": 0.84,
         "task": None, "night": None},
        {"key": "demo-api", "sessionId": api.id, "cwd": f"{SHOW}\\Örnek API", "name": "Örnek API", "status": "busy",
         "startedAt": ago(minutes=9), "statusSince": ago(minutes=1), "model": "sonnet", "lastError": None, "costUsd": 0.21,
         "task": None, "night": None},
        {"key": "demo-fatura", "sessionId": fat.id, "cwd": f"{SHOW}\\Fatura Servisi", "name": "Fatura Servisi", "status": "idle",
         "startedAt": ago(hours=7), "statusSince": ago(hours=2, minutes=10), "model": "opus", "lastError": None, "costUsd": 2.37,
         "task": None, "night": "decision"},
    ]
    stats = {c.id: c.stats() for c in (shop, api, rep, stok, hava, fat)}
    with open(os.path.join(T, "demo.json"), "w", encoding="utf-8") as f:
        json.dump({"now": ms(now), "sessions": sessions, "hosted": hosted, "stats": stats, "drawer": "h:demo-shop"}, f, ensure_ascii=False)
    print("readme ortamı hazır:", T)
    return 0


if __name__ == "__main__":
    sys.exit(main())

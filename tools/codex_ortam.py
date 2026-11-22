"""Sahte Codex ağacı (CLAUDE_PANEL_CODEX_HOME) — gerçek ~/.codex'e dokunmaz. Biçim: docs/codex-yerel-bicim.md (0.171.0 ölçümü).

Satır üreticileri tools/codex_scan_test.py ile ortak. Komut satırı (tools/codex_ui_test.mjs çağırır):
  py -3.13 -I tools/codex_ortam.py <kök> kur          çalışan + açık + biten oturum (kilitler, Go kotası)
  py -3.13 -I tools/codex_ortam.py <kök> kota go|plus|reset   çalışan oturuma yeni token_count satırı ekler
Oturumların klasörleri <kök>/../p altında; çalışan oturumun klasörü bilerek YOK (Klasörü aç → 404, pencere açılmaz).
"""
import json
import os
import sys
import time
from pathlib import Path

CALISAN = "019a2b3c-0000-7000-8000-00000000c0de"
ACIK = "019a2b3c-0000-7000-8000-0000000a91c0"
BITTI = "019a2b3c-0000-7000-8000-0000000b1771"


def satir(tur, payload, ts="2026-11-21T23:23:32.769Z"):
    return json.dumps({"timestamp": ts, "type": tur, "payload": payload}, ensure_ascii=False)


def meta(sid, cwd, eski=False):
    p = {"id": sid, "timestamp": "2026-11-21T23:23:32.769Z", "cwd": cwd, "source": "cli", "cli_version": "0.171.0"}
    if not eski:
        p["session_id"] = sid
    return satir("session_meta", p)


def mesaj(rol, metin):
    tip = "output_text" if rol == "assistant" else "input_text"
    return satir("response_item", {"type": "message", "role": rol, "content": [{"type": tip, "text": metin}]})


def olay(tip, **ek):
    return satir("event_msg", {"type": tip, **ek})


def pencere(yuzde, dakika, sifir):
    return {"used_percent": yuzde, "window_minutes": dakika, "resets_at": sifir}


def kota(yuzde, dakika, limit_id="codex", sifir=1797600001, ikinci=None, plan="go"):
    return olay("token_count", info=None, rate_limits={"limit_id": limit_id, "plan_type": plan,
                "primary": pencere(yuzde, dakika, sifir), "secondary": ikinci})


def yaz(home, ad, satirlar, yas_sn=0, gun="2026/11/22"):
    d = home / "sessions" / gun
    d.mkdir(parents=True, exist_ok=True)
    f = d / ad
    f.write_text("\n".join(satirlar) + "\n", encoding="utf-8")
    if yas_sn:
        t = time.time() - yas_sn
        os.utime(f, (t, t))
    return f


ORTAM = "<environment_context>\n<cwd>C:\\x</cwd>\n<shell>powershell</shell>\n</environment_context>"


def kur(home):
    p = home.parent / "p"
    for ad in ("Codex Acik", "Codex Bitti"):
        (p / ad).mkdir(parents=True, exist_ok=True)
    simdi = int(time.time())
    yaz(home, "rollout-2026-11-22T01-00-00-bitti.jsonl", [
        meta(BITTI, str(p / "Codex Bitti")), mesaj("developer", "GIZLI-SISTEM-TALIMATI"), mesaj("user", ORTAM),
        satir("turn_context", {"model": "gpt-6-luna"}), olay("task_started"),
        mesaj("user", "Testleri çalıştır ve sonucu özetle"),
        satir("response_item", {"type": "function_call", "name": "shell", "arguments": "{}"}),
        mesaj("assistant", "Tüm testler geçti (**42/42**)."), olay("task_complete"),
        mesaj("user", "Teşekkürler, İyi çalışmalar"), mesaj("assistant", "Rica ederim."),
        kota(10.0, 43200, sifir=simdi + 20 * 86400)], yas_sn=3600)
    yaz(home, "rollout-2026-11-22T02-00-00-acik.jsonl", [
        meta(ACIK, str(p / "Codex Acik")), mesaj("user", ORTAM), satir("turn_context", {"model": "gpt-6-luna"}),
        olay("task_started"), mesaj("user", "README'yi güncelle"),
        mesaj("assistant", "README güncellendi; kurulum adımlarına Windows notu eklendi."), olay("task_complete")], yas_sn=60)
    yaz(home, "rollout-2026-11-22T03-00-00-calisan.jsonl", [
        meta(CALISAN, str(p / "Codex Calisan (yok)")), mesaj("user", ORTAM), satir("turn_context", {"model": "gpt-6-luna"}),
        olay("task_started"), mesaj("user", "Ödeme ekranındaki çift tıklama hatasını düzelt"),
        mesaj("assistant", "Düğmeyi işlem sürerken kilitliyorum."), kota(3.0, 43200, sifir=simdi + 20 * 86400)])
    kilit = home / "thread-writer-locks"
    kilit.mkdir(parents=True, exist_ok=True)
    for i in (CALISAN, ACIK):
        (kilit / f"{i}.lock").write_bytes(b"")


def kota_degistir(home, tur):
    simdi = int(time.time())
    satirlar = {
        "go": kota(3.0, 43200, sifir=simdi + 20 * 86400),
        "plus": kota(40.0, 300, sifir=simdi + 2 * 3600, plan="plus", ikinci=pencere(75.0, 10080, simdi + 3 * 86400)),
        "reset": kota(80.0, 43200, sifir=simdi - 3600),
    }
    f = next((home / "sessions").rglob("*-calisan.jsonl"))
    with f.open("a", encoding="utf-8") as h:
        h.write(satirlar[tur] + "\n")


if __name__ == "__main__":
    kok, komut = Path(sys.argv[1]), sys.argv[2]
    if komut == "kur":
        kur(kok)
    elif komut == "kota":
        kota_degistir(kok, sys.argv[3])
    else:
        sys.exit(f"bilinmeyen komut: {komut}")

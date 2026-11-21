"""Codex oturum okuyucusu testi (CodexSessions.cs, `ClaudePanel --codex-scan`).

Gerçek ~/.codex'e dokunmaz: geçici CLAUDE_PANEL_CODEX_HOME. Biçim: docs/codex-yerel-bicim.md (0.171.0 ölçümü).
Kullanım: python -I tools/codex_scan_test.py [ClaudePanel.exe]
"""
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
KOK = Path(__file__).resolve().parent.parent
EXE = Path(sys.argv[1]) if len(sys.argv) > 1 else KOK / "src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe"
gecti = kaldi = 0


def kontrol(ad, gercek, beklenen):
    global gecti, kaldi
    if gercek == beklenen:
        gecti += 1
        print("GEÇTİ ", ad)
    else:
        kaldi += 1
        print("KALDI ", ad, "→", repr(gercek), "beklenen", repr(beklenen))


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


def kota(yuzde, pencere, limit_id="codex"):
    return olay("token_count", info=None, rate_limits={"limit_id": limit_id, "plan_type": "go",
                "primary": {"used_percent": yuzde, "window_minutes": pencere, "resets_at": 1797600001}, "secondary": None})


def yaz(home, ad, satirlar, yas_sn=0, gun="2026/11/22"):
    d = home / "sessions" / gun
    d.mkdir(parents=True, exist_ok=True)
    f = d / ad
    f.write_text("\n".join(satirlar) + "\n", encoding="utf-8")
    if yas_sn:
        t = time.time() - yas_sn
        os.utime(f, (t, t))
    return f


def tara(home):
    env = dict(os.environ, CLAUDE_PANEL_CODEX_HOME=str(home))
    r = subprocess.run([str(EXE), "--codex-scan"], env=env, capture_output=True, timeout=60)
    return json.loads(r.stdout.decode("utf-8"))


with tempfile.TemporaryDirectory() as t:
    home = Path(t) / "codex"
    kontrol("codex klasörü yok → boş liste", tara(home)["sessions"], [])

    # 1. Tamamlanmış oturum: ortam metni başlık olmaz, son cevap, model, kota
    yaz(home, "rollout-a.jsonl", [
        meta("aaaa", r"C:\Projeler\Bir"),
        mesaj("developer", "sistem talimatı"),
        mesaj("user", "<environment_context>\n<cwd>C:\\Projeler\\Bir</cwd>\n</environment_context>"),
        satir("turn_context", {"model": "gpt-6-luna", "cwd": r"C:\Projeler\Bir"}),
        olay("task_started", turn_id="t1"),
        mesaj("user", "Şu hatayı düzelt: İçerik görünmüyor"),
        mesaj("assistant", "İlk cevap"),
        kota(12.5, 43200, "baska"),
        kota(3.0, 43200),
        mesaj("assistant", "Düzelttim, testler geçti."),
        olay("task_complete", turn_id="t1"),
    ], yas_sn=3600)
    # 2. Yarım son satır + eski biçim (yalnız id) + .zst atlanır
    yaz(home, "rollout-b.jsonl", [meta("bbbb", r"C:\Projeler\Iki", eski=True), mesaj("user", "eski biçim"), '{"timestamp":"2026-11-'], yas_sn=7200)
    (home / "sessions/2026/11/22/rollout-z.jsonl.zst").write_bytes(b"\x28\xb5\x2f\xfd")
    # 3. İlk satır session_meta değil → atlanır
    yaz(home, "rollout-c.jsonl", [mesaj("user", "metasız"), meta("cccc", r"C:\x")])
    # 4. Çalışan: kilit + yeni yazılmış + açık tur
    yaz(home, "rollout-d.jsonl", [meta("dddd", r"C:\Projeler\Dort"), olay("task_started", turn_id="t1"), mesaj("user", "uzun iş")])
    # 5. Açık ama boşta: kilit + yeni + tur bitmiş
    yaz(home, "rollout-e.jsonl", [meta("eeee", r"C:\Projeler\Bes"), olay("task_started"), mesaj("user", "kısa"), olay("task_complete")])
    # 6. Kilit kalmış ama dosya eski → bitti sayılır (kilit tek başına canlılık değil)
    yaz(home, "rollout-f.jsonl", [meta("ffff", r"C:\Projeler\Alti"), olay("task_started"), mesaj("user", "yarım kaldı")], yas_sn=3 * 3600)
    # 7. 14 günden eski → listede yok
    yaz(home, "rollout-g.jsonl", [meta("gggg", r"C:\eski"), mesaj("user", "eski")], yas_sn=20 * 86400, gun="2026/11/01")
    kilit = home / "thread-writer-locks"
    kilit.mkdir(parents=True)
    for i in ("dddd", "eeee", "ffff"):
        (kilit / f"{i}.lock").write_bytes(b"")

    s = {x["id"]: x for x in tara(home)["sessions"]}
    kontrol("oturum kimlikleri", sorted(s), ["aaaa", "bbbb", "dddd", "eeee", "ffff"])
    a = s.get("aaaa", {})
    kontrol("başlık: ortam metni atlanır, ilk gerçek kullanıcı mesajı", a.get("title"), "Şu hatayı düzelt: İçerik görünmüyor")
    kontrol("son asistan mesajı", a.get("lastAssistant"), "Düzelttim, testler geçti.")
    kontrol("model turn_context'ten", a.get("model"), "gpt-6-luna")
    kontrol("cwd", a.get("cwd"), r"C:\Projeler\Bir")
    kontrol("kota yalnız limit_id codex", (a.get("primary") or {}).get("usedPercent"), 3.0)
    kontrol("plan türü", a.get("planType"), "go")
    kontrol("kilitsiz → bitti", a.get("state"), "ended")
    kontrol("eski biçim yalnız id + yarım satır", s.get("bbbb", {}).get("title"), "eski biçim")
    kontrol("kilit + yeni + açık tur → çalışıyor", s.get("dddd", {}).get("state"), "working")
    kontrol("kilit + yeni + tur bitti → açık", s.get("eeee", {}).get("state"), "open")
    kontrol("kilit var ama dosya eski → bitti", s.get("ffff", {}).get("state"), "ended")
    kontrol("en yeni önce", list(s)[0] in ("dddd", "eeee"), True)

print(f"Codex tarama: {gecti} geçti, {kaldi} kaldı")
sys.exit(1 if kaldi else 0)

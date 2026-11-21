"""Gece koruması testi: panelin `--night-guard` hook modu ve ~/.claude/hooks/gece-modu-koruma.py aynı örneklerle.

Her örnek gerçek stdin JSON'uyla (Claude Code PreToolUse olayı) koşturulur; engel = exit 2 + stderr'de mesaj, serbest = exit 0.
Örnekler: tools/night_guard_cases.json. Ek senaryolar: koruma dosyası yok (serbest), bozuk/okunamaz (engel),
oturum listede değil (serbest), süresi geçmiş (serbest). Panelin veri klasörüne dokunmaz: CLAUDE_PANEL_DATA geçici klasör.

Kullanım: uv run python -I tools/night_guard_test.py [panel.exe] [kanca.py]
  panel.exe varsayılan: src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe
  kanca.py varsayılan: ~/.claude/hooks/gece-modu-koruma.py ("-" verilirse atlanır)
"""
from __future__ import annotations

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
KANCA = sys.argv[2] if len(sys.argv) > 2 else str(Path.home() / ".claude/hooks/gece-modu-koruma.py")
OTURUM = "gece-oturumu-1"

ornekler = json.loads((KOK / "tools/night_guard_cases.json").read_text(encoding="utf-8"))
veri = Path(tempfile.mkdtemp(prefix="night-guard-test-"))
guard = veri / "night-guard.json"
env = dict(os.environ, CLAUDE_PANEL_DATA=str(veri))

koşucular = {"panel": [str(EXE), "--night-guard"]}
if KANCA != "-":
    koşucular["kanca"] = [sys.executable, "-I", KANCA]

gecen = kalan = 0


def olay(ornek, oturum=OTURUM) -> dict:
    if isinstance(ornek, dict):
        return {"session_id": oturum, "hook_event_name": "PreToolUse", "tool_name": ornek["tool"], "tool_input": {}}
    return {"session_id": oturum, "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": ornek}}


def koş(komut: list[str], ev: dict) -> tuple[int, str]:
    r = subprocess.run(komut, input=json.dumps(ev, ensure_ascii=False).encode("utf-8"), capture_output=True, env=env, timeout=30)
    return r.returncode, r.stderr.decode("utf-8", "replace")


def denetle(ad: str, kod: int, hata: str, beklenen: int) -> None:
    global gecen, kalan
    tamam = kod == beklenen and (beklenen == 0 or "Gece modu" in hata)
    if tamam:
        gecen += 1
    else:
        kalan += 1
        print(f"KALDI  {ad} (beklenen {beklenen}, gelen {kod}) {hata.strip()[:120]}")


def guard_yaz(until: float | str, oturumlar=(OTURUM,)) -> None:
    guard.write_text(json.dumps({"until": until, "sessions": list(oturumlar)}), encoding="utf-8")


try:
    for ad, komut in koşucular.items():
        # 1) Örnek tablosu: geçerli gece koruma dosyası, oturum listede
        guard_yaz(time.time() + 3600)
        for beklenen, liste in ((2, ornekler["block"]), (0, ornekler["allow"])):
            for o in liste:
                kod, hata = koş(komut, olay(o))
                denetle(f"[{ad}] {'engel' if beklenen else 'serbest'}: {o!s:.70}", kod, hata, beklenen)
        engel = olay("gh api repos/o/r/issues -f title=x")
        serbest = olay("git status")
        # 2) Oturum listede değil / süresi geçmiş → serbest
        kod, hata = koş(komut, olay("git push", oturum="gunduz-oturumu"))
        denetle(f"[{ad}] listede olmayan oturum serbest", kod, hata, 0)
        guard_yaz(time.time() - 60)
        kod, hata = koş(komut, engel)
        denetle(f"[{ad}] süresi geçmiş koruma serbest", kod, hata, 0)
        # 3) Koruma dosyası yok → gece modu kapalı, serbest
        guard.unlink()
        kod, hata = koş(komut, engel)
        denetle(f"[{ad}] koruma dosyası yok → serbest", kod, hata, 0)
        # 4) Koruma dosyası bozuk → riskli işlem engellenir (fail-closed), zararsız işlem serbest
        for etiket, icerik in (("bozuk JSON", "{bozuk"), ("boş", ""), ("dizi", "[]"),
                               ("until metin", json.dumps({"until": "yarın", "sessions": [OTURUM]})),
                               ("sessions yok", json.dumps({"until": time.time() + 3600}))):
            guard.write_text(icerik, encoding="utf-8")
            kod, hata = koş(komut, engel)
            denetle(f"[{ad}] koruma dosyası {etiket} → engel", kod, hata, 2)
            kod, hata = koş(komut, serbest)
            denetle(f"[{ad}] koruma dosyası {etiket}, zararsız komut → serbest", kod, hata, 0)
        # 5) Koruma dosyası okunamıyor (kilitli: başka süreç paylaşımsız açmış) → engel
        if os.name == "nt":
            guard_yaz(time.time() + 3600)
            kilit = subprocess.Popen(["pwsh", "-NoProfile", "-c",
                                      f"$f=[IO.File]::Open('{guard}','Open','ReadWrite','None'); 'hazir'; Start-Sleep 20"],
                                     stdout=subprocess.PIPE)
            kilit.stdout.readline()
            try:
                kod, hata = koş(komut, engel)
                denetle(f"[{ad}] koruma dosyası kilitli → engel", kod, hata, 2)
            finally:
                kilit.kill()
                kilit.wait()
        if guard.exists():
            guard.unlink()
finally:
    for f in veri.iterdir():
        f.unlink()
    veri.rmdir()

print(f"Gece koruması: {gecen} geçti, {kalan} kaldı ({', '.join(koşucular)})")
sys.exit(1 if kalan else 0)

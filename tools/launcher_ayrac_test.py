"""Yeni oturum görev metni "--" ayırıcısı testi (Launcher.StartSession → `claude --bg [--name ad] -- "<metin>"`).

Gerçek claude ÇALIŞMAZ: CLAUDE_PANEL_CLAUDE_EXE argümanlarını dosyaya yazan bir .cmd'dir. Test kopyası --no-window, boş
portta, geçici veri klasörüyle açılır. Metin "-" ile başlasa ya da bir alt komut adı ("update") olsa da "--"dan sonra
tek argüman olarak gitmeli. (cmd %* ile aktarıldığı için örnekler ASCII ve tırnaksız.)

Kullanım: uv run python -I tools/launcher_ayrac_test.py [panel.exe]
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
KOK = Path(__file__).resolve().parent.parent
EXE = Path(sys.argv[1]) if len(sys.argv) > 1 else KOK / "src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe"
gecen = kalan = 0

kok = Path(tempfile.mkdtemp(prefix="launcher-ayrac-test-"))
kayit = kok / "argv.jsonl"
(kok / "argv_yaz.py").write_text(
    "import json, sys\n"
    f"open({str(kayit)!r}, 'a', encoding='utf-8').write(json.dumps(sys.argv[1:]) + '\\n')\n", encoding="utf-8")
(kok / "sahte-claude.cmd").write_text(f'@"{sys.executable}" -I "{kok / "argv_yaz.py"}" %*\r\n', encoding="ascii")
for d in ("veri", "claude", "proje1", "proje2", "proje3"):
    (kok / d).mkdir()

with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
b = f"http://127.0.0.1:{port}"
env = dict(os.environ, CLAUDE_PANEL_PORT=str(port), CLAUDE_PANEL_DATA=str(kok / "veri"), CLAUDE_PANEL_CLAUDE_DIR=str(kok / "claude"),
           CLAUDE_PANEL_CLAUDE_EXE=str(kok / "sahte-claude.cmd"))
p = subprocess.Popen([str(EXE), "--no-window"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
tok_dosya = kok / "veri" / f"panel-{port}.token"
for _ in range(100):
    if tok_dosya.exists() and tok_dosya.read_text().strip():
        break
    time.sleep(0.2)
tok = tok_dosya.read_text().strip()


def post(yol: str, govde: dict) -> int:
    r = urllib.request.Request(b + yol, data=json.dumps(govde).encode(), method="POST",
                               headers={"X-Panel-Token": tok, "Origin": b, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=30) as y:
            return y.status
    except urllib.error.HTTPError as e:
        return e.code


ornekler = [
    ({"cwd": str(kok / "proje1"), "prompt": "-p bunu yap"}, ["--bg", "--", "-p bunu yap"]),
    ({"cwd": str(kok / "proje2"), "prompt": "--help", "name": "Deneme"}, ["--bg", "--name", "Deneme", "--", "--help"]),
    ({"cwd": str(kok / "proje3"), "prompt": "update"}, ["--bg", "--", "update"]),
]
try:
    for govde, beklenen in ornekler:
        kod = post("/api/sessions", govde)
        satirlar: list[str] = []
        for _ in range(60):
            satirlar = kayit.read_text(encoding="utf-8").splitlines() if kayit.exists() else []
            if any(json.loads(x) == beklenen for x in satirlar):
                break
            time.sleep(0.25)
        tamam = kod == 200 and any(json.loads(x) == beklenen for x in satirlar)
        if tamam:
            gecen += 1
            print(f"GEÇTİ  {govde['prompt']!r} → {beklenen}")
        else:
            kalan += 1
            print(f"KALDI  {govde['prompt']!r}: HTTP {kod}, kayıt {satirlar}")
finally:
    try:
        post("/api/quit", {})
        p.wait(15)
    except (subprocess.TimeoutExpired, OSError):
        p.kill()
        p.wait()
    shutil.rmtree(kok, ignore_errors=True)

print(f"Görev metni ayırıcısı: {gecen} geçti, {kalan} kaldı")
sys.exit(1 if kalan else 0)

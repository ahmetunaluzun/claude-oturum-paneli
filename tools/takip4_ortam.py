# Takip 4. aşama (Zamanlanmış işler, 0.14.0) için uydurma kaynaklar. tools/takip_ortam.sh'ın kurduğu klasörün üstüne yazar.
# Kullanım: py -3.13 tools/takip4_ortam.py <klasör>      (önce: tools/takip_ortam.sh <klasör> [kutuk])
#   <klasör>/gorevler.json → CLAUDE_PANEL_TASKS_FILE (sahte zamanlayıcı: gerçek Görev Zamanlayıcı'ya dokunulmaz)
#   <klasör>/agents        → CLAUDE_PANEL_LAUNCHAGENTS_DIR (macOS plist okuyucusu için dört dosya)
#   projelerde .claude/scheduled_tasks.json / .lock, <klasör>/claude/scheduled-tasks/*/SKILL.md, NEXT_SESSION.md'de TAKİP satırları
import datetime
import json
import os
import sys

T = os.path.abspath(sys.argv[1])
P = os.path.join(T, "projeler")
now = int(datetime.datetime.now().timestamp() * 1000)
H = 3_600_000


def yaz(yol, metin, mod="w"):
    os.makedirs(os.path.dirname(yol), exist_ok=True)
    with open(yol, mod, encoding="utf-8", newline="\n") as f:
        f.write(metin)


def gorev(ad, komut, arg, **k):
    g = dict(id="\\" + ad, name=ad, folder="\\", enabled=True, nextRun=now + 2 * H, lastRun=now - 22 * H, lastResult=0,
             command=komut, args=arg, workDir="", schedule=None, canDisable=True, unreadable=False)
    g.update(k)
    return g


for betik in ("Demo Mağaza/yedek.py", "Rapor Aracı/gonder.cmd", "Stok Sayım/kontrol.py", "Örnek API/saglik.py"):
    yaz(os.path.join(P, betik), "# uydurma\n")
yaz(os.path.join(T, "claude", "hooks", "temizlik.ps1"), "# uydurma\n")
SYS = r"C:\Windows\System32"
gorevler = [
    gorev("Demo Yedek", r"C:\Araclar\Python\python.exe", f'"{P}\\Demo Mağaza\\yedek.py" --tam'),
    gorev("Rapor Gönder", SYS + r"\cmd.exe", f'/c "{P}\\Rapor Aracı\\gonder.cmd"', lastResult=1, lastRun=now - 3 * H, nextRun=now + 21 * H),
    gorev("Kanca Temizliği", r"C:\Program Files\PowerShell\7\pwsh.exe", f'-NoProfile -File "{T}\\claude\\hooks\\temizlik.ps1"', lastResult=0x41301),
    gorev("Disk Bakımı", SYS + r"\cleanmgr.exe", "/sagerun:1"),
    gorev("Sistem Betiği", SYS + r"\WindowsPowerShell\v1.0\powershell.exe", r"-File C:\Windows\bakim.ps1",
          id="\\Microsoft\\Windows\\Bakım\\Sistem Betiği", folder="\\Microsoft\\Windows\\Bakım"),
    gorev("Kapalı Görev", r"C:\Windows\py.exe", "kontrol.py", workDir=os.path.join(P, "Stok Sayım"), enabled=False, nextRun=None, lastRun=None, lastResult=0x41303),
    gorev("Yetkisiz Görev", r"C:\Araclar\Python\pythonw.exe", f'"{P}\\Örnek API\\saglik.py"', canDisable=False, lastResult=0x80070002),
]
yaz(os.path.join(T, "gorevler.json"), json.dumps(gorevler, ensure_ascii=False, indent=2))

# Claude'un kalıcı görev dosyaları: içerik bilerek bozuk (panel ayrıştırmamalı); ikinci projede yalnız kilit dosyası.
yaz(os.path.join(P, "Demo Mağaza", ".claude", "scheduled_tasks.json"), '{"bicim": "belgesiz", bozuk')
yaz(os.path.join(P, "Örnek API", ".claude", "scheduled_tasks.lock"), "")
yaz(os.path.join(P, "Örnek API", ".git", "info", "exclude"), ".claude/\nsaglik.py\n", "a")

# Masaüstü uygulaması görevleri
yaz(os.path.join(T, "claude", "scheduled-tasks", "sabah-ozeti", "SKILL.md"),
    "---\nname: sabah-ozeti\ndescription: uydurma\n---\n\nDünkü commit'leri özetle ve açık işleri listele.\nİkinci satır.\n")
yaz(os.path.join(T, "claude", "scheduled-tasks", "haftalik-rapor", "SKILL.md"), "# Haftalık raporu hazırla\n")
os.makedirs(os.path.join(T, "claude", "scheduled-tasks", "bos-klasor"), exist_ok=True)


# Verilmiş sözler: geçmiş, bugün, ileri tarih, geçersiz tarih, biçimsiz; kod bloğu ve satır içi geçiş alınmaz.
def g(n):
    return (datetime.date.today() + datetime.timedelta(days=n)).isoformat()


yaz(os.path.join(P, "Örnek API", "NEXT_SESSION.md"), f"""
## Verilen sözler
- TAKİP: {g(-3)} — Ödeme sağlayıcısının yanıtını kontrol et
TAKİP: {g(0)} — Yayın sonrası hata kayıtlarına bak
> **TAKİP:** {g(10)} — Sertifika yenilemesini doğrula
- TAKİP: 2026-13-45 — Tarihi bozuk söz
- TAKİP: yarın — Biçimsiz söz
Bu satırda TAKİP: {g(1)} — satır ortasında geçtiği için alınmaz
```
TAKİP: {g(2)} — kod bloğunda olduğu için alınmaz
```
""", "a")

# macOS LaunchAgents (plist): aralıklı, devre dışı + takvimli, ilgisiz, ikili (okunamaz)
PL = ('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
      '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n%s</dict>\n</plist>\n')
yaz(os.path.join(T, "agents", "ornek.yedek.plist"), PL % (
    "<key>Label</key><string>ornek.yedek</string>\n<key>ProgramArguments</key><array><string>/usr/bin/python3</string>"
    f"<string>{P}\\Demo Mağaza\\yedek.py</string><string>--tam</string></array>\n<key>StartInterval</key><integer>3600</integer>\n<key>RunAtLoad</key><true/>\n"))
yaz(os.path.join(T, "agents", "ornek.rapor.plist"), PL % (
    f"<key>Label</key><string>ornek.rapor</string>\n<key>Program</key><string>{P}\\Rapor Aracı\\gonder.cmd</string>\n<key>Disabled</key><true/>\n"
    "<key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>\n"))
yaz(os.path.join(T, "agents", "ornek.baska.plist"), PL % "<key>Label</key><string>ornek.baska</string>\n<key>Program</key><string>/usr/bin/true</string>\n")
with open(os.path.join(T, "agents", "ikili.plist"), "wb") as f:
    f.write(b"bplist00\xd1\x01\x02")

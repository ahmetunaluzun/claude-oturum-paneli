# Zamanlanmış görev satır düğmeleri testi (tools/gorev_dugme_test.sh) için uydurma görevler ve dosyalar.
# Kullanım: py -3.13 tools/gorev_dugme_ortam.py <klasör>   → <klasör>/gorevler.json (CLAUDE_PANEL_TASKS_FILE) + betikler + loglar
# Görevler gerçek bir şey çalıştırmaz: sahte zamanlayıcı "Şimdi çalıştır"da yalnız gorevler.json'a yazar (OsTasks.Run).
import datetime
import json
import os
import sys

T = os.path.abspath(sys.argv[1])
P = os.path.join(T, "p")
now = int(datetime.datetime.now().timestamp() * 1000)
H = 3_600_000
PY, PWSH = r"C:\Windows\py.exe", r"C:\Program Files\PowerShell\7\pwsh.exe"


def yaz(yol, metin=""):
    os.makedirs(os.path.dirname(yol), exist_ok=True)
    with open(yol, "w", encoding="utf-8", newline="\n") as f:
        f.write(metin)


def gorev(ad, komut, arg, **k):
    g = dict(id="\\Deneme\\" + ad, name=ad, folder="\\Deneme", enabled=True, nextRun=now + 2 * H, lastRun=now - 5 * H, lastResult=0,
             command=komut, args=arg, workDir="", schedule=None, canDisable=True, unreadable=False)
    g.update(k)
    return g


# 1) Çıkış 1 = "değişiklik var" sinyali; log yolu betiğin içinde göreli yazılı
site = os.path.join(P, "Yardim Sitesi")
yaz(os.path.join(site, "izle.py"), 'LOG = "logs/izle.log"\nprint("uydurma")\n')
yaz(os.path.join(site, "logs", "izle.log"), "2026-11-21 03:00 degisiklik var\n")
# 2) Zaten çalışıyordu (0x80070420); log komuttaki yönlendirmede
edge = os.path.join(P, "Edge Izleyici")
yaz(os.path.join(edge, "izle.ps1"), "# uydurma\n")
yaz(os.path.join(edge, "cikti.log"), "uydurma\n")
# 3) Kapanışta durduruldu (0xC000013A); betik klasöründe yalnız logs/ klasörü
kaynak = os.path.join(P, "Kaynak Oncelik")
yaz(os.path.join(kaynak, "oncelik.ps1"), "# uydurma\n")
os.makedirs(os.path.join(kaynak, "logs"), exist_ok=True)
# 4) Gerçek arıza (çıkış 2), log yok
rapor = os.path.join(P, "Gunluk Rapor")
yaz(os.path.join(rapor, "rapor.py"), "print('uydurma')\n")

# 5) Komutun kendisi çalışma klasörüne göreli .bat; log tırnaksız yönlendirmede
haftalik = os.path.join(T, "claude", "hooks", "Haftalik Kontrol")  # ~/.claude altı: proje kökü olmadan da listelenir
yaz(os.path.join(haftalik, "kontrol.bat"), "@echo off\r\ncd /d %~dp0\r\necho Kontrol >> son_kontrol.log\r\n")
yaz(os.path.join(haftalik, "son_kontrol.log"), "uydurma\n")

gorevler = [
    gorev("Haftalık Kontrol", "kontrol.bat", "", workDir=haftalik),
    gorev("Yardım Sitesi", PY, f'-3.13 "{site}\\izle.py"', lastResult=1),
    gorev("Edge İzleyici", PWSH, f'-NoProfile -File "{edge}\\izle.ps1" > "{edge}\\cikti.log"', lastResult=0x80070420),
    gorev("Kaynak Öncelik", PWSH, f'-NoProfile -File "{kaynak}\\oncelik.ps1"', lastResult=0xC000013A),
    gorev("Günlük Rapor", PY, f'"{rapor}\\rapor.py"', lastResult=2),
    gorev("Kapalı İş", PY, f'"{rapor}\\rapor.py"', enabled=False, nextRun=None, lastResult=0x41303),
]
yaz(os.path.join(T, "gorevler.json"), json.dumps(gorevler, ensure_ascii=False, indent=2))

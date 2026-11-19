# Testler için sahte claude: gerçek claude ÇALIŞMAZ, kota harcanmaz, ~/.claude'a yazılmaz.
# Panelin beklediği akışı taklit eder: stdin'den satır satır kullanıcı mesajı (stream-json) okur, stdout'a init + result yazar.
# Davranış mesaja göre:
#   "BEKLE" içeriyorsa      → yanıt vermez (oturum "çalışıyor" kalır)
#   commit istemi ise       → (PANEL-TAMAM işareti isteniyorsa) klasörde .sahte-karar varsa [PANEL-KARAR]; yoksa
#                             SAHTE_CLAUDE_GECIKME sn bekler, `git add -A && git commit` yapar, [PANEL-TAMAM] ile biter
#   kütük istemi ise        → (istemde GUNCELLEME_KUTUGU.md geçiyorsa) klasörde .sahte-karar varsa [PANEL-KARAR]; .sahte-bos
#                             varsa kütüğe dokunmadan [PANEL-TAMAM]; yoksa istemde sayılan dosyaların satırlarını kütükten
#                             çıkarır, sona KAPATILDI bölümü olarak yazar, [PANEL-TAMAM] ile biter
#   "ZAMANLA" içeriyorsa    → SAHTE_CLAUDE_KAYIT klasörüne bu oturumun konuşma kaydını yazar: iki CronCreate (biri tek seferlik),
#                             /loop komutu, dört ScheduleWakeup (son üçü noop: true), kullanım (token) bilgisi
#   durdurma istemi ise     → (istemde CronDelete geçiyorsa) kayda CronDelete + ScheduleWakeup stop yazar
#   diğer                   → kısa yanıt
# Her açılış ve her mesaj SAHTE_CLAUDE_LOG dosyasına yazılır: "ACILIS\t<sid>\t<cwd>" / "MESAJ\t<sid>\t<cwd>\t<metin>".
# Çağıran .cmd argümanları iletmez (satır içi JSON'u cmd ayrıştıramıyor); bu betik argüman kullanmaz.
import json
import os
import subprocess
import sys
import time
import uuid

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8", newline="\n")
SID = str(uuid.uuid4())
CWD = os.getcwd()
LOG = os.environ.get("SAHTE_CLAUDE_LOG")
DELAY = float(os.environ.get("SAHTE_CLAUDE_GECIKME", "0"))
GIT = ["git", "-c", "user.name=Demo", "-c", "user.email=demo@example.invalid", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false"]


def log(*parts):
    if LOG:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write("\t".join(parts) + "\n")


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


KAYIT = os.environ.get("SAHTE_CLAUDE_KAYIT")
_n = [0]


def kayit(tur, icerik, usage=None):
    """Konuşma kaydına (transkript) tek satır ekler; usage = (girdi, çıktı, önbelleğe yazılan)."""
    if not KAYIT:
        return
    os.makedirs(KAYIT, exist_ok=True)
    _n[0] += 1
    msg = {"role": tur, "content": icerik}
    if usage:
        msg.update(id=f"msg_{_n[0]}", model="claude-sahte-1",
                   usage={"input_tokens": usage[0], "output_tokens": usage[1], "cache_creation_input_tokens": usage[2], "cache_read_input_tokens": 9000})
    row = {"type": tur, "uuid": str(uuid.uuid4()), "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "cwd": CWD, "message": msg}
    with open(os.path.join(KAYIT, SID + ".jsonl"), "a", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def arac(ad, kimlik, girdi, usage):
    kayit("assistant", [{"type": "tool_use", "id": kimlik, "name": ad, "input": girdi}], usage)


def zamanla():
    kayit("user", "ZAMANLA")
    arac("CronCreate", "toolu_a", {"cron": "*/30 * * * *", "prompt": "Derleme durumunu denetle", "recurring": True}, (100, 50, 0))
    kayit("user", [{"type": "tool_result", "tool_use_id": "toolu_a", "content": "Scheduled recurring job a1b2c3d4"}])
    arac("CronCreate", "toolu_b", {"cron": "0 9 * * *", "prompt": "Sabah raporunu gönder", "recurring": False}, (200, 100, 1000))
    kayit("user", [{"type": "tool_result", "tool_use_id": "toolu_b", "content": "Scheduled one-shot job e5f6a7b8"}])
    kayit("user", "<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>5m dağıtım durumunu denetle</command-args>")
    for i in range(4):
        arac("ScheduleWakeup", f"toolu_w{i}", {"delaySeconds": 300, "reason": "Dağıtım sürüyor mu diye bakılacak", "prompt": "/loop 5m dağıtım durumunu denetle", "noop": i > 0}, (10, 20, 0))


def durdur():
    arac("CronDelete", "toolu_d1", {"id": "a1b2c3d4"}, (5, 5, 0))
    arac("CronDelete", "toolu_d2", {"id": "e5f6a7b8"}, (5, 5, 0))
    arac("ScheduleWakeup", "toolu_ws", {"stop": True, "reason": "durduruldu"}, (5, 5, 0))


log("ACILIS", SID, CWD)
first = True
for line in sys.stdin:
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        continue
    if msg.get("type") != "user":
        continue
    text = msg.get("message", {}).get("content", "")
    log("MESAJ", SID, CWD, text.replace("\n", " ")[:1200])
    if first:
        out({"type": "system", "subtype": "init", "session_id": SID, "model": "claude-sahte-1", "slash_commands": []})
        first = False
    if "BEKLE" in text:
        continue
    if "[PANEL-TAMAM]" in text and "GUNCELLEME_KUTUGU.md" in text:
        ledger = os.path.join(CWD, "GUNCELLEME_KUTUGU.md")
        if os.path.exists(os.path.join(CWD, ".sahte-karar")):
            reply = "Hangi bölümün kapatılacağı belirsiz.\n[PANEL-KARAR]"
        elif os.path.exists(os.path.join(CWD, ".sahte-bos")):
            reply = "Kütük güncellendi.\n[PANEL-TAMAM]"
        else:
            time.sleep(DELAY)
            names = [os.path.basename(row[2:].strip().replace("\\", "/")) for row in text.split("\n") if row.startswith("- ")]
            with open(ledger, encoding="utf-8") as f:
                rows = f.read().split("\n")
            closed = [r for r in rows if any(n and n in r for n in names)]
            rows = [r for r in rows if r not in closed]
            with open(ledger, "w", encoding="utf-8", newline="\n") as f:
                f.write("\n".join(rows).rstrip("\n") + "\n\n## KAPATILDI — DRIVE'A YÜKLENDİ (sahte oturum)\n\n" + "\n".join(closed) + "\n")
            reply = "Kütük güncellendi.\n[PANEL-TAMAM]"
    elif "[PANEL-TAMAM]" in text:
        if os.path.exists(os.path.join(CWD, ".sahte-karar")):
            reply = "Bu dosyada parola olabilir, commit etmedim.\n[PANEL-KARAR]"
        else:
            time.sleep(DELAY)
            subprocess.run(GIT + ["add", "-A"], cwd=CWD, capture_output=True)
            r = subprocess.run(GIT + ["commit", "-q", "-m", "Sahte commit"], cwd=CWD, capture_output=True)
            reply = "Değişiklikler commit edildi.\n[PANEL-TAMAM]" if r.returncode == 0 else "Commit yapılamadı.\n[PANEL-KARAR]"
    elif "ZAMANLA" in text:
        zamanla()
        reply = "zamanlandı"
    elif "CronDelete" in text:
        durdur()
        reply = "Tekrarlı işler durduruldu."
    else:
        reply = "tamam"
    out({"type": "result", "subtype": "success", "is_error": False, "result": reply, "session_id": SID, "total_cost_usd": 0})

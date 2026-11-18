# Testler için sahte claude: gerçek claude ÇALIŞMAZ, kota harcanmaz, ~/.claude'a yazılmaz.
# Panelin beklediği akışı taklit eder: stdin'den satır satır kullanıcı mesajı (stream-json) okur, stdout'a init + result yazar.
# Davranış mesaja göre:
#   "BEKLE" içeriyorsa      → yanıt vermez (oturum "çalışıyor" kalır)
#   commit istemi ise       → (PANEL-TAMAM işareti isteniyorsa) klasörde .sahte-karar varsa [PANEL-KARAR]; yoksa
#                             SAHTE_CLAUDE_GECIKME sn bekler, `git add -A && git commit` yapar, [PANEL-TAMAM] ile biter
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
    log("MESAJ", SID, CWD, text.replace("\n", " ")[:200])
    if first:
        out({"type": "system", "subtype": "init", "session_id": SID, "model": "claude-sahte-1", "slash_commands": []})
        first = False
    if "BEKLE" in text:
        continue
    if "[PANEL-TAMAM]" in text:
        if os.path.exists(os.path.join(CWD, ".sahte-karar")):
            reply = "Bu dosyada parola olabilir, commit etmedim.\n[PANEL-KARAR]"
        else:
            time.sleep(DELAY)
            subprocess.run(GIT + ["add", "-A"], cwd=CWD, capture_output=True)
            r = subprocess.run(GIT + ["commit", "-q", "-m", "Sahte commit"], cwd=CWD, capture_output=True)
            reply = "Değişiklikler commit edildi.\n[PANEL-TAMAM]" if r.returncode == 0 else "Commit yapılamadı.\n[PANEL-KARAR]"
    else:
        reply = "tamam"
    out({"type": "result", "subtype": "success", "is_error": False, "result": reply, "session_id": SID, "total_cost_usd": 0})

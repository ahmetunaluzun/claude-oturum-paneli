# Arka plan işi testleri için UYDURMA konuşma kaydı satırları ekler (gerçek ~/.claude kayıtlarının YAPISINI taklit eder; içerik uydurma).
# Biçim (22.11.2026'da bu bilgisayardaki gerçek kayıtlardan yalnız yapı olarak doğrulandı):
#   alt ajan başlangıcı : user satırı, toolUseResult {isAsync:true, status:"async_launched", agentId, description}
#   komut başlangıcı    : assistant satırı tool_use Bash {run_in_background:true, description} + user satırı toolUseResult {backgroundTaskId}
#   bitiş               : user satırı (string içerik) ya da queue-operation satırı: <task-notification><task-id>…</task-id>…<status>completed|failed|killed|stopped</status>
#   eşzamanlı alt ajan  : user satırı toolUseResult {status:"completed", agentId}  (isAsync yok)
# Kullanım: py -3.13 arkaplan_kayit.py <kayit.jsonl> <komut> <argümanlar…>
#   agent <kimlik> <açıklama> [saat_önce]      bash <kimlik> <açıklama> [saat_önce]     sync <kimlik>
#   bitti <kimlik> <durum> [user|kuyruk]       yarim <kimlik>  (satır sonu OLMADAN yarım bir bitiş bildirimi yazar)   tamamla  (yarım satırı bitirir)
#   alt <klasör> <kimlik> [dk_önce]            (subagents/agent-<kimlik>.jsonl oluşturur, değişiklik zamanı dk_önce kadar geride)
import json, os, sys, time, uuid
from datetime import datetime, timedelta, timezone

dosya, komut, *a = sys.argv[1:]
SID = os.path.splitext(os.path.basename(dosya))[0]


def ts(saat_once=0.0):
    return (datetime.now(timezone.utc) - timedelta(hours=float(saat_once))).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def yaz(obj, son="\n"):
    os.makedirs(os.path.dirname(dosya), exist_ok=True)
    with open(dosya, "a", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + son)


def sonuc(tool_id, tur_sonuc, saat_once=0.0):
    return {"type": "user", "uuid": str(uuid.uuid4()), "timestamp": ts(saat_once), "sessionId": SID, "cwd": "C:\\uydurma",
            "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tool_id, "content": "uydurma sonuç"}]}, "toolUseResult": tur_sonuc}


def bildirim(kimlik, durum):
    return f"<task-notification>\n<task-id>{kimlik}</task-id>\n<tool-use-id>toolu_{kimlik}</tool-use-id>\n<output-file>x.output</output-file>\n<status>{durum}</status>\n<summary>uydurma özet</summary>\n</task-notification>"


if komut == "agent":
    kimlik, acik, *s = a
    yaz(sonuc("toolu_" + kimlik, {"isAsync": True, "status": "async_launched", "agentId": kimlik, "description": acik, "prompt": "uydurma"}, s[0] if s else 0))
elif komut == "bash":
    kimlik, acik, *s = a
    yaz({"type": "assistant", "uuid": str(uuid.uuid4()), "timestamp": ts(s[0] if s else 0), "sessionId": SID,
         "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_" + kimlik, "name": "Bash",
                                                       "input": {"command": "sleep 999 # uydurma", "description": acik, "run_in_background": True}}]}})
    yaz(sonuc("toolu_" + kimlik, {"stdout": "", "stderr": "", "interrupted": False, "backgroundTaskId": kimlik}, s[0] if s else 0))
elif komut == "sync":
    yaz(sonuc("toolu_" + a[0], {"status": "completed", "agentId": a[0], "content": []}))
elif komut == "bitti":
    kimlik, durum, *t = a
    if t and t[0] == "kuyruk":
        yaz({"type": "queue-operation", "operation": "enqueue", "timestamp": ts(), "sessionId": SID, "content": bildirim(kimlik, durum)})
    else:
        yaz({"type": "user", "uuid": str(uuid.uuid4()), "timestamp": ts(), "sessionId": SID, "message": {"role": "user", "content": bildirim(kimlik, durum)}})
elif komut == "yarim":
    satir = json.dumps({"type": "user", "uuid": str(uuid.uuid4()), "timestamp": ts(), "sessionId": SID, "message": {"role": "user", "content": bildirim(a[0], "completed")}},
                       ensure_ascii=False, separators=(",", ":"))
    os.makedirs(os.path.dirname(dosya), exist_ok=True)
    with open(dosya, "a", encoding="utf-8", newline="\n") as f:
        f.write(satir[:len(satir) // 2])
    open(dosya + ".yarim", "w", encoding="utf-8").write(satir[len(satir) // 2:])
elif komut == "tamamla":
    with open(dosya, "a", encoding="utf-8", newline="\n") as f:
        f.write(open(dosya + ".yarim", encoding="utf-8").read() + "\n")
    os.remove(dosya + ".yarim")
elif komut == "alt":
    klasor, kimlik, *dk = a
    os.makedirs(klasor, exist_ok=True)
    p = os.path.join(klasor, f"agent-{kimlik}.jsonl")
    open(p, "a", encoding="utf-8").write("{}\n")
    t = time.time() - 60 * float(dk[0] if dk else 0)
    os.utime(p, (t, t))
else:
    sys.exit("bilinmeyen komut: " + komut)

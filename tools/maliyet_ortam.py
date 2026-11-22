"""Proje maliyeti + açılış yükü testleri için sahte ~/.claude ağacı (gerçek ~/.claude'a dokunmaz).

Kullanım: py -3.13 -I tools/maliyet_ortam.py <kök>   (kök altında claude/, p/ ve .claude.json kurulur)
Beklenen değerler tools/maliyet_test.sh içinde elle hesaplıdır (fiyatlar CostPrices.cs, 2026-11-22):
  A opus-5-5   in 10, out 1000, okuma 100000, yazma 20000 (1 saat)        = 0,20004 $
  B opus-5-5   in 5, out 500, okuma 120000, yazma 5000 (ayrım yok → 5 dk)  = 0,05902 $
  C haiku-5-5  in 2000, out 300 (alt ajan)                                  = 0,00035 $
  D opus-5-5   hızlı mod, in 100, out 200, 2 web araması                    = 0,0288 $
  E claude-3-opus-20240229 (20 gün önce; fiyatı tabloda yok)               = bilinmiyor
  F sonnet-5-5 (Beta, 40 gün önce) in 3, out 100, okuma 90000, yazma 10000 = 0,035006 $
"""
import json, os, sys, time, uuid

root = os.path.abspath(sys.argv[1])
claude = os.path.join(root, "claude")
alfa = os.path.join(root, "p", "Alfa Projesi")
beta = os.path.join(root, "p", "Beta")
NOW = time.time()


def w(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + ".000Z"


def user(t, cwd, side=False, text="merhaba"):
    return {"type": "user", "isSidechain": side, "cwd": cwd, "timestamp": iso(t), "uuid": str(uuid.uuid4()),
            "message": {"role": "user", "content": text}}


def asst(t, cwd, mid, model, usage, side=False):
    return {"parentUuid": None, "isSidechain": side, "message": {"id": mid, "model": model, "role": "assistant",
            "content": [{"type": "text", "text": "tamam"}], "usage": usage},
            "type": "assistant", "uuid": str(uuid.uuid4()), "timestamp": iso(t), "cwd": cwd}


def jsonl(path, rows, mtime):
    w(path, "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
    os.utime(path, (mtime, mtime))


UA = {"input_tokens": 10, "output_tokens": 1000, "cache_read_input_tokens": 100000, "cache_creation_input_tokens": 20000,
      "cache_creation": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 20000}, "speed": "standard"}
UB = {"input_tokens": 5, "output_tokens": 500, "cache_read_input_tokens": 120000, "cache_creation_input_tokens": 5000}
UC = {"input_tokens": 2000, "output_tokens": 300, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
UD = {"input_tokens": 100, "output_tokens": 200, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0,
      "speed": "fast", "server_tool_use": {"web_search_requests": 2, "web_fetch_requests": 0}}
UE = {"input_tokens": 50, "output_tokens": 50, "cache_read_input_tokens": 80000, "cache_creation_input_tokens": 0}
UF = {"input_tokens": 3, "output_tokens": 100, "cache_read_input_tokens": 90000, "cache_creation_input_tokens": 10000}

projects = os.path.join(claude, "projects")
s1 = str(uuid.UUID(int=1))
t0 = NOW - 2 * 3600
# Oturum 1: A iki satırda (aynı id), 10 dk boşluk, B ve hızlı D. Bozuk satır ve "<synthetic>" yanıt da var.
rows = [user(t0, alfa), asst(t0 + 60, alfa, "msg_A", "claude-opus-5-5", UA), asst(t0 + 120, alfa, "msg_A", "claude-opus-5-5", UA),
        user(t0 + 720, alfa), asst(t0 + 750, alfa, "msg_B", "claude-opus-5-5", UB),
        asst(t0 + 780, alfa, "msg_D", "claude-opus-5-5", UD),
        asst(t0 + 780, alfa, "msg_S", "<synthetic>", {"input_tokens": 0, "output_tokens": 0})]
p1 = os.path.join(projects, "X-Alfa", s1 + ".jsonl")
jsonl(p1, rows, NOW - 60)
with open(p1, "a", encoding="utf-8") as f:
    f.write('{"type":"assistant", bozuk satır\n')
os.utime(p1, (NOW - 60, NOW - 60))
# Alt ajan: 60–240 sn (ana oturumla çakışır; birleşim 0–240 sn)
jsonl(os.path.join(projects, "X-Alfa", s1, "subagents", "agent-a1.jsonl"),
      [user(t0 + 60, alfa, True), asst(t0 + 240, alfa, "msg_C", "claude-haiku-5-5", UC, True)], NOW - 70)
# Aynı oturumun başka klasördeki kopyası (klasör adı değişmiş): A yeniden sayılmamalı
jsonl(os.path.join(projects, "X-Alfa-eski", str(uuid.UUID(int=2)) + ".jsonl"),
      [user(t0, alfa), asst(t0 + 60, alfa, "msg_A", "claude-opus-5-5", UA), asst(t0 + 120, alfa, "msg_A", "claude-opus-5-5", UA)], NOW - 3600)
# 20 gün önce, fiyatı bilinmeyen model
t20 = NOW - 20 * 86400
jsonl(os.path.join(projects, "X-Alfa", str(uuid.UUID(int=3)) + ".jsonl"),
      [user(t20, alfa), asst(t20 + 30, alfa, "msg_E", "claude-3-opus-20240229", UE)], t20 + 30)
# Beta: 40 gün önce
t40 = NOW - 40 * 86400
jsonl(os.path.join(projects, "X-Beta", str(uuid.UUID(int=4)) + ".jsonl"),
      [user(t40, beta), asst(t40 + 90, beta, "msg_F", "claude-sonnet-5-5", UF)], t40 + 90)

# Açılış yükü kaynakları (karakter sayıları 3,5'in katı: tahmin tam sayı çıksın)
w(os.path.join(claude, "CLAUDE.md"), "a" * 7000)                     # 2000
w(os.path.join(claude, "rules", "buyuk-kural.md"), "b" * 3500)       # 1000
w(os.path.join(claude, "rules", "kucuk.md"), "c" * 700)              # 200
w(os.path.join(root, "p", "CLAUDE.md"), "d" * 350)                   # 100 (üst klasör)
w(os.path.join(alfa, "CLAUDE.md"), "e" * 1750)                       # 500
w(os.path.join(projects, "X-Alfa", "memory", "MEMORY.md"), "f" * 350)  # 100
w(os.path.join(claude, "skills", "rapor", "SKILL.md"), "---\nname: rapor\ndescription: " + "g" * 61 + "\n---\n")        # 70 → 20
w(os.path.join(claude, "skills", "sunum-yap", "SKILL.md"), "---\nname: sunum-yap\ndescription: " + "h" * 162 + "\n---\n")  # 175 → 50
w(os.path.join(claude, "skills-disabled", "havuz", "SKILL.md"), "---\nname: havuz\ndescription: " + "i" * 999 + "\n---\n")
w(os.path.join(claude, "settings.json"), json.dumps({"mcpServers": {"postgres": {"command": "x"}}}))
w(os.path.join(root, ".claude.json"), json.dumps({"mcpServers": {"gmail": {}},
  "projects": {alfa.replace("\\", "/"): {"mcpServers": {"proje-mcp": {}}}}}))
w(os.path.join(alfa, ".mcp.json"), json.dumps({"mcpServers": {"figma": {}}}))
os.makedirs(beta, exist_ok=True)
print("kuruldu:", root)

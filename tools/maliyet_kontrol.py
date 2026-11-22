"""/api/cost ve /api/startup-load yanıtlarını tools/maliyet_ortam.py'nin elle hesaplanmış beklentileriyle karşılaştırır.

Kullanım: py -3.13 -I tools/maliyet_kontrol.py <cost.json> <load.json> <load_beta.json> <load_yabanci.json> <kök>
Çıkış 0 = hepsi geçti.
"""
import json, os, sys

sys.stdout.reconfigure(encoding="utf-8")  # -I, PYTHONUTF8'i yok sayar
cost = json.load(open(sys.argv[1], encoding="utf-8"))
load = json.load(open(sys.argv[2], encoding="utf-8"))
load_beta = json.load(open(sys.argv[3], encoding="utf-8"))
load_bad = json.load(open(sys.argv[4], encoding="utf-8"))
root = os.path.abspath(sys.argv[5])
alfa = os.path.join(root, "p", "Alfa Projesi")
beta = os.path.join(root, "p", "Beta")
fail = 0


def check(name, got, want):
    global fail
    ok = got == want
    fail |= not ok
    print(("GEÇTİ " if ok else "KALDI ") + name + ("" if ok else f" (beklenen {want!r}, gelen {got!r})"))


def row(period, cwd):
    return next((r for r in cost["periods"][period] if r["cwd"].lower() == cwd.lower()), None)


A, B, C, D, F = 0.20004, 0.05902, 0.00035, 0.0288, 0.035006
check("hazır", cost["ready"], True)
check("fiyat kaynağı", (cost["source"], cost["asOf"]), ("https://platform.claude.com/docs/en/about-claude/pricing", "2026-11-22"))
check("kayıt sayısı (alt ajan dahil)", cost["files"], 5)
r7 = row("7", alfa)
check("7 gün: yalnız Alfa", [r["name"] for r in cost["periods"]["7"]], ["Alfa Projesi"])
check("7 gün: tokenlar (aynı id bir kez, kopya ve <synthetic> sayılmaz)",
      (r7["input"], r7["output"], r7["cacheRead"], r7["cacheWrite"]), (2115, 2000, 220000, 25000))
check("7 gün: tutar (1 saat yazma, hızlı mod, web araması, Haiku)", r7["cost"], round(A + B + C + D, 4))
check("7 gün: tutar eksiksiz", (r7["costComplete"], r7["costKnown"], r7["unknownModels"]), (True, True, []))
check("7 gün: süre 5 dk (10 dk boşluk sayılmaz, alt ajan + kopya birleşim)", r7["activeMs"], 300000)
check("7 gün: oturum sayısı (alt ajan oturum sayılmaz)", r7["sessions"], 2)
models = {m["model"]: m for m in r7["models"]}
check("7 gün: model dökümü", sorted(models), ["claude-haiku-5-5", "claude-opus-5-5"])
check("7 gün: opus tutarı", models["claude-opus-5-5"]["cost"], round(A + B + D, 4))
check("7 gün: haiku tutarı (0,00035 → 4 basamak)", models["claude-haiku-5-5"]["cost"], 0.0004)
r30 = row("30", alfa)
check("30 gün: bilinmeyen model eksik sayılır, uydurulmaz",
      (r30["costComplete"], r30["unknownModels"], r30["cost"]), (False, ["claude-3-opus-20240229"], round(A + B + C + D, 4)))
check("30 gün: bilinmeyen modelin tutarı null", next(m for m in r30["models"] if m["model"] == "claude-3-opus-20240229")["cost"], None)
check("30 gün: süre + 30 sn", r30["activeMs"], 330000)
check("30 gün: Beta yok", row("30", beta), None)
rb = row("all", beta)
check("tümü: Beta", (rb["cost"], rb["activeMs"], rb["sessions"]), (round(F, 4), 90000, 1))
check("tümü: sıra tutara göre", [r["name"] for r in cost["periods"]["all"]], ["Alfa Projesi", "Beta"])

# ---- Açılış yükü ----
check("ölçülen: 4 oturum, en az / medyan / en çok", (load["sessions"], load["min"], load["median"], load["max"]),
      (4, 80050, 110006, 120010))
check("oran sabiti", load["charsPerToken"], 3.5)
check("varsayılan proje en yeni oturumun klasörü", load["cwd"], alfa)
items = {(i["kind"], i["label"]): i for i in load["items"]}
want = {("global", "CLAUDE.md"): 2000, ("rule", "buyuk-kural.md"): 1000, ("rule", "kucuk.md"): 200,
        ("parentMd", os.path.join("p", "CLAUDE.md")): 100, ("projectMd", os.path.join("Alfa Projesi", "CLAUDE.md")): 500,
        ("memory", "MEMORY.md"): 100, ("skill", "rapor"): 20, ("skill", "sunum-yap"): 50}
check("tahmin kalemleri ve tokenları", {k: v["tokens"] for k, v in items.items() if v["tokens"] is not None}, want)
check("havuzdaki skill sayılmaz", ("skill", "havuz") in items, False)
check("MCP: adlar, ölçülemedi (null)", sorted((k[1], v["source"], v["tokens"]) for k, v in items.items() if k[0] == "mcp"),
      [("figma", ".mcp.json", None), ("gmail", ".claude.json", None), ("postgres", "settings.json", None), ("proje-mcp", ".claude.json", None)])
check("tahmin toplamı", load["estimate"], 3970)
check("fark satırı = medyan − tahmin", load["rest"], 110006 - 3970)
real = os.path.join(os.path.expanduser("~"), ".claude").lower()
check("gerçek ~/.claude okunmadı", [i["path"] for i in load["items"] if i["path"] and i["path"].lower().startswith(real)], [])
check("Beta seçilince proje dosyaları değişir",
      sorted(i["kind"] for i in load_beta["items"] if i["kind"] in ("projectMd", "memory", "mcp")), ["mcp", "mcp"])
check("Beta: üst klasör CLAUDE.md yine var", any(i["kind"] == "parentMd" for i in load_beta["items"]), True)
check("ölçülmeyen klasör istenirse yok sayılır", load_bad["cwd"], alfa)
sys.exit(fail)

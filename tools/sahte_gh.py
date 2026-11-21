# Testler için sahte GitHub CLI (gh): gerçek gh ÇALIŞMAZ, ağa çıkılmaz, GitHub'a hiçbir şey gitmez.
# Panel CLAUDE_PANEL_GH_EXE ile bunu çağıran .cmd'yi kullanır (GitHubWatch.cs). İki kullanım:
#
# 1) gh yerine (argümanlar panelden gelir):  sahte_gh.py api user | api -X GET search/issues -f q=... | api -X GET repos/S/D/issues/N/comments -f per_page=1 -f page=K
#    Senaryo SAHTE_GH_DOSYA'daki JSON'dan okunur: { "mode": "ok" | "noauth" | "net", "login", "items": [...], "raw": [...], "comments": { "sahip/depo#N": ["yazan1", ...] } }
#    Her çağrı SAHTE_GH_LOG'a yazılır: "CAGRI\t<uç>\t<alanlar>". Okuma dışı her çağrı (api dışı komut, GET dışı yöntem) "YAZMA\t..."
#    olarak yazılır ve hata döner: testler panelin GitHub'a yazmadığını bu satırın yokluğuyla doğrular.
#
# 2) Senaryo yazmak için:  sahte_gh.py --senaryo <ad> <dosya>
#    ilk        : 5 öğe + 1 bozuk kayıt. Cevap bekleyen: #1 (başkası açtı, yorum yok), #5 PR (son yorum başkasında, yerel klasörü yok),
#                 #9 (kendi issue'su, son yorum başkasında). Sakin: #2 (son yorum kullanıcıda), #7 (kendi açtığı, yorumsuz).
#    yeniyorum  : #2'ye başkası yeni yorum yazdı (updated_at ilerledi) → cevap bekliyor
#    cevapladim : #1'e kullanıcı cevap yazdı → sakin
#    bos        : açık öğe yok
#    ag / giris : ağ hatası / giriş yapılmamış (liste aynı kalır, yalnız kip değişir)
import json
import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", newline="\n")
sys.stderr.reconfigure(encoding="utf-8", newline="\n")
LOGIN = "testkul"
DAY = 86400


def iso(ago, base=None):
    """base verilmezse günün başı (UTC): senaryo yeniden yazılınca değişmeyen öğelerin updated_at'i aynı kalır."""
    t = time.time() if base == "simdi" else int(time.time()) // DAY * DAY
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(t - ago)))


def senaryo(ad):
    items = [
        dict(repo=f"{LOGIN}/demo-magaza", number=1, title="Gece modu koruması için birkaç öneri", author="misafir1", comments=0, updated=iso(2 * DAY)),
        dict(repo=f"{LOGIN}/demo-magaza", number=2, title="Sepet toplamı indirimde yanlış", author="misafir2", comments=3, updated=iso(5 * DAY)),
        dict(repo=f"{LOGIN}/ornek-kitaplik", number=5, title="Türkçe çeviri düzeltmesi", author="misafir3", comments=2, updated=iso(3 * 3600), pr=True),
        dict(repo=f"{LOGIN}/Temiz-Kutuphane", number=7, title="Sürüm notlarını yaz", author=LOGIN, comments=0, updated=iso(9 * DAY)),
        dict(repo=f"{LOGIN}/demo-magaza", number=9, title="Ödeme sayfası & <b>kaçış</b> denemesi", author=LOGIN, comments=1, updated=iso(DAY)),
    ]
    comments = {f"{LOGIN}/demo-magaza#2": ["misafir2", LOGIN, LOGIN], f"{LOGIN}/ornek-kitaplik#5": [LOGIN, "misafir3"], f"{LOGIN}/demo-magaza#9": ["misafir1"]}
    s = dict(mode="ok", login=LOGIN, items=items, comments=comments, raw=[{"number": "bozuk", "title": 5}])
    if ad == "yeniyorum":
        items[1].update(comments=4, updated=iso(30, "simdi"))
        comments[f"{LOGIN}/demo-magaza#2"].append("misafir2")
    elif ad == "cevapladim":
        items[0].update(comments=1, updated=iso(20, "simdi"))
        comments[f"{LOGIN}/demo-magaza#1"] = [LOGIN]
    elif ad == "bos":
        s.update(items=[], raw=[])
    elif ad == "ag":
        s["mode"] = "net"
    elif ad == "giris":
        s["mode"] = "noauth"
    elif ad != "ilk":
        sys.exit(f"bilinmeyen senaryo: {ad}")
    return s


def log(*parts):
    path = os.environ.get("SAHTE_GH_LOG")
    if path:
        with open(path, "a", encoding="utf-8", newline="\n") as f:
            f.write("\t".join(parts) + "\n")


def gh(argv):
    fields, rest, method, i = {}, [], None, 0
    while i < len(argv):
        a = argv[i]
        if a in ("-f", "-F", "--raw-field", "--field") and i + 1 < len(argv):
            k, _, v = argv[i + 1].partition("=")
            fields[k] = v
            i += 2
        elif a in ("-X", "--method") and i + 1 < len(argv):
            method = argv[i + 1].upper()
            i += 2
        else:
            rest.append(a)
            i += 1
    # Gerçek gh: alan verilip yöntem verilmezse POST yapar. Okuma = "api" + (alan yok ya da açıkça GET).
    if len(rest) != 2 or rest[0] != "api" or (method or ("POST" if fields else "GET")) != "GET":
        log("YAZMA", " ".join(argv))
        print("sahte gh: yalnız okuma çağrıları desteklenir", file=sys.stderr)
        return 1
    ep = rest[1]
    log("CAGRI", ep, json.dumps(fields, ensure_ascii=False, sort_keys=True))
    with open(os.environ["SAHTE_GH_DOSYA"], encoding="utf-8") as f:
        s = json.load(f)
    if s["mode"] == "noauth":
        print("To get started with GitHub CLI, please run:  gh auth login", file=sys.stderr)
        return 4
    if s["mode"] == "net":
        print('error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com', file=sys.stderr)
        return 1
    if ep == "user":
        out = {"login": s["login"], "id": 1}
    elif ep == "search/issues":
        rows = []
        for it in s["items"]:
            kind = "pull" if it.get("pr") else "issues"
            row = {"repository_url": "https://api.github.com/repos/" + it["repo"], "number": it["number"], "title": it["title"], "user": {"login": it["author"]},
                   "comments": it["comments"], "updated_at": it["updated"], "html_url": f"https://github.com/{it['repo']}/{kind}/{it['number']}", "state": "open"}
            if it.get("pr"):
                row["pull_request"] = {"url": "https://api.github.com/repos/" + it["repo"] + "/pulls/" + str(it["number"])}
            rows.append(row)
        out = {"total_count": len(rows), "incomplete_results": False, "items": rows + s.get("raw", [])}
    elif ep.startswith("repos/") and ep.endswith("/comments"):
        p = ep.split("/")
        who = s["comments"].get(f"{p[1]}/{p[2]}#{p[4]}", [])
        page = int(fields.get("page", "1"))
        out = [{"id": page, "user": {"login": who[page - 1]}, "body": "…"}] if 1 <= page <= len(who) else []
    else:
        print("gh: Not Found (HTTP 404)", file=sys.stderr)
        return 1
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--senaryo":
        with open(sys.argv[3], "w", encoding="utf-8", newline="\n") as f:
            json.dump(senaryo(sys.argv[2]), f, ensure_ascii=False, indent=1)
    else:
        sys.exit(gh(sys.argv[1:]))

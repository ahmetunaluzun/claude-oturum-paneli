"""Mac paketlerini zip'ler: dist-mac/<rid> + MAC_TEST.md -> dist-mac/ClaudePanel-<surum>-<rid>.zip.

Zip içinde yollar '/' ile yazılır (Windows Compress-Archive '\\' yazıyor, Mac'te klasörler bozuluyor)
ve ClaudePanel'e çalıştırma izni (0755) verilir. Kullanım: python tools/mac_zip.py <surum>
"""
import sys
import zipfile
from pathlib import Path

KOK = Path(__file__).resolve().parent.parent
DIST = KOK / "dist-mac"


def ziple(surum: str, rid: str) -> Path:
    kaynak = DIST / rid
    hedef = DIST / f"ClaudePanel-{surum}-{rid}.zip"
    ust = f"ClaudePanel-{rid}"
    # publish klasörüne tüm platformların kitaplıkları ve .pdb de düşer: yalnız bu mimarininkiler (runtimes/macos-<mimari>) girer.
    mac = "macos-" + rid.removeprefix("osx-")
    def girsin(p: Path) -> bool:
        r = p.relative_to(kaynak).parts
        return p.suffix != ".pdb" and (r[0] != "runtimes" or r[1] == mac)
    dosyalar = sorted(p for p in kaynak.rglob("*") if p.is_file() and girsin(p))
    dosyalar.append(KOK / "MAC_TEST.md")
    with zipfile.ZipFile(hedef, "w", zipfile.ZIP_DEFLATED) as z:
        for p in dosyalar:
            ad = f"{ust}/{p.name}" if p.parent == KOK else f"{ust}/{p.relative_to(kaynak).as_posix()}"
            bilgi = zipfile.ZipInfo.from_file(p, ad)
            bilgi.create_system = 3  # Unix: izinler external_attr'dan okunur
            izin = 0o755 if p.name == "ClaudePanel" else 0o644
            bilgi.external_attr = (0o100000 | izin) << 16
            bilgi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(bilgi, p.read_bytes())
    return hedef


if __name__ == "__main__":
    for r in ("osx-arm64", "osx-x64"):
        print(ziple(sys.argv[1], r))

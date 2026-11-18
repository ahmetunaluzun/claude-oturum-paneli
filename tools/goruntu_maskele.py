"""Belge görselinde kişisel bilgiyi (ad, e-posta, makine adı) düz kutuyla kapatır.

Kullanım: py -3.13 tools/goruntu_maskele.py <girdi.png> <cikti.png> x1,y1,x2,y2 [x1,y1,x2,y2 ...]
"""
import sys

from PIL import Image, ImageDraw


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    src, dst, *boxes = sys.argv[1:]
    if not boxes:
        raise SystemExit("En az bir kutu gerekli: x1,y1,x2,y2")
    img = Image.open(src).convert("RGB")
    draw = ImageDraw.Draw(img)
    for b in boxes:
        x1, y1, x2, y2 = (int(v) for v in b.split(","))
        draw.rectangle((x1, y1, x2, y2), fill=img.getpixel((max(x1 - 2, 0), y1)))
    img.save(dst, optimize=True)
    print(f"{dst}: {len(boxes)} alan kapatıldı")


if __name__ == "__main__":
    main()

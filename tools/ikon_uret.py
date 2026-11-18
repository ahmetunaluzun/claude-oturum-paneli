"""Uygulama simgesinden (wwwroot/icon-512.png) Windows exe ikonu üretir: src/ClaudePanel/app.ico (16-256 px).
Kullanım: py -3.13 tools/ikon_uret.py"""
from pathlib import Path

from PIL import Image

kok = Path(__file__).resolve().parent.parent / "src" / "ClaudePanel"
kaynak = Image.open(kok / "wwwroot" / "icon-512.png").convert("RGBA")
hedef = kok / "app.ico"
kaynak.save(hedef, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print(hedef, hedef.stat().st_size, "bayt")

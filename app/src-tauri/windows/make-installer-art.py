"""Draws the installer's welcome-page bitmap (windows/installer-hero.bmp).

Run: python app/src-tauri/windows/make-installer-art.py   (needs Pillow and app/node_modules for Geist)
Rendered at 2x the MUI welcome size (164x314) so it stays sharp up to 200% scaling; NSIS fits it to the control.
Light theme: colours are the light tokens in app/src/index.css (paper-1, ink-1, ink-3, copper); the mark is icons/source.svg.
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).parent
GEIST = HERE.parents[1] / "node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2"

W, H = 328, 628  # 2x of MUI's 164x314
SS = 4  # supersampling for clean anti-aliased curves
PAPER = (251, 250, 248)  # --paper-1 (light)
PAPER_0 = (241, 239, 235)  # --paper-0 (light)
INK_1 = (26, 24, 20)
INK_3 = (120, 116, 111)
TILE = (15, 17, 20)  # icon background, icons/source.svg
RING = (236, 231, 221)
COPPER = (233, 162, 59)  # icon dot, icons/source.svg


def font(px: float, weight: int) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(str(GEIST), round(px))
    f.set_variation_by_axes([weight])
    return f


def main():
    img = Image.new("RGB", (W * SS, H * SS), PAPER)
    d = ImageDraw.Draw(img)
    cx = W * SS / 2

    # faint orbit hairlines behind the mark, the orb's quiet state
    cy = H * SS * 0.36
    for k in (1.55, 2.2, 2.95):
        d.ellipse([cx - 60 * SS * k, cy - 60 * SS * k, cx + 60 * SS * k, cy + 60 * SS * k], outline=PAPER_0, width=SS)

    # the app icon (icons/source.svg) as a 120px tile
    t = 120 * SS
    s = t / 1024
    x0, y0 = cx - t / 2, cy - t / 2
    d.rounded_rectangle([x0, y0, x0 + t, y0 + t], radius=224 * s, fill=TILE)
    icx, icy = x0 + 512 * s, y0 + 512 * s
    sweep = 1500 / (2 * math.pi * 268) * 360
    r = 268 * s
    d.arc([icx - r, icy - r, icx + r, icy + r], -62, -62 + sweep, fill=RING, width=round(76 * s))
    dot = 54 * s
    d.ellipse([icx - dot, icy + r - dot, icx + dot, icy + r + dot], fill=COPPER)

    # wordmark and credit
    name = font(40 * SS, 650)
    d.text((cx, y0 + t + 30 * SS), "Halka", font=name, fill=INK_1, anchor="mt")
    credit = font(15 * SS, 450)
    d.text((cx, H * SS - 34 * SS), "Guney", font=credit, fill=INK_3, anchor="ms")

    out = HERE / "installer-hero.bmp"
    img.resize((W, H), Image.LANCZOS).save(out)
    print(out)


if __name__ == "__main__":
    main()

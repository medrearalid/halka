"""Draws the installer's welcome-page bitmap (windows/installer-hero.bmp).

Run: python app/src-tauri/windows/make-installer-art.py
Rendered at 2x the MUI welcome size (164x314) so it stays sharp up to 200% scaling; NSIS fits it to the control.
Colours mirror DESIGN.md tokens (graphite paper-0, warm ink, copper) and icons/source.svg.
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw

W, H = 328, 628  # 2x of MUI's 164x314
SS = 4  # supersampling for clean anti-aliased strokes
BG = (13, 15, 18)
INK = (236, 231, 221)
COPPER = (233, 162, 59)


def ring(d: ImageDraw.ImageDraw, cx, cy, r, width, color, start=0.0, sweep=360.0):
    box = [cx - r, cy - r, cx + r, cy + r]
    d.arc(box, start, start + sweep, fill=color, width=width)


def main():
    img = Image.new("RGB", (W * SS, H * SS), BG)
    d = ImageDraw.Draw(img)
    cx, cy = W * SS / 2, H * SS * 0.42
    s = SS * 0.12  # icon-units (1024 grid) to pixels: ring radius 268 -> ~32px at 1x

    # faint orbit hairlines, the orb's quiet state
    for k, a in ((2.2, 26), (3.1, 16), (4.2, 9)):
        c = tuple(round(BG[i] + (INK[i] - BG[i]) * a / 255) for i in range(3))
        ring(d, cx, cy, 268 * s * k, max(1, SS // 2), c)

    # the mark from icons/source.svg: open ring (dash 1500 of 2*pi*268, rotated -62deg) + copper dot
    sweep = 1500 / (2 * math.pi * 268) * 360
    ring(d, cx, cy, 268 * s, round(76 * s), INK, start=-62, sweep=sweep)
    dot = 54 * s
    d.ellipse([cx - dot, cy + 268 * s - dot, cx + dot, cy + 268 * s + dot], fill=COPPER)

    out = Path(__file__).with_name("installer-hero.bmp")
    img.resize((W, H), Image.LANCZOS).save(out)
    print(out)


if __name__ == "__main__":
    main()

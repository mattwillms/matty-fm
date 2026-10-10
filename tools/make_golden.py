"""The scavenger hunt's golden quarter, as two coin faces: worker/public/golden-heads.webp (the hen off the
placeholder album cover, struck in gold) and golden-tails.webp (a cracked egg). Run: .venv/bin/python tools/make_golden.py"""

import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps

PUB = Path(__file__).resolve().parent.parent / "worker" / "public"
S = 480                      # drawn large, saved at 240 (sharp on a 3x phone at 30-80 px)
GOLD = [(70, 44, 6), (138, 94, 22), (214, 160, 52), (246, 214, 120), (255, 246, 210)]


def gold_map(gray: Image.Image) -> Image.Image:
    """Grey levels to a gold ramp: dark bronze shadows up to pale gold highlights."""
    lut = []
    for c in range(3):
        for v in range(256):
            t = v / 255 * (len(GOLD) - 1)
            i = min(int(t), len(GOLD) - 2)
            f = t - i
            lut.append(round(GOLD[i][c] * (1 - f) + GOLD[i + 1][c] * f))
    return gray.convert("RGB").point(lut)


def blank_coin(field_light: float = .62) -> Image.Image:
    """A gold disc: a reeded rim, a raised lip, and a softly lit field."""
    img = Image.new("RGB", (S, S))
    px = img.load()
    c = S / 2
    for y in range(S):
        for x in range(S):
            d = math.hypot(x - c, y - c) / c
            light = .5 + .5 * ((c - x) * .6 + (c - y) * .8) / c   # lit from the upper left
            if d > .86:      # the rim, reeded
                a = math.atan2(y - c, x - c)
                v = .55 + .3 * light + (.12 if int(a * 180 / math.pi * 1.2) % 2 else -.05)
            elif d > .80:    # the lip, a raised ring
                v = .35 + .5 * light
            else:            # the field
                v = field_light - .12 + .3 * light
            g = max(0, min(255, round(v * 255)))
            px[x, y] = (g, g, g)
    return gold_map(img.convert("L"))


def struck(coin: Image.Image, relief: Image.Image, mask: Image.Image) -> Image.Image:
    """Lay a relief (grey) onto the coin's field inside mask, gold-toned, with an emboss for the struck edges."""
    emb = relief.filter(ImageFilter.EMBOSS)
    shaded = ImageChops.add(ImageOps.autocontrast(relief, cutoff=2), ImageChops.subtract(emb, Image.new("L", relief.size, 128)), 1, -20)
    face = gold_map(shaded)
    out = coin.copy()
    out.paste(face, (0, 0), mask)
    return out


def circle_alpha(img: Image.Image) -> Image.Image:
    a = Image.new("L", (S * 2, S * 2), 0)
    ImageDraw.Draw(a).ellipse((2, 2, S * 2 - 3, S * 2 - 3), fill=255)
    img = img.convert("RGBA")
    img.putalpha(a.resize((S, S), Image.LANCZOS))
    return img.resize((240, 240), Image.LANCZOS)


def heads() -> Image.Image:
    cover = Image.open(PUB / "nocover.webp").convert("RGB")
    hen = cover.crop((180, 170, 650, 640)).resize((300, 300), Image.LANCZOS)
    # the hen against the cover's brown: brighter and more saturated than the paper behind her
    _, _, val = hen.convert("HSV").split()
    # the cover's paper is a dull brown (value ~90); the hen is bright: keep the bright, close the gaps her ink lines leave
    m = val.point(lambda v: 255 if v > 150 else 0)
    m = m.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.MinFilter(9)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.2))
    relief = Image.new("L", (S, S), 150)
    mask = Image.new("L", (S, S), 0)
    off = ((S - 300) // 2, (S - 300) // 2 + 6)
    relief.paste(ImageOps.equalize(hen.convert("L")), off)
    mask.paste(m, off)
    return circle_alpha(struck(blank_coin(), relief, mask))


def tails() -> Image.Image:
    relief = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(relief)
    c = S / 2
    pts = []
    for k in range(120):   # an egg: rounder at the bottom
        t = k / 120 * 2 * math.pi
        x, y = math.sin(t), -math.cos(t)
        w = 92 * (1 + .12 * y)
        pts.append((c + w * x, c + 8 + 118 * y))
    d.polygon(pts, fill=225)
    shade = Image.new("L", (S, S), 0)
    ImageDraw.Draw(shade).ellipse((c - 70, c - 80, c + 30, c + 30), fill=255)
    relief = ImageChops.lighter(relief, ImageChops.multiply(relief, shade.filter(ImageFilter.GaussianBlur(30))))
    crack = [(c - 95, c + 6), (c - 60, c - 14), (c - 34, c + 14), (c - 6, c - 18), (c + 20, c + 10), (c + 46, c - 16), (c + 72, c + 8), (c + 96, c - 4)]
    d = ImageDraw.Draw(relief)
    d.line(crack, fill=60, width=9, joint="curve")
    d.line([(x, y - 3) for x, y in crack], fill=255, width=2)
    mask = relief.point(lambda v: 255 if v > 20 else 0).filter(ImageFilter.GaussianBlur(1))
    base = Image.new("L", (S, S), 140)
    base.paste(relief, (0, 0), mask)
    return circle_alpha(struck(blank_coin(), base.filter(ImageFilter.GaussianBlur(1.5)), mask))


if __name__ == "__main__":
    heads().save(PUB / "golden-heads.webp", quality=88, method=6)
    print("wrote golden-heads.webp (the back, RIP JAZZY BELLE: tools/make_engraving.py)")

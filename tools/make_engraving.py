"""Engravings for the coins' backs, from tools/matty-script.png (the matty script logo, white on black):
  worker/public/matty-engraved.webp   the logo as a cut: a dark groove, its upper-left wall in shade, its lower-right
                                      wall catching the light; translucent, so it reads as cut into any metal
  worker/public/golden-tails.webp     the golden quarter's back: RIP / JAZZY / BELLE, the logo cut beneath
Run: .venv/bin/python tools/make_engraving.py   (after tools/make_golden.py, whose coin blank it reuses)"""

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

from make_golden import S, blank_coin, circle_alpha

HERE = Path(__file__).resolve().parent
PUB = HERE.parent / "worker" / "public"
FONT = "/usr/share/fonts/liberation/LiberationSerif-Bold.ttf"


def logo_mask(width: int) -> Image.Image:
    src = Image.open(HERE / "matty-script.png").convert("L")
    m = src.point(lambda v: 255 if v > 128 else 0)
    m = m.crop(m.getbbox())
    return m.resize((width, round(m.height * width / m.width)), Image.LANCZOS)


def engraving(mask: Image.Image, depth: int = 3) -> Image.Image:
    """A cut the shape of mask: a dim floor, a shaded wall top-left, a lit wall bottom-right (RGBA, mostly clear)."""
    w, h = mask.size
    pad = depth * 2
    m = Image.new("L", (w + pad * 2, h + pad * 2), 0)
    m.paste(mask, (pad, pad))
    shift = lambda dx, dy: ImageChops.offset(m, dx, dy)
    shade = ImageChops.subtract(m, shift(depth, depth + 1))      # inside, where the cut's upper-left wall is
    light = ImageChops.subtract(m, shift(-depth + 1, -depth))    # inside, where its lower-right wall faces the light
    out = Image.new("RGBA", m.size, (0, 0, 0, 0))
    floor = Image.new("RGBA", m.size, (40, 26, 6, 0)); floor.putalpha(m.point(lambda v: v * 70 // 255))
    dark = Image.new("RGBA", m.size, (20, 12, 2, 0)); dark.putalpha(shade.point(lambda v: v * 190 // 255).filter(ImageFilter.GaussianBlur(.7)))
    lit = Image.new("RGBA", m.size, (255, 248, 220, 0)); lit.putalpha(light.point(lambda v: v * 170 // 255).filter(ImageFilter.GaussianBlur(.6)))
    for layer in (floor, dark, lit):
        out = Image.alpha_composite(out, layer)
    return out


def text_mask(lines: list[str], size: int, gap: float) -> Image.Image:
    font = ImageFont.truetype(FONT, size)
    widths = [font.getbbox(t)[2] - font.getbbox(t)[0] for t in lines]
    h = round(size * gap * (len(lines) - 1) + size * 1.1)
    m = Image.new("L", (max(widths) + 8, h), 0)
    d = ImageDraw.Draw(m)
    for i, (t, w) in enumerate(zip(lines, widths)):
        d.text(((m.width - w) / 2, i * size * gap), t, font=font, fill=255)
    return m.crop(m.getbbox())


if __name__ == "__main__":
    engraving(logo_mask(440), depth=4).save(PUB / "matty-engraved.webp", quality=90, method=6)
    coin = blank_coin().convert("RGBA")
    words = engraving(text_mask(["RIP", "JAZZY", "BELLE"], 74, 1.02), depth=4)
    coin.alpha_composite(words, ((S - words.width) // 2, 86))
    logo = engraving(logo_mask(210), depth=3)
    coin.alpha_composite(logo, ((S - logo.width) // 2, 86 + words.height + 22))
    circle_alpha(coin).save(PUB / "golden-tails.webp", quality=88, method=6)
    print("wrote matty-engraved.webp, golden-tails.webp")

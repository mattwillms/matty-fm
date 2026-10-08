"""Home-screen icons for the guest page: cocoa ground, a cream tuning-dial ring with the
orange needle, and the three stripes. Writes worker/public/icon-{180,192,512}.png."""

from pathlib import Path

from PIL import Image, ImageDraw

COCOA, CREAM, ORANGE, GOLD, AVOCADO = "#2A1A12", "#F3E3C3", "#E2621B", "#F0A92B", "#8A8F3C"
OUT = Path(__file__).resolve().parents[1] / "worker" / "public"

S = 1024
img = Image.new("RGB", (S, S), COCOA)
d = ImageDraw.Draw(img)
# dial ring (an "O"), with tick marks around the top like a tuning scale
cx, cy, r = S // 2, 410, 250
d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=CREAM, width=78)
# the needle
d.rounded_rectangle((cx + 60, cy - r - 70, cx + 100, cy + r + 70), radius=20, fill=ORANGE)
# three stripes, stepped like the wordmark
for i, (color, width) in enumerate(((GOLD, 0.80), (ORANGE, 0.70), (AVOCADO, 0.60))):
    y = 760 + i * 74
    d.rounded_rectangle((112, y, 112 + int((S - 224) * width), y + 50), radius=25, fill=color)
for size in (512, 192, 180):
    img.resize((size, size), Image.LANCZOS).save(OUT / f"icon-{size}.png", optimize=True)
print("icons written to", OUT)

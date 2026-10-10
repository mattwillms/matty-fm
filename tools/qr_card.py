"""Print-ready card with the party QR code: writes media/qr-card.html."""

import os
import sys
from pathlib import Path

import segno

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "studio"))
from mattyfm.config import load, load_env  # noqa: E402

load_env()
url = f"https://fm.willms.co/?k={os.environ['PARTY_CODE']}"
svg = segno.make(url, error="m").svg_inline(scale=8, dark="#2b1a0e")
out = load().media_dir / "qr-card.html"
out.write_text(f"""<!doctype html><meta charset="utf-8"><title>WORR card</title>
<style>body{{font-family:Georgia,serif;text-align:center;color:#2b1a0e}}.card{{width:4in;height:6in;margin:.3in auto;
border:6px solid #f2711c;border-radius:24px;padding:.3in}}h1{{font-size:44px;margin:.1em}}p{{font-size:20px}}</style>
<div class="card"><h1>WORR</h1><p>Scan to request a song —<br>the DJ will read your shout-out!</p>{svg}
<p style="font-size:16px">{url.replace("https://", "")}</p></div>""")
print(out)

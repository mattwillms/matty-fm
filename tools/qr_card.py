"""Print-ready party sign with the QR code: writes media/qr-card.html (US Letter; print it from a browser).

The QR carries the party code, so the output stays in media/ (gitignored) and is never published.
"""

import base64
import os
import sys
from pathlib import Path

import segno

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "studio"))
from mattyfm.config import load, load_env  # noqa: E402

load_env()
url = f"https://fm.willms.co/?k={os.environ['PARTY_CODE']}"
qr = segno.make(url, error="q").svg_inline(scale=10, border=0, dark="#2A1A12", omitsize=True)
hen = base64.b64encode((ROOT / "worker/public/hen.png").read_bytes()).decode()
out = load().media_dir / "qr-card.html"
out.write_text(f"""<!doctype html><html lang="en"><meta charset="utf-8"><title>WORR party sign</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT,WONK@9..144,600..900,100,1&family=Jost:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  @page {{ size: letter; margin: 0; }}
  :root {{ --cocoa: #2A1A12; --walnut: #4A2E1E; --orange: #E2621B; --gold: #F0A92B; --rust: #B2361F; --paper: #FBF3E4; }}
  * {{ box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
  html, body {{ margin: 0; background: #ddd; }}
  .sheet {{ width: 8.5in; height: 11in; margin: 0 auto; background: var(--paper); color: var(--cocoa);
            font-family: Jost, sans-serif; display: flex; flex-direction: column; align-items: center; overflow: hidden; }}
  /* the 70s stripes, top and bottom */
  .stripes {{ align-self: stretch; height: .42in; flex: none;
              background: linear-gradient(var(--gold) 0 25%, var(--orange) 25% 50%, var(--rust) 50% 75%, var(--walnut) 75%); }}
  .stripes.bottom {{ transform: scaleY(-1); }}
  main {{ flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: space-evenly; padding: .15in 0; }}
  .mark {{ display: flex; align-items: center; gap: .22in; }}
  .mark img {{ width: 1.3in; height: 1.3in; border-radius: 50%; }}
  h1 {{ font-family: Fraunces, Georgia, serif; font-variation-settings: "SOFT" 100, "WONK" 1, "opsz" 144; font-weight: 900;
        font-size: 1.62in; line-height: .86; letter-spacing: -.02em; margin: 0; padding: 0 .15em .15em 0; color: var(--cocoa);
        /* print: a dark face, then the stripe colours stepped behind it with paper gaps */
        text-shadow: .025em .025em 0 var(--paper), .055em .055em 0 var(--gold), .08em .08em 0 var(--paper),
                     .105em .105em 0 var(--orange), .13em .13em 0 var(--paper), .155em .155em 0 var(--rust); }}
  .tag {{ font-size: 22pt; font-weight: 500; margin: -.25in 0 0; letter-spacing: .01em; }}
  .scan {{ display: flex; align-items: center; gap: .32in; }}
  .qr {{ background: #fff; padding: .2in; border-radius: .22in; border: .07in solid var(--cocoa);
         box-shadow: .09in .09in 0 var(--orange); }}
  .qr svg {{ display: block; width: 3.45in; height: 3.45in; }}
  ol {{ list-style: none; margin: 0; padding: 0; width: 3.35in; counter-reset: s; }}
  li {{ counter-increment: s; display: grid; grid-template-columns: .5in 1fr; align-items: start; margin-bottom: .26in; }}
  li::before {{ content: counter(s); font-family: Fraunces, Georgia, serif; font-weight: 900; font-size: 30pt; line-height: 1;
               color: var(--orange); }}
  li b {{ display: block; font-size: 20pt; line-height: 1.1; }}
  li span {{ display: block; font-size: 14pt; line-height: 1.3; margin-top: .04in; color: var(--walnut); }}
  .more {{ margin: 0 .8in; text-align: center; font-size: 16pt; line-height: 1.45; color: var(--walnut); }}
  .more b {{ color: var(--cocoa); }}
  .help {{ margin: 0; text-align: center; font-size: 14pt; color: var(--walnut); }}
  .help b {{ font-family: Fraunces, Georgia, serif; font-weight: 900; font-size: 26pt; color: var(--cocoa); display: block; }}
  @media print {{ html, body {{ background: none; }} .sheet {{ margin: 0; }} }}
</style>
<div class="sheet">
  <div class="stripes"></div>
  <main>
  <div class="mark"><img src="data:image/png;base64,{hen}" alt=""><h1>WORR</h1></div>
  <p class="tag">The family radio station is on the air.</p>
  <div class="scan">
    <div class="qr">{qr}</div>
    <ol>
      <li><div><b>Scan the code</b><span>with your phone's camera.</span></div></li>
      <li><div><b>Pick a song</b><span>and add a message for the DJ.</span></div></li>
      <li><div><b>Listen for your name</b><span>The DJ reads it on air, then plays your song.</span></div></li>
    </ol>
  </div>
  <p class="more">Also on your radio: <b>sound buttons</b> for the speakers, <b>Orrdle</b>,
    the family word game, and a <b>treasure hunt</b> hidden in the radio itself.</p>
  <p class="help"><b>Stuck? Ask Matt.</b>{url.replace("https://", "")}</p>
  </main>
  <div class="stripes bottom"></div>
</div></html>""")
print(out)

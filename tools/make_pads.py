"""The sound board's eight pads are now clips chosen by the host (2026-10-10, from myinstants.com, saved by hand:
the site blocks scripts): siren, applause, yaaay, rizz, Taco Bell bong, thud (vine boom), faaah, bark fart, in the
order of PRESETS in worker/public/index.html and PADS in admin.html. Each was made with
  ffmpeg -i IN -af "silenceremove=start_periods=1:start_threshold=-50dB,atrim=0:5,afade=t=out:st=4.4:d=0.6,loudnorm=I=-14:TP=-1.5" -ar 44100 -ac 2 -b:a 160k pad-N.mp3
and copied to media/breaks/pad-N.mp3 (the speakers) and worker/public/pads/pad-N.mp3 (a phone in My phone mode).
What follows is the original generator of five demo pads, kept for reference.

Make the admin page's five sound pads: media/breaks/pad-1.mp3 … pad-5.mp3.

Demo sounds from ElevenLabs sound generation. To use your own, drop an mp3 in as
pad-N.mp3 (same loudness: ffmpeg … -af loudnorm=I=-14:TP=-1.5) and rename the pad
in worker/public/admin.html (PADS).
Usage: .venv/bin/python tools/make_pads.py
"""

import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "studio"))
from make_breaks import sfx  # noqa: E402
from mattyfm import config  # noqa: E402

PADS = [   # (prompt, seconds) in the same order as PADS in admin.html
    ("stadium air horn blast, two short honks then one long", 2.0),
    ("comedy drum rimshot, ba dum tss", 1.2),
    ("enthusiastic crowd applause and cheering at a party", 3.0),
    ("sad trombone, wah wah wah waaah, comedic fail", 2.6),
    ("a single hen clucking loudly, farmyard chicken", 1.6),
]


def main() -> None:
    cfg = config.load()
    out = cfg.media_dir / "breaks"
    out.mkdir(parents=True, exist_ok=True)
    for n, (prompt, seconds) in enumerate(PADS, 1):
        raw, dest = out / f"pad-{n}.raw.mp3", out / f"pad-{n}.mp3"
        sfx(prompt, raw, seconds)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(raw), "-af", "aformat=channel_layouts=stereo,loudnorm=I=-14:TP=-1.5",
                        "-ar", str(cfg.sample_rate), "-c:a", "libmp3lame", "-b:a", "192k", str(dest)], check=True)
        raw.unlink()
        print(f"pad-{n}: {prompt}")


if __name__ == "__main__":
    main()

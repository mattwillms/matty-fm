"""Say a line in a DJ voice: .venv/bin/python tools/say.py funny "For Siobhan and Bob" """

import subprocess
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "studio"))
from mattyfm import config, tts  # noqa: E402

cfg = config.load()
dest = Path("/tmp/mattyfm-say.mp3")
names = tts.load_names(cfg.repo / "studio" / "names.toml")
tts.speak(sys.argv[2], sys.argv[1], dest, http=httpx.Client(), aura=lambda t: b"",
          assets=cfg.media_dir / "assets", names=names)
subprocess.run(["mpv", "--really-quiet", str(dest)])

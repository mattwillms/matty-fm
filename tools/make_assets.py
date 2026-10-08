"""Make the station sting and the generic DJ clips (used when TTS is down)."""

import subprocess
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "studio"))
from mattyfm import config, tts  # noqa: E402
from mattyfm.djline import STATION  # noqa: E402

LINES = {
    "sting-voice": ("funny", f"You're grooving to {STATION}!"),
    "generic-funny": ("funny", f"Ooh, here's a request from somebody with great taste. Turn it up, family, this is {STATION}!"),
    "generic-sweet": ("sweet", f"This one's going out with love from the family. You're listening to {STATION}."),
}


def main() -> None:
    cfg = config.load()
    out = cfg.media_dir / "assets"
    out.mkdir(parents=True, exist_ok=True)
    http = httpx.Client()
    for name, (tone, text) in LINES.items():
        engine = tts.speak(text, tone, out / f"{name}.mp3", http=http, aura=lambda t: b"",
                           assets=out, names={})
        print(name, engine)
    # Sting: a short rising sweep under the voice.
    subprocess.run([
        "ffmpeg", "-v", "error", "-y",
        "-f", "lavfi", "-i", "aevalsrc=0.25*sin(2*PI*(300+900*t)*t)*exp(-1.2*t):d=2.2:s=44100",
        "-i", str(out / "sting-voice.mp3"),
        "-filter_complex", "[0:a]aformat=channel_layouts=stereo[s];[1:a]aformat=channel_layouts=stereo,adelay=300:all=1[v];"
                           "[s][v]amix=inputs=2:normalize=0:duration=longest,loudnorm=I=-14:TP=-1.5",
        "-ar", str(cfg.sample_rate), str(out / "sting.mp3")], check=True)
    print("sting ok")


if __name__ == "__main__":
    main()

"""Make the DJ's pre-recorded clips: station IDs, goofs and skip bumpers, each a short
sound effect (ElevenLabs sound generation) with the DJ voice over its tail.

Writes media/breaks/<kind>-<n>.mp3 and media/breaks/index.json. Re-run to replace.
Usage: .venv/bin/python tools/make_breaks.py [--only id-2,goof-1]
  --only  remake just these clips (each costs ElevenLabs credit); the rest keep their files
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "studio"))
from mattyfm import config, mix, tts  # noqa: E402
from mattyfm.djline import STATION  # noqa: E402

S = STATION
CLIPS = [
    # kind, tone, sound effect prompt, line ([long pause]: ElevenLabs v4 pauses ~1.7 s; the console swells the music in it)
    ("id", "funny", "short bright vintage radio station jingle swoosh with a sparkle", f"You're tuned to {S}. [long pause] All requests, all night long."),
    ("id", "funny", "retro radio station ident, quick rising synth sweep", f"Got a song in your head? Just scan the code and request it. Stuck? Ask Matt. This is {S}."),
    ("id", "funny", "vinyl record needle drop and crackle", f"Seventies gold and your requests. [long pause] You're listening to {S}."),
    ("id", "funny", "quick brass fanfare sting, 1970s TV style", f"{S}, broadcasting live from the backyard. Turn it up."),
    ("id", "sweet", "soft warm electric piano chime", f"Good music, good people. [long pause] This is {S}."),
    ("id", "sweet", "gentle wind chimes, short", f"Thanks for being here, everybody. You're listening to {S}."),
    ("goof", "funny", "comedic slide whistle going up", f"{S} traffic report: [long pause] heavy congestion by the desserts. Proceed with caution."),
    ("goof", "funny", "old radio news teletype beeping", f"{S} weather: a hundred percent chance of dancing, [long pause] with scattered high fives."),
    ("goof", "funny", "cartoon boing spring sound", "A friendly reminder from your DJ: drink some water. Punch counts. Probably."),
    ("goof", "funny", "small crowd cheering briefly", f"Breaking news on {S}: the dance floor is open, and nobody is judging. Much."),
    ("goof", "funny", "game show ding ding ding correct answer", f"If you can hear this, congratulations. You're already having fun on {S}."),
    ("goof", "funny", "retro telephone ringing twice", f"The {S} request line is open. Don't be shy, the DJ needs material."),
    # the family is Mississippi State and Ole Miss (rivals); everyone dislikes LSU (and Bama)
    ("goof", "funny", "single cowbell clang, stadium echo", f"[smug] {S} house rules. Cowbells, allowed. Hotty Toddy, allowed. [long pause] Purple and gold can wait in the truck."),
    ("goof", "funny", "news helicopter rotor whir, short", f"{S} traffic. Dawgs merging left, Rebels merging right. [long pause] [playful] Anybody headed to Baton Rouge, that's your exit. Keep going."),
    ("goof", "funny", "boxing ring bell, two dings", "Hail State and Hotty Toddy in the same backyard, and nobody's bleeding. [long pause] [deadpan] Turns out you'll forgive anybody once Lane Kiffin moves to Baton Rouge."),
    ("goof", "funny", "marching band snare drum roll, short", "The Egg Bowl's a month out. Today, it's a truce. [long pause] [smug] We're all family here. Except Bama. Bama's still waiting by the phone for Saban."),
    ("skip", "funny", "vinyl record scratch, fast", "Whoa! Let's try something else."),
    ("skip", "funny", "vinyl record scratch and rewind", "Okay, okay. Moving on!"),
    ("skip", "funny", "quick comedic record scratch", "The DJ has spoken. Next!"),
]


def sfx(prompt: str, dest: Path, seconds: float = 1.8) -> None:
    r = httpx.post("https://api.elevenlabs.io/v1/sound-generation",
                   params={"output_format": "mp3_44100_128"},
                   headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"]},
                   json={"text": prompt, "duration_seconds": seconds, "prompt_influence": 0.5}, timeout=60)
    r.raise_for_status()
    dest.write_bytes(r.content)


def main() -> None:
    cfg = config.load()
    out = cfg.media_dir / "breaks"
    work = out / "work"
    work.mkdir(parents=True, exist_ok=True)
    only = set(sys.argv[sys.argv.index("--only") + 1].split(",")) if "--only" in sys.argv else None
    old = {e["file"]: e for e in json.loads((out / "index.json").read_text())} if only else {}
    http, index, counts = httpx.Client(), [], {}
    for kind, tone, sound, line in CLIPS:
        counts[kind] = counts.get(kind, 0) + 1
        name = f"{kind}-{counts[kind]}"
        if only is not None and name not in only:
            index.append(old[f"{name}.mp3"])
            continue
        voice_raw, voice, fx = work / f"{name}-v.raw.mp3", work / f"{name}-v.mp3", work / f"{name}-fx.mp3"
        engine = tts.speak(line, tone, voice_raw, http=http, aura=lambda t: b"", assets=cfg.media_dir / "assets", names={})
        mix.prepare_voice(voice_raw, voice, cfg.sample_rate)
        sfx(sound, fx, 1.2 if kind == "skip" else 1.8)
        fx_s = mix.duration(fx)
        lead_ms = int(fx_s * 0.6 * 1000)       # the voice comes in over the effect's tail
        dest = out / f"{name}.mp3"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(fx), "-i", str(voice), "-filter_complex",
                        f"[0:a]aformat=channel_layouts=stereo,volume=0.6,afade=t=out:st={fx_s * 0.6:.2f}:d={fx_s * 0.4:.2f}[f];"
                        f"[1:a]aformat=channel_layouts=stereo,adelay={lead_ms}:all=1[v];"
                        "[f][v]amix=inputs=2:normalize=0:duration=longest,loudnorm=I=-14:TP=-1.5",
                        "-ar", str(cfg.sample_rate), "-c:a", "libmp3lame", "-b:a", "192k", str(dest)], check=True)
        seconds = mix.duration(dest)
        index.append({"file": dest.name, "kind": kind, "seconds": round(seconds, 2), "text": line})
        print(f"{name}: {seconds:.1f}s via {engine} — {line}")
    (out / "index.json").write_text(json.dumps(index, indent=1))
    for f in work.iterdir():
        f.unlink()
    work.rmdir()
    print(f"{len(index)} clips")


if __name__ == "__main__":
    main()

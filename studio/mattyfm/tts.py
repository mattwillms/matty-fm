"""Turn a DJ script into speech: ElevenLabs, then Aura via the Worker, then a stock clip."""

import os
import random
import re
import shutil
import tomllib
from collections.abc import Callable
from pathlib import Path

import httpx

MODEL = "eleven_v4"
VOICES = {"funny": "CeNX9CMwmxDxUF5Q2Inm", "sweet": "mKoqwDP2laxTdq1gEgU6"}   # Johnny Dynamite, Countdown Casey
DEFAULT_VOICES = {tone: {vid: 1.0} for tone, vid in VOICES.items()}
VOICES_FILE = Path(__file__).resolve().parents[1] / "voices.toml"


def load_voices(path: Path = VOICES_FILE) -> dict[str, dict[str, float]]:
    """studio/voices.toml: per tone, ElevenLabs voice id = weight (2 and 1: the first reads two lines
    in three). Read for every recording, so an edit takes effect without a restart."""
    try:
        data = tomllib.loads(path.read_text())
        out = {t: {str(v): float(w) for v, w in data.get(t, {}).items() if float(w) > 0} for t in DEFAULT_VOICES}
        return {t: out[t] or DEFAULT_VOICES[t] for t in out}
    except (OSError, ValueError, TypeError, AttributeError):
        return DEFAULT_VOICES


def pick_voice(voices: dict[str, dict[str, float]], tone: str, roll: float | None = None) -> str:
    pool = voices.get(tone) or DEFAULT_VOICES.get(tone) or DEFAULT_VOICES["funny"]
    at = (random.random() if roll is None else roll) * sum(pool.values())
    for vid, w in pool.items():
        at -= w
        if at < 0:
            return vid
    return list(pool)[-1]


def load_names(path: Path) -> dict[str, str]:
    return tomllib.loads(path.read_text()).get("names", {}) if path.exists() else {}


def respell(text: str, names: dict[str, str]) -> str:
    for written, spoken in names.items():
        text = re.sub(rf"\b{re.escape(written)}\b", spoken, text)
    return text


def _eleven(text: str, tone: str, http: httpx.Client) -> bytes:
    resp = http.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{pick_voice(load_voices(), tone)}",
        params={"output_format": "mp3_44100_128"},
        headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"]},
        json={"text": text, "model_id": MODEL},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.content


def looks_like_audio(data: bytes | None) -> bool:
    """MP3 (ID3 tag or frame sync), WAV or Ogg; a JSON error or an HTML page is not."""
    if not data or len(data) < 4:
        return False
    return data[:3] == b"ID3" or (data[0] == 0xFF and data[1] & 0xE0 == 0xE0) or data[:4] in (b"RIFF", b"OggS")


def speak(text: str, tone: str, dest: Path, *, http: httpx.Client,
          aura: Callable[[str], bytes], assets: Path, names: dict[str, str]) -> str:
    spoken = respell(text, names)
    for engine, make in (("eleven", lambda: _eleven(spoken, tone, http)),
                         ("aura", lambda: aura(re.sub(r"\s*\[[^\]]*\]\s*", "... ", spoken).strip()))):   # Aura would read "[pause]" aloud
        try:
            audio = make()
            if looks_like_audio(audio):
                dest.write_bytes(audio)
                return engine
        except Exception:   # an outage or an odd reply: the next voice, then the generic clip
            continue
    shutil.copyfile(assets / f"generic-{tone}.mp3", dest)
    return "generic"

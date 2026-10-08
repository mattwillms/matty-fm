"""Turn a DJ script into speech: ElevenLabs, then Aura via the Worker, then a stock clip."""

import os
import re
import shutil
import tomllib
from collections.abc import Callable
from pathlib import Path

import httpx

MODEL = "eleven_v4"
VOICES = {"funny": "CeNX9CMwmxDxUF5Q2Inm", "sweet": "mKoqwDP2laxTdq1gEgU6"}


def load_names(path: Path) -> dict[str, str]:
    return tomllib.loads(path.read_text()).get("names", {}) if path.exists() else {}


def respell(text: str, names: dict[str, str]) -> str:
    for written, spoken in names.items():
        text = re.sub(rf"\b{re.escape(written)}\b", spoken, text)
    return text


def _eleven(text: str, tone: str, http: httpx.Client) -> bytes:
    resp = http.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{VOICES[tone]}",
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
                         ("aura", lambda: aura(spoken))):
        try:
            audio = make()
            if looks_like_audio(audio):
                dest.write_bytes(audio)
                return engine
        except Exception:   # an outage or an odd reply: the next voice, then the generic clip
            continue
    shutil.copyfile(assets / f"generic-{tone}.mp3", dest)
    return "generic"

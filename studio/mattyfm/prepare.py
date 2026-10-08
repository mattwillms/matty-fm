"""Turn one claimed request into a ready, pre-mixed MP3 in media/ready/."""

import logging
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from . import djline, mix, songs, tts

log = logging.getLogger("mattyfm.prepare")


@dataclass
class Deps:
    cfg: object                     # config.Config (media_dir, sample_rate)
    claude: object                  # anthropic.Anthropic
    http: object                    # httpx.Client
    aura: Callable[[str], bytes]
    names: dict[str, str]


def prepare(item: dict, deps: Deps) -> dict:
    media: Path = deps.cfg.media_dir
    try:
        song = songs.get_song(item, media / "cache")
    except songs.SongNotFound as e:
        return {"id": item["id"], "status": "failed", "error": str(e)}
    try:
        line = djline.write_line(item, deps.claude)
        (media / "voice").mkdir(parents=True, exist_ok=True)
        (media / "ready").mkdir(parents=True, exist_ok=True)
        voice = media / "voice" / f"{item['id']}.mp3"
        engine = tts.speak(line.script, line.tone, voice, http=deps.http, aura=deps.aura,
                           assets=media / "assets", names=deps.names)
        sting = media / "assets" / "sting.mp3"
        seconds = mix.premix(song.path, voice, sting if sting.exists() else None,
                             media / "ready" / f"{item['id']}.mp3", deps.cfg.sample_rate)
    except Exception as e:  # any failure here must not kill the studio
        log.exception("prepare %s failed", item["id"])
        return {"id": item["id"], "status": "failed", "error": f"{type(e).__name__}: {e}"[:300]}
    return {"id": item["id"], "status": "ready", "file": f"{item['id']}.mp3", "durationS": seconds,
            "confidence": song.confidence, "djLine": line.script, "tone": line.tone, "voice": engine}

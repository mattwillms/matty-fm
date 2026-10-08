"""Turn one claimed request into a ready, pre-mixed MP3 in media/ready/."""

import logging
import time
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
    rid = item["id"]
    t0 = time.monotonic()
    try:
        song = songs.get_song(item, media / "cache")
    except songs.SongNotFound as e:
        log.warning("%s song not found (%.1fs): %s", rid, time.monotonic() - t0, e)
        return {"id": rid, "status": "failed", "error": str(e)}
    log.info("%s song ready in %.1fs: %s (video %s, confidence %.0f)", rid, time.monotonic() - t0,
             song.path.name, song.video_id, song.confidence)
    try:
        t1 = time.monotonic()
        line = djline.write_line(item, deps.claude)
        log.info("%s DJ line in %.1fs (tone=%s, fallback=%s): %s", rid, time.monotonic() - t1,
                 line.tone, line.fallback, line.script)
        t1 = time.monotonic()
        (media / "voice").mkdir(parents=True, exist_ok=True)
        (media / "ready").mkdir(parents=True, exist_ok=True)
        voice = media / "voice" / f"{item['id']}.mp3"
        engine = tts.speak(line.script, line.tone, voice, http=deps.http, aura=deps.aura,
                           assets=media / "assets", names=deps.names)
        log.info("%s voice in %.1fs via %s", rid, time.monotonic() - t1, engine)
        t1 = time.monotonic()
        sting = media / "assets" / "sting.mp3"
        seconds = mix.premix(song.path, voice, sting if sting.exists() else None,
                             media / "ready" / f"{item['id']}.mp3", deps.cfg.sample_rate)
    except Exception as e:  # any failure here must not kill the studio
        log.exception("prepare %s failed", item["id"])
        return {"id": item["id"], "status": "failed", "error": f"{type(e).__name__}: {e}"[:300]}
    log.info("%s mixed in %.1fs (%.0fs long); total %.1fs", rid, time.monotonic() - t1, seconds,
             time.monotonic() - t0)
    return {"id": item["id"], "status": "ready", "file": f"{item['id']}.mp3", "durationS": seconds,
            "confidence": song.confidence, "djLine": line.script, "tone": line.tone, "voice": engine}

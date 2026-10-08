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
    search: Callable | None = None     # sources.YouTubeSearch (Data API), never yt-dlp from home
    download: Callable | None = None   # sources.ApifyDownload


CONFIRM_WITHIN_S = 6.0     # downloaded length this close to the catalog's: the right recording
WRONG_BEYOND_S = 20.0      # this far off: probably a different version (live, extended, edit)


def _mmss(seconds: float) -> str:
    seconds = round(seconds)
    return f"{seconds // 60}:{seconds % 60:02d}"


def check_match(song, item: dict) -> tuple[float, str]:
    """Confidence after comparing the downloaded file's real length with the catalog's,
    and a short note saying where the audio came from and how well it matches."""
    confidence = song.confidence
    try:
        actual = mix.duration(song.path)
    except Exception:   # advisory only: an unreadable length must not stop the song
        return confidence, f"{song.title or 'video'}: length unreadable"
    if song.channel.endswith(" - Topic"):
        source = "official label upload"
    elif song.channel:
        source = f"uploaded by {song.channel}"
    else:
        source = "source unknown"
    expected = item["durationMs"] / 1000 if item.get("durationMs") else None
    if expected is None:
        length = f"length not checked (no catalog length; file is {_mmss(actual)})"
    elif abs(actual - expected) <= CONFIRM_WITHIN_S:
        confidence = max(confidence, 75.0)
        length = f"length matches ({_mmss(actual)})"
    elif abs(actual - expected) > WRONG_BEYOND_S:
        confidence = min(confidence, 30.0)
        length = f"length {_mmss(actual)} vs expected {_mmss(expected)}: maybe a different version"
    else:
        length = f"length close ({_mmss(actual)} vs {_mmss(expected)})"
    title = f"{song.title} — " if song.title else ""
    return confidence, f"{title}{source}; {length}"


def is_audio(path: Path) -> bool:
    """A download is only cached if ffprobe reads it as audio of a plausible length."""
    try:
        return mix.duration(path) > 20
    except Exception:
        return False


def prepare(item: dict, deps: Deps) -> dict:
    media: Path = deps.cfg.media_dir
    rid = item["id"]
    t0 = time.monotonic()
    try:
        song = songs.get_song(item, media / "cache", search=deps.search, download=deps.download, tries=2,
                              verify=is_audio)
    except songs.SongNotFound as e:
        log.warning("%s song not found (%.1fs): %s", rid, time.monotonic() - t0, e)
        return {"id": rid, "status": "failed", "error": str(e)}
    except Exception as e:   # timeouts, bad replies, disk errors: fail it, never leave it to loop on lease expiry
        log.exception("%s song lookup failed", rid)
        return {"id": rid, "status": "failed", "error": f"Song lookup failed: {type(e).__name__}: {e}"[:300]}
    confidence, note = check_match(song, item)
    log.info("%s song ready in %.1fs: %s (video %s, confidence %.0f -> %.0f): %s", rid, time.monotonic() - t0,
             song.path.name, song.video_id, song.confidence, confidence, note)
    mixing = False   # only a failure while mixing the song file blames the cached song
    try:
        t1 = time.monotonic()
        line = djline.write_line(item, deps.claude)
        log.info("%s DJ line in %.1fs (tone=%s, fallback=%s): %s", rid, time.monotonic() - t1,
                 line.tone, line.fallback, line.script)
        t1 = time.monotonic()
        (media / "voice").mkdir(parents=True, exist_ok=True)
        (media / "ready").mkdir(parents=True, exist_ok=True)
        raw_voice = media / "voice" / f"{rid}.raw.mp3"
        engine = tts.speak(line.script, line.tone, raw_voice, http=deps.http, aura=deps.aura,
                           assets=media / "assets", names=deps.names)
        log.info("%s voice in %.1fs via %s", rid, time.monotonic() - t1, engine)
        t1 = time.monotonic()
        mixing = True
        seconds, voice_s = mix.prepare_files(song.path, raw_voice, media / "ready" / f"{rid}.mp3",
                                             media / "voice" / f"{rid}.mp3", deps.cfg.sample_rate)
    except Exception as e:  # any failure here must not kill the studio
        log.exception("prepare %s failed", item["id"])
        if mixing:
            # a cached song ffmpeg can't read would fail every retry: drop it so the next try downloads afresh
            song.path.unlink(missing_ok=True)
            song.path.with_suffix(".json").unlink(missing_ok=True)
        return {"id": item["id"], "status": "failed", "error": f"{type(e).__name__}: {e}"[:300]}
    log.info("%s files ready in %.1fs (song %.0fs, voice %.1fs); total %.1fs", rid, time.monotonic() - t1,
             seconds, voice_s, time.monotonic() - t0)
    return {"id": item["id"], "status": "ready", "file": f"{item['id']}.mp3", "durationS": seconds,
            "confidence": confidence, "matchNote": note, "djLine": line.script, "tone": line.tone, "voice": engine,
            "voiceS": voice_s}

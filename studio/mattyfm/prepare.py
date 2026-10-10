"""Turn one claimed request into a ready, pre-mixed MP3 in media/ready/."""

import logging
import shutil
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from . import apple, djline, mix, songs, tts

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
        actual = mix.decoded_duration(song.path)
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


def screen_text(script: str) -> str:
    """The DJ line as guests and the admin read it: the voice cues ([smug], [long pause]) left out."""
    return djline.display(script)


def is_audio(path: Path, expected_s: float | None = None) -> bool:
    """Audio that decodes for over 20 s and, given the catalog length, at least 3/4 of it: a
    truncated download keeps its full-length header, so the header alone would pass it."""
    try:
        got = mix.decoded_duration(path)
        return got > 20 and (not expected_s or got >= 0.75 * expected_s)
    except Exception:
        return False


_answers: dict = {}


def _memo(key: tuple, ask, keep_empty: bool = False):
    """A Claude or Apple answer for a song asked about before tonight (repeats are common at a party).
    An empty answer is kept only with keep_empty: Apple's {} may be an outage, worth asking again."""
    if key not in _answers:
        got = ask()
        if not got and not keep_empty:
            return got
        _answers[key] = got
    return _answers[key]


def prepare(item: dict, deps: Deps) -> dict:
    media: Path = deps.cfg.media_dir
    rid = item["id"]
    t0 = time.monotonic()
    try:
        song = songs.get_song(item, media / "cache", search=deps.search, download=deps.download, tries=2,
                              verify=lambda p: is_audio(p, (item.get("durationMs") or 0) / 1000),
                              verify_cached=is_audio)   # a cached shorter edit is fine; only junk is dropped
    except songs.SongNotFound as e:
        log.warning("%s song not found (%.1fs): %s", rid, time.monotonic() - t0, e)
        return {"id": rid, "status": "failed", "error": str(e)}
    except Exception as e:   # timeouts, bad replies, disk errors: fail it, never leave it to loop on lease expiry
        log.exception("%s song lookup failed", rid)
        return {"id": rid, "status": "failed", "error": f"Song lookup failed: {type(e).__name__}: {e}"[:300]}
    confidence, note = check_match(song, item)
    # junk ("%%%") waits for the host; the same request matched to the same video gets the same answer
    held = _memo(("doubt", item["title"], item["artist"], song.video_id),
                 lambda: djline.doubt(item, song.title or "", song.channel or "", deps.claude), keep_empty=True)
    if held:
        log.info("%s held for the host: %s", rid, held)
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
        try:
            seconds, voice_s = mix.prepare_files(song.path, raw_voice, media / "ready" / f"{rid}.mp3",
                                                 media / "voice" / f"{rid}.mp3", deps.cfg.sample_rate)
            raw_voice.unlink(missing_ok=True)   # mixed into voice/<rid>.mp3: the raw take isn't needed
            try:
                if mix.lengthen_pauses(media / "voice" / f"{rid}.mp3"):   # +0.5 s on a pause, as for bumpers
                    voice_s = mix.duration(media / "voice" / f"{rid}.mp3")
            except Exception:
                log.warning("%s pause stretch failed; using the voice as made", rid)
        except Exception:   # a voice reply that looked like audio but won't decode: the generic clip, not no song
            if engine == "generic" or not is_audio(song.path):
                raise
            log.warning("%s voice from %s would not mix; using the generic clip", rid, engine)
            shutil.copyfile(media / "assets" / f"generic-{line.tone}.mp3", raw_voice)
            engine = "generic"
            seconds, voice_s = mix.prepare_files(song.path, raw_voice, media / "ready" / f"{rid}.mp3",
                                                 media / "voice" / f"{rid}.mp3", deps.cfg.sample_rate)
            raw_voice.unlink(missing_ok=True)
    except Exception as e:  # any failure here must not kill the studio
        log.exception("prepare %s failed", item["id"])
        if mixing and not is_audio(song.path):
            # a cached song ffmpeg can't read would fail every retry: drop it so the next try downloads afresh
            song.path.unlink(missing_ok=True)
            song.path.with_suffix(".json").unlink(missing_ok=True)
        return {"id": item["id"], "status": "failed", "error": f"{type(e).__name__}: {e}"[:300]}
    log.info("%s files ready in %.1fs (song %.0fs, voice %.1fs); total %.1fs", rid, time.monotonic() - t1,
             seconds, voice_s, time.monotonic() - t0)
    # year, album and the Apple Music link for the guests' record sleeve (iPhones can't ask Apple themselves)
    info = _memo(("apple", item["artist"], item["title"]),
                 lambda: apple.release_info(item["artist"], item["title"], deps.http)) if deps.http else {}
    extra = {k2: info[k1] for k1, k2 in (("year", "year"), ("apple", "appleUrl"), ("album", "albumName"),
                                          ("artwork", "artworkUrl")) if info.get(k1)}
    return {**extra, "id": item["id"], "status": "ready", "file": f"{item['id']}.mp3", "durationS": seconds,
            "confidence": confidence, "matchNote": note, "djLine": screen_text(line.script), "tone": line.tone, "voice": engine,
            "voiceS": voice_s, **({"hold": held} if held else {})}

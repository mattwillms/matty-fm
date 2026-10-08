"""Find a requested song on YouTube, download it once, cache it by song key."""

import hashlib
import json
import logging
import re
import subprocess
import sys
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

CONFIDENT = 50.0
MAX_TRIES = 3
MAX_SECONDS = 600
PENALTY_WORDS = ("live", "remix", "karaoke", "cover", "extended", "sped up", "slowed",
                 "8d", "instrumental", "nightcore", "reverb", "acoustic", "demo",
                 "tribute", "in the style of", "made famous", "sound alike", "soundalike")


log = logging.getLogger("mattyfm.songs")


class SongNotFound(Exception):
    pass


@dataclass(frozen=True)
class Candidate:
    id: str
    title: str
    channel: str
    duration: float


@dataclass(frozen=True)
class SongFile:
    path: Path
    confidence: float
    video_id: str
    title: str = ""      # the YouTube video's title and channel, for the admin's match note
    channel: str = ""


def norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9 ]+", " ", text.lower()).strip()


def _key_part(text: str) -> str:
    # Mirror of norm() in worker/src/queue.ts. Change both together.
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    text = re.sub(r"\((?:[^)]*(?:remaster|version|edit|mono|stereo)[^)]*)\)", " ", text)
    text = re.sub(r"\s-\s.*(?:remaster|version|edit|mono|stereo).*$", " ", text)
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def song_key(artist: str, title: str) -> str:
    return f"{_key_part(artist)}|{_key_part(title)}"


def base_title(title: str) -> str:
    """The song without version tags: '(Live From …)', '[Remastered]', ' - 2004 Remaster'."""
    t = re.sub(r"\s*[\(\[][^)\]]*[\)\]]", "", title)
    t = re.sub(r"\s+-\s+.*$", "", t)
    return t.strip() or title


def base_key(artist: str, title: str) -> str:
    """Mirror of baseKey() in worker/src/queue.ts."""
    return song_key(artist, base_title(title))


def score(c: Candidate, title: str, artist: str, duration_s: float | None) -> float:
    s = 0.0
    if c.duration > MAX_SECONDS:
        return -100.0
    if duration_s:
        diff = abs(c.duration - duration_s)
        s += 40 if diff <= 3 else 25 if diff <= 6 else 10 if diff <= 15 else -30
    if c.channel.endswith(" - Topic"):
        s += 30
    got, wanted = norm(c.title), norm(f"{title} {artist}")
    for word in PENALTY_WORDS:
        if re.search(rf"\b{word}\b", got) and not re.search(rf"\b{word}\b", wanted):
            s -= 25
    if norm(title) and norm(title) in got:
        s += 15
    first = norm(artist).split()[:1]
    if first and first[0] in norm(f"{c.title} {c.channel}"):
        s += 10
    if "official audio" in got:
        s += 10
    if "official video" in got or "music video" in got:
        s -= 10
    return s


def ranked(cands: list[Candidate], title: str, artist: str,
           duration_s: float | None) -> list[tuple[Candidate, float]]:
    """Usable candidates, best first, with their scores."""
    usable = [c for c in cands if c.duration <= MAX_SECONDS]
    scored = [(c, score(c, title, artist, duration_s)) for c in usable]
    return sorted(scored, key=lambda cs: cs[1], reverse=True)


def pick(cands: list[Candidate], title: str, artist: str,
         duration_s: float | None) -> tuple[Candidate, float]:
    best = ranked(cands, title, artist, duration_s)
    if not best:
        raise SongNotFound(f"No usable match for {artist} - {title}")
    return best[0]


def _reason(e: subprocess.SubprocessError) -> str:
    """yt-dlp's own last ERROR line, not the command line."""
    err = getattr(e, "stderr", "") or ""
    lines = [l for l in str(err).splitlines() if "ERROR" in l] or str(err).splitlines() or [str(e)]
    return lines[-1].strip()[:200]


def yt_search(query: str) -> list[Candidate]:
    out = subprocess.run(
        [sys.executable, "-m", "yt_dlp", "--flat-playlist", "--dump-json", "--no-warnings",
         f"ytsearch8:{query}"],
        capture_output=True, text=True, timeout=60, check=True,
    ).stdout
    cands = []
    for line in out.splitlines():
        d = json.loads(line)
        if d.get("duration"):
            cands.append(Candidate(d["id"], d.get("title") or "",
                                   d.get("channel") or d.get("uploader") or "", float(d["duration"])))
    return cands


def yt_download(video_id: str, dest: Path) -> None:
    tmp = dest.with_name(dest.stem + ".dl")
    subprocess.run(
        [sys.executable, "-m", "yt_dlp", "-q", "--no-warnings", "-f", "bestaudio",
         "-x", "--audio-format", "mp3", "--audio-quality", "0", "--sleep-requests", "1",
         "-o", f"{tmp}.%(ext)s", "--", video_id],
        capture_output=True, text=True, timeout=300, check=True,
    )
    Path(f"{tmp}.mp3").rename(dest)


def cache_name(key: str) -> str:
    """A safe file name for a song key: the key itself when it is a usable name, otherwise a hash
    (a key with no letters, like "|" for an all-Japanese request, or one too long for the disk)."""
    if key.strip("| ") and len(key.encode()) <= 150 and "/" not in key:
        return key
    return "k-" + hashlib.sha1(key.encode()).hexdigest()


def get_song(item: dict, cache_dir: Path,
             search: Callable[[str], list[Candidate]] | None = yt_search,
             download: Callable[[str, Path], None] | list | None = yt_download,
             tries: int = MAX_TRIES, verify: Callable[[Path], bool] | None = None) -> SongFile:
    cache_dir.mkdir(parents=True, exist_ok=True)
    key = item["songKey"]
    path, meta = cache_dir / f"{cache_name(key)}.mp3", cache_dir / f"{cache_name(key)}.json"
    # A tagged version ("Live From …", "Remastered") plays the cached original if there is one.
    for k in dict.fromkeys((key, base_key(item["artist"], item["title"]))):
        hit_path, hit_meta = cache_dir / f"{cache_name(k)}.mp3", cache_dir / f"{cache_name(k)}.json"
        if hit_path.exists() and hit_meta.exists():
            try:
                m = json.loads(hit_meta.read_text())
            except ValueError:   # a half-written or corrupt entry is a miss, not a crash
                log.warning("cache: %s has unreadable metadata; fetching again", k)
                continue
            if k != key:
                log.info("cache: %s plays the cached %s", key, k)
            return SongFile(hit_path, float(m["confidence"]), m["video_id"], m.get("title", ""), m.get("channel", ""))
    if search is None or download is None:
        raise SongNotFound("Not cached, and no song source is configured (APIFY_TOKEN / YOUTUBE_API_KEY)")
    duration_s = item["durationMs"] / 1000 if item.get("durationMs") else None
    try:
        cands = search(f'{item["artist"]} {base_title(item["title"])}')
    except subprocess.SubprocessError as e:
        raise SongNotFound(f"YouTube search failed: {e}") from e
    options = ranked(cands, item["title"], item["artist"], duration_s)
    if not options:
        raise SongNotFound(f"No usable match for {item['artist']} - {item['title']}")
    reasons = []
    downloaders = download if isinstance(download, (list, tuple)) else [download]
    # every candidate with the fast downloader first; slower fallbacks only after that
    attempts = [(dl, best, conf) for dl in downloaders for best, conf in options[:tries]]
    for dl, best, confidence in attempts:
        try:
            dl(best.id, path)
        except Exception as e:   # blocked, unavailable, a bad reply: try the next
            reasons.append(f"{best.id}: {_reason(e) if isinstance(e, subprocess.SubprocessError) else e}")
            log.warning("download %s failed: %s", best.id, reasons[-1])
            continue
        if verify is not None and not verify(path):   # bytes that aren't audio never reach the cache
            path.unlink(missing_ok=True)
            reasons.append(f"{best.id}: download was not playable audio")
            log.warning("download %s failed: not playable audio", best.id)
            continue
        meta.write_text(json.dumps({"confidence": confidence, "video_id": best.id,
                                    "title": best.title, "channel": best.channel}))
        return SongFile(path, confidence, best.id, best.title, best.channel)
    raise SongNotFound("Download failed: " + " | ".join(reasons))

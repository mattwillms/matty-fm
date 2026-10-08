"""Find a requested song on YouTube, download it once, cache it by song key."""

import json
import re
import subprocess
import sys
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

CONFIDENT = 50.0
MAX_SECONDS = 600
PENALTY_WORDS = ("live", "remix", "karaoke", "cover", "extended", "sped up", "slowed",
                 "8d", "instrumental", "nightcore", "reverb", "acoustic", "demo")


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


def pick(cands: list[Candidate], title: str, artist: str,
         duration_s: float | None) -> tuple[Candidate, float]:
    usable = [c for c in cands if c.duration <= MAX_SECONDS]
    if not usable:
        raise SongNotFound(f"No usable match for {artist} - {title}")
    best = max(usable, key=lambda c: score(c, title, artist, duration_s))
    return best, score(best, title, artist, duration_s)


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


def get_song(item: dict, cache_dir: Path,
             search: Callable[[str], list[Candidate]] = yt_search,
             download: Callable[[str, Path], None] = yt_download) -> SongFile:
    cache_dir.mkdir(parents=True, exist_ok=True)
    key = item["songKey"]
    path, meta = cache_dir / f"{key}.mp3", cache_dir / f"{key}.json"
    if path.exists() and meta.exists():
        m = json.loads(meta.read_text())
        return SongFile(path, float(m["confidence"]), m["video_id"])
    duration_s = item["durationMs"] / 1000 if item.get("durationMs") else None
    try:
        cands = search(f'"{item["artist"]} - {item["title"]}"')
    except subprocess.SubprocessError as e:
        raise SongNotFound(f"YouTube search failed: {e}") from e
    best, confidence = pick(cands, item["title"], item["artist"], duration_s)
    try:
        download(best.id, path)
    except subprocess.SubprocessError as e:
        raise SongNotFound(f"Download failed: {e}") from e
    meta.write_text(json.dumps({"confidence": confidence, "video_id": best.id,
                                "title": best.title, "channel": best.channel}))
    return SongFile(path, confidence, best.id)

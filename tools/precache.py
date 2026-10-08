"""Pre-download likely requests: catalog lookup for duration, then songs.get_song.

Usage: .venv/bin/python tools/precache.py tools/precache.txt
Also links the first 40 cached songs into media/backup/ for the offline playlist.
"""

import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "studio"))
from mattyfm import config, songs  # noqa: E402


def lookup(artist: str, title: str) -> dict | None:
    r = httpx.get("https://api.deezer.com/search", params={"q": f'artist:"{artist}" track:"{title}"', "limit": 1}, timeout=10)
    data = r.json().get("data") or []
    return data[0] if data else None


def main(listfile: str) -> None:
    cfg = config.load()
    cache, backup = cfg.media_dir / "cache", cfg.media_dir / "backup"
    backup.mkdir(parents=True, exist_ok=True)
    ok = 0
    for line in Path(listfile).read_text().splitlines():
        if " - " not in line or line.startswith("#"):
            continue
        artist, title = (p.strip() for p in line.split(" - ", 1))
        hit = lookup(artist, title)
        key = songs.song_key(artist, title)
        item = {"songKey": key, "title": title, "artist": artist,
                "durationMs": hit["duration"] * 1000 if hit else None}
        try:
            got = songs.get_song(item, cache)
            ok += 1
            flag = "" if got.confidence >= songs.CONFIDENT else "  LOW"
            print(f"ok   {got.confidence:5.1f}{flag}  {line}")
            link = backup / got.path.name
            if ok <= 40 and not link.is_symlink():
                # Relative, so it still resolves inside the container's /media mount.
                link.symlink_to(Path("../cache") / got.path.name)
        except songs.SongNotFound as e:
            print(f"FAIL {line}: {e}")
        time.sleep(5)
    print(f"{ok} cached")


if __name__ == "__main__":
    main(sys.argv[1])

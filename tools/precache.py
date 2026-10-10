"""Pre-download likely requests, so they play instantly and never depend on YouTube on the day.

Usage: .venv/bin/python tools/precache.py tools/precache.txt [--dry] [--max N]
  --dry    list the songs not cached yet; no searches, no downloads
  --max N  search for at most N uncached songs this run (default 40): YouTube allows
           ~100 searches a day and live requests need some of them
Same sources as the studio (YouTube Data API search, Apify download): never yt-dlp from home.
Also links the first 40 cached songs into media/backup/ for the offline playlist.
"""

import argparse
import os
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "studio"))
from mattyfm import config, prepare, songs, sources  # noqa: E402


def lookup(artist: str, title: str) -> dict | None:
    r = httpx.get("https://api.deezer.com/search", params={"q": f'artist:"{artist}" track:"{title}"', "limit": 1}, timeout=10)
    data = r.json().get("data") or []
    return data[0] if data else None


def cached(cache: Path, artist: str, title: str) -> bool:
    keys = (songs.song_key(artist, title), songs.base_key(artist, title))
    return any((cache / f"{songs.cache_name(k)}.mp3").exists() for k in keys)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("listfile")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--max", type=int, default=40)
    args = ap.parse_args()
    cfg = config.load()
    cache, backup = cfg.media_dir / "cache", cfg.media_dir / "backup"
    backup.mkdir(parents=True, exist_ok=True)
    wanted = []
    for line in Path(args.listfile).read_text().splitlines():
        if " - " in line and not line.startswith("#"):
            wanted.append(tuple(p.strip() for p in line.split(" - ", 1)))
    todo = [(a, t) for a, t in wanted if not cached(cache, a, t)]
    print(f"{len(wanted) - len(todo)} of {len(wanted)} already cached; {len(todo)} to go")
    if args.dry:
        for a, t in todo:
            print(f"  missing  {a} - {t}")
        return
    yt_key, apify = os.environ.get("YOUTUBE_API_KEY", ""), os.environ.get("APIFY_TOKEN", "")
    if not (yt_key and apify):
        sys.exit("YOUTUBE_API_KEY and APIFY_TOKEN are needed (~/.config/mattyfm/env)")
    search = sources.YouTubeSearch(yt_key, httpx.Client(), cache / "search.json")
    download = sources.downloaders(apify)
    ok = 0
    for artist, title in todo[:args.max]:
        hit = lookup(artist, title)
        item = {"songKey": songs.song_key(artist, title), "title": title, "artist": artist,
                "durationMs": hit["duration"] * 1000 if hit else None}
        try:
            got = songs.get_song(item, cache, search=search, download=download, tries=2, verify=prepare.is_audio)
            ok += 1
            flag = "" if got.confidence >= songs.CONFIDENT else "  LOW"
            print(f"ok   {got.confidence:5.1f}{flag}  {artist} - {title}", flush=True)
        except songs.SongNotFound as e:
            print(f"FAIL {artist} - {title}: {str(e)[:200]}", flush=True)
            if "quota" in str(e).lower():
                print("YouTube search quota used up for today: stopping")
                break
        time.sleep(2)
    for f in sorted(cache.glob("*.mp3"))[:40]:   # offline backup playlist
        link = backup / f.name
        if not link.exists() and not link.is_symlink():
            link.symlink_to(Path("../cache") / f.name)   # relative: still resolves if media/ moves
    print(f"{ok} newly cached")


if __name__ == "__main__":
    main()

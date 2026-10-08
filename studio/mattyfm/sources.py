"""Song sources that keep the home IP off YouTube.

Search: the official YouTube Data API (an API key, not the website), with real
video lengths so songs.score() can match the catalog duration. Results are cached
on disk because search.list is limited to ~100 calls a day.

Download: Apify actors fetch the audio on their servers; we download the finished
file from Apify's storage. In order: streamers/youtube-video-downloader,
thenetaji/youtube-music-downloader, lurkapi/youtube-to-mp3-audio-downloader.
"""

import html
import os
import time
import json
import logging
import re
from pathlib import Path

import httpx

from .songs import Candidate, SongNotFound

log = logging.getLogger("mattyfm.sources")
API = "https://www.googleapis.com/youtube/v3"
APIFY = "https://api.apify.com/v2/acts"


def iso_seconds(iso: str) -> int:
    m = re.fullmatch(r"P(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso or "")
    if not m:
        return 0
    h, mi, s = (int(x or 0) for x in m.groups())
    return h * 3600 + mi * 60 + s


def safe_link(url: str) -> bool:
    """Only fetch finished files from Apify's own storage over https (never an arbitrary or LAN URL)."""
    try:
        u = httpx.URL(url)
    except Exception:
        return False
    return u.scheme == "https" and (u.host == "api.apify.com" or u.host.endswith(".apify.com"))


class YouTubeSearch:
    def __init__(self, key: str, http: httpx.Client, cache_file: Path):
        self.key, self.http, self.cache_file = key, http, cache_file
        self.cache = self._read()

    def _read(self) -> dict:
        try:
            return json.loads(self.cache_file.read_text())
        except (OSError, ValueError):   # missing or unreadable: start empty, never crash the studio
            return {}

    def __call__(self, query: str) -> list[Candidate]:
        if query in self.cache:
            return [Candidate(**c) for c in self.cache[query]]
        hdr = {"x-goog-api-key": self.key}   # a header, never the URL: URLs end up in logs
        r = self.http.get(f"{API}/search", timeout=10, headers=hdr, params={
            "q": query, "part": "snippet", "type": "video", "videoCategoryId": "10", "maxResults": 8})
        if r.status_code == 403 and "quota" in r.text.lower():
            raise SongNotFound("YouTube Data API daily search quota is used up")
        if r.status_code != 200:
            raise SongNotFound(f"YouTube search failed (HTTP {r.status_code})")
        items = r.json().get("items", [])
        if not items:
            return []
        ids = [i["id"]["videoId"] for i in items]
        d = self.http.get(f"{API}/videos", timeout=10, headers=hdr,
                          params={"id": ",".join(ids), "part": "contentDetails"})
        if d.status_code != 200:
            raise SongNotFound(f"YouTube video lookup failed (HTTP {d.status_code})")
        lengths = {v["id"]: iso_seconds(v["contentDetails"]["duration"]) for v in d.json().get("items", [])}
        cands = [Candidate(id=i["id"]["videoId"], title=html.unescape(i["snippet"]["title"]),
                           channel=html.unescape(i["snippet"]["channelTitle"]),
                           duration=float(lengths.get(i["id"]["videoId"], 0)))
                 for i in items if lengths.get(i["id"]["videoId"])]
        self.cache[query] = [c.__dict__ for c in cands]
        # the studio and tools/precache.py share this file: merge what the other wrote, then
        # swap the file in whole, so neither drops the other's entries or reads half a file
        self.cache = {**self._read(), **self.cache}
        tmp = self.cache_file.with_name(f"{self.cache_file.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(self.cache))
        tmp.replace(self.cache_file)
        return cands


class ApifyDownload:
    """`only`: restrict to one actor ("streamers", "thenetaji" or "lurkapi"); default tries all in order."""

    HANG_S = 150   # a failure this slow means the service hung (run-sync gives up at 170 s)

    def __init__(self, token: str, http: httpx.Client, only: str | None = None, clock=time.monotonic):
        self.token, self.http, self.only, self.clock = token, http, only, clock
        # what songs.get_song reads to order services and skip a hung one: when this last
        # failed (0 = its last try worked, or it hasn't been tried) and whether that was a hang
        self.failed_at, self.timed_out = 0.0, False

    def _run(self, actor: str, body: dict) -> list:
        r = self.http.post(f"{APIFY}/{actor}/run-sync-get-dataset-items", timeout=200,
                           headers={"authorization": f"Bearer {self.token}"},   # never in the URL
                           params={"timeout": 170}, json=body)
        if r.status_code not in (200, 201):
            raise httpx.HTTPStatusError(f"HTTP {r.status_code}", request=r.request, response=r)
        return r.json() if isinstance(r.json(), list) else []

    def __call__(self, video_id: str, dest: Path) -> None:
        started = self.clock()
        try:
            self._download(video_id, dest)
        except Exception:
            self.failed_at = self.clock()
            self.timed_out = self.failed_at - started >= self.HANG_S
            raise
        self.failed_at, self.timed_out = 0.0, False

    def _download(self, video_id: str, dest: Path) -> None:
        url = f"https://www.youtube.com/watch?v={video_id}"
        attempts = [
            # first since 2026-10-08, when YouTube blocked the other two; it also returns a direct
            # googlevideo link, which is YouTube itself and must never be fetched from home
            ("streamers~youtube-video-downloader",
             {"videos": [{"url": url}], "preferredFormat": "mp3", "preferredQuality": "144p"},
             lambda it: it.get("downloadedFileUrl")),
            ("thenetaji~youtube-music-downloader",
             {"urls": [{"url": url}], "region": "US", "saveMedia": True, "audioFormat": "mp3"},
             lambda it: (it.get("savedFile") or {}).get("url")),
            ("lurkapi~youtube-to-mp3-audio-downloader",
             {"videoUrls": [url], "audioFormat": "mp3", "audioBitrate": "192k", "maxVideosPerUrl": 1},
             lambda it: it.get("audioFileUrl")),
        ]
        if self.only:
            attempts = [a for a in attempts if a[0].startswith(self.only)]
        reasons = []
        for actor, body, file_url in attempts:
            try:
                items = self._run(actor, body)
                link = file_url(items[0]) if items else None
                if link and not safe_link(link):
                    log.warning("apify %s returned a non-Apify link for %s; ignored", actor, video_id)
                    link = None
                if not link:
                    reasons.append(f"{actor.split('~')[0]}: {(items[0].get('error') if items else 'no result')}"[:160])
                    log.warning("apify %s gave no file for %s: %s", actor, video_id, reasons[-1])
                    continue
                f = self.http.get(link, timeout=60)
                f.raise_for_status()
                tmp = dest.with_name(dest.stem + ".dl")
                tmp.write_bytes(f.content)
                tmp.rename(dest)
                log.info("apify %s downloaded %s (%d bytes)", actor.split("~")[0], video_id, len(f.content))
                return
            except httpx.HTTPError as e:   # str(e) can contain URLs: report only the type and status
                status = getattr(getattr(e, "response", None), "status_code", "")
                reasons.append(f"{actor.split('~')[0]}: {type(e).__name__} {status}".strip())
                log.warning("apify %s failed for %s: %s", actor, video_id, reasons[-1])
        raise SongNotFound("Download failed: " + " | ".join(reasons))


def downloaders(token: str) -> list:
    """The download chain, in order: each actor separately, so every candidate gets the
    first actor before any slower fallback (songs.get_song tries downloader x candidate)."""
    return [ApifyDownload(token, httpx.Client(), only=a) for a in ("streamers", "thenetaji", "lurkapi")]

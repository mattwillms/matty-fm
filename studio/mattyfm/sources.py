"""Song sources that keep the home IP off YouTube.

Search: the official YouTube Data API (an API key, not the website), with real
video lengths so songs.score() can match the catalog duration. Results are cached
on disk because search.list is limited to ~100 calls a day.

Download: Apify actors fetch the audio on their servers; we download the finished
file from Apify's storage. Primary thenetaji/youtube-music-downloader, fallback
lurkapi/youtube-to-mp3-audio-downloader.
"""

import html
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


class YouTubeSearch:
    def __init__(self, key: str, http: httpx.Client, cache_file: Path):
        self.key, self.http, self.cache_file = key, http, cache_file
        self.cache = json.loads(cache_file.read_text()) if cache_file.exists() else {}

    def __call__(self, query: str) -> list[Candidate]:
        if query in self.cache:
            return [Candidate(**c) for c in self.cache[query]]
        r = self.http.get(f"{API}/search", timeout=10, params={
            "q": query, "part": "snippet", "type": "video", "videoCategoryId": "10",
            "maxResults": 8, "key": self.key})
        if r.status_code == 403 and "quota" in r.text.lower():
            raise SongNotFound("YouTube Data API daily search quota is used up")
        r.raise_for_status()
        items = r.json().get("items", [])
        if not items:
            return []
        ids = [i["id"]["videoId"] for i in items]
        d = self.http.get(f"{API}/videos", timeout=10, params={
            "id": ",".join(ids), "part": "contentDetails", "key": self.key})
        d.raise_for_status()
        lengths = {v["id"]: iso_seconds(v["contentDetails"]["duration"]) for v in d.json().get("items", [])}
        cands = [Candidate(id=i["id"]["videoId"], title=html.unescape(i["snippet"]["title"]),
                           channel=html.unescape(i["snippet"]["channelTitle"]),
                           duration=float(lengths.get(i["id"]["videoId"], 0)))
                 for i in items if lengths.get(i["id"]["videoId"])]
        self.cache[query] = [c.__dict__ for c in cands]
        self.cache_file.write_text(json.dumps(self.cache))
        return cands


class ApifyDownload:
    def __init__(self, token: str, http: httpx.Client):
        self.token, self.http = token, http

    def _run(self, actor: str, body: dict) -> list:
        r = self.http.post(f"{APIFY}/{actor}/run-sync-get-dataset-items", timeout=200,
                           params={"token": self.token, "timeout": 170}, json=body)
        r.raise_for_status()
        return r.json() if isinstance(r.json(), list) else []

    def __call__(self, video_id: str, dest: Path) -> None:
        url = f"https://www.youtube.com/watch?v={video_id}"
        attempts = [
            ("thenetaji~youtube-music-downloader",
             {"urls": [{"url": url}], "region": "US", "saveMedia": True, "audioFormat": "mp3"},
             lambda it: (it.get("savedFile") or {}).get("url")),
            ("lurkapi~youtube-to-mp3-audio-downloader",
             {"videoUrls": [url], "audioFormat": "mp3", "audioBitrate": "192k", "maxVideosPerUrl": 1},
             lambda it: it.get("audioFileUrl")),
        ]
        reasons = []
        for actor, body, file_url in attempts:
            try:
                items = self._run(actor, body)
                link = file_url(items[0]) if items else None
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
            except httpx.HTTPError as e:
                reasons.append(f"{actor.split('~')[0]}: {type(e).__name__}: {e}"[:160])
                log.warning("apify %s failed for %s: %s", actor, video_id, reasons[-1])
        raise SongNotFound("Download failed: " + " | ".join(reasons))

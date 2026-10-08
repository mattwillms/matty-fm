"""SomaFM's own published track list, so the screens can show what SomaFM is playing."""

import logging
import time

import httpx

FEED = "https://somafm.com/songs/seventies.json"
log = logging.getLogger("mattyfm.somafm")


class NowPlaying:
    """Current SomaFM song, refreshed at most every `every_s` seconds; never raises."""

    def __init__(self, http: httpx.Client, every_s: float = 30.0):
        self.http, self.every_s = http, every_s
        self.last: dict | None = None
        self.fetched = 0.0

    def get(self) -> dict | None:
        if time.monotonic() - self.fetched >= self.every_s:
            self.fetched = time.monotonic()
            try:
                r = self.http.get(FEED, headers={"User-Agent": "OrrFM-studio/1.0"}, timeout=5)
                r.raise_for_status()
                song = r.json()["songs"][0]
                now = {"artist": song["artist"], "title": song["title"], "since": int(song["date"])}
                if self.last and (self.last["artist"], self.last["title"]) == (now["artist"], now["title"]):
                    now["artwork"] = self.last.get("artwork", "")
                else:
                    now["artwork"] = self._artwork(now["artist"], now["title"])
                    log.info("SomaFM now: %s - %s", now["artist"], now["title"])
                self.last = now
            except Exception as e:  # the feed is cosmetic: keep the last known song
                log.debug("SomaFM feed failed: %s", e)
        return self.last

    def _artwork(self, artist: str, title: str) -> str:
        """Album art from Apple's catalog (SomaFM's feed has none). Empty if not found."""
        try:
            r = self.http.get("https://itunes.apple.com/search", timeout=5,
                              params={"term": f"{artist} {title}", "entity": "song", "limit": 1})
            results = r.json().get("results") or []
            return results[0]["artworkUrl100"].replace("100x100", "200x200") if results else ""
        except Exception:
            return ""

"""SomaFM's own published track list, so the screens can show what SomaFM is playing."""

import logging
import time

import httpx

from . import apple

FEED = "https://somafm.com/songs/seventies.json"
log = logging.getLogger("mattyfm.somafm")


class NowPlaying:
    """Current SomaFM song, refreshed at most every `every_s` seconds; never raises."""

    def __init__(self, http: httpx.Client, every_s: float = 30.0):
        self.http, self.every_s = http, every_s
        self.last: dict | None = None
        self.prev: dict | None = None
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
                    for k in ("artwork", "year", "album", "apple"):
                        if self.last.get(k):
                            now[k] = self.last[k]
                else:
                    # year, album and the Apple Music link for the guests' record sleeve (iPhones can't ask Apple)
                    info = apple.release_info(now["artist"], now["title"], self.http)
                    now.update({k: v for k, v in info.items() if k in ("year", "album", "apple")})
                    now["artwork"] = info.get("artwork", "")
                    log.info("SomaFM now: %s - %s", now["artist"], now["title"])
                    self.prev = self.last
                self.last = now
            except Exception as e:  # the feed is cosmetic: keep the last known song
                log.debug("SomaFM feed failed: %s", e)
        return self.last

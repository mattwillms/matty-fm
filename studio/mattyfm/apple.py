"""Release info (year, album, cover, Apple Music link) from Apple's catalog, looked up here.

The guest page used to ask Apple directly from each phone, but Apple's search API answers an
iPhone with a redirect to the iTunes app (301 to musics://...), so iPhones never got it. The
studio asks from the home connection instead and hands the answer to the Worker for every phone.
"""

import logging
from urllib.parse import urlencode, urlsplit, parse_qsl, urlunsplit

import httpx

from .songs import base_key

SEARCH = "https://itunes.apple.com/search"
log = logging.getLogger("mattyfm.apple")


def music_link(url: str) -> str:
    """Apple's trackViewUrl ends "&uo=4", which opens the iTunes Store; app=music opens Music."""
    parts = urlsplit(url)
    q = [(k, v) for k, v in parse_qsl(parts.query) if k != "uo"] + [("app", "music")]
    return urlunsplit(parts._replace(query=urlencode(q)))


def _matches(row: dict, want: str) -> bool:
    try:
        return bool(row.get("releaseDate")) and base_key(str(row.get("artistName") or ""), str(row.get("trackName") or "")) == want
    except Exception:   # one odd row must not lose the rest
        return False


def _https(url, domain: str) -> bool:
    """Only Apple's own https links pass on to the guests' phones."""
    try:
        u = urlsplit(str(url or ""))
        return u.scheme == "https" and (u.hostname == domain or (u.hostname or "").endswith("." + domain))
    except ValueError:
        return False


def release_info(artist: str, title: str, http: httpx.Client) -> dict:
    """{year, album, apple, artwork} for the earliest matching release (the original album, not a
    later best-of), or {} if Apple has nothing or can't be reached. Never raises."""
    try:
        r = http.get(SEARCH, timeout=6, params={"term": f"{artist} {title}", "entity": "song",
                                                "limit": 25, "country": "US", "media": "music"})
        r.raise_for_status()
        want = base_key(artist, title)
        results = r.json().get("results", [])
        hits = [x for x in results if isinstance(x, dict) and _matches(x, want)]
        if not hits:   # no exact match: Apple's best guess still gives a cover, but no year or album
            art = results[0].get("artworkUrl100", "") if results and isinstance(results[0], dict) else ""
            return {"artwork": art.replace("100x100bb", "200x200bb")} if _https(art, "mzstatic.com") else {}
        first = min(hits, key=lambda x: x["releaseDate"])
        info = {"year": first["releaseDate"][:4], "album": first.get("collectionName", "")}
        if _https(first.get("trackViewUrl"), "apple.com"):
            info["apple"] = music_link(first["trackViewUrl"])
        if _https(first.get("artworkUrl100"), "mzstatic.com"):
            info["artwork"] = first["artworkUrl100"].replace("100x100bb", "200x200bb")   # the sleeve enlarges it itself
        return info
    except Exception as e:   # cosmetic: the sleeve just shows less
        log.info("Apple lookup for %s - %s failed: %s", artist, title, e)
        return {}

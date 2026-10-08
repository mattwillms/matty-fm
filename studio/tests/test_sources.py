"""Song sources that keep the home IP off YouTube: Data API search, Apify download."""

import json

import httpx
import pytest

from mattyfm import sources
from mattyfm.songs import SongNotFound


def client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_iso_duration():
    assert sources.iso_seconds("PT3M35S") == 215
    assert sources.iso_seconds("PT1H2M3S") == 3723
    assert sources.iso_seconds("PT45S") == 45


def test_search_returns_candidates_with_real_durations(tmp_path):
    def handler(r):
        if r.url.path.endswith("/search"):
            assert r.url.params["videoCategoryId"] == "10" and r.url.params["key"] == "k"
            return httpx.Response(200, json={"items": [
                {"id": {"videoId": "a"}, "snippet": {"title": "September &amp; more", "channelTitle": "EWF - Topic"}},
                {"id": {"videoId": "b"}, "snippet": {"title": "September (Live)", "channelTitle": "Fan"}}]})
        assert r.url.params["id"] == "a,b"
        return httpx.Response(200, json={"items": [
            {"id": "a", "contentDetails": {"duration": "PT3M35S"}},
            {"id": "b", "contentDetails": {"duration": "PT5M1S"}}]})

    yt = sources.YouTubeSearch("k", client(handler), tmp_path / "search.json")
    cands = yt('"Earth, Wind & Fire - September"')
    assert [(c.id, c.channel, c.duration) for c in cands] == [("a", "EWF - Topic", 215.0), ("b", "Fan", 301.0)]
    assert cands[0].title == "September & more"


def test_search_results_are_cached(tmp_path):
    calls = {"n": 0}

    def handler(r):
        calls["n"] += 1
        if r.url.path.endswith("/search"):
            return httpx.Response(200, json={"items": [{"id": {"videoId": "a"}, "snippet": {"title": "T", "channelTitle": "C"}}]})
        return httpx.Response(200, json={"items": [{"id": "a", "contentDetails": {"duration": "PT3M"}}]})

    yt = sources.YouTubeSearch("k", client(handler), tmp_path / "search.json")
    yt("q")
    yt("q")
    assert calls["n"] == 2   # one search + one durations call, then the cache answers


def test_quota_error_is_a_clear_song_not_found(tmp_path):
    yt = sources.YouTubeSearch("k", client(lambda r: httpx.Response(403, json={"error": {"errors": [{"reason": "quotaExceeded"}]}})),
                               tmp_path / "s.json")
    with pytest.raises(SongNotFound, match="quota"):
        yt("q")


def test_apify_falls_back_to_the_second_actor_and_downloads_from_storage(tmp_path):
    seen = []

    def handler(r):
        seen.append(r.url.path)
        if "thenetaji" in r.url.path:
            return httpx.Response(200, json=[{"error": "YouTube is blocking this video"}])
        if "lurkapi" in r.url.path:
            body = json.loads(r.content)
            assert body["videoUrls"] == ["https://www.youtube.com/watch?v=abc"]
            return httpx.Response(200, json=[{"audioFileUrl": "https://api.apify.com/v2/key-value-stores/s/records/f.mp3"}])
        return httpx.Response(200, content=b"ID3audio")

    dl = sources.ApifyDownload("tok", client(handler))
    dest = tmp_path / "x.mp3"
    dl("abc", dest)
    assert dest.read_bytes() == b"ID3audio"
    assert any("thenetaji" in p for p in seen) and any("lurkapi" in p for p in seen)


def test_apify_total_failure_raises_with_reasons(tmp_path):
    dl = sources.ApifyDownload("tok", client(lambda r: httpx.Response(200, json=[{"error": "blocked"}])))
    with pytest.raises(SongNotFound, match="blocked"):
        dl("abc", tmp_path / "x.mp3")

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
            assert r.url.params["videoCategoryId"] == "10" and r.headers["x-goog-api-key"] == "k"
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
        if "streamers" in r.url.path or "thenetaji" in r.url.path:
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


def test_keys_never_appear_in_urls_or_error_text(tmp_path):
    seen = []

    def handler(r):
        seen.append(r)
        if "googleapis" in r.url.host:
            return httpx.Response(500)
        return httpx.Response(500)

    yt = sources.YouTubeSearch("SECRETKEY", client(handler), tmp_path / "s.json")
    with pytest.raises(Exception) as e1:
        yt("q")
    dl = sources.ApifyDownload("SECRETTOKEN", client(handler))
    with pytest.raises(SongNotFound) as e2:
        dl("abc", tmp_path / "x.mp3")
    for r in seen:
        assert "SECRET" not in str(r.url)
    assert any(r.headers.get("x-goog-api-key") == "SECRETKEY" for r in seen)
    assert any(r.headers.get("authorization") == "Bearer SECRETTOKEN" for r in seen)
    assert "SECRET" not in str(e1.value) and "SECRET" not in str(e2.value)


def test_only_apify_storage_links_are_downloaded(tmp_path):
    fetched = []

    def handler(r):
        if "/acts/" in r.url.path:
            return httpx.Response(200, json=[{"savedFile": {"url": "http://192.168.86.1/admin"}},])
        fetched.append(str(r.url))
        return httpx.Response(200, content=b"x")

    dl = sources.ApifyDownload("tok", client(handler))
    with pytest.raises(SongNotFound):
        dl("abc", tmp_path / "x.mp3")
    assert fetched == []


def test_streamers_goes_first_and_only_its_apify_copy_is_fetched(tmp_path):
    # 2026-10-08: YouTube blocked thenetaji and lurkapi; streamers still worked
    seen = []

    def handler(r):
        seen.append(str(r.url))
        if "streamers~youtube-video-downloader" in r.url.path:
            body = json.loads(r.content)
            assert body["videos"] == [{"url": "https://www.youtube.com/watch?v=abc"}] and body["preferredFormat"] == "mp3"
            return httpx.Response(200, json=[{
                "audioOnlyUrl": "https://rr1---sn-x.googlevideo.com/videoplayback?id=abc",   # YouTube itself: never from home
                "downloadedFileUrl": "https://api.apify.com/v2/key-value-stores/s/records/abc_ABBA.mp3"}])
        return httpx.Response(200, content=b"ID3audio")

    dest = tmp_path / "x.mp3"
    sources.ApifyDownload("tok", client(handler))("abc", dest)
    assert dest.read_bytes() == b"ID3audio"
    assert "streamers" in seen[0] and len(seen) == 2
    assert not any("googlevideo" in u for u in seen)


def test_two_processes_sharing_the_search_cache_keep_each_others_entries(tmp_path):
    f = tmp_path / "search.json"
    def handler(r):
        if r.url.path.endswith("/search"):
            return httpx.Response(200, json={"items": [{"id": {"videoId": "v1"}, "snippet": {"title": "t", "channelTitle": "c"}}]})
        return httpx.Response(200, json={"items": [{"id": "v1", "contentDetails": {"duration": "PT3M"}}]})
    studio = sources.YouTubeSearch("k", client(handler), f)
    precache = sources.YouTubeSearch("k", client(handler), f)
    studio("abba waterloo")
    precache("abba sos")
    assert set(json.loads(f.read_text())) == {"abba waterloo", "abba sos"}
    f.write_text('{"half')   # a torn file never crashes a new reader
    assert sources.YouTubeSearch("k", client(handler), f).cache == {}


def test_apify_download_remembers_failures_and_hangs(tmp_path):
    import itertools
    clock = itertools.chain([0.0, 5.0, 100.0, 300.0, 400.0], itertools.repeat(410.0))   # then still (the fetch reads it too)
    fail = {"on": True}

    def handler(r):
        if "streamers" in r.url.path:
            if fail["on"]:
                return httpx.Response(400, json={"error": {"type": "run-timeout-exceeded"}})
            return httpx.Response(200, json=[{"downloadedFileUrl": "https://api.apify.com/v2/key-value-stores/s/records/a.mp3"}])
        return httpx.Response(200, content=b"ID3audio")

    dl = sources.ApifyDownload("tok", client(handler), only="streamers", clock=lambda: next(clock))
    with pytest.raises(SongNotFound):
        dl("abc", tmp_path / "x.mp3")          # fails fast (5 s): a failure, not a hang
    assert dl.failed_at == 5.0 and not dl.timed_out
    with pytest.raises(SongNotFound):
        dl("abc", tmp_path / "x.mp3")          # fails after 200 s: it hung
    assert dl.failed_at == 300.0 and dl.timed_out
    fail["on"] = False
    dl("abc", tmp_path / "x.mp3")
    assert dl.failed_at == 0.0 and not dl.timed_out


def test_a_second_key_takes_over_when_the_first_runs_out(tmp_path):
    used = []

    def handler(r):
        key = r.headers["x-goog-api-key"]
        used.append((r.url.path.rsplit("/", 1)[-1], key))
        if key == "k1":
            return httpx.Response(403, json={"error": {"errors": [{"reason": "quotaExceeded"}]}})
        if r.url.path.endswith("/search"):
            return httpx.Response(200, json={"items": [{"id": {"videoId": "a"}, "snippet": {"title": "T", "channelTitle": "C"}}]})
        return httpx.Response(200, json={"items": [{"id": "a", "contentDetails": {"duration": "PT3M"}}]})

    yt = sources.YouTubeSearch(["k1", "k2", ""], client(handler), tmp_path / "s.json")
    assert [c.id for c in yt("q1")] == ["a"]
    yt("q2")   # k1 is spent for today: not asked again
    assert used == [("search", "k1"), ("search", "k2"), ("videos", "k2"), ("search", "k2"), ("videos", "k2")]

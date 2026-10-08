"""Request-pipeline faults from the 2026-10-08 QA round, each pinned by a test."""

import json
import subprocess
import threading
from pathlib import Path

import httpx
import pytest

from mattyfm import mix, prepare, songs, sources
from mattyfm.songs import Candidate, SongNotFound


def tone(path: Path, seconds: float) -> Path:
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
                    "-c:a", "libmp3lame", "-b:a", "64k", str(path)], check=True)
    return path


def test_every_ffmpeg_and_ffprobe_run_has_a_time_limit(monkeypatch, tmp_path):
    seen = []

    def run(*a, **kw):
        seen.append(kw)
        return subprocess.CompletedProcess(a, 0, stdout="12.0\n", stderr="")
    monkeypatch.setattr(subprocess, "run", run)
    mix._ffmpeg("-i", "x")
    mix.duration(tmp_path / "x.mp3")
    assert all(kw.get("timeout") and kw.get("stdin") == subprocess.DEVNULL for kw in seen)


def test_a_truncated_download_is_not_the_song(tmp_path):
    whole = tone(tmp_path / "whole.mp3", 60)
    cut = tmp_path / "cut.mp3"
    cut.write_bytes(whole.read_bytes()[: len(whole.read_bytes()) * 2 // 5])   # header still says 60 s
    assert prepare.is_audio(whole, 60)
    assert not prepare.is_audio(cut, 60)
    assert prepare.is_audio(cut) == (mix.decoded_duration(cut) > 20)   # no catalog length: only the 20 s floor
    assert 20 < mix.decoded_duration(cut) < 30


def test_an_unplayable_cached_file_is_fetched_again(tmp_path):
    key = "abba|sos"
    (tmp_path / f"{songs.cache_name(key)}.mp3").write_bytes(b"")
    (tmp_path / f"{songs.cache_name(key)}.json").write_text(json.dumps({"confidence": 60, "video_id": "old"}))
    got = []

    def dl(vid, dest):
        got.append(vid)
        dest.write_bytes(b"ID3fresh")
    item = {"songKey": key, "title": "SOS", "artist": "ABBA", "durationMs": 200000}
    song = songs.get_song(item, tmp_path, search=lambda q: [Candidate("new", "SOS", "ABBA - Topic", 200)],
                          download=[dl], verify=lambda p: p.stat().st_size > 0)
    assert got == ["new"] and song.video_id == "new"


@pytest.mark.parametrize("meta", ['{"video_id": "v"}', "[1, 2]", '{"confidence": null, "video_id": "v"}'])
def test_odd_cache_metadata_is_a_miss_not_a_crash(tmp_path, meta):
    key = "abba|sos"
    (tmp_path / f"{songs.cache_name(key)}.mp3").write_bytes(b"ID3")
    (tmp_path / f"{songs.cache_name(key)}.json").write_text(meta)
    item = {"songKey": key, "title": "SOS", "artist": "ABBA", "durationMs": 200000}
    song = songs.get_song(item, tmp_path, search=lambda q: [Candidate("new", "SOS", "ABBA - Topic", 200)],
                          download=[lambda v, d: d.write_bytes(b"ID3")])
    assert song.video_id == "new"


def test_two_searches_finishing_together_both_succeed(tmp_path):
    def handler(r):
        if r.url.path.endswith("/search"):
            return httpx.Response(200, json={"items": [{"id": {"videoId": "v1"}, "snippet": {"title": "t", "channelTitle": "c"}}]})
        return httpx.Response(200, json={"items": [{"id": "v1", "contentDetails": {"duration": "PT3M"}}]})
    yt = sources.YouTubeSearch("k", httpx.Client(transport=httpx.MockTransport(handler)), tmp_path / "search.json")
    errors = []

    def go(n):
        try:
            for i in range(25):
                yt(f"q{n}-{i}")
        except Exception as e:   # noqa: BLE001
            errors.append(e)
    threads = [threading.Thread(target=go, args=(n,)) for n in range(4)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert errors == [] and len(json.loads((tmp_path / "search.json").read_text())) == 100


def test_a_search_cache_that_cant_be_saved_still_answers(tmp_path):
    def handler(r):
        if r.url.path.endswith("/search"):
            return httpx.Response(200, json={"items": [{"id": {"videoId": "v1"}, "snippet": {"title": "t", "channelTitle": "c"}}]})
        return httpx.Response(200, json={"items": [{"id": "v1", "contentDetails": {"duration": "PT3M"}}]})
    gone = tmp_path / "no-such-dir" / "search.json"
    yt = sources.YouTubeSearch("k", httpx.Client(transport=httpx.MockTransport(handler)), gone)
    assert [c.id for c in yt("abba")] == ["v1"]


def test_fetching_the_finished_file_has_an_overall_time_limit(tmp_path):
    ticks = iter(range(0, 10_000, 30))   # each chunk arrives 30 s after the last: a trickle

    def chunks():
        for _ in range(20):
            yield b"x" * 10

    def handler(r):
        if "acts" in r.url.path:
            return httpx.Response(200, json=[{"downloadedFileUrl": "https://api.apify.com/v2/key-value-stores/s/records/a.mp3"}])
        return httpx.Response(200, content=chunks())
    dl = sources.ApifyDownload("tok", httpx.Client(transport=httpx.MockTransport(handler)), only="streamers",
                               clock=lambda: next(ticks))
    with pytest.raises(SongNotFound, match="too slow"):
        dl("abc", tmp_path / "x.mp3")
    assert not (tmp_path / "x.mp3").exists() and not list(tmp_path.glob("*.dl"))


def test_one_song_s_downloads_stop_after_the_overall_budget(tmp_path):
    now = [0.0]
    tried = []

    def slow(name):
        def dl(vid, dest):
            tried.append((name, vid))
            now[0] += 149   # each try hangs just under the hang mark
            raise SongNotFound("timed out")
        return dl
    cands = [Candidate("v1", "SOS", "ABBA - Topic", 200), Candidate("v2", "SOS (Audio)", "ABBA", 200)]
    item = {"songKey": "abba|sos", "title": "SOS", "artist": "ABBA", "durationMs": 200000}
    with pytest.raises(SongNotFound, match="gave up"):
        songs.get_song(item, tmp_path, search=lambda q: cands, download=[slow("a"), slow("b"), slow("c")],
                       tries=2, budget_s=240, clock=lambda: now[0])
    assert len(tried) == 2   # 0 s and 149 s started; at 298 s the budget is spent

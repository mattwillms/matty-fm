from pathlib import Path

import pytest

from mattyfm import songs
from mattyfm.songs import Candidate, SongNotFound


def c(title, channel="Some Uploader", duration=215.0, id="x"):
    return Candidate(id=id, title=title, channel=channel, duration=duration)


def test_topic_with_matching_duration_wins():
    cands = [
        c("Earth, Wind & Fire - September (Official Video)", duration=230, id="vid"),
        c("September", channel="Earth, Wind & Fire - Topic", duration=215, id="topic"),
        c("September (Live at Budokan)", channel="Earth, Wind & Fire - Topic", duration=300, id="live"),
    ]
    best, confidence = songs.pick(cands, "September", "Earth, Wind & Fire", 215.0)
    assert best.id == "topic"
    assert confidence >= songs.CONFIDENT


def test_penalised_words_only_when_not_requested():
    karaoke = c("September Karaoke Version", duration=215)
    plain = c("September", duration=215)
    assert songs.score(karaoke, "September", "EWF", 215) < songs.score(plain, "September", "EWF", 215)
    live_req = c("Hotel California (Live)", duration=430)
    assert songs.score(live_req, "Hotel California (Live)", "Eagles", 430) > 0


def test_no_duration_still_picks_topic():
    cands = [
        c("random cover of dancing queen", duration=200, id="cover"),
        c("Dancing Queen", channel="ABBA - Topic", duration=231, id="topic"),
    ]
    best, confidence = songs.pick(cands, "Dancing Queen", "ABBA", None)
    assert best.id == "topic"


def test_overlong_and_empty_raise():
    with pytest.raises(SongNotFound):
        songs.pick([], "x", "y", None)
    with pytest.raises(SongNotFound):
        songs.pick([c("x", duration=4000)], "x", "y", None)


def test_song_key_matches_worker_rules():
    # Same cases as worker/test/queue.test.ts "songKey".
    assert songs.song_key("Beyoncé", "Halo (Remastered 2009)") == songs.song_key("beyonce", "HALO")
    assert songs.song_key("Earth, Wind & Fire", "September - 2004 Remaster") == "earth wind fire|september"


def test_get_song_uses_cache_before_search(tmp_path):
    (tmp_path / "abba|dancing queen.mp3").write_bytes(b"ID3")
    (tmp_path / "abba|dancing queen.json").write_text('{"confidence": 88, "video_id": "v1"}')

    def boom(*a, **k):
        raise AssertionError("search must not run on a cache hit")

    item = {"songKey": "abba|dancing queen", "title": "Dancing Queen", "artist": "ABBA", "durationMs": None}
    got = songs.get_song(item, tmp_path, search=boom, download=boom)
    assert got.path.name == "abba|dancing queen.mp3" and got.confidence == 88


def test_get_song_downloads_best_and_writes_cache(tmp_path):
    cands = [c("Dancing Queen", channel="ABBA - Topic", duration=231, id="topic")]

    def fake_download(video_id: str, dest: Path) -> None:
        assert video_id == "topic"
        dest.write_bytes(b"ID3")

    item = {"songKey": "abba|dancing queen", "title": "Dancing Queen", "artist": "ABBA", "durationMs": 231000}
    got = songs.get_song(item, tmp_path, search=lambda q: cands, download=fake_download)
    assert got.path.exists() and (tmp_path / "abba|dancing queen.json").exists()


def test_unavailable_video_falls_back_to_next_best(tmp_path):
    import subprocess
    cands = [c("Dancing Queen", channel="ABBA - Topic", duration=231, id="blocked"),
             c("ABBA - Dancing Queen (Official Audio)", channel="ABBA", duration=231, id="ok")]
    tried = []

    def flaky(video_id: str, dest: Path) -> None:
        tried.append(video_id)
        if video_id == "blocked":
            raise subprocess.CalledProcessError(1, "yt-dlp", stderr="ERROR: [youtube] blocked: Video unavailable")
        dest.write_bytes(b"ID3")

    item = {"songKey": "abba|dancing queen", "title": "Dancing Queen", "artist": "ABBA", "durationMs": 231000}
    got = songs.get_song(item, tmp_path, search=lambda q: cands, download=flaky)
    assert tried == ["blocked", "ok"] and got.video_id == "ok"


def test_all_downloads_failing_reports_youtube_reason(tmp_path):
    import subprocess

    def broken(video_id: str, dest: Path) -> None:
        raise subprocess.CalledProcessError(1, "yt-dlp", stderr="noise\nERROR: [youtube] x: Video unavailable\n")

    item = {"songKey": "a|b", "title": "B", "artist": "A", "durationMs": None}
    with pytest.raises(SongNotFound, match="Video unavailable"):
        songs.get_song(item, tmp_path, search=lambda q: [c("B", id="x"), c("B", id="y")], download=broken)

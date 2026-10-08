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


def test_primary_downloader_tries_every_candidate_before_the_slow_fallback(tmp_path):
    cands = [c("Mimosa", channel="X - Topic", duration=140, id="blocked"),
             c("Mimosa 2000", channel="Y", duration=140, id="ok")]
    order = []

    def primary(vid, dest):
        order.append(("primary", vid))
        if vid == "blocked":
            raise SongNotFound("blocked")
        dest.write_bytes(b"ID3")

    def fallback(vid, dest):
        order.append(("fallback", vid))
        dest.write_bytes(b"ID3")

    item = {"songKey": "furacao|mimosa", "title": "Mimosa", "artist": "Furacao", "durationMs": 140000}
    got = songs.get_song(item, tmp_path, search=lambda q: cands, download=[primary, fallback], tries=2)
    assert order == [("primary", "blocked"), ("primary", "ok")] and got.video_id == "ok"


def test_base_key_drops_version_tags():
    assert songs.base_key("Tears For Fears", "Everybody Wants To Rule The World (Live From Franklin, TN)") == \
        "tears for fears|everybody wants to rule the world"
    assert songs.base_key("Journey", "Don't Stop Believin' - 2024 Remaster") == "journey|don t stop believin"


def test_a_tagged_version_uses_the_cached_original(tmp_path):
    (tmp_path / "tears for fears|everybody wants to rule the world.mp3").write_bytes(b"ID3")
    (tmp_path / "tears for fears|everybody wants to rule the world.json").write_text('{"confidence": 80, "video_id": "v"}')
    item = {"songKey": "tears for fears|everybody wants to rule the world live from franklin tn",
            "title": "Everybody Wants To Rule The World (Live From Franklin, TN)", "artist": "Tears For Fears", "durationMs": 300000}
    got = songs.get_song(item, tmp_path, search=lambda q: (_ for _ in ()).throw(AssertionError("no search")), download=None)
    assert got.path.name.startswith("tears for fears|everybody wants")


def test_youtube_query_has_no_quotes_or_version_tags(tmp_path):
    seen = []

    def search(q):
        seen.append(q)
        return [c("Everybody Wants To Rule The World", channel="Tears For Fears - Topic", duration=251, id="ok")]

    item = {"songKey": "tears for fears|x", "title": "Everybody Wants To Rule The World (Live From Franklin, TN)",
            "artist": "Tears For Fears", "durationMs": None}
    songs.get_song(item, tmp_path, search=search, download=lambda v, d: d.write_bytes(b"ID3"))
    assert seen == ["Tears For Fears Everybody Wants To Rule The World"]


def test_tribute_and_sound_alike_uploads_are_penalised():
    original = c("Garth Brooks - Friends in Low Places (Official Audio)", channel="Some Uploader", duration=258)
    tribute = c("Garth Brooks - Friends in Low Places (Tribute) (Official Audio)", channel="Some Uploader", duration=258)
    styled = c("Garth Brooks - Friends in Low Places (In the Style of) (Official Audio)", channel="Some Uploader", duration=258)
    for bad in (tribute, styled):
        assert songs.score(bad, "Friends in Low Places", "Garth Brooks", 258) < songs.score(original, "Friends in Low Places", "Garth Brooks", 258) - 20


ITEM_DQ = {"songKey": "abba|dancing queen", "title": "Dancing Queen", "artist": "ABBA", "durationMs": 231000}


def test_corrupt_cache_metadata_is_a_miss_not_a_crash(tmp_path):
    (tmp_path / "abba|dancing queen.mp3").write_bytes(b"ID3")
    (tmp_path / "abba|dancing queen.json").write_text("{not json")
    cands = [c("Dancing Queen", channel="ABBA - Topic", duration=231, id="topic")]
    got = songs.get_song(ITEM_DQ, tmp_path, search=lambda q: cands, download=lambda v, d: d.write_bytes(b"ID3"))
    assert got.video_id == "topic"


def test_any_downloader_error_moves_on_to_the_fallback(tmp_path):
    cands = [c("Dancing Queen", channel="ABBA - Topic", duration=231, id="topic")]

    def broken(video_id, dest):
        raise ValueError("Apify answered with HTML")

    got = songs.get_song(ITEM_DQ, tmp_path, search=lambda q: cands,
                         download=[broken, lambda v, d: d.write_bytes(b"ID3")])
    assert got.video_id == "topic"


def test_a_download_that_is_not_audio_is_never_cached(tmp_path):
    cands = [c("Dancing Queen", channel="ABBA - Topic", duration=231, id="a"),
             c("Dancing Queen", channel="ABBA - Topic", duration=231, id="b")]

    def dl(video_id, dest):
        dest.write_bytes(b"<html>blocked</html>" if video_id == "a" else b"ID3 real audio")

    got = songs.get_song(ITEM_DQ, tmp_path, search=lambda q: cands, download=dl,
                         verify=lambda p: p.read_bytes().startswith(b"ID3"))
    assert got.video_id == "b"
    import json
    assert json.loads((tmp_path / "abba|dancing queen.json").read_text())["video_id"] == "b"


def test_song_keys_keep_letters_of_every_script_like_the_worker():
    assert songs.song_key("Кино", "Группа крови") == "кино|группа крови"
    assert songs.song_key("坂本九", "上を向いて歩こう") != songs.song_key("Кино", "Группа крови")
    assert len(songs.song_key("Q" * 300, "B" * 300)) == 161


class FakeService:
    """A download service as get_song sees it: callable, plus what it remembers about its last try."""

    def __init__(self, name, order, works=True, failed_at=0.0, hangs=False):
        self.name, self.order, self.works, self.failed_at, self.hangs, self.timed_out = name, order, works, failed_at, hangs, False

    def __call__(self, vid, dest):
        self.order.append((self.name, vid))
        if not self.works:
            self.timed_out = self.hangs
            raise SongNotFound(f"{self.name} failed")
        dest.write_bytes(b"ID3")


def test_a_service_that_failed_recently_is_tried_after_the_ones_that_work(tmp_path):
    # 2026-10-08: with a blocked service first, every request waited out its failures again
    order = []
    blocked = FakeService("blocked", order, works=False, failed_at=100.0)
    older = FakeService("older", order, works=False, failed_at=50.0)
    fine = FakeService("fine", order)
    item = {"songKey": "abba|sos", "title": "SOS", "artist": "ABBA", "durationMs": 200000}
    songs.get_song(item, tmp_path, search=lambda q: [c("SOS", id="v1")], download=[blocked, older, fine], tries=2)
    assert order == [("fine", "v1")]
    order.clear()
    (tmp_path / f"{songs.cache_name('abba|sos')}.mp3").unlink()
    fine.works = False
    with pytest.raises(SongNotFound):
        songs.get_song(item, tmp_path, search=lambda q: [c("SOS", id="v1")], download=[blocked, older, fine], tries=2)
    assert [n for n, _ in order] == ["fine", "older", "blocked"]   # the oldest failure is likeliest to have recovered


def test_a_service_that_hangs_is_not_tried_on_the_other_matches(tmp_path):
    order = []
    hanging = FakeService("hanging", order, works=False, hangs=True)
    backup = FakeService("backup", order, works=False)
    cands = [c("SOS", channel="ABBA - Topic", duration=200, id="v1"), c("SOS (lyrics)", duration=200, id="v2")]
    item = {"songKey": "abba|sos", "title": "SOS", "artist": "ABBA", "durationMs": 200000}
    with pytest.raises(SongNotFound):
        songs.get_song(item, tmp_path, search=lambda q: cands, download=[hanging, backup], tries=2)
    assert order == [("hanging", "v1"), ("backup", "v1"), ("backup", "v2")]

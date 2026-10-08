from pathlib import Path
from types import SimpleNamespace as NS

from mattyfm import prepare
from mattyfm.djline import DJLine
from mattyfm.songs import SongFile, SongNotFound

ITEM = {"id": "r7", "songKey": "abba|sos", "title": "SOS", "artist": "ABBA", "album": "", "durationMs": 200000,
        "freeText": False, "requesters": [{"name": "Ann", "message": "hi"}]}


def deps(tmp_path):
    cfg = NS(media_dir=tmp_path, sample_rate=44100)
    return prepare.Deps(cfg=cfg, claude=None, http=None, aura=lambda t: b"", names={})


def test_ready_result(tmp_path, monkeypatch):
    monkeypatch.setattr(prepare.songs, "get_song", lambda item, cache, **k: SongFile(tmp_path / "s.mp3", 77.0, "v"))
    monkeypatch.setattr(prepare.djline, "write_line", lambda item, c: DJLine(True, "sweet", "Hello Ann.", False))
    monkeypatch.setattr(prepare.tts, "speak", lambda *a, **k: "eleven")
    monkeypatch.setattr(prepare.mix, "prepare_files", lambda *a, **k: (201.5, 4.2))
    r = prepare.prepare(ITEM, deps(tmp_path))
    note = r.pop("matchNote")
    assert r == {"id": "r7", "status": "ready", "file": "r7.mp3", "durationS": 201.5, "confidence": 77.0,
                 "djLine": "Hello Ann.", "tone": "sweet", "voice": "eleven", "voiceS": 4.2}
    assert "unreadable" in note


def test_song_not_found_fails_fast_without_tts(tmp_path, monkeypatch):
    def nope(item, cache, **k):
        raise SongNotFound("No usable match")

    monkeypatch.setattr(prepare.songs, "get_song", nope)
    monkeypatch.setattr(prepare.tts, "speak", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no TTS")))
    r = prepare.prepare(ITEM, deps(tmp_path))
    assert r["status"] == "failed" and "No usable match" in r["error"]


def test_unexpected_error_becomes_failed(tmp_path, monkeypatch):
    monkeypatch.setattr(prepare.songs, "get_song", lambda item, cache, **k: SongFile(tmp_path / "s.mp3", 77.0, "v"))
    monkeypatch.setattr(prepare.djline, "write_line", lambda item, c: DJLine(True, "funny", "x", False))
    monkeypatch.setattr(prepare.tts, "speak", lambda *a, **k: "eleven")

    def broken(*a, **k):
        raise RuntimeError("ffmpeg exploded")

    monkeypatch.setattr(prepare.mix, "prepare_files", broken)
    assert prepare.prepare(ITEM, deps(tmp_path))["status"] == "failed"


def _ready(tmp_path, monkeypatch, actual_s, duration_ms, channel="Nielson Lucas", conf=35.0):
    song = SongFile(tmp_path / "s.mp3", conf, "v", title="Toto - Africa (Official Audio)", channel=channel)
    monkeypatch.setattr(prepare.songs, "get_song", lambda item, cache, **k: song)
    monkeypatch.setattr(prepare.djline, "write_line", lambda item, c: DJLine(True, "funny", "x", False))
    monkeypatch.setattr(prepare.tts, "speak", lambda *a, **k: "eleven")
    monkeypatch.setattr(prepare.mix, "prepare_files", lambda *a, **k: (actual_s, 3.0))
    monkeypatch.setattr(prepare.mix, "duration", lambda p: actual_s)
    monkeypatch.setattr(prepare.mix, "decoded_duration", lambda p: actual_s)   # lengths are checked by decoding
    return prepare.prepare({**ITEM, "durationMs": duration_ms}, deps(tmp_path))


def test_matching_length_confirms_a_fan_upload(tmp_path, monkeypatch):
    r = _ready(tmp_path, monkeypatch, 296.0, 295000)
    assert r["confidence"] >= 75
    assert "Nielson Lucas" in r["matchNote"] and "length matches" in r["matchNote"]


def test_wrong_length_lowers_confidence_and_says_why(tmp_path, monkeypatch):
    r = _ready(tmp_path, monkeypatch, 420.0, 295000, conf=80.0)
    assert r["confidence"] <= 30 and "7:00" in r["matchNote"] and "4:55" in r["matchNote"]


def test_unknown_length_is_said_plainly(tmp_path, monkeypatch):
    r = _ready(tmp_path, monkeypatch, 296.0, None, channel="Toto - Topic")
    assert "official" in r["matchNote"] and "not checked" in r["matchNote"]


def test_a_search_timeout_fails_the_request_instead_of_looping(tmp_path, monkeypatch):
    import httpx

    def timeout(item, cache, **k):
        raise httpx.ConnectTimeout("youtube timed out")

    monkeypatch.setattr(prepare.songs, "get_song", timeout)
    r = prepare.prepare(ITEM, deps(tmp_path))
    assert r["status"] == "failed" and "timed out" in r["error"]


def test_a_song_file_ffmpeg_cannot_read_is_dropped_from_the_cache(tmp_path, monkeypatch):
    cached, meta = tmp_path / "abba|sos.mp3", tmp_path / "abba|sos.json"
    cached.write_bytes(b"junk"); meta.write_text("{}")
    monkeypatch.setattr(prepare.songs, "get_song", lambda item, cache, **k: SongFile(cached, 77.0, "v"))
    monkeypatch.setattr(prepare.djline, "write_line", lambda item, c: DJLine(True, "funny", "x", False))
    monkeypatch.setattr(prepare.tts, "speak", lambda *a, **k: "eleven")

    def broken(*a, **k):
        raise RuntimeError("ffmpeg: Invalid data found when processing input")

    monkeypatch.setattr(prepare.mix, "prepare_files", broken)
    r = prepare.prepare(ITEM, deps(tmp_path))
    assert r["status"] == "failed" and "Invalid data" in r["error"]
    assert not cached.exists() and not meta.exists()   # a retry downloads it fresh


def test_a_voice_failure_keeps_the_cached_song(tmp_path, monkeypatch):
    cached = tmp_path / "abba|sos.mp3"
    cached.write_bytes(b"ID3")
    monkeypatch.setattr(prepare.songs, "get_song", lambda item, cache, **k: SongFile(cached, 77.0, "v"))
    monkeypatch.setattr(prepare.djline, "write_line", lambda item, c: DJLine(True, "funny", "x", False))
    monkeypatch.setattr(prepare.tts, "speak", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("tts down")))
    assert prepare.prepare(ITEM, deps(tmp_path))["status"] == "failed"
    assert cached.exists()


def test_a_ready_song_carries_release_info_for_the_sleeve(tmp_path, monkeypatch):
    monkeypatch.setattr(prepare.songs, "get_song", lambda item, cache, **k: SongFile(tmp_path / "s.mp3", 77.0, "v"))
    monkeypatch.setattr(prepare.djline, "write_line", lambda item, c: DJLine(True, "sweet", "Hello Ann.", False))
    monkeypatch.setattr(prepare.tts, "speak", lambda *a, **k: "eleven")
    monkeypatch.setattr(prepare.mix, "prepare_files", lambda *a, **k: (201.5, 4.2))
    monkeypatch.setattr(prepare.apple, "release_info",
                        lambda artist, title, http: {"year": "1975", "album": "Arrival", "apple": "https://music.apple.com/x?app=music"})
    d = deps(tmp_path)
    d.http = object()
    r = prepare.prepare(ITEM, d)
    assert r["year"] == "1975" and r["appleUrl"] == "https://music.apple.com/x?app=music" and r["albumName"] == "Arrival"


def test_a_bad_voice_does_not_delete_a_good_cached_song(tmp_path, monkeypatch):
    cached, meta = tmp_path / "abba|sos.mp3", tmp_path / "abba|sos.json"
    cached.write_bytes(b"ID3"); meta.write_text("{}")
    monkeypatch.setattr(prepare.songs, "get_song", lambda item, cache, **k: SongFile(cached, 77.0, "v"))
    monkeypatch.setattr(prepare.djline, "write_line", lambda item, c: DJLine(True, "funny", "x", False))
    monkeypatch.setattr(prepare.tts, "speak", lambda *a, **k: "aura")
    monkeypatch.setattr(prepare.mix, "prepare_files", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("voice: Invalid data")))
    monkeypatch.setattr(prepare, "is_audio", lambda p: p == cached)   # the song itself decodes fine
    assert prepare.prepare(ITEM, deps(tmp_path))["status"] == "failed"
    assert cached.exists() and meta.exists()

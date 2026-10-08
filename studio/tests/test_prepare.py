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
    assert r == {"id": "r7", "status": "ready", "file": "r7.mp3", "durationS": 201.5, "confidence": 77.0,
                 "djLine": "Hello Ann.", "tone": "sweet", "voice": "eleven", "voiceS": 4.2}


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

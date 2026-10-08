"""The Pi console engine: every transition rule, driven by a fake clock."""

import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "console", Path(__file__).resolve().parents[2] / "pi" / "console.py")
console = importlib.util.module_from_spec(spec)
spec.loader.exec_module(console)


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class Players:
    """Records what each channel is asked to play."""

    def __init__(self):
        self.started, self.stopped = [], []
        self.alive = {}

    def play(self, channel, url):
        self.started.append((channel, url))
        self.alive[channel] = url

    def stop(self, channel):
        self.stopped.append(channel)
        self.alive.pop(channel, None)

    def running(self, channel):
        return channel in self.alive


class Mixer:
    def __init__(self):
        self.level = {"SomaVol": 100, "DeckAVol": 0, "DeckBVol": 0, "DjVol": 100}

    def set(self, control, pct):
        self.level[control] = pct


def item(i, song_s=200.0, voice_s=4.0):
    return {"id": i, "title": f"T{i}", "artist": "A", "songS": song_s, "voiceS": voice_s}


def make():
    clock, players, mixer = Clock(), Players(), Mixer()
    eng = console.Engine("http://ws:8040", clock=clock, players=players, mixer=mixer)
    eng.soma_up = lambda: True
    return eng, clock, players, mixer


def run(eng, clock, seconds, step=0.1):
    for _ in range(int(round(seconds / step))):
        clock.t += step
        eng.tick()


def test_soma_to_request_follows_the_rule():
    eng, clock, players, mixer = make()
    eng.push(item("r1", voice_s=4.0))
    eng.tick()
    assert ("deckA", "http://ws:8040/ready/r1.mp3") in players.started
    run(eng, clock, 0.6)
    assert ("dj", "http://ws:8040/voice/r1.mp3") in players.started      # voice starts 0.5 s in
    assert 0 < mixer.level["SomaVol"] < 100 and 0 < mixer.level["DeckAVol"] < 100
    run(eng, clock, 4.0)                                                   # lead = 0.5 + 4.0
    assert mixer.level["DeckAVol"] == 100 and mixer.level["SomaVol"] == 0
    assert mixer.level["DjVol"] == 100
    assert eng.status()["source"] == "requests" and eng.status()["current"] == "r1"


def test_song_to_song_starts_lead_seconds_before_the_end():
    eng, clock, players, mixer = make()
    eng.push(item("r1", song_s=60.0, voice_s=4.0))
    eng.tick()
    run(eng, clock, 10)
    eng.push(item("r2", voice_s=6.0))                     # lead 6.5 s
    run(eng, clock, 60 - 10 - 6.5 - 0.3)
    assert ("deckB", "http://ws:8040/ready/r2.mp3") not in players.started
    run(eng, clock, 0.5)
    assert ("deckB", "http://ws:8040/ready/r2.mp3") in players.started
    run(eng, clock, 7)
    assert mixer.level["DeckBVol"] == 100 and mixer.level["DeckAVol"] == 0
    assert "deckA" in players.stopped
    assert eng.status()["current"] == "r2"


def test_song_with_nothing_queued_crossfades_to_soma_over_its_last_seconds():
    eng, clock, players, mixer = make()
    eng.push(item("r1", song_s=30.0, voice_s=2.0))
    eng.tick()
    run(eng, clock, 30 - console.OUTRO_S - 0.2)
    assert mixer.level["DeckAVol"] == 100
    run(eng, clock, console.OUTRO_S + 0.5)
    assert mixer.level["SomaVol"] == 100 and mixer.level["DeckAVol"] == 0
    assert eng.status()["source"] == "soma"


def test_skip_goes_straight_to_the_queued_request():
    eng, clock, players, mixer = make()
    eng.push(item("r1"))
    eng.tick()
    run(eng, clock, 20)
    eng.push(item("r2", voice_s=3.0))
    eng.skip()
    run(eng, clock, 0.2)
    assert ("deckB", "http://ws:8040/ready/r2.mp3") in players.started
    run(eng, clock, 4)
    assert mixer.level["SomaVol"] == 0                    # never went via SomaFM
    assert eng.status()["current"] == "r2"


def test_skip_with_nothing_queued_goes_to_soma():
    eng, clock, players, mixer = make()
    eng.push(item("r1"))
    eng.tick()
    run(eng, clock, 20)
    eng.skip()
    run(eng, clock, 4)
    assert mixer.level["SomaVol"] == 100 and eng.status()["source"] == "soma"


def test_clear_drops_the_queued_request():
    eng, clock, players, mixer = make()
    eng.push(item("r1"))
    eng.tick()
    run(eng, clock, 5)
    eng.push(item("r2"))
    assert eng.status()["queued"] == 1
    eng.clear()
    assert eng.status()["queued"] == 0


def test_soma_down_plays_backup_and_returns_when_it_is_back():
    eng, clock, players, mixer = make()
    eng.backup = ["http://ws:8040/backup/a.mp3"]
    up = {"v": False}
    eng.soma_up = lambda: up["v"]
    run(eng, clock, 0.5)
    assert any(u.endswith("/backup/a.mp3") for _, u in players.started)
    run(eng, clock, 4)
    assert eng.status()["source"] == "backup"
    up["v"] = True
    run(eng, clock, 4)
    assert mixer.level["SomaVol"] == 100 and eng.status()["source"] == "soma"


def test_a_deck_that_stops_early_does_not_leave_silence():
    eng, clock, players, mixer = make()
    eng.push(item("r1", song_s=200.0))
    eng.tick()
    run(eng, clock, 10)
    players.alive.pop("deckA")            # decoder died / file ended early
    run(eng, clock, 4)
    assert mixer.level["SomaVol"] == 100 and eng.status()["source"] == "soma"


def test_backup_paths_resolve_against_the_file_server():
    eng, clock, players, mixer = make()
    eng.backup = [{"url": "backup/a.mp3", "songS": 100.0}]
    eng.soma_up = lambda: False
    run(eng, clock, 0.3)
    assert ("deckA", "http://ws:8040/backup/a.mp3") in players.started

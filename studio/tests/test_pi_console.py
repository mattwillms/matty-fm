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


def watch(eng, clock, seconds, mixer, a, b, step=0.1):
    """Run, and fail if channels a and b are ever both audible (no overlap)."""
    for _ in range(int(round(seconds / step))):
        clock.t += step
        eng.tick()
        assert not (mixer.level[a] > 0 and mixer.level[b] > 0), (clock.t, mixer.level)


def test_soma_to_request_fades_down_gap_then_up_under_the_voice():
    eng, clock, players, mixer = make()
    eng.push(item("r1", voice_s=4.0))
    eng.tick()
    watch(eng, clock, 0.6, mixer, "SomaVol", "DeckAVol")
    assert ("dj", "http://ws:8040/voice/r1.mp3") in players.started           # voice 0.5 s in
    assert 0 < mixer.level["SomaVol"] < 100
    assert not any(ch == "deckA" for ch, _ in players.started)                # song not yet
    watch(eng, clock, console.DOWN_S - 0.6 + console.GAP_S + 0.1, mixer, "SomaVol", "DeckAVol")
    assert mixer.level["SomaVol"] == 0
    assert ("deckA", "http://ws:8040/ready/r1.mp3") in players.started        # after the silence
    watch(eng, clock, 4.5 - (console.DOWN_S + console.GAP_S + 0.1) + 0.05, mixer, "SomaVol", "DeckAVol")
    assert mixer.level["DeckAVol"] == 100                                      # full as the voice ends
    assert mixer.level["DjVol"] == 100
    assert eng.status()["source"] == "requests" and eng.status()["current"] == "r1"


def test_song_to_song_starts_as_the_old_song_fades_out():
    eng, clock, players, mixer = make()
    eng.push(item("r1", song_s=60.0, voice_s=4.0))
    eng.tick()
    run(eng, clock, 10)
    eng.push(item("r2", voice_s=6.0))
    played_from = clock.t                  # deckA started at about t0 + DOWN_S + GAP_S
    run(eng, clock, 60 - 10 - console.DOWN_S - 0.5 + (console.DOWN_S + console.GAP_S) - 0.5)
    assert not any(ch == "deckB" for ch, _ in players.started)
    watch(eng, clock, 9, mixer, "DeckAVol", "DeckBVol")
    assert ("deckB", "http://ws:8040/ready/r2.mp3") in players.started
    assert mixer.level["DeckBVol"] == 100 and mixer.level["DeckAVol"] == 0
    assert "deckA" in players.stopped
    assert eng.status()["current"] == "r2"


def test_song_with_nothing_queued_fades_out_then_soma_fades_in():
    eng, clock, players, mixer = make()
    eng.push(item("r1", song_s=30.0, voice_s=2.0))
    eng.tick()
    start = console.DOWN_S + console.GAP_S         # deckA began here
    run(eng, clock, start + 30 - console.OUTRO_S - 0.3)
    assert mixer.level["DeckAVol"] == 100
    watch(eng, clock, console.OUTRO_S + console.GAP_S + console.SOMA_UP_S + 0.5, mixer, "SomaVol", "DeckAVol")
    assert mixer.level["SomaVol"] == 100 and mixer.level["DeckAVol"] == 0
    assert eng.status()["source"] == "soma"


def test_skip_goes_straight_to_the_queued_request():
    eng, clock, players, mixer = make()
    eng.push(item("r1"))
    eng.tick()
    run(eng, clock, 20)
    eng.push(item("r2", voice_s=3.0))
    eng.skip()
    watch(eng, clock, 4, mixer, "DeckAVol", "DeckBVol")
    assert ("deckB", "http://ws:8040/ready/r2.mp3") in players.started
    assert mixer.level["SomaVol"] == 0                    # never went via SomaFM
    assert eng.status()["current"] == "r2"


def test_skip_with_nothing_queued_goes_to_soma():
    eng, clock, players, mixer = make()
    eng.push(item("r1"))
    eng.tick()
    run(eng, clock, 20)
    eng.skip()
    watch(eng, clock, 5, mixer, "SomaVol", "DeckAVol")
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
    run(eng, clock, 2.5)
    assert any(u.endswith("/backup/a.mp3") for _, u in players.started)
    run(eng, clock, 4)
    assert eng.status()["source"] == "backup"
    up["v"] = True
    run(eng, clock, 6)
    assert mixer.level["SomaVol"] == 100 and eng.status()["source"] == "soma"


def test_a_deck_that_stops_early_does_not_leave_silence():
    eng, clock, players, mixer = make()
    eng.push(item("r1", song_s=200.0))
    eng.tick()
    run(eng, clock, 10)
    players.alive.pop("deckA")            # decoder died / file ended early
    run(eng, clock, 6)
    assert mixer.level["SomaVol"] == 100 and eng.status()["source"] == "soma"


def test_backup_paths_resolve_against_the_file_server():
    eng, clock, players, mixer = make()
    eng.backup = [{"url": "backup/a.mp3", "songS": 100.0}]
    eng.soma_up = lambda: False
    run(eng, clock, 2.5)
    assert ("deckA", "http://ws:8040/backup/a.mp3") in players.started


def test_voice_break_dips_soma_under_the_dj_and_restores_it():
    eng, clock, players, mixer = make()
    run(eng, clock, 1)
    assert eng.voice_break("http://ws:8040/breaks/id1.mp3", 3.0) is True
    run(eng, clock, 0.6)
    assert ("dj", "http://ws:8040/breaks/id1.mp3") in players.started
    assert mixer.level["SomaVol"] == console.DUCK_PCT
    run(eng, clock, 3.0 + console.RESTORE_S + 0.2)
    assert mixer.level["SomaVol"] == 100
    assert eng.status()["source"] == "soma"


def test_voice_break_over_a_request_dips_the_song():
    eng, clock, players, mixer = make()
    eng.push(item("r1", voice_s=2.0))
    eng.tick()
    run(eng, clock, 10)                      # transition over, song at full
    assert mixer.level["DeckAVol"] == 100
    assert eng.voice_break("http://ws:8040/breaks/id1.mp3", 3.0) is True
    run(eng, clock, 0.6)
    assert ("dj", "http://ws:8040/breaks/id1.mp3") in players.started
    assert mixer.level["DeckAVol"] == console.DUCK_PCT
    run(eng, clock, 3.0 + console.RESTORE_S + 0.2)
    assert mixer.level["DeckAVol"] == 100


def test_voice_break_during_a_transition_waits_for_it_to_finish():
    eng, clock, players, mixer = make()
    eng.push(item("r1", voice_s=4.0))
    eng.tick()
    run(eng, clock, 0.6)                     # mid-transition: DJ intro is talking
    assert eng.voice_break("http://ws:8040/breaks/id2.mp3", 2.0) is True
    run(eng, clock, 1.0)
    assert ("dj", "http://ws:8040/breaks/id2.mp3") not in players.started
    run(eng, clock, 5.0)                     # transition done -> bumper plays
    assert ("dj", "http://ws:8040/breaks/id2.mp3") in players.started


def test_skip_with_nothing_queued_plays_the_skip_bumper():
    eng, clock, players, mixer = make()
    eng.push(item("r1"))
    eng.tick()
    run(eng, clock, 20)
    eng.skip(bumper=("http://ws:8040/breaks/skip1.mp3", 2.0))
    run(eng, clock, 1)
    assert ("dj", "http://ws:8040/breaks/skip1.mp3") in players.started
    watch(eng, clock, 5, mixer, "SomaVol", "DeckAVol")
    assert mixer.level["SomaVol"] == 100


def test_a_pad_plays_on_its_own_channel_over_everything():
    eng, clock, players, mixer = make()
    eng.push(item("r1", voice_s=4.0))
    eng.tick()
    run(eng, clock, 0.6)                              # mid-transition, DJ talking
    before = dict(mixer.level)
    eng.fx("breaks/pad-1.mp3")
    assert ("fx", "http://ws:8040/breaks/pad-1.mp3") in players.started
    assert players.running("dj")                      # the DJ keeps talking
    assert mixer.level == before                      # nothing ducks or jumps
    eng.fx("breaks/pad-2.mp3")                        # a second tap replaces the first
    assert players.started[-1] == ("fx", "http://ws:8040/breaks/pad-2.mp3")
    run(eng, clock, 5)
    assert eng.status()["current"] == "r1"            # the transition finished as normal

from mattyfm.feed import decide

IDLE = {"source": "soma", "current": "", "remaining": -1.0, "queued": 0}
ITEM = {"id": "r1", "title": "SOS", "artist": "ABBA"}


def reply(next=None, commands=(), soma_only=False):
    return {"commands": list(commands), "settings": {"somaOnly": soma_only, "stopAfterCurrent": False},
            "next": next, "jobs": []}


def test_push_when_idle_and_ready():
    assert decide(IDLE, reply(ITEM)) == [("push", ITEM)]


def test_push_as_soon_as_ready_even_mid_song():
    # The console holds one queued song so a skip can go straight to it.
    playing = {"source": "requests", "current": "r0", "remaining": 90.0, "queued": 0}
    assert decide(playing, reply(ITEM)) == [("push", ITEM)]


def test_never_push_when_something_is_queued():
    assert decide({**IDLE, "queued": 1}, reply(ITEM)) == []


def test_commands_run_first():
    acts = decide(IDLE, reply(None, [{"id": 4, "type": "clear"}, {"id": 5, "type": "skip"}]))
    assert acts == [("clear",), ("skip",)]


def test_clear_command():
    assert decide({**IDLE, "queued": 1}, reply(None, [{"id": 1, "type": "clear"}])) == [("clear",)]


def test_soma_only_skips_requests():
    playing = {"source": "requests", "current": "r0", "remaining": 90.0, "queued": 0}
    assert decide(playing, reply(ITEM, soma_only=True)) == [("skip",)]


def test_wants_next_only_when_it_would_push():
    from mattyfm.feed import wants_next
    assert wants_next(IDLE) is True
    assert wants_next({**IDLE, "queued": 1}) is False
    assert wants_next({"source": "requests", "current": "r0", "remaining": 90.0, "queued": 0}) is True


def test_a_double_skip_skips_once_and_clear_goes_first():
    # Skip tapped twice, or Skip plus deleting the next song, must not skip into a song being cleared
    playing = {"source": "requests", "current": "r1", "remaining": 50.0, "queued": 1}
    cmds = [{"id": 1, "type": "skip"}, {"id": 2, "type": "skip"}, {"id": 3, "type": "clear"}]
    assert decide(playing, reply(None, cmds)) == [("clear",), ("skip",)]


def test_an_unreachable_station_reads_as_silence_with_the_reason():
    import httpx
    from mattyfm.feed import station_status

    class DeadPi:
        def status(self):
            raise httpx.ConnectError("no route to host")

    status, error = station_status(DeadPi())
    assert status == {"source": "silence", "current": "", "remaining": -1.0, "queued": 0}
    assert "no route to host" in error


class FakeStation:
    def __init__(self, accept=True):
        self.calls, self.accept = [], accept

    def voice(self, url, voice_s, soma_only=False):
        self.calls.append((url, round(voice_s, 1), soma_only))
        return self.accept


def test_replay_plays_the_song_s_dj_voice_again_over_whatever_is_on_air(tmp_path):
    from mattyfm import feed
    (tmp_path / "voice").mkdir()
    (tmp_path / "voice" / "r12.mp3").write_bytes(b"ID3")
    st = FakeStation()
    assert feed.replay_dj(st, tmp_path, "r12", duration=lambda p: 6.4) is True
    assert st.calls == [("voice/r12.mp3", 6.4, False)]


def test_replay_refuses_odd_ids_and_missing_voices(tmp_path):
    from mattyfm import feed
    st = FakeStation()
    for bad in ("../ready/r1", "r1/../../x", "", "r 1", None):
        assert feed.replay_dj(st, tmp_path, bad, duration=lambda p: 5.0) is False
    assert feed.replay_dj(st, tmp_path, "r99", duration=lambda p: 5.0) is False   # no voice file
    assert st.calls == []


def _tone(path, seconds):
    import subprocess
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=f=300:d={seconds}", "-ar", "44100",
                    "-ac", "2", "-c:a", "libmp3lame", str(path)], check=True)


def test_a_joke_rides_in_front_of_a_request_intro_and_comes_off_again(tmp_path):
    from mattyfm import feed, mix
    (tmp_path / "voice").mkdir(); (tmp_path / "breaks").mkdir()
    _tone(tmp_path / "voice" / "r5.mp3", 4.0)
    _tone(tmp_path / "breaks" / "joke-j1.mp3", 10.0)
    secs = feed.attach_joke(tmp_path, "r5", tmp_path / "breaks" / "joke-j1.mp3")
    assert abs(secs - 14.4) < 0.3 and abs(mix.duration(tmp_path / "voice" / "r5.mp3") - secs) < 0.1
    assert abs(mix.duration(tmp_path / "voice" / "r5.intro.mp3") - 4.0) < 0.1     # the intro is kept for Replay
    secs2 = feed.attach_joke(tmp_path, "r5", tmp_path / "breaks" / "joke-j1.mp3")   # again: not joke+joke+intro
    assert abs(secs2 - secs) < 0.1
    assert abs(feed.detach_joke(tmp_path, "r5") - 4.0) < 0.1
    assert abs(mix.duration(tmp_path / "voice" / "r5.mp3") - 4.0) < 0.1


def test_a_joke_can_stand_in_for_an_intro_with_no_message(tmp_path):
    from mattyfm import feed, mix
    (tmp_path / "voice").mkdir(); (tmp_path / "breaks").mkdir()
    _tone(tmp_path / "voice" / "r6.mp3", 4.0)
    _tone(tmp_path / "breaks" / "joke-j2.mp3", 10.0)
    assert abs(feed.attach_joke(tmp_path, "r6", tmp_path / "breaks" / "joke-j2.mp3", replace=True) - 10.0) < 0.2
    assert abs(feed.detach_joke(tmp_path, "r6") - 4.0) < 0.1      # the intro is still there if needed

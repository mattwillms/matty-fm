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

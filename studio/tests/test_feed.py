from mattyfm.feed import decide

IDLE = {"source": "soma", "current": "", "remaining": -1.0, "queued": 0}
ITEM = {"id": "r1", "title": "SOS", "artist": "ABBA"}


def reply(next=None, commands=(), soma_only=False):
    return {"commands": list(commands), "settings": {"somaOnly": soma_only, "stopAfterCurrent": False},
            "next": next, "jobs": []}


def test_push_when_idle_and_ready():
    assert decide(IDLE, reply(ITEM)) == [("push", ITEM)]


def test_no_push_while_song_has_time_left():
    playing = {"source": "requests", "current": "r0", "remaining": 90.0, "queued": 0}
    assert decide(playing, reply(ITEM)) == []


def test_push_in_last_30_seconds():
    ending = {"source": "requests", "current": "r0", "remaining": 25.0, "queued": 0}
    assert decide(ending, reply(ITEM)) == [("push", ITEM)]


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

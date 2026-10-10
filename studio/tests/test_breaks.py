from mattyfm import breaks

SOMA = {"source": "soma", "current": "", "remaining": -1, "queued": 0}
REQ = {"source": "requests", "current": "r1", "remaining": 100, "queued": 0}


def make():
    return breaks.Scheduler(now=0.0)


def test_first_break_not_before_ten_minutes():
    s = make()
    assert s.due(SOMA, now=9 * 60, soma_age=30) is None
    assert s.due(SOMA, now=10 * 60, soma_age=30) is not None


def test_only_while_soma_is_on_air_and_nothing_queued():
    s = make()
    assert s.due(REQ, now=40 * 60, soma_age=30) is None
    assert s.due({**SOMA, "queued": 1}, now=40 * 60, soma_age=30) is None


def test_a_request_resets_the_clock():
    s = make()
    s.due(REQ, now=25 * 60, soma_age=30)               # request playing at 25 min
    assert s.due(SOMA, now=30 * 60, soma_age=30) is None
    assert s.due(SOMA, now=46 * 60, soma_age=30) is not None


def test_back_announce_only_near_the_start_of_a_soma_song():
    s = make()
    kinds = []
    for minute in range(30, 400, 30):
        k = s.due(SOMA, now=minute * 60, soma_age=400)   # SomaFM song started long ago
        if k:
            kinds.append(k)
            s.done(now=minute * 60)
    assert kinds and "backannounce" not in kinds
    assert set(kinds) <= {"id", "goof"}


def test_breaks_rotate_and_stay_at_least_ten_minutes_apart():
    s = make()
    times, kinds = [], []
    t = 0
    while t < 6 * 3600:
        t += 10
        k = s.due(SOMA, now=t, soma_age=30)
        if k:
            times.append(t)
            kinds.append(k)
            s.done(now=t)
    assert all(b - a >= 10 * 60 for a, b in zip(times, times[1:]))
    assert {"backannounce", "id", "goof"} <= set(kinds)


def test_the_gap_follows_the_admin_setting():
    s = make()
    s.set_gap(5 * 60)
    assert s.due(SOMA, now=4 * 60, soma_age=30) is None
    assert s.due(SOMA, now=5 * 60, soma_age=30) is not None


def test_gap_is_clamped_to_five_to_thirty_minutes_in_fives():
    s = make()
    for asked, got in ((1 * 60, 5 * 60), (90 * 60, 30 * 60), (12 * 60, 10 * 60), (13 * 60, 15 * 60)):
        s.set_gap(asked)
        assert s.gap_s == got


def test_seconds_left_counts_down_to_the_next_break():
    s = make()
    assert s.seconds_left(now=5 * 60) == 5 * 60
    s.done(now=21 * 60)
    assert s.seconds_left(now=21 * 60) == 10 * 60
    assert s.seconds_left(now=99 * 60) == 0


def test_without_back_announces_ids_and_goofs_alternate():
    s = make()
    kinds = []
    for minute in range(10, 200, 10):
        k = s.due(SOMA, now=minute * 60, soma_age=400)   # never at the start of a SomaFM song
        if k:
            kinds.append(k)
            s.done(now=minute * 60, kind=k)
    assert all(a != b for a, b in zip(kinds, kinds[1:])), kinds


def test_clips_rotate_evenly_and_new_ones_catch_up(tmp_path):
    from mattyfm.breaks import Rotation
    clips = [{"file": f"goof-{i}.mp3"} for i in range(1, 5)]
    rot = Rotation(tmp_path / "plays.json")
    first_round = []
    for _ in range(4):
        c = rot.pick(clips)
        rot.played(c["file"])
        first_round.append(c["file"])
    assert sorted(first_round) == sorted(c["file"] for c in clips)   # each once before any repeats
    rot = Rotation(tmp_path / "plays.json")                       # a studio restart keeps the counts
    clips.append({"file": "goof-5.mp3"})
    assert rot.pick(clips)["file"] == "goof-5.mp3"               # the new one catches up first
    rot.played("goof-5.mp3")
    assert set(rot.counts.values()) == {1} and len(rot.counts) == 5   # level again: anyone may play next


def test_rotation_survives_a_missing_or_corrupt_counts_file(tmp_path):
    from mattyfm.breaks import Rotation
    f = tmp_path / "plays.json"
    f.write_text("{oops")
    rot = Rotation(f)
    assert rot.pick([{"file": "a.mp3"}])["file"] == "a.mp3"
    rot.played("a.mp3")
    assert Rotation(f).counts == {"a.mp3": 1}


def test_jokes_keep_their_own_5_minute_clock_and_requests_dont_delay_them():
    from mattyfm.breaks import Scheduler, JOKE_GAP_S
    soma = {"source": "soma", "current": "", "remaining": -1, "queued": 0}
    req = {"source": "requests", "current": "r1", "remaining": 100, "queued": 0}
    s = Scheduler(gap_s=10 * 60, now=0)
    assert s.joke_due(0) and s.joke_due(1)                   # no joke yet today: the first one goes as soon as it's ready
    s.joke_told(100)
    assert not s.joke_due(100 + JOKE_GAP_S - 1)
    s.due(req, 200, None)                                    # a request on air...
    assert s.joke_due(100 + JOKE_GAP_S)                      # ...doesn't push the next joke back
    t = 100 + JOKE_GAP_S
    assert s.due(soma, t, None, joke_ready=True) is None        # requests just ended: "back to SomaFM" is owed first
    assert s.due(soma, t + 10, None, joke_ready=True) == "return"
    s.done(t + 10, "return")
    assert s.due(soma, t + 70, None, joke_ready=True) == "joke"  # a minute after the last talk
    s.joke_told(t + 70)
    assert s.due(soma, t + 70 + JOKE_GAP_S - 1, None, joke_ready=True) is None


def test_a_joke_isnt_crammed_right_after_another_break():
    from mattyfm.breaks import Scheduler
    soma = {"source": "soma", "current": "", "remaining": -1, "queued": 0}
    s = Scheduler(gap_s=10 * 60, now=0)
    s.done(1000, "id")
    assert s.due(soma, 1030, None, joke_ready=True) is None   # a bumper just played
    assert s.due(soma, 1070, None, joke_ready=True) == "joke"


SOMA_T = {"source": "soma", "current": "", "remaining": -1, "queued": 0}
REQ_T = {"source": "requests", "current": "r1", "remaining": 100, "queued": 0}


def test_jokes_never_move_the_bumper_clock():
    s = breaks.Scheduler(gap_s=10 * 60, now=0)
    s.joke_told(9 * 60 + 30)                                  # a joke 30 s before the bumper is due
    assert s.due(SOMA_T, 10 * 60, soma_age=30) is None        # a minute's spacing after the joke...
    assert s.due(SOMA_T, 10 * 60 + 30, soma_age=30) is not None   # ...then the bumper, on its own clock


def test_a_due_bumper_waits_for_the_next_song_change_then_goes_anyway():
    s = make()
    assert s.due(SOMA, now=10 * 60, soma_age=200) is None      # mid-song: waits
    assert s.holding(10 * 60)
    assert s.due(SOMA, now=10 * 60 + 60, soma_age=20) is not None   # the next song's intro
    s2 = make()
    assert s2.due(SOMA, now=10 * 60 + breaks.BUMPER_HOLD_S - 1, soma_age=200) is None
    assert s2.due(SOMA, now=10 * 60 + breaks.BUMPER_HOLD_S, soma_age=200) is not None   # waited long enough


def test_a_due_joke_waits_a_minute_at_most_for_a_song_change():
    s = make()
    assert s.due(SOMA, now=100, soma_age=200, joke_ready=True) is None
    assert s.due(SOMA, now=100 + breaks.JOKE_HOLD_S, soma_age=210, joke_ready=True) == "joke"


def test_requests_ending_get_a_back_to_somafm_line():
    s = make()
    s.due(REQ_T, now=100, soma_age=None)
    assert s.due(SOMA_T, now=103, soma_age=None) is None       # still fading over
    assert s.due(SOMA_T, now=111, soma_age=None) == "return"
    s.done(111, "return")
    assert s.due(SOMA_T, now=120, soma_age=None) is None       # said once


def test_no_back_to_somafm_line_after_a_skip_stinger_or_once_stale():
    s = make()
    s.due(REQ_T, now=100, soma_age=None)
    s.skipped(98)
    s.due(SOMA_T, now=101, soma_age=None)
    assert s.due(SOMA_T, now=110, soma_age=None) != "return"
    s2 = make()
    s2.due(REQ_T, now=100, soma_age=None)
    s2.due({**SOMA_T, "queued": 1}, now=101, soma_age=None)   # the next request is already on its way
    s2.due(REQ_T, now=110, soma_age=None)
    s2.due(SOMA_T, now=400, soma_age=None)
    assert s2.due(SOMA_T, now=400 + breaks.RETURN_WINDOW_S[1] + 1, soma_age=None) != "return"


def test_back_announces_take_half_the_turns_at_song_starts():
    s = make()
    kinds = []
    t = 0
    while t < 8 * 3600:
        t += 10
        k = s.due(SOMA, now=t, soma_age=30)
        if k:
            kinds.append(k)
            s.done(now=t, kind=k)
    assert kinds.count("backannounce") * 2 == len(kinds) or abs(kinds.count("backannounce") * 2 - len(kinds)) <= 1
    assert all(not (a == b == "id") and not (a == b == "goof") for a, b in zip(kinds, kinds[1:]))


def test_an_announcement_doesnt_wait_for_the_joke_clock():
    # party test: "Group photo on the porch now" aired 39 minutes late behind the jokes
    s = make()
    s.joke_told(100)
    assert s.due(SOMA, 200, 30, joke_ready=True) is None                    # a joke: 5 minutes apart
    assert s.due(SOMA, 200, 30, joke_ready=True, announce=True) == "joke"   # news: at the next chance
    s.joke_told(200)
    assert s.due(SOMA, 230, 30, joke_ready=True, announce=True) is None     # never on top of the last talk

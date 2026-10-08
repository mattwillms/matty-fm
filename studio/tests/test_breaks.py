from mattyfm import breaks

SOMA = {"source": "soma", "current": "", "remaining": -1, "queued": 0}
REQ = {"source": "requests", "current": "r1", "remaining": 100, "queued": 0}


def make():
    return breaks.Scheduler(now=0.0)


def test_first_break_not_before_twenty_minutes():
    s = make()
    assert s.due(SOMA, now=19 * 60, soma_age=30) is None
    assert s.due(SOMA, now=29 * 60, soma_age=30) is not None


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


def test_breaks_rotate_and_stay_at_least_twenty_minutes_apart():
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
    assert all(b - a >= 20 * 60 for a, b in zip(times, times[1:]))
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
    assert s.seconds_left(now=5 * 60) == 15 * 60
    s.done(now=21 * 60)
    assert s.seconds_left(now=21 * 60) == 20 * 60
    assert s.seconds_left(now=99 * 60) == 0

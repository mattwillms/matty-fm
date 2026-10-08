import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "mattyfm_pi", Path(__file__).resolve().parents[2] / "pi" / "mattyfm_pi.py")
pi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pi)


def test_parse_icy_title():
    assert pi.parse_title("@I ICY-META: StreamTitle='MATTYFM:r3 ABBA - SOS';") == "MATTYFM:r3 ABBA - SOS"
    assert pi.parse_title("@I ICY-META: StreamTitle='It''s fine';") == "It''s fine"
    assert pi.parse_title("@P 2") is None
    assert pi.parse_title("@I ICY-NAME: MattyFM") is None


def test_mode_follows_title_and_soma_health():
    assert pi.decide_mode("MATTYFM:r1 A - B", soma_up=True) == "station"
    assert pi.decide_mode("IDLE", soma_up=True) == "soma"
    assert pi.decide_mode("", soma_up=True) == "soma"
    assert pi.decide_mode("IDLE", soma_up=False) == "station"   # internet down: backup playlist


def test_ramp_is_a_crossfade():
    steps = pi.ramp(0, 100, 5)
    assert steps[0] == 20 and steps[-1] == 100 and steps == sorted(steps)
    assert pi.ramp(100, 0, 4) == [75, 50, 25, 0]
    assert pi.ramp(40, 40, 3) == [40, 40, 40]

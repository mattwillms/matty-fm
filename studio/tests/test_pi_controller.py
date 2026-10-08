import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "mattyfm_pi", Path(__file__).resolve().parents[2] / "pi" / "mattyfm_pi.py")
pi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pi)


def test_parse_icy_title():
    assert pi.parse_title(b"StreamTitle='MATTYFM:r3 ABBA - SOS';\0\0") == "MATTYFM:r3 ABBA - SOS"
    assert pi.parse_title(b"StreamUrl='x';") is None


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


def test_supervisor_exits_when_a_player_thread_died():
    import threading
    alive = threading.Thread(target=lambda: None)
    assert pi.threads_healthy([]) is True
    assert pi.threads_healthy([alive]) is False   # never started = not alive


def test_icy_reader_splits_audio_and_titles():
    import io
    def block(title):
        meta = f"StreamTitle='{title}';".encode()
        meta += b"\0" * (-len(meta) % 16)
        return bytes([len(meta) // 16]) + meta
    raw = b"A" * 8 + block("IDLE") + b"B" * 8 + b"\0" + b"C" * 8 + block("MATTYFM:r9 X - Y")
    events = list(pi.icy_events(io.BytesIO(raw), metaint=8, chunk=3))
    audio = b"".join(e[1] for e in events if e[0] == "audio")
    titles = [e[1] for e in events if e[0] == "title"]
    assert audio == b"A" * 8 + b"B" * 8 + b"C" * 8
    assert titles == ["IDLE", "MATTYFM:r9 X - Y"]
    # A title is reported only after all audio that precedes it.
    kinds = [e[0] for e in events]
    assert kinds.index("title") > max(i for i, k in enumerate(kinds[:kinds.index("title")]) if k == "audio")


def test_soma_health_is_recent_bytes():
    h = pi.FlowHealth(stall_s=4.0)
    assert h.up(now=100.0) is False
    h.saw_bytes(now=100.0)
    assert h.up(now=103.0) is True
    assert h.up(now=105.0) is False

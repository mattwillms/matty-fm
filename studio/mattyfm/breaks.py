"""When the DJ speaks between requests: every N minutes (the admin slider, 5 to 30, default 10), over SomaFM only.

Kinds rotate: a back-announce of the SomaFM song that just started (voiced fresh),
a station ID, a goof (both pre-made clips with sound effects). A request on air
pushes the next break out to a full gap after it.
"""

import json
import random
import threading
from pathlib import Path

DEFAULT_GAP_S = 10 * 60
MIN_GAP_S, MAX_GAP_S, STEP_S = 5 * 60, 30 * 60, 5 * 60
BACKANNOUNCE_WINDOW_S = (10, 75)   # seconds after a SomaFM song started (its intro)
ROTATION = ("backannounce", "id", "goof")
JOKE_GAP_S = 5 * 60   # guests' jokes: one every 5 minutes (their own clock; requests don't delay it)
BREAK_SPACING_S = 60  # never a joke right on top of another break


class Scheduler:
    """No randomness: the admin page shows a countdown, so the break must land when it says."""

    def __init__(self, gap_s: float = DEFAULT_GAP_S, now: float = 0.0):
        self.gap_s = DEFAULT_GAP_S
        self.set_gap(gap_s)
        self.last = now          # the last break, or the last moment a request was on air (bumpers)
        self.last_break = -1e9   # the last break of any kind actually played
        self.last_joke = None    # the last guest joke told
        self.turn = 0

    def set_gap(self, gap_s: float) -> None:
        stepped = round(gap_s / STEP_S) * STEP_S
        self.gap_s = min(MAX_GAP_S, max(MIN_GAP_S, stepped))

    def joke_due(self, now: float) -> bool:
        """A joke may go now: none told yet, or 5 minutes since the last. Played at the next song
        change (in front of a request's intro) or over SomaFM, whichever comes first."""
        return self.last_joke is None or now - self.last_joke >= JOKE_GAP_S

    def joke_told(self, now: float) -> None:
        self.last_joke = now
        self.last_break = now
        self.last = max(self.last, now)   # the bumper clock restarts after it too

    def gap(self, joke_ready: bool = False) -> float:
        return JOKE_GAP_S if joke_ready else self.gap_s

    @property
    def next_due(self) -> float:
        return self.last + self.gap_s

    def seconds_left(self, now: float, joke_ready: bool = False) -> float:
        if joke_ready:
            return 0.0 if self.last_joke is None else max(0.0, self.last_joke + JOKE_GAP_S - now)
        return max(0.0, self.last + self.gap_s - now)

    def due(self, status: dict, now: float, soma_age: float | None, joke_ready: bool = False) -> str | None:
        """The kind of break to play now, or None. `soma_age`: seconds since SomaFM's song began.
        A guest's joke waiting: it goes first, on a 5-minute gap instead of the slider's."""
        if status["source"] == "requests":
            self.last = max(self.last, now)
            return None
        if status["source"] != "soma" or status["queued"]:
            return None
        if joke_ready and self.joke_due(now) and now - self.last_break >= BREAK_SPACING_S:
            return "joke"
        if now < self.last + self.gap_s:
            return None
        lo, hi = BACKANNOUNCE_WINDOW_S
        fresh_song = soma_age is not None and lo <= soma_age <= hi
        for i in range(len(ROTATION)):
            kind = ROTATION[(self.turn + i) % len(ROTATION)]
            if kind != "backannounce" or fresh_song:
                return kind
        return None

    def done(self, now: float, kind: str | None = None) -> None:
        # the next turn follows the kind that actually played, so a skipped back-announce
        # doesn't make the station ID come round twice in a row
        if kind == "joke":   # a joke doesn't take a turn from the station's own rotation
            self.joke_told(now)
            return
        self.turn = (ROTATION.index(kind) if kind in ROTATION else self.turn) + 1
        self.last = now
        self.last_break = now


def library(media: Path) -> dict[str, list[dict]]:
    """media/breaks/index.json → {"id": [...], "goof": [...], "skip": [...]} of {file, seconds, text}."""
    index = media / "breaks" / "index.json"
    if not index.exists():
        return {}
    out: dict[str, list[dict]] = {}
    for e in json.loads(index.read_text()):
        out.setdefault(e["kind"], []).append(e)
    return out


class Rotation:
    """A shuffle bag for clips: only those played the fewest times can play next (at random
    among them), so nothing repeats until every clip has had its turn. Counts are kept on
    disk, so a studio restart doesn't start the rotation over; a new clip starts at 0 and
    so plays first until it has caught up."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        try:
            data = json.loads(path.read_text())
            self.counts = {str(k): int(v) for k, v in data.items()} if isinstance(data, dict) else {}
        except (OSError, ValueError, TypeError):
            self.counts = {}

    def pick(self, clips: list[dict]) -> dict:
        with self.lock:
            low = min(self.counts.get(c["file"], 0) for c in clips)
            return random.choice([c for c in clips if self.counts.get(c["file"], 0) == low])

    def played(self, file: str) -> None:
        with self.lock:
            self.counts[file] = self.counts.get(file, 0) + 1
            try:
                tmp = self.path.with_name(self.path.name + ".tmp")
                tmp.write_text(json.dumps(self.counts))
                tmp.replace(self.path)
            except OSError:
                pass   # the rotation still works in memory

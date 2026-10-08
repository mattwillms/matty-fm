"""When the DJ speaks between requests: every N minutes (the admin slider, 5 to 30, default 10), over SomaFM only.

Kinds rotate: a back-announce of the SomaFM song that just started (voiced fresh),
a station ID, a goof (both pre-made clips with sound effects). A request on air
pushes the next break out to a full gap after it.
"""

import json
from pathlib import Path

DEFAULT_GAP_S = 10 * 60
MIN_GAP_S, MAX_GAP_S, STEP_S = 5 * 60, 30 * 60, 5 * 60
BACKANNOUNCE_WINDOW_S = (10, 75)   # seconds after a SomaFM song started (its intro)
ROTATION = ("backannounce", "id", "goof")


class Scheduler:
    """No randomness: the admin page shows a countdown, so the break must land when it says."""

    def __init__(self, gap_s: float = DEFAULT_GAP_S, now: float = 0.0):
        self.gap_s = DEFAULT_GAP_S
        self.set_gap(gap_s)
        self.last = now          # the last break, or the last moment a request was on air
        self.turn = 0

    def set_gap(self, gap_s: float) -> None:
        stepped = round(gap_s / STEP_S) * STEP_S
        self.gap_s = min(MAX_GAP_S, max(MIN_GAP_S, stepped))

    @property
    def next_due(self) -> float:
        return self.last + self.gap_s

    def seconds_left(self, now: float) -> float:
        return max(0.0, self.next_due - now)

    def due(self, status: dict, now: float, soma_age: float | None) -> str | None:
        """The kind of break to play now, or None. `soma_age`: seconds since SomaFM's song began."""
        if status["source"] == "requests":
            self.last = max(self.last, now)
            return None
        if now < self.next_due or status["source"] != "soma" or status["queued"]:
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
        self.turn = (ROTATION.index(kind) if kind in ROTATION else self.turn) + 1
        self.last = now


def library(media: Path) -> dict[str, list[dict]]:
    """media/breaks/index.json → {"id": [...], "goof": [...], "skip": [...]} of {file, seconds, text}."""
    index = media / "breaks" / "index.json"
    if not index.exists():
        return {}
    out: dict[str, list[dict]] = {}
    for e in json.loads(index.read_text()):
        out.setdefault(e["kind"], []).append(e)
    return out

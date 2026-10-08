"""When the DJ speaks between requests: at least 20 minutes apart, over SomaFM only.

Kinds rotate: a back-announce of the SomaFM song that just started (voiced fresh),
a station ID, a goof (both pre-made clips with sound effects). A request on air
pushes the next break out to a full gap after it.
"""

import json
import random
from pathlib import Path

MIN_GAP_S = 20 * 60
MAX_GAP_S = 28 * 60
BACKANNOUNCE_WINDOW_S = (10, 75)   # seconds after a SomaFM song started (its intro)
ROTATION = ("backannounce", "id", "goof")


class Scheduler:
    def __init__(self, rng: random.Random | None = None, now: float = 0.0):
        self.rng = rng or random.Random()
        self.next_due = now + self.rng.uniform(MIN_GAP_S, MAX_GAP_S)
        self.turn = 0

    def due(self, status: dict, now: float, soma_age: float | None) -> str | None:
        """The kind of break to play now, or None. `soma_age`: seconds since SomaFM's song began."""
        if status["source"] == "requests":
            self.next_due = max(self.next_due, now + MIN_GAP_S)
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

    def done(self, now: float) -> None:
        self.turn += 1
        self.next_due = now + self.rng.uniform(MIN_GAP_S, MAX_GAP_S)


def library(media: Path) -> dict[str, list[dict]]:
    """media/breaks/index.json → {"id": [...], "goof": [...], "skip": [...]} of {file, seconds, text}."""
    index = media / "breaks" / "index.json"
    if not index.exists():
        return {}
    out: dict[str, list[dict]] = {}
    for e in json.loads(index.read_text()):
        out.setdefault(e["kind"], []).append(e)
    return out

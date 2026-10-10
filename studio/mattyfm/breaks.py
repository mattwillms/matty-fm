"""When the DJ speaks over SomaFM (request intros are read with their songs, elsewhere).

Three clocks:
- bumpers: every N minutes (the admin slider, 5 to 30, default 10), held at zero while a
  request is on air, so the first one comes a full gap after the requests end;
- guests' jokes: one every 5 minutes, on their own clock (a joke never moves the bumper clock,
  so station IDs keep coming on a busy joke night); a regular announcement doesn't wait for that
  clock: it goes at the next song change (party test: "group photo now" aired 39 minutes late);
- spacing: nobody talks within a minute of the last thing said.

Like a real DJ, a due break waits for the next SomaFM song to start and talks over its
intro (a joke waits at most a minute for that, a bumper two and a half), then goes anyway.
When requests hand back to SomaFM the DJ says so ("that was ..., back to ...") unless a
skip stinger just covered it.

Kinds rotate: a back-announce of the song that just started (written fresh, so half the
turns), a station ID, a goof (both pre-made clips with sound effects).
"""

import json
import random
import threading
from pathlib import Path

DEFAULT_GAP_S = 10 * 60
MIN_GAP_S, MAX_GAP_S, STEP_S = 5 * 60, 30 * 60, 5 * 60
BACKANNOUNCE_WINDOW_S = (10, 75)   # seconds after a SomaFM song started (its intro)
ROTATION = ("backannounce", "id", "backannounce", "goof")
JOKE_GAP_S = 5 * 60   # guests' jokes: one every 5 minutes (their own clock; requests don't delay it)
BREAK_SPACING_S = 60  # never talk right on top of the last thing said
JOKE_HOLD_S = 60      # a due joke waits this long for a SomaFM song change, then goes anyway
BUMPER_HOLD_S = 150   # the same for a bumper
RETURN_WINDOW_S = (8, 45)   # after requests hand back to SomaFM: when the "back to the feed" line may go
SKIP_COVERS_S = 30    # a skip stinger this recent already said it: no "back to" line


class Scheduler:
    """No randomness: the admin page shows a countdown, so the break must land when it says."""

    def __init__(self, gap_s: float = DEFAULT_GAP_S, now: float = 0.0):
        self.gap_s = DEFAULT_GAP_S
        self.set_gap(gap_s)
        self.last = now          # the last bumper, or the last moment a request was on air
        self.last_break = -1e9   # the last time the DJ talked (any break, or a request on air)
        self.last_joke = None    # the last guest joke told
        self.joke_waits = None   # since when a due joke has waited for a song change
        self.turn = 0
        self.on_requests = False
        self.back_at = None      # when requests handed back to SomaFM (the "back to" line is owed)
        self.skip_at = -1e9

    def set_gap(self, gap_s: float) -> None:
        stepped = round(gap_s / STEP_S) * STEP_S
        self.gap_s = min(MAX_GAP_S, max(MIN_GAP_S, stepped))

    def joke_due(self, now: float) -> bool:
        """A joke may go now: none told yet, or 5 minutes since the last. Played at the next song
        change (in front of a request's intro) or over SomaFM, whichever comes first."""
        return self.last_joke is None or now - self.last_joke >= JOKE_GAP_S

    def joke_told(self, now: float) -> None:
        self.last_joke = now
        self.last_break = max(self.last_break, now)
        self.joke_waits = None

    def skipped(self, now: float) -> None:
        self.skip_at = now

    def seconds_left(self, now: float, joke_ready: bool = False) -> float:
        if joke_ready:
            return 0.0 if self.last_joke is None else max(0.0, self.last_joke + JOKE_GAP_S - now)
        return max(0.0, self.last + self.gap_s - now)

    def holding(self, now: float) -> bool:
        """A bumper is due and waits for the next SomaFM song to start (shown on the admin page)."""
        return not self.on_requests and now >= self.last + self.gap_s

    def due(self, status: dict, now: float, soma_age: float | None, joke_ready: bool = False,
            announce: bool = False) -> str | None:
        """The kind of break to play now, or None. `soma_age`: seconds since SomaFM's song began
        (None: unknown, so nothing waits for a song change)."""
        if status["source"] == "requests":
            self.last = max(self.last, now)
            self.last_break = max(self.last_break, now)
            self.on_requests = True
            return None
        if status["source"] != "soma":
            return None
        if self.on_requests:   # requests just handed back to SomaFM
            self.on_requests = False
            self.back_at = None if now - self.skip_at < SKIP_COVERS_S else now
        if status["queued"]:
            return None
        if self.back_at is not None:
            waited = now - self.back_at
            if waited > RETURN_WINDOW_S[1]:
                self.back_at = None
            elif waited >= RETURN_WINDOW_S[0]:
                self.back_at = None
                return "return"
            else:
                return None
        if now - self.last_break < BREAK_SPACING_S:
            return None
        lo, hi = BACKANNOUNCE_WINDOW_S
        fresh_song = soma_age is None or lo <= soma_age <= hi
        if joke_ready and (announce or self.joke_due(now)):
            if self.joke_waits is None:
                self.joke_waits = now
            if fresh_song or soma_age is None or now - self.joke_waits >= JOKE_HOLD_S:
                return "joke"
        due_at = self.last + self.gap_s
        if now < due_at:
            return None
        if not fresh_song and now - due_at < BUMPER_HOLD_S:
            return None   # waits for the next song's intro
        fresh = soma_age is not None and lo <= soma_age <= hi
        for i in range(len(ROTATION)):
            kind = ROTATION[(self.turn + i) % len(ROTATION)]
            if kind != "backannounce" or fresh:
                return kind
        return None

    def done(self, now: float, kind: str | None = None) -> None:
        if kind == "joke":   # a joke doesn't take a turn from the station's own rotation, or move its clock
            self.joke_told(now)
            return
        self.last = now
        self.last_break = now
        if kind == "return":   # the "back to" line counts as talk, not as a turn
            return
        # the next turn follows the kind that actually played, so a skipped back-announce
        # doesn't make the station ID come round twice in a row
        self.turn = (ROTATION.index(kind) if kind in ROTATION else self.turn) + 1


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
        except (OSError, ValueError, TypeError, OverflowError):
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

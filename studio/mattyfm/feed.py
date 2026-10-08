"""Decide what to tell Liquidsoap on each beat. Pure, so it is easy to test."""

def wants_next(status: dict) -> bool:
    """The console holds one queued song: hand the next over as soon as there is room,
    so a skip or a song's end can go straight into it."""
    return status["queued"] == 0


SILENCE = {"source": "silence", "current": "", "remaining": -1.0, "queued": 0}


def station_status(station) -> tuple[dict, str]:
    """The console's status, or silence plus the reason when it can't be reached. The studio
    keeps beating either way, so the Worker never thinks the studio itself is gone."""
    try:
        return station.status(), ""
    except Exception as e:   # httpx errors (ConnectError, timeouts) are not OSError
        return dict(SILENCE), f"station unreachable: {type(e).__name__}: {e}"[:200]


def decide(status: dict, reply: dict) -> list[tuple]:
    kinds = {c["type"] for c in reply.get("commands", [])}
    # clear before skip (a skip must never land on a song being cleared), and one skip however many were sent
    actions: list[tuple] = [(k,) for k in ("clear", "skip") if k in kinds]
    if reply["settings"]["somaOnly"]:
        if status["source"] == "requests" and ("skip",) not in actions:
            actions.append(("skip",))
        return actions
    if any(a == ("clear",) for a in actions):
        return actions  # re-evaluate on the next beat with an empty Liquidsoap queue
    nxt = reply.get("next")
    if nxt and wants_next(status):
        actions.append(("push", nxt))
    return actions

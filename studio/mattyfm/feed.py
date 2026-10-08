"""Decide what to tell Liquidsoap on each beat. Pure, so it is easy to test."""

PUSH_WINDOW_S = 30.0


def wants_next(status: dict) -> bool:
    """True when the station has room for the next song right now (idle, or the last 30 s)."""
    idle = status["source"] != "requests"
    ending = 0 <= status["remaining"] <= PUSH_WINDOW_S
    return status["queued"] == 0 and (idle or ending)


def decide(status: dict, reply: dict) -> list[tuple]:
    actions: list[tuple] = [(c["type"],) for c in reply.get("commands", []) if c["type"] in ("skip", "clear")]
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

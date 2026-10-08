"""Decide what to tell Liquidsoap on each beat. Pure, so it is easy to test."""

def wants_next(status: dict) -> bool:
    """The console holds one queued song: hand the next over as soon as there is room,
    so a skip or a song's end can go straight into it."""
    return status["queued"] == 0


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

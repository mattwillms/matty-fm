"""Decide what to tell Liquidsoap on each beat. Pure, so it is easy to test."""

PUSH_WINDOW_S = 30.0


def decide(status: dict, reply: dict) -> list[tuple]:
    actions: list[tuple] = [(c["type"],) for c in reply.get("commands", []) if c["type"] in ("skip", "clear")]
    if reply["settings"]["somaOnly"]:
        if status["source"] == "requests" and ("skip",) not in actions:
            actions.append(("skip",))
        return actions
    if any(a == ("clear",) for a in actions):
        return actions  # re-evaluate on the next beat with an empty Liquidsoap queue
    nxt = reply.get("next")
    idle = status["source"] != "requests"
    ending = 0 <= status["remaining"] <= PUSH_WINDOW_S
    if nxt and status["queued"] == 0 and (idle or ending):
        actions.append(("push", nxt))
    return actions

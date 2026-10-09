"""Sum up a party_sim run: tools/party_report.py OUT_DIR  ->  OUT_DIR/summary.json (and prints it)."""

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path


def rows(p: Path):
    return [json.loads(ln) for ln in p.open()] if p.exists() else []


def main(out: Path):
    g, c = rows(out / "guests.jsonl"), rows(out / "credits.jsonl")
    m = sorted(rows(out / "monitor.jsonl") + rows(out / "monitor2.jsonl"), key=lambda r: r["t"])
    t0, t1 = m[0]["t"], m[-1]["t"]
    s = {"hours": round((t1 - t0) / 3600, 2)}

    calls = [r for r in g if r.get("call", "").startswith(("GET", "POST"))]
    s["calls"] = len(calls)
    s["by_call_status"] = Counter(f'{r["call"]} {r["status"]}' for r in calls).most_common()
    errs = Counter()
    for r in calls:
        e = (r.get("resp") or {}).get("error") if isinstance(r.get("resp"), dict) else None
        if e:
            errs[f'{r["persona"]}: {e}'] += 1
    s["guest_errors"] = errs.most_common()
    s["server_errors"] = [r for r in calls if r["status"] >= 500 or r["status"] == 0]
    s["slow_calls"] = sorted((r for r in calls if r["ms"] > 3000), key=lambda r: -r["ms"])[:15]
    s["crashes"] = [r for r in g if r.get("call") == "GUEST CRASH"]
    ok = Counter(r["persona"] for r in calls if r["call"] == "POST /api/request" and (r.get("resp") or {}).get("ok"))
    s["requests_accepted_by_persona"] = dict(ok)

    # each song's life: first time seen in each status
    life = defaultdict(dict)
    meta = {}
    for r in m:
        if r.get("kind") == "item":
            life[r["id"]].setdefault(r["status"], r["t"])
            meta[r["id"]] = r
    songs = []
    for i, st in life.items():
        r = meta[i]
        first = min(st.values())
        songs.append({"id": i, "song": f'{r["artist"]} - {r["title"]}', "final": r["status"], "error": r.get("error"),
                      "conf": r.get("conf"), "match": r.get("match"),
                      "wait_to_air_min": round((st["playing"] - first) / 60, 1) if "playing" in st else None,
                      "prep_min": round((st.get("ready", st.get("queued", first)) - first) / 60, 1)})
    s["songs"] = len(songs)
    s["songs_by_final"] = Counter(x["final"] for x in songs)
    aired = [x["wait_to_air_min"] for x in songs if x["wait_to_air_min"] is not None]
    if aired:
        aired.sort()
        s["wait_to_air_min"] = {"median": aired[len(aired) // 2], "max": aired[-1], "n": len(aired)}
    s["failed_songs"] = [x for x in songs if x["final"] in ("failed",) or x["error"]]
    s["low_confidence"] = [x for x in songs if x["conf"] is not None and x["conf"] < 70]

    # pauses: the Pi on "silence" (studio can't reach it) or nothing on air
    ticks = [r for r in m if r.get("kind") == "tick"]
    gaps, start = [], None
    for r in ticks:
        bad = r.get("source") in ("silence", None, "off")
        if bad and start is None:
            start = r
        elif not bad and start is not None:
            gaps.append({"from": start["t"], "secs": round(r["t"] - start["t"]), "source": start.get("source")})
            start = None
    s["pauses"] = gaps
    s["max_waiting"] = max((r.get("waiting") or 0) for r in ticks) if ticks else 0
    s["source_share"] = Counter(r.get("source") for r in ticks)
    s["stale_beats"] = [r for r in ticks if (r.get("ageS") or 0) > 30][:20]

    s["dj_scripts"] = [{"t": r["t"], "kind": r.get("hkind") or r.get("type"),
                        "text": r.get("text") or r.get("djLine")} for r in m if r.get("kind") == "history"]
    s["jokes"] = Counter(f'{r.get("jkind")}:{r["status"]}' for r in m if r.get("kind") == "joke")
    s["credits"] = [c[0], c[-1]] if c else []
    s["monitor_errors"] = [r for r in m if r.get("kind") == "monitor-error"]
    (out / "summary.json").write_text(json.dumps(s, indent=1, ensure_ascii=False, default=str))
    print(json.dumps({k: v for k, v in s.items() if k not in ("dj_scripts",)}, indent=1, ensure_ascii=False, default=str)[:20000])


if __name__ == "__main__":
    main(Path(sys.argv[1]))

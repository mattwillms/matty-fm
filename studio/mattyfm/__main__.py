"""Studio main loop: one beat every 3 s; preparation runs in a 2-thread pool."""

import json
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import anthropic
import httpx

from . import config, feed, mix, prepare, somafm, sources, tts
from .pilink import PiLink
from .worker_api import WorkerAPI

BEAT_S = 3.0
WORKERS = 2
log = logging.getLogger("mattyfm")


def write_backup_index(media) -> None:
    """backup/index.json lists the offline playlist (with lengths) for the Pi console."""
    entries = []
    for f in sorted((media / "backup").glob("*.mp3")):
        try:
            entries.append({"url": f"backup/{f.name}", "songS": mix.duration(f)})
        except Exception as e:
            log.warning("backup %s unreadable: %s", f.name, e)
    (media / "backup" / "index.json").write_text(json.dumps(entries))
    log.info("backup index: %d songs", len(entries))


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)   # it logs full request URLs at INFO
    cfg = config.load()
    api = WorkerAPI(cfg.worker_url, cfg.studio_secret)
    station = PiLink(cfg.pi_url, cfg.pi_token)
    write_backup_index(cfg.media_dir)
    yt_key, apify = os.environ.get("YOUTUBE_API_KEY", ""), os.environ.get("APIFY_TOKEN", "")
    if not (yt_key and apify):
        log.error("YOUTUBE_API_KEY / APIFY_TOKEN missing: only cached songs can play")
    deps = prepare.Deps(cfg=cfg, claude=anthropic.Anthropic(max_retries=1), http=httpx.Client(),
                        aura=api.tts, names=tts.load_names(cfg.repo / "studio" / "names.toml"),
                        search=sources.YouTubeSearch(yt_key, httpx.Client(), cfg.media_dir / "cache" / "search.json") if yt_key else None,
                        download=sources.ApifyDownload(apify, httpx.Client()) if apify else None)
    soma_np = somafm.NowPlaying(httpx.Client())
    pool = ThreadPoolExecutor(WORKERS)
    working: set[str] = set()
    lock = threading.Lock()
    pushed: list[str] = []
    done_cmds: set[int] = set()
    last_seen = None   # (source, current, queued) — logged whenever it changes   # executed locally; acked every beat until the Worker drops them
    last_error = ""

    def run_job(item: dict) -> None:
        nonlocal last_error
        try:
            result = prepare.prepare(item, deps)
            api.result(result)
            log.info("%s %s: %s - %s", item["id"], result["status"], item["artist"], item["title"])
        except Exception as e:
            last_error = f"result {item['id']}: {e}"[:200]
            log.exception("job %s", item["id"])
        finally:
            with lock:
                working.discard(item["id"])

    while True:
        started = time.monotonic()
        try:
            try:
                status = station.status()
            except OSError as e:
                status = {"source": "silence", "current": "", "remaining": -1.0, "queued": 0}
                last_error = f"station unreachable: {e}"
            seen = (status["source"], status["current"] if status["source"] == "requests" else "", status["queued"])
            if seen != last_seen:
                log.info("station: source=%s current=%s queued=%s remaining=%.0fs",
                         seen[0], seen[1] or "-", seen[2], status["remaining"])
                last_seen = seen
            with lock:
                body = {**status, "pushed": pushed, "working": sorted(working),
                        "want": WORKERS - len(working), "ack": sorted(done_cmds), "error": last_error,
                        "wantNext": feed.wants_next(status), "soma": soma_np.get()}
            reply = api.beat(body)
            pushed = []
            fresh = [c for c in reply["commands"] if c["id"] not in done_cmds]
            done_cmds = {c["id"] for c in reply["commands"]} | {c["id"] for c in fresh}
            reply = {**reply, "commands": fresh}
            if reply["settings"]["somaOnly"] or reply["settings"]["stopAfterCurrent"]:
                log.debug("settings: %s", reply["settings"])
            for job in reply["jobs"]:
                log.info("job %s claimed: %s - %s (%d requester(s))", job["id"], job["artist"],
                         job["title"], len(job["requesters"]))
                with lock:
                    working.add(job["id"])
                pool.submit(run_job, job)
            for action in feed.decide(status, reply):
                if action[0] == "skip":
                    log.info("command: skip")
                    station.skip()
                elif action[0] == "clear":
                    log.info("command: clear station queue")
                    station.clear()
                elif action[0] == "push":
                    item = action[1]
                    song = cfg.media_dir / "ready" / f"{item['id']}.mp3"
                    voice = cfg.media_dir / "voice" / f"{item['id']}.mp3"
                    station.push({"id": item["id"], "title": item["title"], "artist": item["artist"],
                                  "songS": mix.duration(song),
                                  "voiceS": mix.duration(voice) if voice.exists() else 0.0})
                    pushed.append(item["id"])
                    log.info("pushed %s: %s - %s (station was source=%s remaining=%.0fs)", item["id"],
                             item["artist"], item["title"], status["source"], status["remaining"])
            last_error = ""
        except Exception as e:
            msg = f"{type(e).__name__}: {e}"[:200]
            if msg != last_error:
                log.warning("beat failed: %s", msg)   # logged once per distinct error, not every 3 s
            last_error = msg
        time.sleep(max(0.0, BEAT_S - (time.monotonic() - started)))


if __name__ == "__main__":
    main()

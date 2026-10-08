"""Studio main loop: one beat every 3 s; preparation runs in a 2-thread pool."""

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import anthropic
import httpx

from . import config, feed, prepare, tts
from .station import Station
from .worker_api import WorkerAPI

BEAT_S = 3.0
WORKERS = 2
log = logging.getLogger("mattyfm")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    cfg = config.load()
    api = WorkerAPI(cfg.worker_url, cfg.studio_secret)
    station = Station(cfg.telnet_host, cfg.telnet_port)
    deps = prepare.Deps(cfg=cfg, claude=anthropic.Anthropic(max_retries=1), http=httpx.Client(),
                        aura=api.tts, names=tts.load_names(cfg.repo / "studio" / "names.toml"))
    pool = ThreadPoolExecutor(WORKERS)
    working: set[str] = set()
    lock = threading.Lock()
    pushed: list[str] = []
    done_cmds: set[int] = set()   # executed locally; acked every beat until the Worker drops them
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
            with lock:
                body = {**status, "pushed": pushed, "working": sorted(working),
                        "want": WORKERS - len(working), "ack": sorted(done_cmds), "error": last_error}
            reply = api.beat(body)
            pushed = []
            fresh = [c for c in reply["commands"] if c["id"] not in done_cmds]
            done_cmds = {c["id"] for c in reply["commands"]} | {c["id"] for c in fresh}
            reply = {**reply, "commands": fresh}
            for job in reply["jobs"]:
                with lock:
                    working.add(job["id"])
                pool.submit(run_job, job)
            for action in feed.decide(status, reply):
                if action[0] == "skip":
                    station.skip()
                elif action[0] == "clear":
                    station.clear()
                elif action[0] == "push":
                    item = action[1]
                    station.push(f"{cfg.station_media_dir}/ready/{item['id']}.mp3",
                                 item["id"], item["title"], item["artist"])
                    pushed.append(item["id"])
                    log.info("pushed %s", item["id"])
            last_error = ""
        except Exception as e:
            last_error = f"{type(e).__name__}: {e}"[:200]
            log.warning("beat failed: %s", last_error)
        time.sleep(max(0.0, BEAT_S - (time.monotonic() - started)))


if __name__ == "__main__":
    main()

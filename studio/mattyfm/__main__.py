"""Studio main loop: one beat every 3 s; preparation runs in a 2-thread pool."""

import json
import logging
import os
import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import anthropic
import httpx

from . import breaks, config, djline, feed, mix, prepare, somafm, sources, tts
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
    sched = breaks.Scheduler(now=time.monotonic())
    clips = breaks.library(cfg.media_dir)
    log.info("break clips: %s", {k: len(v) for k, v in clips.items()} or "none (run tools/make_breaks.py)")
    on_break = threading.Event()   # one break at a time
    break_pool = ThreadPoolExecutor(1)   # breaks never take a song-preparation worker

    def run_break(kind: str) -> None:
        try:
            if kind == "backannounce" and soma_np.last:
                line = djline.backannounce(soma_np.prev, soma_np.last, deps.claude)
                stamp = int(time.time())
                raw = cfg.media_dir / "breaks" / f"live-{stamp}.raw.mp3"
                out = cfg.media_dir / "breaks" / f"live-{stamp}.mp3"
                engine = tts.speak(line.script, line.tone, raw, http=deps.http, aura=deps.aura,
                                   assets=cfg.media_dir / "assets", names=deps.names)
                seconds = mix.prepare_voice(raw, out, cfg.sample_rate)
                raw.unlink(missing_ok=True)
                url, text = f"breaks/{out.name}", line.script
                log.info("break back-announce via %s (%.1fs): %s", engine, seconds, text)
            else:
                pool_kind = kind if clips.get(kind) else next((k for k in ("id", "goof") if clips.get(k)), None)
                if not pool_kind:
                    log.warning("break %s skipped: no clips (run tools/make_breaks.py)", kind)
                    return
                clip = random.choice(clips[pool_kind])
                url, seconds, text = f"breaks/{clip['file']}", clip["seconds"], clip["text"]
            if station.voice(url, seconds):
                log.info("break on air (%s): %s", kind, text)
                sched.done(time.monotonic())
            else:
                log.info("break %s declined by the console (busy)", kind)
        except Exception:
            log.exception("break %s failed", kind)
        finally:
            on_break.clear()

    def start_break(kind: str) -> None:
        if not on_break.is_set():
            on_break.set()
            break_pool.submit(run_break, kind)
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
            if any(c["type"] == "break" for c in reply["commands"]):
                log.info("command: play a bumper now")
                start_break(random.choice(["id", "goof"]))
            soma = soma_np.last
            soma_age = time.time() - soma["since"] if soma else None
            kind = sched.due(status, time.monotonic(), soma_age)
            if kind:
                start_break(kind)
            for action in feed.decide(status, reply):
                if action[0] == "skip":
                    log.info("command: skip")
                    skip_clips = clips.get("skip") or []
                    clip = random.choice(skip_clips) if skip_clips else None
                    station.skip(bumper={"url": f"breaks/{clip['file']}", "voiceS": clip["seconds"]} if clip else None)
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

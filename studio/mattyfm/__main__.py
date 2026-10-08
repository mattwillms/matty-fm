"""Studio main loop: one beat every 3 s; preparation runs in a 2-thread pool."""

import json
import logging
import os
import random
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import anthropic
import httpx

from . import breaks, config, djline, feed, mix, prepare, somafm, sources, tts
from .pilink import PiLink
from .worker_api import WorkerAPI

BEAT_S = 3.0
WORKERS = 3   # one slow or stuck request can't hold every slot (cached songs wait behind it otherwise)
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
                        download=sources.downloaders(apify) if apify else None)
    soma_np = somafm.NowPlaying(httpx.Client())
    sched = breaks.Scheduler(now=time.monotonic())
    clips = breaks.library(cfg.media_dir)
    rotation = breaks.Rotation(cfg.media_dir / "breaks" / "plays.json")   # every clip of a kind before any repeats
    log.info("break clips: %s", {k: len(v) for k, v in clips.items()} or "none (run tools/make_breaks.py)")
    on_break = threading.Event()   # one break at a time
    last_dj: dict = {}             # the last thing the DJ said over SomaFM, for the admin page
    break_pool = ThreadPoolExecutor(1)   # breaks never take a song-preparation worker

    def run_break(kind: str, soma_only: bool) -> None:
        try:
            if kind == "joke":   # a guest's joke, written up and recorded when it came in
                joke = dict(next_joke or {})
                if not joke:
                    return
                path = cfg.media_dir / "breaks" / str(joke.get("file", ""))
                if not path.is_file():   # its recording is gone: let it go rather than stall every break
                    log.warning("joke %s has no recording; skipped", joke.get("id"))
                    with lock:
                        jokes_played.append(joke["id"])
                    return
                url, seconds, text = f"breaks/{path.name}", float(joke["seconds"]), joke.get("script", "")
            elif kind == "backannounce" and soma_np.last:
                line = djline.backannounce(soma_np.prev, soma_np.last, deps.claude)
                stamp = int(time.time())
                raw = cfg.media_dir / "breaks" / f"live-{stamp}.raw.mp3"
                out = cfg.media_dir / "breaks" / f"live-{stamp}.mp3"
                engine = tts.speak(line.script, line.tone, raw, http=deps.http, aura=deps.aura,
                                   assets=cfg.media_dir / "assets", names=deps.names)
                seconds = mix.prepare_voice(raw, out, cfg.sample_rate)
                raw.unlink(missing_ok=True)
                try:
                    if mix.lengthen_pauses(out):   # +0.5 s on his pause: room for the music to come up
                        seconds = mix.duration(out)
                except Exception:
                    log.warning("pause stretch failed for %s; playing it as made", out.name)
                url, text, path = f"breaks/{out.name}", line.script, out
                log.info("break back-announce via %s (%.1fs): %s", engine, seconds, text)
            else:
                pool_kind = kind if clips.get(kind) else next((k for k in ("id", "goof") if clips.get(k)), None)
                if not pool_kind:
                    log.warning("break %s skipped: no clips (run tools/make_breaks.py)", kind)
                    return
                clip = rotation.pick(clips[pool_kind])
                url, seconds, text = f"breaks/{clip['file']}", clip["seconds"], clip["text"]
                path = cfg.media_dir / "breaks" / clip["file"]
            try:
                speech = mix.speech_segments(path)   # the console ducks the music exactly while he talks
            except Exception:
                speech = []   # it dips over the whole clip instead
            text = djline.display(text)
            if station.voice(url, seconds, soma_only=soma_only, speech=speech):
                log.info("break on air (%s): %s", kind, text)
                if kind == "joke":
                    with lock:
                        jokes_played.append(joke["id"])   # sent with every beat until the Worker has it
                elif not url.startswith("breaks/live-"):   # a fresh back-announce isn't a clip in the rotation
                    rotation.played(url.rsplit("/", 1)[-1])
                last_dj.update({"kind": kind, "text": text, "at": int(time.time() * 1000)})
                sched.done(time.monotonic(), kind)
            else:
                log.info("break %s declined by the console (busy)", kind)
        except Exception:
            log.exception("break %s failed", kind)
        finally:
            on_break.clear()

    def start_break(kind: str, soma_only: bool = True) -> None:
        """Scheduled breaks are soma_only (a back-announce names the SomaFM song); the admin's
        "Play a bumper" plays over whatever is on air."""
        if not on_break.is_set():
            on_break.set()
            break_pool.submit(run_break, kind, soma_only)
    pool = ThreadPoolExecutor(WORKERS)
    working: set[str] = set()
    lock = threading.Lock()
    pushed: list[str] = []
    done_cmds: set[int] = set()
    last_seen = None   # (source, current, queued) — logged whenever it changes   # executed locally; acked every beat until the Worker drops them
    last_error = ""

    unsent: dict[str, dict] = {}   # finished results the Worker hasn't taken yet: re-sent every beat
    joke_working: set[str] = set()   # guests' jokes being written up and recorded
    jokes_played: list[str] = []     # told on air, not yet confirmed by the Worker
    next_joke: dict | None = None    # the oldest recorded joke, from the last beat
    joke_on: dict[str, tuple[str, int]] = {}   # request id -> (joke id, beat it was pushed): told when that song starts
    last_push: dict | None = None    # what the console holds queued (Skip may put a joke in front of it)
    beat_no = 0

    def joke_file(j: dict | None) -> Path | None:
        p = cfg.media_dir / "breaks" / str((j or {}).get("file", ""))
        return p if j and p.is_file() else None

    def run_joke(job: dict) -> None:
        """Write the joke up in the DJ's voice, record it, and hand it back as a ready break."""
        jid = job["id"]
        try:
            line = djline.message_line(job, deps.claude)   # a joke or an announcement
            if not line.ok:
                api.joke_result({"id": jid, "status": "rejected"})
                log.info("joke %s declined by the DJ", jid)
                return
            raw, out = cfg.media_dir / "breaks" / f"joke-{jid}.raw.mp3", cfg.media_dir / "breaks" / f"joke-{jid}.mp3"
            engine = tts.speak(line.script, "funny", raw, http=deps.http, aura=deps.aura,
                               assets=cfg.media_dir / "assets", names=deps.names)
            if engine == "generic":   # no voice could say it: the generic clip is not this joke
                raw.unlink(missing_ok=True)
                api.joke_result({"id": jid, "status": "failed"})
                log.warning("joke %s: no voice could record it", jid)
                return
            seconds = mix.prepare_voice(raw, out, cfg.sample_rate)
            raw.unlink(missing_ok=True)
            try:
                if mix.lengthen_pauses(out):   # the pause before the punchline: +0.5 s
                    seconds = mix.duration(out)
            except Exception:
                log.warning("joke %s pause stretch failed; using it as made", jid)
            api.joke_result({"id": jid, "status": "ready", "file": out.name, "seconds": round(seconds, 2),
                             "script": djline.display(line.script)})
            log.info("joke %s ready via %s (%.1fs): %s", jid, engine, seconds, djline.display(line.script))
        except Exception:
            log.exception("joke %s failed", jid)
            try:
                api.joke_result({"id": jid, "status": "failed"})
            except Exception:
                pass   # its lease lapses and it's tried again
        finally:
            with lock:
                joke_working.discard(jid)

    def run_job(item: dict) -> None:
        nonlocal last_error
        result = None
        try:
            result = prepare.prepare(item, deps)
            api.result(result)
            log.info("%s %s: %s - %s", item["id"], result["status"], item["artist"], item["title"])
        except Exception as e:
            last_error = f"result {item['id']}: {type(e).__name__}"[:200]
            log.exception("job %s", item["id"])
            if result is not None:   # the work is done, only the post failed: keep it, and its lease
                with lock:
                    unsent[item["id"]] = result
                return
        with lock:
            working.discard(item["id"])

    def resend() -> None:
        """Results whose post failed (the Worker blinked): until now they were dropped, the lease ran
        out, and the whole song was prepared again, about 2 minutes later."""
        with lock:
            todo = list(unsent.items())
        for rid, result in todo:
            try:
                api.result(result)
            except Exception as e:
                tries = result.get("_tries", 0) + 1
                result["_tries"] = tries
                log.warning("result %s still not delivered (try %d): %s", rid, tries, type(e).__name__)
                if tries < 20:
                    return   # still unwell: next beat
                log.error("result %s given up after %d tries: its lease lapses and it's prepared again", rid, tries)
            log.info("%s %s delivered late", rid, result["status"])
            with lock:
                unsent.pop(rid, None)
                working.discard(rid)

    while True:
        started = time.monotonic()
        try:
            status, unreachable = feed.station_status(station)
            if unreachable:
                last_error = unreachable
            seen = (status["source"], status["current"] if status["source"] == "requests" else "", status["queued"])
            if seen != last_seen:
                log.info("station: source=%s current=%s queued=%s remaining=%.0fs",
                         seen[0], seen[1] or "-", seen[2], status["remaining"])
                last_seen = seen
            with lock:
                body = {**status, "pushed": pushed, "working": sorted(working | joke_working),
                        "want": WORKERS - len(working), "ack": sorted(done_cmds), "error": last_error,
                        "wantJokes": 0 if joke_working else 1, "jokesPlayed": list(jokes_played),
                        "wantNext": feed.wants_next(status), "soma": soma_np.get(),
                        "lastDj": dict(last_dj) or None,
                        "nextBreakS": round(sched.seconds_left(time.monotonic(), joke_ready=bool(next_joke))),
                        "cached": sorted(p.stem for p in (cfg.media_dir / "cache").glob("*.mp3"))}
            reply = api.beat(body)
            beat_no += 1
            pushed = []
            # a joke rode in front of a request's intro: told once that song is on air; dropped if the
            # console no longer holds the song (cleared or re-handed: the next push decides afresh)
            for rid, (jid, at) in list(joke_on.items()):
                if status["source"] == "requests" and status["current"] == rid:
                    with lock:
                        jokes_played.append(jid)
                    sched.joke_told(time.monotonic())
                    del joke_on[rid]
                    log.info("joke %s told in front of %s", jid, rid)
                elif beat_no - at >= 2 and not status["queued"] and status["current"] != rid:
                    del joke_on[rid]
            with lock:   # the Worker has these now (marking played twice is harmless)
                del jokes_played[:len(body["jokesPlayed"])]
            next_joke = reply.get("nextJoke")
            for j in reply.get("jokeJobs") or []:
                log.info("joke %s claimed from %s", j["id"], j["name"])
                with lock:
                    joke_working.add(j["id"])
                pool.submit(run_joke, j)
            resend()
            fresh = [c for c in reply["commands"] if c["id"] not in done_cmds]
            done_cmds = {c["id"] for c in reply["commands"]} | {c["id"] for c in fresh}
            reply = {**reply, "commands": fresh}
            sched.set_gap(60 * reply["settings"].get("breakEveryMin", 10))
            if reply["settings"]["somaOnly"] or reply["settings"]["stopAfterCurrent"]:
                log.debug("settings: %s", reply["settings"])
            for job in reply["jobs"]:
                log.info("job %s claimed: %s - %s (%d requester(s))", job["id"], job["artist"],
                         job["title"], len(job["requesters"]))
                with lock:
                    working.add(job["id"])
                pool.submit(run_job, job)
            for c in reply["commands"]:
                pad = re.fullmatch(r"pad([1-5])", c["type"])
                if pad:   # a sound pad from the admin page: straight to the console's fx channel
                    log.info("command: pad %s", pad[1])
                    try:
                        station.fx(f"breaks/pad-{pad[1]}.mp3")
                    except Exception as e:
                        log.warning("pad %s failed: %s", pad[1], e)
            for c in reply["commands"]:
                if c["type"] == "replay":   # the admin's Replay on the DJ read
                    try:
                        played = feed.replay_dj(station, cfg.media_dir, c.get("target"), mix.duration, mix.speech_segments)
                        log.info("command: replay DJ read of %s: %s", c.get("target"), "on air" if played else "declined")
                    except Exception as e:
                        log.warning("replay of %s failed: %s", c.get("target"), e)
            if any(c["type"] == "break" for c in reply["commands"]):
                log.info("command: play a bumper now")
                start_break(random.choice(["id", "goof"]), soma_only=False)
            soma = soma_np.last
            soma_age = time.time() - soma["since"] if soma else None
            kind = sched.due(status, time.monotonic(), soma_age, joke_ready=bool(next_joke))
            if next_joke and next_joke.get("urgent") and joke_file(next_joke):
                # urgent (and every host announcement): read now, over whatever is on air; the console
                # declines near a song's end, so it's tried again each beat until it's on
                start_break("joke", soma_only=False)
            elif kind:
                start_break(kind)
            for action in feed.decide(status, reply):
                if action[0] == "skip":
                    log.info("command: skip")
                    skip_clips = clips.get("skip") or []
                    clip = rotation.pick(skip_clips) if skip_clips else None
                    jf = joke_file(next_joke) if next_joke and next_joke["id"] not in [j for j, _ in joke_on.values()] else None
                    if jf and status["queued"] and last_push:   # a joke waiting: told in front of the song skipped to
                        voice_s = feed.attach_joke(cfg.media_dir, last_push["id"], jf)
                        station.push({**last_push, "voiceS": voice_s})
                        joke_on[last_push["id"]] = (next_joke["id"], beat_no)
                        station.skip()
                        log.info("skip: joke %s in front of %s", next_joke["id"], last_push["id"])
                    elif jf:                                      # back to SomaFM: the joke is the skip bumper
                        station.skip(bumper={"url": f"breaks/{jf.name}", "voiceS": float(next_joke["seconds"])})
                        with lock:
                            jokes_played.append(next_joke["id"])
                        sched.joke_told(time.monotonic())
                        log.info("skip: joke %s as the bumper", next_joke["id"])
                    else:
                        if clip:
                            rotation.played(clip["file"])
                        station.skip(bumper={"url": f"breaks/{clip['file']}", "voiceS": clip["seconds"]} if clip else None)
                elif action[0] == "clear":
                    log.info("command: clear station queue")
                    station.clear()
                elif action[0] == "push":
                    item = action[1]
                    song = cfg.media_dir / "ready" / f"{item['id']}.mp3"
                    voice = cfg.media_dir / "voice" / f"{item['id']}.mp3"
                    try:
                        song_s = mix.duration(song)
                        jf = joke_file(next_joke) if next_joke and not next_joke.get("urgent") else None   # urgent goes as a break
                        told_elsewhere = next_joke and any(j == next_joke["id"] and r != item["id"] for r, (j, _) in joke_on.items())
                        has_message = any(r.get("message") for r in item.get("requesters") or [])
                        if voice.exists() and jf and not told_elsewhere and not has_message:
                            # no shout-out to read: the joke stands in for the intro (no 5-minute wait: it replaces talk)
                            voice_s = feed.attach_joke(cfg.media_dir, item["id"], jf, replace=True)
                            joke_on[item["id"]] = (next_joke["id"], beat_no)
                            log.info("joke %s stands in for %s's intro", next_joke["id"], item["id"])
                        elif voice.exists() and jf and not told_elsewhere and sched.joke_due(time.monotonic()):
                            voice_s = feed.attach_joke(cfg.media_dir, item["id"], jf)   # joke, then the shout-out
                            joke_on[item["id"]] = (next_joke["id"], beat_no)
                            log.info("joke %s rides in front of %s", next_joke["id"], item["id"])
                        elif voice.exists():
                            joke_on.pop(item["id"], None)
                            voice_s = feed.detach_joke(cfg.media_dir, item["id"])   # just its own intro
                        else:
                            voice_s = 0.0
                    except Exception as e:   # a missing or broken file: fail this one, never block the line behind it
                        log.warning("push %s failed, marking it failed: %s", item["id"], e)
                        api.result({"id": item["id"], "status": "failed", "error": f"Song file unreadable: {e}"[:300]})
                        continue
                    last_push = {"id": item["id"], "title": item["title"], "artist": item["artist"],
                                 "songS": song_s, "voiceS": voice_s}
                    station.push(last_push)
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

#!/usr/bin/env python3
"""The OrrFM console on the Pi: SomaFM, two song decks and a DJ channel, mixed here.

Channels (each an ALSA softvol control into dmix on the USB card):
  soma  SomaVol   SomaFM, streamed live (the Pi is an ordinary listener)
  deckA DeckAVol  requested songs (and backup songs), alternating with deckB
  deckB DeckBVol
  dj    DjVol     the DJ voice, always at full level
  fx    FxVol     sound pads from the admin page: over everything, nothing ducks

One transition rule for every change (SomaFM->song, song->song, song->SomaFM,
skips), with NO overlap between outgoing and incoming: the outgoing fades to
silence over DOWN_S; the DJ starts LEAD_PAD_S after the fade begins; after a
GAP_S beat of silence the incoming starts and fades up while the DJ is still
talking, landing at full volume as the voice ends. A song's next transition
starts DOWN_S before it ends; with nothing queued the song fades out over its
last OUTRO_S seconds and SomaFM fades back in after the gap.

The studio (workstation) drives this over a token-protected HTTP API:
  GET /status  POST /push {id,title,artist,songS,voiceS}  POST /skip  POST /clear  POST /fx {url}
Song and voice files come from the workstation's file server.

Config: /etc/mattyfm.conf — CARD, FILES_URL, SOMA_URLS, TOKEN, PORT.
Logs: journalctl -u mattyfm-pi (every push, transition, level ramp, stall, exit).
"""

import fcntl
import json
import random
import re
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LEAD_PAD_S = 0.5        # the voice starts this long after the outgoing begins fading down
DOWN_S = 1.5            # outgoing fades to silence over this
GAP_S = 0.4             # a beat of silence (only the DJ) before the incoming starts
MIN_UP_S = 1.0          # incoming never jumps up faster than this
PLAIN_UP_S = 1.5        # incoming fade without a voice
PLAIN_FADE_S = DOWN_S   # kept for skips
OUTRO_S = 3.0           # song -> SomaFM: the song fades out over its last seconds
SOMA_UP_S = 2.0
DUCK_PCT = 55           # voice breaks: the on-air channel dips to this (softvol %, ~-27 dB)
DUCK_S = 0.5            # dip over this, then the DJ starts
RESTORE_S = 1.0         # back to full over this after the DJ ends
DEAD_AFTER_S = 1.0      # a deck that stopped this long after starting is treated as ended
TICK_S = 0.1
SOMA_STALL_S = 4.0
CHUNK = 4096
PIPE_BYTES = 4096
F_SETPIPE_SZ = 1031
USER_AGENT = "OrrFM-Pi/1.0 (personal listener; mpg123)"
CONTROLS = {"soma": "SomaVol", "deckA": "DeckAVol", "deckB": "DeckBVol", "dj": "DjVol"}
DECKS = ("deckA", "deckB")


def log(msg: str) -> None:
    print(msg, flush=True)


# ---------- pure helpers ----------

def level_at(t: float, start: int, end: int, dur: float) -> int:
    """Linear ramp from start to end over dur seconds, evaluated at elapsed time t."""
    if dur <= 0 or t >= dur:
        return end
    return round(start + (end - start) * max(t, 0) / dur)


def threads_healthy(threads: list) -> bool:
    return all(t.is_alive() for t in threads)


class FlowHealth:
    """Up while bytes keep arriving; down after `stall_s` without any."""

    def __init__(self, stall_s: float = SOMA_STALL_S):
        self.stall_s = stall_s
        self.last = None

    def saw_bytes(self, now: float | None = None) -> None:
        self.last = time.monotonic() if now is None else now

    def reset(self) -> None:
        self.last = None

    def up(self, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        return self.last is not None and now - self.last < self.stall_s


# ---------- the engine (pure logic; players, mixer and clock are injected) ----------

class Engine:
    def __init__(self, files_url: str, clock, players, mixer, log=log):
        self.files = files_url.rstrip("/")
        self.clock, self.players, self.mixer, self.log = clock, players, mixer, log
        self.lock = threading.RLock()
        self.on_air: tuple[str, dict | None] = ("soma", None)
        self.queued: dict | None = None
        self.ramps: list[tuple[str, int, int, float, float]] = []   # control, start, end, t0, dur
        self.started_at: dict[str, float] = {}
        self.pending_dj: tuple[str, float] | None = None
        self.pending_play: tuple[str, str, float] | None = None
        self.pending_break: tuple[str, float] | None = None
        self.pending_stop: list[tuple[str, float]] = []
        self.transition_until = 0.0
        self.backup: list = []
        self.backup_i = 0

    def soma_up(self) -> bool:   # replaced at runtime by the SomaFM reader's health
        return True

    # ----- commands from the studio -----
    def push(self, item: dict) -> None:
        with self.lock:
            self.queued = item
            self.log(f"push {item['id']}: {item.get('artist')} - {item.get('title')} "
                     f"(song {item.get('songS', 0):.0f}s, voice {item.get('voiceS', 0):.1f}s)")

    def clear(self) -> None:
        with self.lock:
            if self.queued:
                self.log(f"clear {self.queued['id']}")
            self.queued = None

    def skip(self, bumper: tuple[str, float] | None = None) -> None:
        """Skip what is on air: straight into the queued request (its own DJ intro covers
        it), or back to SomaFM with the skip bumper over the fade."""
        with self.lock:
            ch, it = self.on_air
            if ch == "soma":
                self.log("skip ignored: nothing but SomaFM on air")
                return
            self.log(f"skip {it['id'] if it else ch}" + (" with bumper" if bumper else ""))
            if self.queued:
                self._to_request()
            elif bumper and self.soma_up():
                self._transition("soma", None, bumper[0], bumper[1], down_s=PLAIN_FADE_S, up_s=SOMA_UP_S)
            else:
                self._to_soma(PLAIN_FADE_S)

    def voice_break(self, url: str, voice_s: float) -> bool:
        """DJ over whatever is on air (SomaFM, a request, a backup song): dip, talk, restore.
        During a transition it waits until the transition is done."""
        with self.lock:
            now = self.clock()
            if now < self.transition_until:
                self.pending_break = (url, voice_s)
                self.log(f"voice break waits for the transition ({self.transition_until - now:.1f}s)")
                return True
            ch, it = self.on_air
            control = CONTROLS[ch]
            level = self.mixer.level[control]
            back_at = now + DUCK_S + voice_s
            self.ramps = [r for r in self.ramps if r[0] != control]
            self.ramps.append((control, level, DUCK_PCT, now, DUCK_S))
            self.ramps.append((control, DUCK_PCT, 100, back_at, RESTORE_S))
            self.pending_dj = (url, now + DUCK_S)
            self.transition_until = back_at + RESTORE_S
            self.log(f"voice break on {ch}: {voice_s:.1f}s")
            return True

    def fx(self, url: str) -> None:
        """A sound pad: its own channel, laid over whatever is on air. A new tap replaces the last."""
        with self.lock:
            self.players.play("fx", self.resolve(url))
            self.log(f"pad: {url}")

    def status(self) -> dict:
        with self.lock:
            ch, it = self.on_air
            if ch == "soma":
                source = "soma"
            elif it and it.get("backup"):
                source = "backup"
            else:
                source = "requests"
            remaining = -1.0
            if ch in DECKS and it:
                remaining = max(0.0, it.get("songS", 0) - (self.clock() - self.started_at.get(ch, self.clock())))
            return {"source": source, "current": it["id"] if it and not it.get("backup") else "",
                    "remaining": round(remaining, 1), "queued": 1 if self.queued else 0}

    # ----- transitions -----
    def resolve(self, url: str) -> str:
        """Relative paths (breaks/x.mp3) are on the workstation's file server."""
        return url if url.startswith("http") else f"{self.files}/{url.lstrip('/')}"

    def _url(self, kind: str, item: dict) -> str:
        return item["url"] if kind == "ready" and item.get("url") else f"{self.files}/{kind}/{item['id']}.mp3"

    def _free_deck(self) -> str:
        return "deckB" if self.on_air[0] == "deckA" else "deckA"

    def _transition(self, to_ch: str, to_item: dict | None, voice_url: str | None, voice_s: float,
                    down_s: float = DOWN_S, up_s: float = PLAIN_UP_S) -> None:
        now = self.clock()
        from_ch = self.on_air[0]
        in_start = now + down_s + GAP_S
        in_full = max(now + LEAD_PAD_S + voice_s, in_start + MIN_UP_S) if voice_url else in_start + up_s
        self.ramps = [r for r in self.ramps if r[0] not in (CONTROLS[from_ch], CONTROLS[to_ch])]
        self.ramps.append((CONTROLS[from_ch], self.mixer.level[CONTROLS[from_ch]], 0, now, down_s))
        self.ramps.append((CONTROLS[to_ch], 0, 100, in_start, in_full - in_start))
        self.mixer.set(CONTROLS[to_ch], 0)
        if to_ch in DECKS:
            self.pending_play = (to_ch, self._url("ready", to_item), in_start)
        self.pending_dj = (voice_url, now + LEAD_PAD_S) if voice_url else None
        if from_ch in DECKS:
            self.pending_stop.append((from_ch, now + down_s + 0.2))
        self.on_air = (to_ch, to_item)
        self.transition_until = in_full
        label = to_item["id"] if to_item and not to_item.get("backup") else ("backup" if to_item else "SomaFM")
        self.log(f"transition {from_ch} -> {to_ch} ({label}): down {down_s:.1f}s, gap {GAP_S}s, "
                 f"up {in_full - in_start:.1f}s" + (f", DJ at +{LEAD_PAD_S}s for {voice_s:.1f}s" if voice_url else ""))


    def _to_request(self) -> None:
        item, self.queued = self.queued, None
        voice = self._url("voice", item) if item.get("voiceS") else None
        self._transition(self._free_deck(), item, voice, item.get("voiceS", 0.0))

    def _to_soma(self, fade_s: float) -> None:
        if not self.soma_up() and self.backup:
            self._to_backup()
            return
        self._transition("soma", None, None, 0.0, down_s=fade_s, up_s=SOMA_UP_S)

    def _to_backup(self) -> None:
        entry = self.backup[self.backup_i % len(self.backup)]
        self.backup_i += 1
        url, song_s = (entry, 240.0) if isinstance(entry, str) else (entry["url"], entry.get("songS", 240.0))
        if not url.startswith("http"):
            url = f"{self.files}/{url}"
        self._transition(self._free_deck(), {"id": "backup", "backup": True, "url": url, "songS": song_s},
                         None, 0.0)

    # ----- the clock tick -----
    def tick(self) -> None:
        with self.lock:
            now = self.clock()
            current: dict[str, int] = {}
            for control, start, end, t0, dur in self.ramps:
                if now >= t0 or control not in current:   # a later-starting ramp waits its turn
                    current[control] = level_at(now - t0, start, end, dur)
            for control, lvl in current.items():
                # sent every step: a softvol control created mid-fade must not keep its default
                self.mixer.set(control, lvl)
            self.ramps = [r for r in self.ramps if now - r[3] < r[4]]
            if self.pending_play and now >= self.pending_play[2]:
                ch, url, _ = self.pending_play
                self.players.play(ch, url)
                self.started_at[ch] = now
                self.pending_play = None
            if self.pending_dj and now >= self.pending_dj[1]:
                self.players.play("dj", self.pending_dj[0])
                self.pending_dj = None
            for ch, at in list(self.pending_stop):
                if now >= at:
                    self.pending_stop.remove((ch, at))
                    if self.on_air[0] != ch:
                        self.players.stop(ch)
            if now < self.transition_until:
                return
            if self.pending_break:
                url, secs = self.pending_break
                self.pending_break = None
                self.voice_break(url, secs)
                return
            ch, it = self.on_air
            if ch == "soma":
                if self.queued:
                    self._to_request()
                elif not self.soma_up() and self.backup:
                    self.log("SomaFM down: backup playlist")
                    self._to_backup()
                return
            if self.pending_play and self.pending_play[0] == ch:
                return
            elapsed = now - self.started_at.get(ch, now)
            remaining = it.get("songS", 0) - elapsed
            dead = elapsed > DEAD_AFTER_S and not self.players.running(ch)
            if dead:
                self.log(f"{ch} stopped with {remaining:.0f}s left")
            if it.get("backup"):
                if self.queued:
                    self._to_request()
                elif self.soma_up():
                    self._transition("soma", None, None, 0.0, up_s=SOMA_UP_S)
                elif dead or remaining <= PLAIN_FADE_S:
                    self._to_backup()
                return
            if dead:
                self._to_request() if self.queued else self._to_soma(PLAIN_FADE_S)
            elif self.queued and remaining <= DOWN_S:
                self._to_request()
            elif not self.queued and remaining <= OUTRO_S:
                self._to_soma(OUTRO_S)


# ---------- runtime: players, mixer, SomaFM reader, control API ----------

class Players:
    """One mpg123 per channel, playing a URL to that channel's ALSA device."""

    def __init__(self):
        self.procs: dict[str, subprocess.Popen] = {}

    def play(self, channel: str, url: str) -> None:
        self.stop(channel)
        self.procs[channel] = subprocess.Popen(["mpg123", "-q", "-o", "alsa", "-a", channel, url])

    def stop(self, channel: str) -> None:
        p = self.procs.pop(channel, None)
        if p and p.poll() is None:
            p.kill()
            p.wait()

    def running(self, channel: str) -> bool:
        p = self.procs.get(channel)
        return p is not None and p.poll() is None


class Mixer:
    """Softvol levels in percent, set through one long-lived `amixer -s`."""

    def __init__(self, card: str):
        self.card = card
        self.level = {"SomaVol": 100, "DeckAVol": 0, "DeckBVol": 0, "DjVol": 100}
        self.proc = None

    def set(self, control: str, pct: int) -> None:
        if self.proc is None or self.proc.poll() is not None:
            self.proc = subprocess.Popen(["amixer", "-q", "-c", self.card, "-s"],
                                         stdin=subprocess.PIPE, text=True, bufsize=1)
        self.proc.stdin.write(f"sset {control} {pct}%\n")
        self.proc.stdin.flush()
        self.level[control] = pct


class SomaReader:
    """Streams SomaFM into its decoder; health = bytes arrived recently."""

    def __init__(self, urls: list[str]):
        self.urls, self.health, self.proc = urls, FlowHealth(), None

    def _decoder(self):
        if self.proc is None or self.proc.poll() is not None:
            self.proc = subprocess.Popen(["mpg123", "-q", "-b", "1024", "-o", "alsa", "-a", "soma", "-"],
                                         stdin=subprocess.PIPE)
            try:
                fcntl.fcntl(self.proc.stdin.fileno(), F_SETPIPE_SZ, PIPE_BYTES)
            except OSError:
                pass
        return self.proc

    def run(self) -> None:
        i = 0
        while True:
            url = self.urls[i % len(self.urls)]
            log(f"soma: connecting {url}")
            try:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=SOMA_STALL_S) as r:
                    log(f"soma: connected ({r.status})")
                    while data := r.read(CHUNK):
                        self.health.saw_bytes()
                        dec = self._decoder()
                        dec.stdin.write(data)
                        dec.stdin.flush()
                    log("soma: stream ended")
            except Exception as e:  # stall, DNS, TLS, decoder pipe — never let the thread die
                log(f"soma: {type(e).__name__}: {e}")
            self.health.reset()
            i += 1
            time.sleep(2)


def load_conf(path: str = "/etc/mattyfm.conf") -> dict:
    conf = {}
    with open(path) as f:
        for line in f:
            if "=" in line and not line.startswith("#"):
                k, _, v = line.strip().partition("=")
                conf[k] = v.strip().strip('"')
    return conf


def load_backup(files_url: str) -> list:
    """The workstation publishes backup/index.json: [{"url": ..., "songS": ...}]."""
    try:
        with urllib.request.urlopen(f"{files_url.rstrip('/')}/backup/index.json", timeout=5) as r:
            entries = json.load(r)
        random.shuffle(entries)
        log(f"backup playlist: {len(entries)} songs")
        return entries
    except Exception as e:
        log(f"backup playlist unavailable: {e}")
        return []


def serve(engine: Engine, token: str, port: int) -> None:
    class Handler(BaseHTTPRequestHandler):
        def _reply(self, code: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self) -> bool:
            if self.headers.get("x-token") != token:
                self._reply(401, {"error": "unauthorized"})
                return False
            return True

        def do_GET(self):
            if self._authorized():
                self._reply(200, engine.status()) if self.path == "/status" else self._reply(404, {})

        def do_POST(self):
            if not self._authorized():
                return
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0)) or 0) or b"{}")
            if self.path == "/push":
                engine.push(body)
            elif self.path == "/skip":
                b = body.get("bumper")
                engine.skip((engine.resolve(b["url"]), float(b["voiceS"])) if b else None)
            elif self.path == "/voice":
                if not engine.voice_break(engine.resolve(body["url"]), float(body["voiceS"])):
                    return self._reply(409, {"error": "busy"})
            elif self.path == "/clear":
                engine.clear()
            elif self.path == "/fx":
                engine.fx(body["url"])
            else:
                return self._reply(404, {})
            self._reply(200, engine.status())

        def log_message(self, *args):   # status polls every 3 s: keep the journal readable
            pass

    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


def main(conf_path: str) -> None:
    conf = load_conf(conf_path)
    mixer = Mixer(conf["CARD"])
    players = Players()
    engine = Engine(conf["FILES_URL"], clock=time.monotonic, players=players, mixer=mixer)
    soma = SomaReader(conf["SOMA_URLS"].split())
    engine.soma_up = soma.health.up
    engine.backup = load_backup(conf["FILES_URL"])
    threads = [threading.Thread(target=soma.run, daemon=True, name="soma"),
               threading.Thread(target=serve, args=(engine, conf["TOKEN"], int(conf.get("PORT", "8042"))),
                                daemon=True, name="api")]
    for t in threads:
        t.start()
    # A softvol control exists only once something has played through it, and starts at
    # full volume: open every channel with a moment of silence first, then set levels.
    for ch in [*CONTROLS, "fx"]:
        subprocess.run(["aplay", "-q", "-D", ch, "-f", "cd", "-d", "1", "/dev/zero"], check=False)
    time.sleep(1)
    for control, pct in (("SomaVol", 100), ("DeckAVol", 0), ("DeckBVol", 0), ("DjVol", 100), ("FxVol", 100)):
        mixer.set(control, pct)
    log("console ready: SomaVol 100, DeckAVol 0, DeckBVol 0, DjVol 100, FxVol 100")
    last = time.monotonic()
    while True:
        time.sleep(TICK_S)
        if not threads_healthy(threads):
            log(f"thread(s) died: {[t.name for t in threads if not t.is_alive()]}; exiting for restart")
            sys.exit(1)
        try:
            engine.tick()
        except Exception as e:
            log(f"tick error: {type(e).__name__}: {e}")
        if time.monotonic() - last >= 60:
            last = time.monotonic()
            log(f"status: {engine.status()} soma_up={soma.health.up()} levels={mixer.level}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/etc/mattyfm.conf")

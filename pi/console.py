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
  POST /power {on}: off fades every channel to silence, stops every player and SomaFM's stream
Song and voice files come from the workstation's file server.

Config: /etc/mattyfm.conf — CARD, FILES_URL, SOMA_URLS, TOKEN, PORT.
Logs: journalctl -u mattyfm-pi (every push, transition, level ramp, stall, exit).
"""

import fcntl
import os
import json
import math
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
OFF_FADE_S = 3.0
OFF_MARK = "/run/mattyfm-off"   # present while the station is off: the watchdog leaves a silent card alone        # station off: everything fades to silence over this, then every player stops
DUCK_PCT = 75           # voice breaks: the on-air channel dips to this (softvol %, -60..0 dB: 75 = -15 dB, the music stays faintly under the voice)
DUCK_S = 0.5            # dip over this, then the DJ starts
RESTORE_S = 1.0         # back to full over this after the DJ ends
# Auto-duck, following the speech (segments measured by the studio): down as each word lands,
# back up as soon as he stops. Both paths go through the same dmix buffer, so they stay in step.
DUCK_LEAD_S = 0.1       # look-ahead: start down this far before the word...
DUCK_ATTACK_S = 0.1     # ...and be fully down this fast
DUCK_HOLD_S = 0.2       # after the last word of a phrase, hold this long...
DUCK_RELEASE_S = 0.5    # ...then back up over this
DUCK_MERGE_S = 0.9      # a breath shorter than this keeps the music down (no pumping)
FIRST_FADE_S = 0.4      # the first dip of a break: the music fades down over about half a beat, then he talks
DEAD_AFTER_S = 1.0      # a deck that stopped this long after starting is treated as ended
TICK_S = 0.1
SOMA_STALL_S = 4.0
SOMA_DOWN_S = 6.0       # SomaFM must be gone this long before the backup takes over (a reconnect is ~2 s)
SOMA_BACK_S = 10.0      # and back this long before the backup hands over to it again
SOMA_STEADY_S = 5.0     # a stream that reconnects, bursts and stalls stays "down" until it holds this long
CHUNK = 4096
PIPE_BYTES = 4096
F_SETPIPE_SZ = 1031
USER_AGENT = "OrrFM-Pi/1.0 (personal listener; mpg123)"
CONTROLS = {"soma": "SomaVol", "deckA": "DeckAVol", "deckB": "DeckBVol", "dj": "DjVol"}
DECKS = ("deckA", "deckB")


def seconds(v) -> float:
    """A duration from the studio: a real, finite, non-negative number of seconds, or ValueError."""
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0:
        raise ValueError(f"not a duration: {v!r}")
    return float(v)


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
        self.pending_break: tuple[str, float, object] | None = None   # url, voice seconds, gaps
        self.pending_stop: list[tuple[str, float]] = []
        self.transition_until = 0.0
        self.backup: list = []
        self.backup_i = 0
        self.recent: list[tuple[str, float]] = []   # (id, start time) of the last requests that started, newest last
        self.soma_down_since: float | None = None
        self.soma_up_since: float | None = None
        self.off = False                          # the host switched the station off (SomaFM disconnects too)
        self.on_power = None                      # told True/False when it switches off/on (the watchdog's marker)
        self.stop_all_at: float | None = None     # when the off fade ends and the players stop

    def soma_up(self) -> bool:   # replaced at runtime by the SomaFM reader's health
        return True

    # SomaFM health with hysteresis: a short blip must not cause two transitions
    def _soma_watch(self, now: float) -> None:
        if self.soma_up():
            self.soma_up_since = self.soma_up_since or now
            if now - self.soma_up_since >= SOMA_STEADY_S:   # short bursts don't wipe the outage clock
                self.soma_down_since = None
        else:
            self.soma_up_since, self.soma_down_since = None, self.soma_down_since or now

    def _soma_out(self) -> bool:
        """Down right now, and not properly back since it first dropped SOMA_DOWN_S ago."""
        return (self.soma_down_since is not None and self.soma_up_since is None
                and self.clock() - self.soma_down_since >= SOMA_DOWN_S)

    def _soma_back(self) -> bool:
        return self.soma_up_since is not None and self.clock() - self.soma_up_since >= SOMA_BACK_S

    # ----- commands from the studio -----
    def push(self, item: dict) -> None:
        for k in ("songS", "voiceS"):   # a NaN or a string here would make every tick raise
            seconds(item.get(k, 0.0))
        with self.lock:
            if self.off:
                self.log(f"push {item['id']} ignored: the station is off")
                return
            _, on_air = self.on_air
            starting = self.pending_play and self.pending_play[1].endswith(f"/{item['id']}.mp3")
            if (on_air and on_air.get("id") == item["id"]) or starting:
                # a push that landed late gets re-sent: queueing the song on air would play it twice
                self.log(f"push {item['id']} ignored: it's already on air")
                return
            self.queued = item
            self.log(f"push {item['id']}: {item.get('artist')} - {item.get('title')} "
                     f"(song {item.get('songS', 0):.0f}s, voice {item.get('voiceS', 0):.1f}s)")

    def power(self, on: bool) -> None:
        """Station off: every channel fades to silence, then every player stops (SomaReader sees
        `off` and drops its stream). On: SomaFM fades back in; requests play again."""
        with self.lock:
            now = self.clock()
            if not on and not self.off:
                self.off = True
                self.queued, self.pending_play, self.pending_dj, self.pending_break = None, None, None, None
                self.transition_until = 0.0
                self.ramps = [(c, lvl, 0, now, OFF_FADE_S) for c, lvl in self.mixer.level.items() if lvl > 0]
                self.stop_all_at = now + OFF_FADE_S + 0.2
                self.on_air = ("off", None)
                self.log(f"power off: fading to silence over {OFF_FADE_S:.0f}s")
                if self.on_power:
                    self.on_power(True)
            elif on and self.off:
                self.off, self.stop_all_at, self.ramps = False, None, []
                for c in self.mixer.level:
                    self.mixer.set(c, 0 if c in ("SomaVol", "DeckAVol", "DeckBVol") else 100)
                self.ramps.append(("SomaVol", 0, 100, now + 1.0, SOMA_UP_S))   # a second for the stream to reconnect
                self.on_air = ("soma", None)
                self.soma_down_since = self.soma_up_since = None
                self.transition_until = now + 1.0 + SOMA_UP_S
                self.log("power on: SomaFM back")
                if self.on_power:
                    self.on_power(False)

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
            if ch == "off":
                self.log("skip ignored: the station is off")
                return
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

    def voice_break(self, url: str, voice_s: float, soma_only: bool = False, speech=()) -> bool:
        """DJ over whatever is on air (SomaFM, a request, a backup song): dip, talk, restore.
        During a transition it waits until the transition is done. soma_only (scheduled breaks,
        which may name the SomaFM song): declined unless SomaFM is on air, settled, nothing queued.
        Declined too when a song is too close to its end for the break to finish first."""
        voice_s = seconds(voice_s)
        with self.lock:
            now = self.clock()
            ch, it = self.on_air
            if self.off:
                return False
            if soma_only and (ch != "soma" or self.queued or now < self.transition_until or self.pending_break):
                self.log("voice break declined: not on settled SomaFM")
                return False
            if ch in DECKS and it and not self.pending_play:
                # measured from when it can start: after a transition or a break already on
                left = it.get("songS", 0) - (max(now, self.transition_until) - self.started_at.get(ch, now))
                if left < DUCK_S + voice_s + RESTORE_S + DOWN_S + OUTRO_S:   # room for the song's own fade-out too
                    self.log(f"voice break declined: {left:.0f}s of the song left")
                    return False
            if now < self.transition_until:
                if self.pending_break:   # one already waits: never drop it for this one (the studio retries)
                    self.log("voice break declined: another is already waiting")
                    return False
                self.pending_break = (url, voice_s, speech)
                self.log(f"voice break waits for the transition ({self.transition_until - now:.1f}s)")
                return True
            control = CONTROLS[ch]
            level = self.mixer.level[control]
            self.ramps = [r for r in self.ramps if r[0] != control]
            phrases = self._phrases(speech, voice_s)
            if phrases:   # duck with the speech itself: the music follows his words
                # the first dip is a smooth fade, finished as his first word lands (the clip waits for it)
                delay = max(0.0, FIRST_FADE_S - phrases[0][0])
                t = now + delay
                self.ramps.append((control, level, DUCK_PCT, t + phrases[0][0] - FIRST_FADE_S, FIRST_FADE_S))
                for i, (start, end) in enumerate(phrases):
                    if i:
                        self.ramps.append((control, 100, DUCK_PCT, t + max(0.0, start - DUCK_LEAD_S), DUCK_ATTACK_S))
                    self.ramps.append((control, DUCK_PCT, 100, t + end + DUCK_HOLD_S, DUCK_RELEASE_S))
                self.pending_dj = (url, t)
                self.transition_until = t + phrases[-1][1] + DUCK_HOLD_S + DUCK_RELEASE_S
            else:   # no speech map: dip over the whole clip, as before
                back_at = now + DUCK_S + voice_s
                self.ramps.append((control, level, DUCK_PCT, now, DUCK_S))
                self.ramps.append((control, DUCK_PCT, 100, back_at, RESTORE_S))
                self.pending_dj = (url, now + DUCK_S)
                self.transition_until = back_at + RESTORE_S
            self.log(f"voice break on {ch}: {voice_s:.1f}s")
            return True

    @staticmethod
    def _phrases(speech, voice_s: float) -> list[tuple[float, float]]:
        """Where he's talking (seconds from the clip's start), breaths merged; junk is skipped."""
        out: list[tuple[float, float]] = []
        for seg in speech if isinstance(speech, (list, tuple)) else ():
            try:
                start, end = float(seg[0]), float(seg[1])
            except (TypeError, ValueError, IndexError):
                continue
            if not (0 <= start < end <= voice_s + 0.5) or (out and start < out[-1][0]):
                continue
            if out and start - out[-1][1] < DUCK_MERGE_S:
                out[-1] = (out[-1][0], max(out[-1][1], end))
            else:
                out.append((start, end))
        return out

    def fx(self, url: str) -> None:
        """A sound pad: its own channel, laid over whatever is on air. A new tap replaces the last."""
        with self.lock:
            if self.off:
                return
            self.players.play("fx", self.resolve(url))
            self.log(f"pad: {url}")

    def status(self) -> dict:
        with self.lock:
            ch, it = self.on_air
            if ch == "off":
                source = "off"
            elif ch == "soma":
                source = "soma"
            elif it and it.get("backup"):
                source = "backup"
            else:
                source = "requests"
            remaining = -1.0
            if ch in DECKS and it:
                remaining = max(0.0, it.get("songS", 0) - (self.clock() - self.started_at.get(ch, self.clock())))
            return {"source": source, "current": it["id"] if it and not it.get("backup") else "",
                    "remaining": round(remaining, 1), "queued": 1 if self.queued else 0,
                    "recent": [{"id": i, "agoS": round(self.clock() - t, 1)} for i, t in self.recent]}

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
        elif self.pending_play:   # skipped before it started: never start it at volume 0
            self.pending_play = None
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
        if self._soma_out() and self.backup:
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
            self._soma_watch(now)
            current: dict[str, int] = {}
            for control, start, end, t0, dur in self.ramps:
                if now >= t0 or control not in current:   # a later-starting ramp waits its turn
                    current[control] = level_at(now - t0, start, end, dur)
            for control, lvl in current.items():
                # sent every step: a softvol control created mid-fade must not keep its default
                self.mixer.set(control, lvl)
            self.ramps = [r for r in self.ramps if now - r[3] < r[4]]
            if self.off:   # faded out: stop every player once the fade is done, then nothing more
                if self.stop_all_at is not None and now >= self.stop_all_at:
                    for ch in ("deckA", "deckB", "dj", "fx"):
                        self.players.stop(ch)
                    self.stop_all_at = None
                    self.log("power off: silent, every player stopped")
                return
            if self.pending_play and now >= self.pending_play[2]:
                ch, url, _ = self.pending_play
                self.players.play(ch, url)
                self.started_at[ch] = now
                self.pending_play = None
                it = self.on_air[1]
                if self.on_air[0] == ch and it and not it.get("backup"):
                    # reported in every status: if the studio missed this (it was offline), the
                    # Worker still learns the song played and won't hand it out again
                    self.recent = (self.recent + [(it["id"], now)])[-8:]
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
                url, secs, speech = self.pending_break
                self.pending_break = None
                self.voice_break(url, secs, speech=speech)
                return
            ch, it = self.on_air
            if ch == "soma":
                if self.queued:
                    self._to_request()
                elif self._soma_out() and self.backup:
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
                elif self._soma_back():
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

    def __init__(self, urls: list[str], wanted=lambda: True):
        self.urls, self.health, self.proc = urls, FlowHealth(), None
        self.wanted = wanted   # False while the station is off: no stream, no decoder

    def _quiet(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        self.proc = None

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
            if not self.wanted():   # station off: hold no connection to SomaFM at all
                self._quiet()
                self.health.reset()
                time.sleep(0.5)
                continue
            url = self.urls[i % len(self.urls)]
            log(f"soma: connecting {url}")
            try:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=SOMA_STALL_S) as r:
                    log(f"soma: connected ({r.status})")
                    while data := r.read(CHUNK):
                        if not self.wanted():
                            log("soma: station off, disconnected")
                            break
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
            try:
                length = min(int(self.headers.get("content-length", 0) or 0), 65536)
                body = json.loads(self.rfile.read(length) or b"{}")
                if not isinstance(body, dict):
                    raise ValueError("body must be a JSON object")
                if self.path == "/push":
                    if not isinstance(body.get("id"), str):
                        raise ValueError("push needs an id")
                    engine.push(body)
                elif self.path == "/skip":
                    b = body.get("bumper")
                    engine.skip((engine.resolve(str(b["url"])), seconds(b["voiceS"])) if b else None)
                elif self.path == "/voice":
                    if not engine.voice_break(engine.resolve(str(body["url"])), body["voiceS"],
                                              soma_only=body.get("somaOnly") is True, speech=body.get("speech") or ()):
                        return self._reply(409, {"error": "busy"})
                elif self.path == "/clear":
                    engine.clear()
                elif self.path == "/fx":
                    engine.fx(str(body["url"]))
                elif self.path == "/power":
                    if not isinstance(body.get("on"), bool):
                        raise ValueError("power needs on: true or false")
                    engine.power(body["on"])
                else:
                    return self._reply(404, {})
            except (ValueError, KeyError, TypeError) as e:   # a bad request is answered, never left hanging
                return self._reply(400, {"error": f"bad request: {e}"[:200]})
            self._reply(200, engine.status())

        def log_message(self, *args):   # status polls every 3 s: keep the journal readable
            pass

    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


def main(conf_path: str) -> None:
    conf = load_conf(conf_path)
    mixer = Mixer(conf["CARD"])
    players = Players()
    engine = Engine(conf["FILES_URL"], clock=time.monotonic, players=players, mixer=mixer)
    # off: SomaFM keeps flowing through the fade, and hangs up once it's silent
    # Off is silent on purpose: a marker tells the watchdog not to "fix" it by restarting us, and a restart
    # while off (the watchdog, a crash) comes back off, never with a few seconds of SomaFM first.
    def mark_off(off: bool) -> None:
        try:
            open(OFF_MARK, "w").close() if off else os.path.exists(OFF_MARK) and os.remove(OFF_MARK)
        except OSError as e:
            log(f"off marker: {e}")
    engine.on_power = mark_off
    if os.path.exists(OFF_MARK):
        engine.power(False)
        engine.stop_all_at = None   # already silent: nothing to fade or stop, and SomaFM never connects
        log("started off (the station was switched off)")
    soma = SomaReader(conf["SOMA_URLS"].split(), wanted=lambda: not (engine.off and engine.stop_all_at is None))
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
    backup_retry = time.monotonic() + 60
    while True:
        time.sleep(TICK_S)
        if not engine.backup and time.monotonic() >= backup_retry:   # the file server was down at boot
            backup_retry = time.monotonic() + 60
            entries = load_backup(conf["FILES_URL"])
            with engine.lock:
                engine.backup = entries
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

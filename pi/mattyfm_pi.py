#!/usr/bin/env python3
"""MattyFM receiver on the Pi: SomaFM and the station, crossfaded.

Python does the networking; two mpg123 processes only decode what it pipes in,
each into its own ALSA softvol control (SomaVol, StationVol) mixed by dmix on
the USB card.

- Station: Python reads the Icecast stream with ICY metadata, strips the
  titles out itself and feeds pure audio to mpg123. A title is acted on right
  after the audio before it has been handed over, and the pipe is kept tiny,
  so the crossfade lands where the listener hears the change.
  "MATTYFM:<id> ..." = a request is on air; anything else = idle.
- SomaFM: healthy means bytes actually arrived in the last few seconds — not
  that a process is alive. If SomaFM stalls (internet down), the station's
  backup playlist takes over.

SomaFM is played here, as an ordinary listener, because SomaFM blocks the
station software from relaying it.

Config: /etc/mattyfm.conf (CARD, STATION_URL, SOMA_URLS space-separated).
Logs: journalctl -u mattyfm-pi (every title, mode change, fade, stall, exit).
"""

import fcntl
import re
import subprocess
import sys
import threading
import time
import urllib.request

STATION_UP_S = 0.5      # into a request: the DJ voice is at full level almost at once
DEFAULT_DOWN_S = 2.5    # outgoing audio fades under the first half of the script
MAX_DOWN_S = 8.0
BACK_TO_SOMA_S = 5.0    # OUTRO: SomaFM rises under the request's last seconds
STEP_S = 0.1
SOMA_STALL_S = 4.0
CHUNK = 4096
PIPE_BYTES = 4096            # tiny pipe: titles stay in step with what is audible
F_SETPIPE_SZ = 1031
USER_AGENT = "MattyFM-Pi/1.0 (personal listener; mpg123)"
TITLE = re.compile(rb"StreamTitle='(.*?)';", re.S)


def log(msg: str) -> None:
    print(msg, flush=True)


# ---------- pure helpers (unit-tested on the workstation) ----------

def parse_title(meta: bytes) -> str | None:
    m = TITLE.search(meta)
    return m.group(1).decode("utf-8", "replace") if m else None


def icy_events(stream, metaint: int, chunk: int = CHUNK):
    """Yield ("audio", bytes) and ("title", str) in stream order from an ICY stream."""
    while True:
        left = metaint
        while left:
            data = stream.read(min(chunk, left))
            if not data:
                return
            left -= len(data)
            yield ("audio", data)
        n = stream.read(1)
        if not n:
            return
        size = n[0] * 16
        meta = b""
        while len(meta) < size:
            more = stream.read(size - len(meta))
            if not more:
                return
            meta += more
        if size:
            title = parse_title(meta)
            if title is not None:
                yield ("title", title)


FADE_IN_TITLE = re.compile(r"\bfade=([0-9.]+)")


def fade_from_title(title: str) -> float:
    m = FADE_IN_TITLE.search(title)
    if not m:
        return DEFAULT_DOWN_S
    try:
        return min(max(float(m.group(1)), 0.2), MAX_DOWN_S)
    except ValueError:
        return DEFAULT_DOWN_S


def level_at(t: float, start: int, end: int, dur: float) -> int:
    """Linear ramp from start to end over dur seconds, evaluated at elapsed time t."""
    if dur <= 0 or t >= dur:
        return end
    return round(start + (end - start) * max(t, 0) / dur)


def decide_mode(title: str, soma_up: bool) -> str:
    if title.startswith("MATTYFM:") or not soma_up:
        return "station"
    return "soma"


def ramp(start: int, end: int, steps: int) -> list[int]:
    return [round(start + (end - start) * (i + 1) / steps) for i in range(steps)]


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


def load_conf(path: str = "/etc/mattyfm.conf") -> dict:
    conf = {}
    with open(path) as f:
        for line in f:
            if "=" in line and not line.startswith("#"):
                k, _, v = line.strip().partition("=")
                conf[k] = v.strip().strip('"')
    return conf


# ---------- runtime ----------

class Mixer:
    """The two softvol levels, in percent (dB-linear), set through one long-lived amixer."""

    def __init__(self, card: str):
        self.card = card
        self.level = {"SomaVol": 100, "StationVol": 0}
        self.lock = threading.Lock()
        self.proc = None

    def _send(self, line: str) -> None:
        if self.proc is None or self.proc.poll() is not None:
            self.proc = subprocess.Popen(["amixer", "-q", "-c", self.card, "-s"],
                                         stdin=subprocess.PIPE, text=True, bufsize=1)
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()

    def set(self, control: str, pct: int) -> None:
        self._send(f"sset {control} {pct}%")
        self.level[control] = pct

    def crossfade(self, to: str, up_s: float, down_s: float) -> None:
        """Bring `to` up over up_s and the other down over down_s, each on its own clock."""
        up, down = ("StationVol", "SomaVol") if to == "station" else ("SomaVol", "StationVol")
        with self.lock:
            a0, b0 = self.level[up], self.level[down]
            t0 = time.monotonic()
            while True:
                t = time.monotonic() - t0
                self.set(up, level_at(t, a0, 100, up_s))
                self.set(down, level_at(t, b0, 0, down_s))
                if t >= max(up_s, down_s):
                    break
                time.sleep(STEP_S)
            log(f"fade to {to} done in {time.monotonic() - t0:.2f}s (up {up_s:.1f}s, down {down_s:.1f}s)")


class Decoder:
    """One mpg123 decoding stdin into an ALSA device; restarted if it dies."""

    def __init__(self, device: str, extra: tuple = ()):
        self.device, self.extra, self.proc = device, extra, None

    def write(self, data: bytes) -> None:
        if self.proc is None or self.proc.poll() is not None:
            if self.proc is not None:
                log(f"{self.device}: decoder exited {self.proc.returncode}, restarting")
            self.proc = subprocess.Popen(["mpg123", "-q", *self.extra, "-o", "alsa", "-a", self.device, "-"],
                                         stdin=subprocess.PIPE)
            try:
                fcntl.fcntl(self.proc.stdin.fileno(), F_SETPIPE_SZ, PIPE_BYTES)
            except OSError:
                pass
        self.proc.stdin.write(data)
        self.proc.stdin.flush()


class Receiver:
    def __init__(self, conf: dict):
        self.station_url = conf["STATION_URL"]
        self.soma_urls = conf["SOMA_URLS"].split()
        self.mixer = Mixer(conf["CARD"])
        self.title = ""
        self.soma = FlowHealth()
        self.mode = None
        self.state_lock = threading.Lock()
        self.ready = threading.Event()   # no decisions until startup has set known volumes
        self.bytes = {"soma": 0, "station": 0}

    def reconcile(self, why: str) -> None:
        if not self.ready.is_set():
            return
        with self.state_lock:
            want = decide_mode(self.title, self.soma.up())
            if want == self.mode:
                return
            log(f"mode {self.mode} -> {want} ({why}; title={self.title!r}, soma_up={self.soma.up()})")
            self.mode = want
            title = self.title
        if want == "station":
            self.mixer.crossfade("station", up_s=STATION_UP_S, down_s=fade_from_title(title))
        else:
            self.mixer.crossfade("soma", up_s=BACK_TO_SOMA_S, down_s=BACK_TO_SOMA_S)

    def open(self, url: str, icy: bool):
        headers = {"User-Agent": USER_AGENT}
        if icy:
            headers["Icy-MetaData"] = "1"
        return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=SOMA_STALL_S)

    def run_soma(self) -> None:
        dec = Decoder("soma", ("-b", "1024"))   # ~6 s decoded buffer rides out internet blips
        i = 0
        while True:
            url = self.soma_urls[i % len(self.soma_urls)]
            log(f"soma: connecting {url}")
            try:
                with self.open(url, icy=False) as r:
                    log(f"soma: connected ({r.status})")
                    while data := r.read(CHUNK):
                        was_up = self.soma.up()
                        self.soma.saw_bytes()
                        self.bytes["soma"] += len(data)
                        dec.write(data)
                        if not was_up:
                            self.reconcile("soma flowing")
                    log("soma: stream ended")
            except Exception as e:  # stall (timeout), DNS, TLS, decoder pipe — never let the thread die
                log(f"soma: {type(e).__name__}: {e}")
            self.soma.reset()
            self.reconcile("soma down")
            i += 1
            time.sleep(2)

    def run_station(self) -> None:
        dec = Decoder("station")
        while True:
            log(f"station: connecting {self.station_url}")
            try:
                with self.open(self.station_url, icy=True) as r:
                    metaint = int(r.headers.get("icy-metaint", "0"))
                    if not metaint:
                        raise RuntimeError("station sent no icy-metaint; titles unavailable")
                    log(f"station: connected (metaint {metaint})")
                    for kind, value in icy_events(r, metaint):
                        if kind == "audio":
                            self.bytes["station"] += len(value)
                            dec.write(value)
                        elif value != self.title:
                            log(f"station: title {value!r}")
                            self.title = value
                            self.reconcile("title changed")
                    log("station: stream ended")
            except Exception as e:
                log(f"station: {type(e).__name__}: {e}")
            if self.title:
                self.title = ""
                self.reconcile("station down")
            time.sleep(2)

    def run(self) -> None:
        threads = [threading.Thread(target=self.run_station, daemon=True, name="station"),
                   threading.Thread(target=self.run_soma, daemon=True, name="soma")]
        for t in threads:
            t.start()
        time.sleep(3)   # softvol controls exist only once each decoder has opened its device
        self.mixer.set("SomaVol", 100)
        self.mixer.set("StationVol", 0)
        self.mode = "soma"
        log("startup: SomaVol 100, StationVol 0")
        self.ready.set()
        self.reconcile("startup")
        last_report = time.monotonic()
        while True:
            time.sleep(1)
            if not threads_healthy(threads):
                dead = [t.name for t in threads if not t.is_alive()]
                log(f"thread(s) died: {dead}; exiting so systemd restarts the receiver")
                sys.exit(1)
            self.reconcile("periodic")
            if time.monotonic() - last_report >= 60:
                last_report = time.monotonic()
                log(f"status: mode={self.mode} title={self.title!r} soma_up={self.soma.up()} "
                    f"bytes soma={self.bytes['soma']} station={self.bytes['station']} "
                    f"levels={self.mixer.level}")


if __name__ == "__main__":
    Receiver(load_conf(sys.argv[1] if len(sys.argv) > 1 else "/etc/mattyfm.conf")).run()

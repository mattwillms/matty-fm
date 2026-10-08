#!/usr/bin/env python3
"""MattyFM receiver on the Pi: SomaFM and the station, crossfaded.

Two mpg123 players run all the time, each into its own ALSA softvol control
(SomaVol, StationVol) mixed by dmix on the USB card. The station's in-stream
ICY title says what is on air: "MATTYFM:<id> ..." means a request, anything
else means idle. Because the title arrives in step with its own audio, the
crossfade lands where the listener hears the change.

SomaFM is played here, as an ordinary listener, because SomaFM blocks the
station software from relaying it.

Config: /etc/mattyfm.conf (CARD, STATION_URL, SOMA_URLS space-separated).
"""

import re
import subprocess
import sys
import threading
import time

FADE_S = 2.5
FADE_STEPS = 25
SOMA_HEALTHY_AFTER_S = 5.0
TITLE = re.compile(r"^@I ICY-META: StreamTitle='(.*)';\s*$")


def parse_title(line: str) -> str | None:
    m = TITLE.match(line.strip())
    return m.group(1) if m else None


def decide_mode(title: str, soma_up: bool) -> str:
    if title.startswith("MATTYFM:") or not soma_up:
        return "station"
    return "soma"


def ramp(start: int, end: int, steps: int) -> list[int]:
    return [round(start + (end - start) * (i + 1) / steps) for i in range(steps)]


def load_conf(path: str = "/etc/mattyfm.conf") -> dict:
    conf = {}
    with open(path) as f:
        for line in f:
            if "=" in line and not line.startswith("#"):
                k, _, v = line.strip().partition("=")
                conf[k] = v.strip().strip('"')
    return conf


def log(msg: str) -> None:
    print(msg, flush=True)


class Mixer:
    """Volume of the two softvol controls, in percent (dB-linear)."""

    def __init__(self, card: str):
        self.card = card
        self.level = {"SomaVol": 100, "StationVol": 0}
        self.lock = threading.Lock()

    def set(self, control: str, pct: int) -> None:
        subprocess.run(["amixer", "-q", "-c", self.card, "sset", control, f"{pct}%"], check=False)
        self.level[control] = pct

    def crossfade(self, to: str) -> None:
        up, down = ("StationVol", "SomaVol") if to == "station" else ("SomaVol", "StationVol")
        with self.lock:
            for a, b in zip(ramp(self.level[up], 100, FADE_STEPS), ramp(self.level[down], 0, FADE_STEPS)):
                self.set(up, a)
                self.set(down, b)
                time.sleep(FADE_S / FADE_STEPS)


class Receiver:
    def __init__(self, conf: dict):
        self.card = conf["CARD"]
        self.station_url = conf["STATION_URL"]
        self.soma_urls = conf["SOMA_URLS"].split()
        self.mixer = Mixer(self.card)
        self.title = ""
        self.soma_since = None      # monotonic time the current SomaFM player started
        self.mode = None
        self.state_lock = threading.Lock()
        self.ready = threading.Event()   # no decisions until startup has set known volumes

    def soma_up(self) -> bool:
        return self.soma_since is not None and time.monotonic() - self.soma_since > SOMA_HEALTHY_AFTER_S

    def reconcile(self) -> None:
        if not self.ready.is_set():
            return
        with self.state_lock:
            want = decide_mode(self.title, self.soma_up())
            if want == self.mode:
                return
            log(f"mode {self.mode} -> {want} (title={self.title!r}, soma_up={self.soma_up()})")
            self.mode = want
        self.mixer.crossfade(want)

    def run_soma(self) -> None:
        i = 0
        while True:
            url = self.soma_urls[i % len(self.soma_urls)]
            log(f"soma: playing {url}")
            p = subprocess.Popen(["mpg123", "-q", "--timeout", "10", "-b", "1024", "-o", "alsa",
                                  "-a", "soma", url])
            self.soma_since = time.monotonic()
            p.wait()
            self.soma_since = None
            log(f"soma: player exited {p.returncode}")
            self.reconcile()
            i += 1
            time.sleep(2)

    def run_station(self) -> None:
        while True:
            log(f"station: loading {self.station_url}")
            p = subprocess.Popen(["mpg123", "-R", "--timeout", "10", "-o", "alsa", "-a", "station"],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
            p.stdin.write(f"LOAD {self.station_url}\n")
            p.stdin.flush()
            for line in p.stdout:
                title = parse_title(line)
                if title is not None and title != self.title:
                    self.title = title
                    self.reconcile()
                elif line.startswith("@P 0") or line.startswith("@E"):
                    log(f"station: {line.strip()}")
                    break
            p.kill()
            p.wait()
            self.title = ""
            self.reconcile()
            time.sleep(2)

    def run(self) -> None:
        # softvol controls exist only once a player has opened them: start players, then set levels.
        threading.Thread(target=self.run_station, daemon=True).start()
        threading.Thread(target=self.run_soma, daemon=True).start()
        time.sleep(3)
        self.mixer.set("SomaVol", 100)
        self.mixer.set("StationVol", 0)
        self.mode = "soma"
        time.sleep(SOMA_HEALTHY_AFTER_S)
        self.ready.set()
        self.reconcile()
        while True:
            time.sleep(5)
            self.reconcile()   # catches SomaFM coming back after an outage


if __name__ == "__main__":
    Receiver(load_conf(sys.argv[1] if len(sys.argv) > 1 else "/etc/mattyfm.conf")).run()

#!/usr/bin/env python3
"""The listening tap: the console's mix (as it goes to the speakers) for one listener on the LAN.

The console writes every channel to the speakers and to a loopback card too (asound.conf, TAP=1). This
reads the loopback's capture side and sends it as raw 16-bit stereo PCM at 44.1 kHz over TCP, only while
someone is connected: nothing is read or sent otherwise. No encoding on the Pi (its one core is busy
enough); the listener's computer does that (tools/listen.py). A new listener replaces the old one.

Config: /etc/mattyfm.conf — TAP_PORT (8043), TAP_ALLOW (addresses that may listen, space-separated).
"""

import socket
import subprocess
import sys
import threading

CAPTURE = ["arecord", "-q", "-D", "hw:CARD=Loopback,DEV=1,SUBDEV=0", "-f", "S16_LE", "-r", "44100", "-c", "2", "-t", "raw"]
current: list[subprocess.Popen] = []   # the one capture running (a new listener stops it first)
lock = threading.Lock()


def conf(path: str = "/etc/mattyfm.conf") -> dict:
    out = {}
    try:
        for line in open(path):
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"')
    except OSError:
        pass
    return out


def serve(sock: socket.socket) -> None:
    with lock:
        for p in current:
            p.kill()
        current.clear()
        proc = subprocess.Popen(CAPTURE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        current.append(proc)
    try:
        while chunk := proc.stdout.read(8820):   # 50 ms of audio
            sock.sendall(chunk)
    except OSError:
        pass   # the listener went away
    finally:
        proc.kill()
        proc.wait()
        sock.close()


def main() -> None:
    c = conf()
    port, allow = int(c.get("TAP_PORT", "8043")), set(c.get("TAP_ALLOW", "192.168.86.44").split())
    srv = socket.create_server(("0.0.0.0", port), reuse_port=True)
    print(f"tap: listening on {port} for {' '.join(sorted(allow))}", flush=True)
    while True:
        sock, (addr, _) = srv.accept()
        if addr not in allow:
            sock.close()
            continue
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        threading.Thread(target=serve, args=(sock,), daemon=True).start()


if __name__ == "__main__":
    sys.exit(main())

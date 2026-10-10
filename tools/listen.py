#!/usr/bin/env python3
"""Listen to the party mix on this computer: tools/listen.py, then press Play in the page it opens.

The Pi sends its speakers' mix as raw PCM (pi/tap.py, only while someone listens); this turns it into MP3
with ffmpeg and plays it in an ordinary browser tab, so the computer's other sound keeps working alongside.
A few seconds behind the room. Only this computer can open the page (127.0.0.1).
"""

import http.server
import socket
import subprocess
import sys
import threading
import webbrowser

PI, TAP_PORT, PORT = "192.168.86.31", 8043, 8045
PAGE = b"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>OrrFM monitor</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #2a1a12; color: #f3e3c3;
         font: 16px/1.4 system-ui, sans-serif; }
  main { text-align: center; padding: 16px; }
  h1 { font: 700 1.6rem Georgia, serif; color: #f0a92b; margin: 0 0 6px; }
  p { margin: 0 0 22px; color: #cdb591; }
  button { width: 120px; height: 120px; border-radius: 50%; border: 0; background: #e2621b; color: #241208;
           font: 700 1.1rem system-ui, sans-serif; cursor: pointer; box-shadow: 0 6px 16px #000a; }
  button:focus-visible { outline: 3px solid #f3e3c3; outline-offset: 4px; }
  button.on { background: #6fe3c8; }
  #msg { margin-top: 18px; min-height: 1.4em; font-size: .9rem; }
  input { width: 200px; margin-top: 18px; accent-color: #e2621b; }
</style></head><body><main>
<h1>OrrFM monitor</h1><p>What the party speakers are playing, a few seconds behind.</p>
<button id="b" type="button">Play</button>
<div><input id="v" type="range" min="0" max="1" step="0.05" value="0.8" aria-label="Volume"></div>
<div id="msg" role="status"></div>
<audio id="a" preload="none"></audio>
<script>
const a = document.getElementById("a"), b = document.getElementById("b"), msg = document.getElementById("msg");
document.getElementById("v").oninput = (e) => { a.volume = e.target.value; };
a.volume = 0.8;
b.onclick = () => {
  if (!a.paused) { a.pause(); a.removeAttribute("src"); a.load(); b.textContent = "Play"; b.className = ""; msg.textContent = ""; return; }
  a.src = "/live.mp3?" + Date.now(); msg.textContent = "Connecting...";
  a.play().then(() => { b.textContent = "Stop"; b.className = "on"; msg.textContent = "Live"; })
          .catch(() => { msg.textContent = "Couldn't reach the Pi's tap."; });
};
a.onerror = () => { if (a.getAttribute("src")) { msg.textContent = "The stream dropped. Press Play again."; b.textContent = "Play"; b.className = ""; } };
</script></main></body></html>"""


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        # only this computer's own name for the page: a web page elsewhere can't rebind a hostname of its own
        # to 127.0.0.1 and read the stream (DNS rebinding)
        if self.headers.get("host", "") not in (f"127.0.0.1:{PORT}", f"localhost:{PORT}"):
            self.send_error(403)
            return
        if self.path == "/":
            self.send_response(200)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(PAGE)
            return
        if not self.path.startswith("/live.mp3"):
            self.send_error(404)
            return
        try:
            pi = socket.create_connection((PI, TAP_PORT), timeout=5)
        except OSError as e:
            self.send_error(502, f"tap unreachable: {e}")
            return
        enc = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-f", "s16le", "-ar", "44100", "-ac", "2", "-i", "pipe:0",
                                "-f", "mp3", "-b:a", "192k", "pipe:1"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)

        def feed():
            try:
                while data := pi.recv(65536):
                    enc.stdin.write(data)
            except OSError:
                pass
            finally:
                try:
                    enc.stdin.close()
                except OSError:
                    pass
        threading.Thread(target=feed, daemon=True).start()
        self.send_response(200)
        self.send_header("content-type", "audio/mpeg")
        self.send_header("cache-control", "no-store")
        self.end_headers()
        try:
            while chunk := enc.stdout.read(4096):
                self.wfile.write(chunk)
        except OSError:
            pass   # the tab stopped listening
        finally:
            pi.close()
            enc.kill()


def main():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://127.0.0.1:{PORT}/"
    print(f"OrrFM monitor: {url}  (Ctrl-C to stop)")
    if "--no-open" not in sys.argv:
        webbrowser.open(url)
    srv.serve_forever()


if __name__ == "__main__":
    main()

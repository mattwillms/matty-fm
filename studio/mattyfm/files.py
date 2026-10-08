"""LAN file server for the Pi console: only ready/, voice/ and backup/ under media/.

Usage: python -m mattyfm.files   (binds 0.0.0.0:8040; the firewall allows the LAN only)
"""

import functools
import posixpath
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ALLOWED = ("ready", "voice", "backup")


class Handler(SimpleHTTPRequestHandler):
    def send_head(self):
        path = posixpath.normpath(urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)).lstrip("/")
        top = path.split("/", 1)[0]
        if top not in ALLOWED or path == top or ".." in path.split("/"):
            self.send_error(404)
            return None
        return super().send_head()

    def list_directory(self, path):   # never list folders
        self.send_error(404)
        return None

    def log_message(self, fmt, *args):  # quiet: the Pi fetches a few files per song
        pass


def make_server(media: Path, host: str = "0.0.0.0", port: int = 8040) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), functools.partial(Handler, directory=str(media)))


if __name__ == "__main__":
    from . import config
    make_server(config.load().media_dir).serve_forever()

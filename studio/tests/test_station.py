import json
import socketserver
import threading

import pytest

from mattyfm.station import Station


class FakeLiq(socketserver.StreamRequestHandler):
    log: list[str] = []

    def handle(self):
        for raw in self.rfile:
            line = raw.decode().strip()
            if line == "quit":
                self.wfile.write(b"Bye!\r\n")
                return
            FakeLiq.log.append(line)
            if line == "status":
                body = json.dumps({"source": "soma", "current": "", "remaining": -1.0, "queued": 0})
            else:
                body = "ok"
            self.wfile.write(f"{body}\r\nEND\r\n".encode())


@pytest.fixture
def liq():
    FakeLiq.log = []
    srv = socketserver.TCPServer(("127.0.0.1", 0), FakeLiq)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield Station("127.0.0.1", srv.server_address[1])
    srv.shutdown()
    srv.server_close()


def test_status_parses_json(liq):
    assert liq.status()["source"] == "soma"


def test_push_annotates_and_strips_quotes(liq):
    liq.push("/media/ready/r1.mp3", "r1", 'Say "Hi"', "Band\nName")
    assert FakeLiq.log[-1] == (
        'reqs.push annotate:mattyfm_id="r1",title="Say \'Hi\'",artist="Band Name":/media/ready/r1.mp3'
    )


def test_skip_and_clear(liq):
    liq.skip()
    liq.clear()
    assert FakeLiq.log[-2:] == ["reqs.skip", "clear"]

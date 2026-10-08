import json

import httpx

from mattyfm.pilink import PiLink


def test_pilink_speaks_the_console_api_with_its_token():
    seen = []

    def handler(r):
        seen.append((r.method, r.url.path, r.headers.get("x-token"), r.content))
        return httpx.Response(200, json={"source": "soma", "current": "", "remaining": -1, "queued": 0})

    pi = PiLink("http://pi:8042", "tok", httpx.Client(transport=httpx.MockTransport(handler)))
    assert pi.status()["source"] == "soma"
    pi.push({"id": "r1", "title": "T", "artist": "A", "songS": 200.0, "voiceS": 4.0})
    pi.skip()
    pi.clear()
    assert [s[:3] for s in seen] == [("GET", "/status", "tok"), ("POST", "/push", "tok"),
                                     ("POST", "/skip", "tok"), ("POST", "/clear", "tok")]
    assert json.loads(seen[1][3])["voiceS"] == 4.0

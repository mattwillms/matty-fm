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


def test_voice_break_and_skip_bumper():
    seen = []

    def handler(r):
        seen.append((r.url.path, json.loads(r.content or b"{}")))
        return httpx.Response(200, json={"source": "soma", "current": "", "remaining": -1, "queued": 0})

    pi = PiLink("http://pi:8042", "tok", httpx.Client(transport=httpx.MockTransport(handler)))
    assert pi.voice("breaks/id1.mp3", 3.2) is True
    pi.skip(bumper={"url": "breaks/skip1.mp3", "voiceS": 1.5})
    assert seen == [("/voice", {"url": "breaks/id1.mp3", "voiceS": 3.2}),
                    ("/skip", {"bumper": {"url": "breaks/skip1.mp3", "voiceS": 1.5}})]


def test_pad_asks_the_console_to_play_a_sound():
    seen = []

    def handler(r):
        seen.append((r.url.path, json.loads(r.content or b"{}")))
        return httpx.Response(200, json={"source": "soma", "current": "", "remaining": -1, "queued": 0})

    pi = PiLink("http://pi:8042", "tok", httpx.Client(transport=httpx.MockTransport(handler)))
    pi.fx("breaks/pad-3.mp3")
    assert seen == [("/fx", {"url": "breaks/pad-3.mp3"})]

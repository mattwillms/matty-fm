import httpx

from mattyfm import somafm


def client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_current_song_from_feed():
    feed = {"id": "seventies", "songs": [{"title": "Woman", "artist": "Dane Donohue", "album": "x", "date": "1791431741"},
                                          {"title": "Rock On", "artist": "David Essex", "album": "y", "date": "1791431544"}]}
    np = somafm.NowPlaying(client(lambda r: httpx.Response(200, json=feed)), every_s=0)
    assert {k: v for k, v in np.get().items() if k != "artwork"} == {"artist": "Dane Donohue", "title": "Woman", "since": 1791431741}


def test_feed_failure_keeps_last_known_and_never_raises():
    calls = {"n": 0}

    def handler(r):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(200, json={"songs": [{"title": "A", "artist": "B", "date": "5"}]})
        return httpx.Response(503)

    np = somafm.NowPlaying(client(handler), every_s=0)
    assert np.get()["title"] == "A"
    assert np.get()["title"] == "A"


def test_artwork_looked_up_once_per_song():
    seen = []

    def handler(r):
        seen.append(str(r.url))
        if "somafm.com" in str(r.url):
            return httpx.Response(200, json={"songs": [{"title": "Woman", "artist": "Dane Donohue", "date": "7"}]})
        return httpx.Response(200, json={"results": [{"artworkUrl100": "https://is1-ssl.mzstatic.com/x/100x100bb.jpg"}]})

    np = somafm.NowPlaying(client(handler), every_s=0)
    assert np.get()["artwork"] == "https://is1-ssl.mzstatic.com/x/200x200bb.jpg"
    np.get()
    assert sum("itunes.apple.com" in u for u in seen) == 1

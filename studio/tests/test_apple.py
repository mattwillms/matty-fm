"""Release info from Apple, looked up from the studio: iPhones can't reach Apple's search API
(it redirects them to the iTunes app), so the studio does it for every phone."""

import httpx

from mattyfm import apple


def http_with(results, seen=None):
    def handler(req):
        if seen is not None:
            seen.append(req)
        return httpx.Response(200, json={"resultCount": len(results), "results": results})
    return httpx.Client(transport=httpx.MockTransport(handler))


def hit(title, artist, date, album, track_id=1):
    return {"trackName": title, "artistName": artist, "releaseDate": date, "collectionName": album, "trackId": track_id,
            "trackViewUrl": f"https://music.apple.com/us/album/x/1?i={track_id}&uo=4",
            "artworkUrl100": "https://is1-ssl.mzstatic.com/image/thumb/a/100x100bb.jpg"}


def test_the_earliest_matching_release_wins_over_a_best_of():
    results = [hit("Dreams", "Fleetwood Mac", "2002-10-15T07:00:00Z", "The Very Best of Fleetwood Mac", 9),
               hit("Dreams", "Fleetwood Mac", "1977-02-04T08:00:00Z", "Rumours", 7),
               hit("Dreams", "The Cranberries", "1993-03-01T08:00:00Z", "Everybody Else", 5)]
    info = apple.release_info("Fleetwood Mac", "Dreams", http_with(results))
    assert info["year"] == "1977" and info["album"] == "Rumours"
    assert info["apple"] == "https://music.apple.com/us/album/x/1?i=7&app=music"   # the Music app, not the iTunes Store
    assert info["artwork"].endswith("/200x200bb.jpg")


def test_remaster_tags_still_match():
    results = [hit("Go Your Own Way (2004 Remaster)", "Fleetwood Mac", "1976-12-20T08:00:00Z", "Rumours")]
    assert apple.release_info("Fleetwood Mac", "Go Your Own Way", http_with(results))["year"] == "1976"


def test_no_match_or_a_failure_is_empty_never_an_error():
    assert apple.release_info("Paul Carrack", "Foregone Conclusion", http_with([])) == {}
    broken = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(503)))
    assert apple.release_info("ABBA", "SOS", broken) == {}


def test_asks_as_a_desktop_browser_for_us_songs():
    seen = []
    apple.release_info("ABBA", "SOS", http_with([], seen))
    q = seen[0].url.params
    assert q["entity"] == "song" and q["country"] == "US" and "ABBA SOS" in q["term"]


def test_one_odd_row_does_not_lose_the_rest_and_links_are_checked():
    results = [{"trackName": "Dreams", "artistName": None, "releaseDate": "1970-01-01T00:00:00Z"},
               hit("Dreams", "Fleetwood Mac", "1977-02-04T08:00:00Z", "Rumours", 7)]
    assert apple.release_info("Fleetwood Mac", "Dreams", http_with(results))["year"] == "1977"
    bad = hit("Dreams", "Fleetwood Mac", "1977-02-04T08:00:00Z", "Rumours")
    bad["trackViewUrl"], bad["artworkUrl100"] = "javascript:alert(1)", "http://evil.example/x.jpg"
    info = apple.release_info("Fleetwood Mac", "Dreams", http_with([bad]))
    assert "apple" not in info and "artwork" not in info and info["year"] == "1977"

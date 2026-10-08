"""Client for the Pi console's control API (same shape the station client had)."""

import httpx


class PiLink:
    def __init__(self, base: str, token: str, http: httpx.Client | None = None):
        self.base = base.rstrip("/")
        self.http = http or httpx.Client(timeout=4)
        self.headers = {"x-token": token}

    def status(self) -> dict:
        r = self.http.get(f"{self.base}/status", headers=self.headers)
        r.raise_for_status()
        return r.json()

    def _post(self, path: str, body: dict | None = None) -> dict:
        r = self.http.post(f"{self.base}{path}", json=body or {}, headers=self.headers)
        r.raise_for_status()
        return r.json()

    def push(self, item: dict) -> dict:
        return self._post("/push", item)

    def skip(self, bumper: dict | None = None) -> None:
        """bumper {url, voiceS}: played over the fade to SomaFM when nothing is queued."""
        self._post("/skip", {"bumper": bumper} if bumper else None)

    def voice(self, url: str, voice_s: float, soma_only: bool = False) -> bool:
        """A DJ break over whatever is on air. soma_only (scheduled breaks): only over settled
        SomaFM with nothing queued. False if the console declined."""
        r = self.http.post(f"{self.base}/voice", json={"url": url, "voiceS": voice_s, "somaOnly": soma_only},
                           headers=self.headers)
        return r.status_code == 200

    def fx(self, url: str) -> None:
        """A sound pad over whatever is on air (a path on the file server, e.g. breaks/pad-1.mp3)."""
        self._post("/fx", {"url": url})

    def clear(self) -> None:
        self._post("/clear")

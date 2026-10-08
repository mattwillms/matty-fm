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

    def skip(self) -> None:
        self._post("/skip")

    def clear(self) -> None:
        self._post("/clear")

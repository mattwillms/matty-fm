"""Client for the Worker's /api/studio/* endpoints."""

import httpx


class WorkerAPI:
    def __init__(self, base: str, secret: str, http: httpx.Client | None = None):
        self.base = base.rstrip("/")
        self.http = http or httpx.Client(timeout=10)
        self.headers = {"authorization": f"Bearer {secret}"}

    def _post(self, path: str, body: dict) -> httpx.Response:
        r = self.http.post(f"{self.base}{path}", json=body, headers=self.headers)
        r.raise_for_status()
        return r

    def beat(self, body: dict) -> dict:
        return self._post("/api/studio/beat", body).json()

    def result(self, body: dict) -> dict:
        return self._post("/api/studio/result", body).json()

    def tts(self, text: str) -> bytes:
        return self._post("/api/studio/tts", {"text": text}).content

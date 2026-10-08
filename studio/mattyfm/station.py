"""Liquidsoap telnet client. One connection per command keeps it stateless."""

import json
import socket


def _clean(text: str) -> str:
    return " ".join(text.replace('"', "'").split())


class Station:
    def __init__(self, host: str = "127.0.0.1", port: int = 1234, timeout: float = 5.0):
        self.host, self.port, self.timeout = host, port, timeout

    def command(self, line: str) -> str:
        with socket.create_connection((self.host, self.port), timeout=self.timeout) as s:
            s.sendall(f"{line}\nquit\n".encode())
            chunks = []
            while chunk := s.recv(4096):
                chunks.append(chunk)
        out = []
        for reply_line in b"".join(chunks).decode(errors="replace").splitlines():
            if reply_line.strip() == "END":
                break
            out.append(reply_line)
        return "\n".join(out).strip()

    def status(self) -> dict:
        return json.loads(self.command("status"))

    def push(self, path: str, item_id: str, title: str, artist: str) -> str:
        meta = f'mattyfm_id="{_clean(item_id)}",title="{_clean(title)}",artist="{_clean(artist)}"'
        return self.command(f"reqs.push annotate:{meta}:{path}")

    def skip(self) -> None:
        self.command("reqs.skip")

    def clear(self) -> None:
        self.command("clear")

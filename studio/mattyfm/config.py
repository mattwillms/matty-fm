"""Settings from ~/.config/mattyfm/env and the environment."""

import os
from dataclasses import dataclass
from pathlib import Path

ENV_FILE = Path.home() / ".config" / "mattyfm" / "env"
REPO = Path(__file__).resolve().parents[2]


def load_env(path: Path = ENV_FILE) -> None:
    """Load KEY=VALUE lines without overriding variables already set.

    A trailing " # note" is a comment; a "#" inside a value is kept.
    Matching surrounding quotes are removed (values with spaces are quoted so
    the same file also works with systemd and `set -a; . env`).
    """
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.split(" #")[0].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key.strip(), value)


@dataclass(frozen=True)
class Config:
    worker_url: str
    studio_secret: str
    repo: Path
    media_dir: Path
    sample_rate: int
    pi_url: str
    pi_token: str


def load() -> Config:
    load_env()
    return Config(
        worker_url=os.environ.get("MATTYFM_WORKER_URL", "https://fm.willms.co").rstrip("/"),
        studio_secret=os.environ.get("STUDIO_SECRET", ""),
        repo=REPO,
        media_dir=REPO / "media",
        sample_rate=int(os.environ.get("MATTYFM_RATE", "44100")),
        pi_url=os.environ.get("MATTYFM_PI_URL", "http://192.168.86.31:8042"),
        pi_token=os.environ.get("PI_TOKEN", ""),
    )

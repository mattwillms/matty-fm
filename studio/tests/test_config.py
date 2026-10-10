from pathlib import Path

from mattyfm import config


def test_load_env_parses_and_keeps_existing(tmp_path, monkeypatch):
    env = tmp_path / "env"
    env.write_text("# comment\nA=1\nB = two  # note\nC=has#hash\n\nA=ignored\n")
    monkeypatch.setenv("A", "already")
    monkeypatch.delenv("B", raising=False)
    monkeypatch.delenv("C", raising=False)
    config.load_env(env)
    import os
    assert os.environ["A"] == "already"
    assert os.environ["B"] == "two"
    assert os.environ["C"] == "has#hash"


def test_load_reads_defaults(monkeypatch):
    monkeypatch.setenv("STUDIO_SECRET", "s")
    monkeypatch.delenv("MATTYFM_RATE", raising=False)
    cfg = config.load()
    assert cfg.sample_rate == 44100
    assert cfg.worker_url == "https://fm.willms.co"
    assert cfg.media_dir == cfg.repo / "media"


def test_load_env_strips_matching_quotes(tmp_path, monkeypatch):
    env = tmp_path / "env"
    env.write_text('KEY="ssh-ed25519 AAAA mattyfm"\nODD="half\n')
    monkeypatch.delenv("KEY", raising=False)
    monkeypatch.delenv("ODD", raising=False)
    config.load_env(env)
    import os
    assert os.environ["KEY"] == "ssh-ed25519 AAAA mattyfm"
    assert os.environ["ODD"] == '"half'

import re
import subprocess

import pytest

from mattyfm import mix


def tone(path, freq, seconds, volume=0.5):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                    f"sine=f={freq}:d={seconds}", "-af", f"volume={volume}",
                    "-ac", "2", "-ar", "44100", str(path)], check=True)


def mean_db(path, start, length):
    out = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-ss", str(start), "-t", str(length),
                          "-i", str(path), "-af", "volumedetect", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    return float(re.search(r"mean_volume: (-?[\d.]+) dB", out).group(1))


@pytest.fixture
def parts(tmp_path):
    tone(tmp_path / "song.mp3", 220, 60)
    tone(tmp_path / "voice.mp3", 880, 5)
    tone(tmp_path / "sting.mp3", 1320, 2)
    return tmp_path


def test_premix_keeps_song_length(parts):
    out = parts / "out.mp3"
    seconds = mix.premix(parts / "song.mp3", parts / "voice.mp3", parts / "sting.mp3", out, 44100)
    assert abs(seconds - 60) < 1.5


def test_song_is_ducked_under_voice(parts):
    out = parts / "out.mp3"
    mix.premix(parts / "song.mp3", parts / "voice.mp3", None, out, 44100)
    # 220 Hz band only: under the voice it must be much quieter than later.
    filt = parts / "low.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(out), "-af", "lowpass=f=300", str(filt)], check=True)
    assert mean_db(filt, 2, 2) < mean_db(filt, 30, 2) - 6


def test_rejects_short_output(parts):
    tone(parts / "tiny.mp3", 220, 5)
    with pytest.raises(ValueError):
        mix.premix(parts / "tiny.mp3", parts / "voice.mp3", None, parts / "o.mp3", 44100)

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


def test_song_is_whole_and_starts_mid_script(parts):
    out = parts / "out.mp3"
    seconds = mix.premix(parts / "song.mp3", parts / "voice.mp3", None, out, 44100)
    start = mix.song_start(5.0)
    assert abs(start - (mix.VOICE_AT + 2.5)) < 0.01
    assert abs(seconds - (60 + start)) < 1.5


def band(parts, out, f):
    dest = parts / f"b{f}.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(out), "-af", f"bandpass=f={f}:w=60", str(dest)], check=True)
    return dest


def test_voice_first_then_song_fades_up_by_the_end_of_the_script(parts):
    out = parts / "out.mp3"
    mix.premix(parts / "song.mp3", parts / "voice.mp3", None, out, 44100)
    song, voice = band(parts, out, 220), band(parts, out, 880)
    assert mean_db(voice, 0.7, 1.5) > -30                      # voice at full from ~0.5 s
    assert mean_db(song, 0.5, 2.0) < -45                       # no song under the first half
    assert mean_db(song, 6.0, 2.0) > mean_db(song, 3.2, 0.5) + 6   # song rising through the second half
    assert mean_db(song, 30, 2) - mean_db(song, 5.4, 0.3) < 3  # near full volume as the script ends

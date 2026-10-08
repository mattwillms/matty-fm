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


def test_prepare_files_writes_song_and_voice_separately(parts):
    song_out, voice_out = parts / "ready.mp3", parts / "voice-out.mp3"
    song_s, voice_s = mix.prepare_files(parts / "song.mp3", parts / "voice.mp3", song_out, voice_out, 44100)
    assert song_out.exists() and voice_out.exists()
    assert abs(song_s - 60) < 1.0 and abs(voice_s - 5) < 0.5
    # the voice file is voice only: no 220 Hz song in it
    assert mean_db(voice_out, 1, 2) > -40


def test_rejects_short_song(parts):
    tone(parts / "tiny.mp3", 220, 5)
    with pytest.raises(ValueError):
        mix.prepare_files(parts / "tiny.mp3", parts / "voice.mp3", parts / "o.mp3", parts / "v.mp3", 44100)


def test_speech_gaps_finds_the_pauses_in_a_voice(tmp_path):
    import subprocess
    v = tmp_path / "v.mp3"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=300:d=1.5", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=1.4",
                    "-f", "lavfi", "-i", "sine=f=300:d=1.0", "-filter_complex", "[0][1][2]concat=n=3:v=0:a=1", str(v)], check=True)
    gaps = mix.speech_gaps(v)
    assert len(gaps) == 1 and abs(gaps[0][0] - 1.5) < 0.15 and abs(gaps[0][1] - 2.9) < 0.15

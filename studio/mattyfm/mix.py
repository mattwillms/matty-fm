"""Pre-mix one request: sting, DJ voice over the ducked song intro, then the song."""

import json
import re
import subprocess
from pathlib import Path

SONG_LUFS, VOICE_LUFS, TRUE_PEAK = -16, -14, -1.5
# The DJ talks over the transition: the voice starts VOICE_AT seconds in at full
# level while the Pi fades SomaFM (or the last song) down under the first half of
# the script; the new song starts at the script's midpoint and fades up to full
# volume as the script ends.
VOICE_AT = 0.5


def song_start(voice_s: float) -> float:
    """Where the song begins in the mix: the midpoint of the script."""
    return VOICE_AT + voice_s / 2


VOICE_CHAIN = ("highpass=f=80,equalizer=f=3000:t=q:w=1:g=3,"
               "acompressor=threshold=-18dB:ratio=4:attack=5:release=100:makeup=2")


def _ffmpeg(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-y", *args],
                          capture_output=True, text=True, check=True)


def duration(path: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


def _measure(path: Path, target: int) -> dict:
    err = _ffmpeg("-i", str(path), "-af",
                  f"loudnorm=I={target}:TP={TRUE_PEAK}:print_format=json", "-f", "null", "-").stderr
    return json.loads(re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", err, re.S).group(0))


def _normalize(src: Path, dest: Path, target: int, rate: int, pre: str = "") -> None:
    """Two-pass linear loudnorm: same perceived loudness, dynamics untouched."""
    m = _measure(src, target)
    chain = (f"{pre + ',' if pre else ''}loudnorm=I={target}:TP={TRUE_PEAK}:"
             f"measured_I={m['input_i']}:measured_TP={m['input_tp']}:"
             f"measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:"
             f"offset={m['target_offset']}:linear=true")
    _ffmpeg("-i", str(src), "-af", f"{chain},aresample={rate}", "-ac", "2", str(dest))


def prepare_files(song: Path, voice: Path, song_out: Path, voice_out: Path, rate: int) -> tuple[float, float]:
    """Loudness-match the song and the DJ voice into two files; the Pi mixes them live.

    Returns (song seconds, voice seconds).
    """
    work = song_out.with_suffix(".work")
    work.mkdir(exist_ok=True)
    try:
        song_n, voice_n = work / "song.wav", work / "voice.wav"
        _normalize(song, song_n, SONG_LUFS, rate)
        song_s = duration(song_n)
        if song_s < 20:
            raise ValueError(f"Song too short ({song_s:.1f}s)")
        _normalize(voice, voice_n, VOICE_LUFS, rate, pre=VOICE_CHAIN + ",silenceremove=start_periods=1:start_threshold=-45dB")
        for src, dest in ((song_n, song_out), (voice_n, voice_out)):
            tmp = dest.with_name(dest.stem + ".tmp.mp3")
            _ffmpeg("-i", str(src), "-ar", str(rate), "-c:a", "libmp3lame", "-b:a", "192k", str(tmp))
            tmp.rename(dest)
        return duration(song_out), duration(voice_out)
    finally:
        for f in work.iterdir():
            f.unlink()
        work.rmdir()

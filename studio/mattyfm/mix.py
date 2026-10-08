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


def premix(song: Path, voice: Path, sting: Path | None, dest: Path, rate: int) -> float:
    """Voice from VOICE_AT; song from the script's midpoint, fading up to full by its end.

    `sting` is accepted for bumpers but not used on song transitions.
    """
    work = dest.with_suffix(".work")
    work.mkdir(exist_ok=True)
    song_n, voice_n = work / "song.wav", work / "voice.wav"
    _normalize(song, song_n, SONG_LUFS, rate)
    _normalize(voice, voice_n, VOICE_LUFS, rate, pre=VOICE_CHAIN)
    if duration(song_n) < 20:
        raise ValueError(f"Song too short ({duration(song_n):.1f}s)")
    voice_s = duration(voice_n)
    start = song_start(voice_s)
    fade = VOICE_AT + voice_s - start            # second half of the script
    fmt = f"aformat=sample_fmts=fltp:sample_rates={rate}:channel_layouts=stereo"
    graph = (f"[1:a]{fmt},adelay={int(VOICE_AT * 1000)}:all=1[v];"
             f"[0:a]{fmt},adelay={int(start * 1000)}:all=1,afade=t=in:st={start:.3f}:d={fade:.3f}[s];"
             "[s][v]amix=inputs=2:normalize=0:duration=longest,alimiter=limit=0.95[out]")
    tmp = dest.with_name(dest.stem + ".tmp.mp3")
    _ffmpeg("-i", str(song_n), "-i", str(voice_n), "-filter_complex", graph, "-map", "[out]",
            "-ar", str(rate), "-c:a", "libmp3lame", "-b:a", "192k", str(tmp))
    tmp.rename(dest)
    for f in work.iterdir():
        f.unlink()
    work.rmdir()
    return duration(dest)

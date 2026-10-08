"""Pre-mix one request: sting, DJ voice over the ducked song intro, then the song."""

import json
import re
import subprocess
from pathlib import Path

SONG_LUFS, VOICE_LUFS, TRUE_PEAK = -16, -14, -1.5
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
    work = dest.with_suffix(".work")
    work.mkdir(exist_ok=True)
    song_n, voice_n = work / "song.wav", work / "voice.wav"
    _normalize(song, song_n, SONG_LUFS, rate)
    _normalize(voice, voice_n, VOICE_LUFS, rate, pre=VOICE_CHAIN)
    total = duration(song_n)
    if total < 20:
        raise ValueError(f"Song too short ({total:.1f}s)")

    fmt = f"aformat=sample_fmts=fltp:sample_rates={rate}:channel_layouts=stereo"
    inputs = ["-i", str(song_n), "-i", str(voice_n)]
    voice_at = 0.5
    if sting:
        inputs += ["-i", str(sting)]
        voice_at = duration(sting) + 0.2
    talk = (f"[1:a]{fmt},adelay={int(voice_at * 1000)}:all=1,apad=whole_dur={total}[v];"
            + (f"[2:a]{fmt},apad=whole_dur={total}[st];[v][st]amix=inputs=2:normalize=0:duration=first,"
               if sting else "[v]anull,")
            + "asplit[talk][key];")
    graph = (talk + f"[0:a]{fmt}[song];"
             "[song][key]sidechaincompress=threshold=0.02:ratio=12:attack=30:release=700[ducked];"
             "[ducked][talk]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95[out]")
    tmp = dest.with_name(dest.stem + ".tmp.mp3")
    _ffmpeg(*inputs, "-filter_complex", graph, "-map", "[out]", "-ar", str(rate),
            "-c:a", "libmp3lame", "-b:a", "192k", str(tmp))
    tmp.rename(dest)
    for f in work.iterdir():
        f.unlink()
    work.rmdir()
    return duration(dest)

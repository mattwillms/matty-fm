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


TOOL_TIMEOUT_S = 120   # no ffmpeg run on one song takes this long: a hung one must not hold a slot forever


def _ffmpeg(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-y", *args], stdin=subprocess.DEVNULL,
                          capture_output=True, text=True, check=True, timeout=TOOL_TIMEOUT_S)


def duration(path: Path) -> float:
    """The length the file's header claims (fast; a cut-off MP3 still claims its full length)."""
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "csv=p=0", str(path)], stdin=subprocess.DEVNULL, capture_output=True, text=True,
                         check=True, timeout=30)
    return float(out.stdout.strip())


def speech_segments(path: Path) -> list[tuple[float, float]]:
    """Where the voice is talking, as (start, end) seconds: the console ducks the music to exactly
    these (it merges short breaths itself). Measured on the audio, so a pause's length doesn't matter."""
    out = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af",
                          "silencedetect=noise=-35dB:d=0.25", "-f", "null", "-"], stdin=subprocess.DEVNULL,
                         capture_output=True, text=True, check=True, timeout=30).stderr
    total = decoded_duration(path)
    talk, at = [], 0.0
    for m in re.finditer(r"silence_(start|end): (-?[\d.]+)", out):
        t = max(0.0, float(m[2]))
        if m[1] == "start":
            if t - at > 0.05:
                talk.append((round(at, 2), round(t, 2)))
            at = None
        else:
            at = t
    if at is not None and total - at > 0.05:   # talking right to the end
        talk.append((round(at, 2), round(total, 2)))
    return talk


def lengthen_pauses(path: Path, extra_s: float = 0.5, min_s: float = 0.9) -> int:
    """Each pause in a voice (an inner silence of min_s or more, not a breath) gets extra_s longer,
    in place: the voice model decides pause lengths, and the music needs a little more room to come
    up in them. Returns how many pauses were stretched (0: the file is untouched)."""
    err = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af",
                          f"silencedetect=noise=-35dB:d={min_s}", "-f", "null", "-"], stdin=subprocess.DEVNULL,
                         capture_output=True, text=True, check=True, timeout=30).stderr
    total = decoded_duration(path)
    starts = [float(x) for x in re.findall(r"silence_start: (-?[\d.]+)", err)]
    ends = [float(x) for x in re.findall(r"silence_end: (-?[\d.]+)", err)]
    cuts = [round((a + b) / 2, 3) for a, b in zip(starts, ends) if a > 0.05 and b < total - 0.05]
    if not cuts:
        return 0
    info = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels",
                           "-of", "csv=p=0", str(path)], stdin=subprocess.DEVNULL, capture_output=True, text=True,
                          check=True, timeout=30).stdout.strip().split(",")
    rate, layout = info[0], "stereo" if info[1].strip() == "2" else "mono"
    edges, parts, labels = [0.0, *cuts, None], [], []
    for i in range(len(edges) - 1):
        end = f":end={edges[i + 1]}" if edges[i + 1] is not None else ""
        parts.append(f"[0:a]atrim=start={edges[i]}{end},asetpts=PTS-STARTPTS[p{i}]")
        labels.append(f"[p{i}]")
        if edges[i + 1] is not None:
            parts.append(f"anullsrc=r={rate}:cl={layout},atrim=end={extra_s}[q{i}]")
            labels.append(f"[q{i}]")
    graph = ";".join(parts) + ";" + "".join(labels) + f"concat=n={len(labels)}:v=0:a=1[out]"
    tmp = path.with_name(path.stem + ".pauses.mp3")
    _ffmpeg("-i", str(path), "-filter_complex", graph, "-map", "[out]", "-c:a", "libmp3lame", "-b:a", "192k", str(tmp))
    tmp.replace(path)
    return len(cuts)


def decoded_duration(path: Path) -> float:
    """Seconds of audio that actually decode: what a truncated download really holds."""
    out = subprocess.run(["ffmpeg", "-v", "error", "-nostats", "-i", str(path), "-map", "0:a:0", "-f", "null",
                          "-progress", "pipe:1", "-"], stdin=subprocess.DEVNULL, capture_output=True, text=True,
                         check=True, timeout=TOOL_TIMEOUT_S).stdout
    us = [int(v) for k, _, v in (line.partition("=") for line in out.splitlines()) if k == "out_time_us" and v.isdigit()]
    return max(us, default=0) / 1e6


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


def prepare_voice(voice: Path, out: Path, rate: int) -> float:
    """A DJ-only clip (break or bumper): same voice chain and loudness as request intros."""
    work = out.with_suffix(".work.wav")
    try:
        _normalize(voice, work, VOICE_LUFS, rate,
                   pre=VOICE_CHAIN + ",silenceremove=start_periods=1:start_threshold=-45dB")
        tmp = out.with_name(out.stem + ".tmp.mp3")
        _ffmpeg("-i", str(work), "-ar", str(rate), "-c:a", "libmp3lame", "-b:a", "192k", str(tmp))
        tmp.rename(out)
        return duration(out)
    finally:
        work.unlink(missing_ok=True)

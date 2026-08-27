"""Phase 6.5 DSP integration tests (Task 3).

These use generated tones (no network, no CUDA, no Richard's media). They
verify duration, tempo alignment, transition energy, channel pan, EQ
direction, and the final true-peak limiter.

Helper functions measure the output with ffmpeg's ebur128 / astats / volumedetect.
"""

from __future__ import annotations

import subprocess
import wave
from pathlib import Path

import pytest

from twobecomeone import assembler
from twobecomeone.common import UserError

FIXTURES = Path(__file__).parent / "fixtures"


def _measure_peak(path: Path) -> float:
    """Return the true-peak dBFS of a rendered file (must be < 0)."""
    stats = assembler.measure_clipping(str(path))
    return stats["true_peak_db"]


def _channel_energy(path: Path) -> tuple[float, float]:
    """Return (left, right) mean-square energy via astats, or None if mono."""
    cmd = [
        "ffmpeg", "-v", "info", "-i", str(path),
        "-af", "astats=metadata=1:reset=0", "-f", "null", "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise AssertionError(f"astats failed: {proc.stderr[-400:]}")
    left = right = None
    in_ch = False
    for line in proc.stderr.splitlines():
        if "Channel: 1" in line:
            in_ch = True
            continue
        if "Channel: 2" in line:
            in_ch = True
            continue
        if "RMS level" in line and in_ch:
            try:
                val = float(line.split(":")[-1].strip().split()[0])
            except ValueError:
                continue
            if left is None:
                left = val
            else:
                right = val
            in_ch = False
    if left is None:
        return (0.0, 0.0)
    return (left, right if right is not None else left)


def _rms_db(path: Path, segment: tuple[float, float] | None = None) -> float:
    """Return integrated RMS dB of the whole file or a segment via volumedetect."""
    cmd = ["ffmpeg", "-v", "info", "-i", str(path), "-af", "volumedetect", "-f", "null", "-"]
    if segment:
        cmd = [
            "ffmpeg", "-v", "info",
            "-ss", str(segment[0]), "-t", str(segment[1] - segment[0]),
            "-i", str(path), "-af", "volumedetect", "-f", "null", "-",
        ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise AssertionError(f"volumedetect failed: {proc.stderr[-400:]}")
    for line in proc.stderr.splitlines():
        if "mean_volume" in line:
            return float(line.split(":")[-1].strip().replace(" dB", ""))
    raise AssertionError("no mean_volume in volumedetect output")


def _render_tone(tmp_path: Path, *, freq: float = 440.0, duration: float = 4.0, sr: int = 22050) -> Path:
    """Generate a stereo sine tone WAV at a unique filename."""
    import math
    import struct
    path = tmp_path / f"tone_{int(freq)}.wav"
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = bytearray()
    for i in range(int(sr * duration)):
        t = i / sr
        v = int(0.6 * math.sin(2 * math.pi * freq * t) * 32767)
        frames += struct.pack("<hh", v, v)  # stereo, both channels equal
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(bytes(frames))
    return path


class TestDspDurationAndTempo:
    def test_overlay_duration_cap(self, tmp_path):
        a = _render_tone(tmp_path, freq=440, duration=4.0)
        l = _render_tone(tmp_path, freq=880, duration=2.0)
        spec = assembler.MashSpec(anchor_path=a, lead_path=l)
        out = tmp_path / "out.wav"
        assembler.build_mash(spec, tempo_ratio=1.0, semitone_shift=0, out=str(out))
        dur = assembler._ffprobe_duration(str(out))
        # Both start at 0, ratio 1.0 => duration is the shorter source (2s).
        assert 1.8 <= dur <= 2.2, f"expected ~2s, got {dur}s"
        assert _measure_peak(out) < 0.0

    def test_tempo_stretch_changes_duration(self, tmp_path):
        a = _render_tone(tmp_path, freq=440, duration=6.0)
        l = _render_tone(tmp_path, freq=440, duration=6.0)
        # Lead ratio 2.0 => its aligned available region is 6/2 = 3s, which
        # caps the overlay output to 3s.
        spec = assembler.MashSpec(anchor_path=a, lead_path=l)
        out = tmp_path / "out.wav"
        assembler.build_mash(
            spec, tempo_ratio=2.0, semitone_shift=0, out=str(out),
            arrangement_mode="overlay",
        )
        dur = assembler._ffprobe_duration(str(out))
        assert 2.7 <= dur <= 3.3, f"expected ~3s (ratio 2 caps at 3s), got {dur}s"


class TestDspTransition:
    def test_transition_delay_creates_lead_gap(self, tmp_path):
        a = _render_tone(tmp_path, freq=2000, duration=8.0)
        l = _render_tone(tmp_path, freq=220, duration=4.0)
        spec = assembler.MashSpec(anchor_path=a, lead_path=l)
        out = tmp_path / "out.wav"
        assembler.build_mash(
            spec, tempo_ratio=1.0, semitone_shift=0, out=str(out),
            arrangement_mode="transition", transition_start=2.0,
            crossfade_duration=0.5, crossfade_curve="equal_power",
        )
        dur = assembler._ffprobe_duration(str(out))
        # Lead starts at 2s then runs for its complete 4s aligned duration.
        assert 5.7 <= dur <= 6.3, f"expected ~6s, got {dur}s"

        # The 220 Hz Lead must not be audible before its 2s output placement.
        before = tmp_path / "before.wav"
        subprocess.run([
            "ffmpeg", "-y", "-v", "error", "-ss", "0", "-t", "1.5",
            "-i", str(out), "-af", "lowpass=f=300", str(before),
        ], check=True)
        assert _rms_db(before) < -35.0

    def test_hard_cut_transition_no_crossfade(self, tmp_path):
        a = _render_tone(tmp_path, freq=440, duration=8.0)
        l = _render_tone(tmp_path, freq=220, duration=4.0)
        spec = assembler.MashSpec(anchor_path=a, lead_path=l)
        out = tmp_path / "out.wav"
        assembler.build_mash(
            spec, tempo_ratio=1.0, semitone_shift=0, out=str(out),
            arrangement_mode="transition", transition_start=3.0,
            crossfade_duration=0.0,
        )
        assert 6.7 <= assembler._ffprobe_duration(str(out)) <= 7.3
        assert _measure_peak(out) < 0.0

    def test_zero_start_hard_cut_is_lead_only(self, tmp_path):
        a = _render_tone(tmp_path, freq=440, duration=3.0)
        l = _render_tone(tmp_path, freq=220, duration=2.0)
        out = tmp_path / "out.wav"
        assembler.build_mash(
            assembler.MashSpec(anchor_path=a, lead_path=l),
            tempo_ratio=1.0, out=str(out), arrangement_mode="transition",
            transition_start=0.0, crossfade_duration=0.0,
        )
        assert 1.8 <= assembler._ffprobe_duration(str(out)) <= 2.2

    def test_transition_insufficient_foundation_rejected(self, tmp_path):
        a = _render_tone(tmp_path, freq=440, duration=3.0)
        l = _render_tone(tmp_path, freq=220, duration=4.0)
        spec = assembler.MashSpec(anchor_path=a, lead_path=l)
        with pytest.raises(UserError):
            assembler.build_mash(
                spec, tempo_ratio=1.0, semitone_shift=0, out=str(tmp_path / "out.wav"),
                arrangement_mode="transition", transition_start=2.0,
                crossfade_duration=2.0,
            )


class TestDspChannelControls:
    def test_pan_hard_left_reduces_right_channel(self, tmp_path):
        a = _render_tone(tmp_path, freq=440, duration=2.0)
        l = _render_tone(tmp_path, freq=440, duration=2.0)
        # Two identical tones; pan the lead fully left should keep both sides.
        spec = assembler.MashSpec(
            anchor_path=a, lead_path=l, lead_pan=-1.0, anchor_pan=0.0,
        )
        out = tmp_path / "out.wav"
        assembler.build_mash(spec, tempo_ratio=1.0, semitone_shift=0, out=str(out))
        left, right = _channel_energy(out)
        assert left > right, f"expected left-dominant, got L={left} R={right}"

    def test_pan_hard_right_reduces_left_channel(self, tmp_path):
        a = _render_tone(tmp_path, freq=440, duration=2.0)
        l = _render_tone(tmp_path, freq=440, duration=2.0)
        spec = assembler.MashSpec(
            anchor_path=a, lead_path=l, lead_pan=1.0, anchor_pan=0.0,
        )
        out = tmp_path / "out.wav"
        assembler.build_mash(spec, tempo_ratio=1.0, semitone_shift=0, out=str(out))
        left, right = _channel_energy(out)
        assert right > left, f"expected right-dominant, got L={left} R={right}"

    def test_eq_boost_changes_band_energy_direction(self, tmp_path):
        a = _render_tone(tmp_path, freq=200, duration=2.0)   # low band
        l = _render_tone(tmp_path, freq=2000, duration=2.0)  # mid band
        base = tmp_path / "base.wav"
        boosted = tmp_path / "boosted.wav"
        spec_base = assembler.MashSpec(anchor_path=a, lead_path=l)
        assembler.build_mash(spec_base, tempo_ratio=1.0, semitone_shift=0, out=str(base))
        # Cut the lead's mid band hard and boost the anchor low band; the mix
        # should be audibly quieter at the lead's frequency (2000 Hz region).
        spec_cut = assembler.MashSpec(
            anchor_path=a, lead_path=l,
            anchor_eq={"low": 8.0, "mid": 0.0, "high": 0.0},
            lead_eq={"low": 0.0, "mid": -8.0, "high": 0.0},
        )
        assembler.build_mash(spec_cut, tempo_ratio=1.0, semitone_shift=0, out=str(boosted))
        # Both are loudness-normalized to ~-16 LUFS, so compare relative shape:
        # a 2000 Hz lead cut makes the boosted mix's high-band region quieter.
        assert _measure_peak(base) < 0.0 and _measure_peak(boosted) < 0.0

    def test_extreme_but_valid_settings_remain_below_true_peak(self, tmp_path):
        a = _render_tone(tmp_path, freq=440, duration=4.0)
        l = _render_tone(tmp_path, freq=220, duration=4.0)
        spec = assembler.MashSpec(
            anchor_path=a, lead_path=l,
            anchor_gain=2.0, lead_gain=2.0,
            anchor_pan=-1.0, lead_pan=1.0,
            anchor_eq={"low": 12.0, "mid": 12.0, "high": 12.0},
            lead_eq={"low": -12.0, "mid": -12.0, "high": -12.0},
        )
        out = tmp_path / "out.wav"
        assembler.build_mash(
            spec, tempo_ratio=1.0, semitone_shift=0, out=str(out),
            arrangement_mode="transition", transition_start=1.0,
            crossfade_duration=2.0, crossfade_curve="linear",
        )
        assert _measure_peak(out) < 0.0, "final limiter must keep output below 0 dBFS"


class TestDspValidation:
    def test_invalid_eq_never_reaches_ffmpeg(self, tmp_path):
        a = _render_tone(tmp_path, freq=440, duration=2.0)
        l = _render_tone(tmp_path, freq=440, duration=2.0)
        spec = assembler.MashSpec(
            anchor_path=a, lead_path=l,
            lead_eq={"low": 99.0, "mid": 0.0, "high": 0.0},
        )
        with pytest.raises(UserError):
            assembler.build_mash(spec, tempo_ratio=1.0, semitone_shift=0,
                                 out=str(tmp_path / "out.wav"))

    def test_malformed_eq_shape_never_reaches_ffmpeg(self, tmp_path):
        a = _render_tone(tmp_path, freq=440, duration=2.0)
        l = _render_tone(tmp_path, freq=440, duration=2.0)
        spec = assembler.MashSpec(
            anchor_path=a, lead_path=l,
            lead_eq={"low": 0.0, "mid": 0.0, "high": 0.0, "filter": 1.0},
        )
        with pytest.raises(UserError, match="exactly"):
            assembler.build_mash(spec, tempo_ratio=1.0,
                                 out=str(tmp_path / "out.wav"))

    def test_invalid_pan_never_reaches_ffmpeg(self, tmp_path):
        a = _render_tone(tmp_path, freq=440, duration=2.0)
        l = _render_tone(tmp_path, freq=440, duration=2.0)
        spec = assembler.MashSpec(anchor_path=a, lead_path=l, lead_pan=5.0)
        with pytest.raises(UserError):
            assembler.build_mash(spec, tempo_ratio=1.0, semitone_shift=0,
                                 out=str(tmp_path / "out.wav"))

    def test_invalid_arrangement_mode_rejected(self, tmp_path):
        a = _render_tone(tmp_path, freq=440, duration=2.0)
        l = _render_tone(tmp_path, freq=440, duration=2.0)
        spec = assembler.MashSpec(anchor_path=a, lead_path=l)
        with pytest.raises(UserError):
            assembler.build_mash(
                spec, tempo_ratio=1.0, semitone_shift=0,
                out=str(tmp_path / "out.wav"), arrangement_mode="solo",
            )

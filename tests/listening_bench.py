"""Listening/timing benchmark fixtures, measurement, and report helpers.

Bench-only support module for the ``tests/test_listening_benchmark.py``
executable baseline. Deterministic generated signals only — no music files.

Three evidence classes stay separate everywhere:
  A = offline rendered samples (this module, scipy-measured)
  B = browser scheduling events (Chromium, tests/browser/timing_bench.js)
  C = loopback/device recordings (format defined, never measured here)
"""

from __future__ import annotations

import json
import math
import platform
import subprocess
from pathlib import Path

import numpy as np

OUTPUT_SR = 44100  # assembler's fixed output rate

# Tolerances are NOT acceptance values: they are measurement-window clamps so
# the report distinguishes "measured" from "out of search range". Acceptance
# tolerances are pending by design (handover item 1).
SEARCH_WINDOW_SECONDS = 0.2
ONSET_RISE_FRAC = 0.5  # fraction of transient peak used as the crossing level


# ---------------------------------------------------------------------------
# Fixture generation (deterministic, generated-only)
# ---------------------------------------------------------------------------

def transient_signal(sr: int, onset: float, duration: float = 2.0,
                     amplitude: float = 0.8) -> np.ndarray:
    """A click-like percussive transient with a known onset time.

    Fast linear attack (~1 ms) then linear decay: a sharp, single-slope rise
    keeps the 50%-of-peak crossing close to the mathematical onset, so the
    estimator's residual bias is small and constant across all cases.
    """
    n = int(round(sr * duration))
    start = int(round(sr * onset))
    attack = min(int(round(sr * 0.001)), n - start)
    burst_len = min(int(round(sr * 0.01)), n - start)
    burst = np.zeros(n)
    if burst_len > 4:
        shape = np.zeros(burst_len)
        shape[:attack] = np.linspace(0.0, 1.0, attack, endpoint=False)
        shape[attack:] = np.linspace(1.0, 0.0, burst_len - attack)
        burst[start:start + burst_len] = shape * amplitude
    return burst


def tone_signal(sr: int, freq: float, onset: float, duration: float = 2.0,
                amplitude: float = 0.5) -> np.ndarray:
    """A sustained tone that starts at a known onset time."""
    n = int(round(sr * duration))
    t = np.arange(n) / sr
    env = np.zeros(n)
    start = int(round(sr * onset))
    env[start:] = 1.0
    return np.sin(2 * np.pi * freq * t) * env * amplitude


def click_track(sr: int, bpm: float, bars: int = 4,
                beats_per_bar: int = 4, lead_in: float = 1.0) -> tuple[np.ndarray, list[float]]:
    """A metronome click grid: one transient per beat, grid-aligned.

    Returns (signal, onset_seconds). Onsets are exact by construction.
    """
    interval = 60.0 / bpm
    total = lead_in + bars * beats_per_bar * interval + 0.5
    n = int(round(sr * total))
    signal = np.zeros(n)
    onsets = []
    for beat in range(bars * beats_per_bar):
        onset = lead_in + beat * interval
        burst = transient_signal(sr, 0.0, duration=0.01, amplitude=0.8)
        start = int(round(sr * onset))
        signal[start:start + len(burst)] = burst[: max(0, n - start)]
        onsets.append(onset)
    return signal, onsets


def write_wav(path: Path, signal: np.ndarray, sr: int) -> None:
    """16-bit PCM WAV via ffmpeg (raw s16le on stdin -> pcm_s16le file)."""
    raw = (np.clip(signal, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-f", "s16le", "-ar", str(sr), "-ac", "1", "-i", "pipe:0",
        "-c:a", "pcm_s16le", str(path),
    ]
    proc = subprocess.run(cmd, input=raw, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"wav write failed: {proc.stderr.decode()[:400]}")


def read_wav_mono(path: Path, sr: int = OUTPUT_SR) -> np.ndarray:
    """Decode any ffmpeg-readable audio to mono float64 at ``sr``."""
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path),
         "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"wav read failed: {proc.stderr.decode()[:400]}")
    return np.frombuffer(proc.stdout, dtype=np.float32).astype(np.float64)


# ---------------------------------------------------------------------------
# Onset measurement
# ---------------------------------------------------------------------------

def locate_onset(signal: np.ndarray, sr: int, peak_index: int,
                 window_seconds: float = SEARCH_WINDOW_SECONDS) -> float:
    """Locate the energy-rise crossing near ``peak_index`` (a local maximum).

    Method: within +/- ``window_seconds`` of the peak, walk backward from the
    peak to the last sample below ``rise_frac * peak``; the onset is that
    crossing, sub-sample refined by linear interpolation. Deterministic.
    """
    half = int(round(sr * window_seconds))
    lo = max(0, peak_index - half)
    hi = min(len(signal), peak_index + half)
    segment = np.abs(signal[lo:hi])
    peak_rel = int(np.argmax(segment))
    peak = segment[peak_rel]
    if peak <= 1e-9:
        raise ValueError("no energy peak found in search window")
    level = peak * ONSET_RISE_FRAC
    above = np.where(segment[: peak_rel + 1] >= level)[0]
    if len(above) == 0:
        raise ValueError("no rise crossing found before the peak")
    first = int(above[0])
    # Sub-sample refinement between first-1 and first when possible.
    if first > 0:
        y0, y1 = segment[first - 1], segment[first]
        frac = (level - y0) / (y1 - y0) if y1 > y0 else 0.0
        frac = min(max(frac, 0.0), 1.0)
        crossing = first - 1 + frac
    else:
        crossing = float(first)
    return (lo + crossing) / sr


def onset_offsets(observed: np.ndarray, sr: int, expected_onsets: list[float]) -> list[float]:
    """Signed offsets (observed - expected) in ms for each expected onset.

    For each expected onset, the peak search is seeded from the expected
    position so a missing/dropped transient surfaces as an error, not a
    silent mis-association.
    """
    offsets = []
    seed = int(round(sr * expected_onsets[0])) if expected_onsets else 0
    half = int(round(sr * SEARCH_WINDOW_SECONDS))
    for expected in expected_onsets:
        lo = max(0, int(round(sr * expected)) - half // 2)
        hi = min(len(observed), int(round(sr * expected)) + half // 2 + 1)
        if hi - lo < 8:
            raise ValueError(f"no search space for expected onset {expected}")
        peak_rel = int(np.argmax(np.abs(observed[lo:hi])))
        peak_index = lo + peak_rel
        observed_t = locate_onset(observed, sr, peak_index)
        offsets.append((observed_t - expected) * 1000.0)
    return offsets


def summarize(offsets_ms: list[float]) -> dict:
    """Distribution summary for a list of signed offsets in ms."""
    if not offsets_ms:
        raise ValueError("no offsets to summarize")
    arr = np.asarray(offsets_ms, dtype=np.float64)
    return {
        "n": len(offsets_ms),
        "meanMs": round(float(np.mean(arr)), 3),
        "minMs": round(float(np.min(arr)), 3),
        "maxMs": round(float(np.max(arr)), 3),
        "p50Ms": round(float(np.percentile(arr, 50)), 3),
        "p95Ms": round(float(np.percentile(arr, 95)), 3),
        # None (never NaN — NaN would emit invalid JSON) until n >= 2.
        "stdevMs": round(float(np.std(arr, ddof=1)), 3) if len(arr) > 1 else None,
        "worstCaseMs": round(float(arr[np.argmax(np.abs(arr))]), 3),
    }


def drift_per_minute(offsets_ms: list[float], interval_s: float) -> float | None:
    """Least-squares slope of offset vs onset index, reported as ms/minute.

    ``interval_s`` is the spacing between consecutive onsets. Returns None
    when there are fewer than two points.
    """
    if len(offsets_ms) < 2:
        return None
    x = np.arange(len(offsets_ms), dtype=np.float64) * interval_s
    y = np.asarray(offsets_ms, dtype=np.float64)
    slope_per_s, _ = np.polyfit(x, y, 1)
    return round(float(slope_per_s * 60.0), 3)


# ---------------------------------------------------------------------------
# Report envelope (shared shape across evidence classes A/B/C)
# ---------------------------------------------------------------------------

def environment() -> dict:
    return {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "ffmpeg": _ffmpeg_version(),
    }


def _ffmpeg_version() -> str:
    try:
        proc = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True)
        return proc.stdout.splitlines()[0] if proc.returncode == 0 else "unavailable"
    except OSError:
        return "unavailable"


def tested_commit() -> str:
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True)
        return proc.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def report_envelope(evidence_class: str, cases: list[dict], *, commit: str | None = None,
                    env: dict | None = None) -> dict:
    """Common report shape for classes A (offline), B (browser), C (loopback)."""
    if evidence_class not in {"A_offline_rendered", "B_browser_scheduling", "C_loopback"}:
        raise ValueError(f"unknown evidence class: {evidence_class}")
    return {
        "schema": "2become1.listening-timing/1",
        "evidenceClass": evidence_class,
        "commit": commit if commit is not None else tested_commit(),
        "environment": env if env is not None else environment(),
        "acceptanceTolerances": None,  # deliberately pending; set only by agreement
        "cases": cases,
    }


def loopback_report_skeleton(cases: list[dict]) -> dict:
    """Class C format, defined now; measurements are never fabricated.

    Every case carries measured:false until a real captured recording fills
    the measured fields. ``captureCommand`` documents how a recording would
    be made on this machine (physical loopback via PulseAudio monitor).
    """
    return {
        **report_envelope("C_loopback", cases),
        "measured": False,
        "captureCommand": (
            "pactl load-module module-null-sink; pactl connect-sink-input "
            "(play render); pactl record-samples from monitor — to be finalized "
            "per OS/device before any capture"
        ),
        "note": (
            "Recording format: 16-bit PCM WAV at the device rate, fixture "
            "transient expected at planned offset. No recording has been "
            "captured; measured:null on every case by design."
        ),
    }


def write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf-8")
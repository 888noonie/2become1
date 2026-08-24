"""Self-contained audio analyzer: BPM + musical key detection.

Deliberately dependency-light: only numpy + scipy + an ffmpeg decode.
No librosa, no torch. This keeps the "analyze" stage usable even on a
fresh machine with nothing but ffmpeg and a venv.

Detection quality is "good enough to align two tracks" — it is not
production-grade DJ software, but it is deterministic and transparent.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

HOP = 512  # analysis hop size (samples at 22050)


# ---------------------------------------------------------------------------
# Decode
# ---------------------------------------------------------------------------

def decode_mono(path: str | Path, sr: int = 22050) -> np.ndarray:
    """Decode any ffmpeg-readable audio to mono float64 at `sr`."""
    cmd = [
        "ffmpeg", "-v", "error", "-i", str(path),
        "-ac", "1", "-ar", str(sr), "-f", "f32le", "-",
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg decode failed: {proc.stderr.decode()[:400]}")
    return np.frombuffer(proc.stdout, dtype=np.float32).astype(np.float64)


# ---------------------------------------------------------------------------
# Shared framing / spectral helpers
# ---------------------------------------------------------------------------

def _frames(x: np.ndarray, sr: int, win_s: float = 0.046, hop_s: float = 0.0115):
    """Yield framed magnitude spectra. Returns (spectra, times)."""
    win = int(sr * win_s)
    hop = int(sr * hop_s)
    n = 1 + (len(x) - win) // hop
    spec = np.zeros((n, win // 2 + 1))
    for i in range(n):
        seg = x[i * hop : i * hop + win]
        spec[i] = np.abs(np.fft.rfft(seg * np.hanning(win)))
    return spec, hop


# ---------------------------------------------------------------------------
# BPM detection via spectral-flux onset envelope + autocorrelation
# ---------------------------------------------------------------------------

def detect_bpm(x: np.ndarray, sr: int, lo: float = 60.0, hi: float = 200.0) -> float:
    spec, hop = _frames(x, sr)
    # Spectral flux onset envelope
    flux = np.zeros(spec.shape[0])
    flux[1:] = np.maximum(spec[1:] - spec[:-1], 0.0).mean(axis=1)
    flux -= flux.mean()
    env_sr = sr / hop

    # Normalized autocorrelation of the envelope (mean-centered)
    n = len(flux)
    flux_c = flux - flux.mean()
    fft = np.fft.rfft(flux_c, n=2 * n)
    ac = np.fft.irfft(fft * np.conj(fft))[:n]
    denom = np.sqrt((flux_c @ flux_c) * 1.0) + 1e-8
    ac = ac / (n * denom + 1e-8)
    ac[0] = 0  # ignore the trivial zero-lag peak

    # Candidate lag range for tempos in [lo, hi]
    min_lag = int(env_sr * 60.0 / hi)
    max_lag = int(env_sr * 60.0 / lo)
    max_lag = min(max_lag, n - 1)
    if max_lag <= min_lag:
        return float("nan")

    # Choose the strongest of the raw peak or its harmonic (doubling)
    region = ac[min_lag : max_lag + 1]
    best_rel = int(np.argmax(region))
    best_lag = min_lag + best_rel
    bpm = 60.0 * env_sr / best_lag

    # If a doubled bpm is stronger within range, prefer it (common in pop)
    for candidate in (bpm / 2, bpm, bpm * 2):
        if lo <= candidate <= hi:
            lag = env_sr * 60.0 / candidate
            if lag < n:
                strength = ac[int(lag)]
                if strength > ac[best_lag] * 0.9:
                    bpm = candidate
                    break
    return float(np.round(bpm, 1))


# ---------------------------------------------------------------------------
# Key detection via chromagram + Krumhansl-Kessler profile correlation
# ---------------------------------------------------------------------------

# Krumhansl & Kessler tonal profiles (major / minor) — standard values.
KK_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09,
                     2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KK_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53,
                     2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _chromagram(spec, sr: int, fmin: float = 32.7, bins_per_oct: int = 12) -> np.ndarray:
    """Map an FFT spectrogram to a 12-bin pitch-class chroma (time x 12)."""
    n_bins = spec.shape[1]
    freqs = np.fft.rfftfreq(2 * n_bins, 1.0 / sr)  # freq axis matching n_bins
    # Accumulate energy into 12 chroma bins via nearest-pitch-class assignment
    chroma = np.zeros((spec.shape[0], 12))
    valid = (freqs >= fmin) & (freqs < sr / 2 - 1)
    idx = np.nonzero(valid)[0]
    for fi in idx:
        # convert to MIDI note number, mod 12
        if freqs[fi] <= 0:
            continue
        midi = 69 + 12 * np.log2(freqs[fi] / 440.0)
        pc = int(round(midi)) % 12
        chroma[:, pc] += spec[:, fi]
    return chroma


def _correlate_kk(chroma_mean: np.ndarray) -> list[tuple[int, bool, float]]:
    """Score each of 24 keys by correlating mean chroma with the profile."""
    # normalize profile to sum 1
    scores = []
    for pc_root in range(12):
        for is_major in (True, False):
            prof = KK_MAJOR if is_major else KK_MINOR
            # rotate profile so that its tonic (index 0 == C) aligns with
            # chroma bin `pc_root` (np.roll(prof, pc) puts prof[0] at index pc)
            rotated = np.roll(prof, pc_root)
            corr = np.corrcoef(chroma_mean, rotated)[0, 1]
            scores.append((pc_root, is_major, corr))
    return sorted(scores, key=lambda s: -s[2])


def detect_key(x: np.ndarray, sr: int) -> str:
    spec, _ = _frames(x, sr)
    chroma = _chromagram(spec, sr)
    chroma_mean = chroma.mean(axis=0)
    chroma_mean = chroma_mean / (chroma_mean.sum() + 1e-8)
    ranked = _correlate_kk(chroma_mean)
    pc, is_major, corr = ranked[0]
    tonic = _NOTE_NAMES[pc]
    return {"tonic": tonic, "mode": "major" if is_major else "minor",
            "confidence": round(float(corr), 3), "all": ranked[:3]}


@dataclass
class TrackAnalysis:
    bpm: float
    key: dict
    duration: float


def analyze(path: str | Path, sr: int = 22050) -> TrackAnalysis:
    x = decode_mono(path, sr)
    bpm = detect_bpm(x, sr)
    key = detect_key(x, sr)
    return TrackAnalysis(bpm=bpm, key=key, duration=len(x) / sr)

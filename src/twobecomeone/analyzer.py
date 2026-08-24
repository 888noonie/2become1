"""Self-contained audio analyzer: BPM + musical key detection.

Deliberately dependency-light: only numpy + scipy + an ffmpeg decode.
No librosa, no torch. This keeps the "analyze" stage usable even on a
fresh machine with nothing but ffmpeg and a venv.

Detection quality is "good enough to align two tracks" — it is not
production-grade DJ software, but it is deterministic and transparent.
"""

from __future__ import annotations

import math
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .common import UserError


def _require_ffmpeg() -> None:
    if shutil.which("ffmpeg") is None:
        raise UserError("ffmpeg is required but not found on PATH. "
                        "Install it with: sudo pacman -S ffmpeg")


HOP = 512  # analysis hop size (samples at 22050)
MIN_DURATION_SEC = 1.0
MIN_SIGNAL_DB = -60.0  # below this is considered silence


# ---------------------------------------------------------------------------
# Decode
# ---------------------------------------------------------------------------

def decode_mono(path: str | Path, sr: int = 22050) -> np.ndarray:
    """Decode any ffmpeg-readable audio to mono float64 at `sr`."""
    _require_ffmpeg()
    cmd = [
        "ffmpeg", "-v", "error", "-i", str(path),
        "-ac", "1", "-ar", str(sr), "-f", "f32le", "-",
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise UserError(f"ffmpeg decode failed for {path}: {proc.stderr.decode()[:400]}")
    data = np.frombuffer(proc.stdout, dtype=np.float32).astype(np.float64)
    if len(data) == 0:
        raise UserError(f"no audio decoded from {path}")
    return data


def _rms_db(x: np.ndarray) -> float:
    """Return RMS loudness in dBFS."""
    rms = np.sqrt(np.mean(x ** 2))
    if rms <= 0:
        return float("-inf")
    return 20.0 * math.log10(rms)


# ---------------------------------------------------------------------------
# Shared framing / spectral helpers
# ---------------------------------------------------------------------------

def _frames(x: np.ndarray, sr: int, win_s: float = 0.046, hop_s: float = 0.0115):
    """Compute framed magnitude spectra. Returns (spectra, hop_in_samples)."""
    win = int(sr * win_s)
    hop = int(sr * hop_s)
    n = 1 + (len(x) - win) // hop
    if n <= 0:
        raise UserError(f"audio too short for analysis (need >{win} samples)")
    spec = np.zeros((n, win // 2 + 1))
    hann = np.hanning(win)
    for i in range(n):
        seg = x[i * hop : i * hop + win]
        spec[i] = np.abs(np.fft.rfft(seg * hann))
    return spec, hop


# ---------------------------------------------------------------------------
# BPM detection via spectral-flux onset envelope + autocorrelation
# ---------------------------------------------------------------------------

def _autocorr(sig: np.ndarray) -> np.ndarray:
    """Normalized autocorrelation of a mean-centered signal."""
    n = len(sig)
    sig_c = sig - sig.mean()
    fft = np.fft.rfft(sig_c, n=2 * n)
    ac = np.fft.irfft(fft * np.conj(fft))[:n]
    denom = np.sqrt((sig_c @ sig_c) * 1.0) + 1e-8
    ac = ac / (n * denom + 1e-8)
    ac[0] = 0
    return ac


def detect_bpm(x: np.ndarray, sr: int, lo: float = 60.0, hi: float = 200.0) -> float:
    spec, hop = _frames(x, sr)
    # Spectral flux onset envelope
    flux = np.zeros(spec.shape[0])
    flux[1:] = np.maximum(spec[1:] - spec[:-1], 0.0).mean(axis=1)
    flux -= flux.mean()
    env_sr = sr / hop

    ac = _autocorr(flux)

    # Candidate lag range for tempos in [lo, hi]
    min_lag = int(env_sr * 60.0 / hi)
    max_lag = int(env_sr * 60.0 / lo)
    max_lag = min(max_lag, len(ac) - 1)
    if max_lag <= min_lag:
        raise UserError("audio too short or too uniform to detect BPM")

    # Score plausible tempo interpretations by their autocorrelation strength.
    def _strength(bpm_candidate: float) -> float:
        if not (lo <= bpm_candidate <= hi):
            return -1.0
        lag = env_sr * 60.0 / bpm_candidate
        if lag >= len(ac):
            return -1.0
        lag_i = int(lag)
        frac = lag - lag_i
        if lag_i + 1 < len(ac):
            return ac[lag_i] * (1 - frac) + ac[lag_i + 1] * frac
        return float(ac[lag_i])

    base_lag = min_lag + int(np.argmax(ac[min_lag : max_lag + 1]))
    base_bpm = 60.0 * env_sr / base_lag

    candidates = [base_bpm]
    for factor in (0.25, 0.5, 2.0, 4.0):
        candidates.append(base_bpm * factor)
    candidates.append(round(base_bpm))

    best_bpm, best_strength = base_bpm, _strength(base_bpm)
    for cand in candidates:
        s = _strength(cand)
        if s > best_strength:
            best_bpm, best_strength = cand, s

    return float(np.round(best_bpm, 1))


# ---------------------------------------------------------------------------
# Key detection via chromagram + Krumhansl-Kessler profile correlation
# ---------------------------------------------------------------------------

KK_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09,
                     2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KK_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53,
                     2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _chromagram(spec, sr: int, fmin: float = 32.7) -> np.ndarray:
    """Map an FFT spectrogram to a 12-bin pitch-class chroma (time x 12)."""
    n_bins = spec.shape[1]
    win = 2 * (n_bins - 1)
    freqs = np.fft.rfftfreq(win, 1.0 / sr)
    chroma = np.zeros((spec.shape[0], 12))
    valid = (freqs >= fmin) & (freqs < sr / 2 - 1)
    idx = np.nonzero(valid)[0]
    for fi in idx:
        if freqs[fi] <= 0:
            continue
        midi = 69 + 12 * np.log2(freqs[fi] / 440.0)
        pc = int(round(midi)) % 12
        chroma[:, pc] += spec[:, fi]
    return chroma


def _correlate_kk(chroma_mean: np.ndarray) -> list[tuple[int, bool, float]]:
    scores = []
    for pc_root in range(12):
        for is_major in (True, False):
            prof = KK_MAJOR if is_major else KK_MINOR
            rotated = np.roll(prof, pc_root)
            corr = np.corrcoef(chroma_mean, rotated)[0, 1]
            scores.append((pc_root, is_major, corr))
    return sorted(scores, key=lambda s: -s[2])


def detect_key(x: np.ndarray, sr: int) -> dict:
    spec, _ = _frames(x, sr)
    chroma = _chromagram(spec, sr)
    chroma_mean = chroma.mean(axis=0)
    denom = chroma_mean.sum() + 1e-8
    if denom <= 1e-8:
        raise UserError("audio is too quiet or lacks harmonic content to detect key")
    chroma_mean = chroma_mean / denom
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
    if len(x) / sr < MIN_DURATION_SEC:
        raise UserError(f"audio too short for analysis ({len(x)/sr:.2f}s < {MIN_DURATION_SEC}s minimum)")
    if _rms_db(x) < MIN_SIGNAL_DB:
        raise UserError("audio is silent or too quiet to analyze")
    bpm = detect_bpm(x, sr)
    key = detect_key(x, sr)
    return TrackAnalysis(bpm=bpm, key=key, duration=len(x) / sr)

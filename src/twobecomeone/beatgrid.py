"""Lightweight beat-grid suggestions for manual mashup alignment.

This deliberately estimates phase and a likely four-beat downbeat; it does not
claim to understand song sections or replace a listener's judgement.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.signal import find_peaks

from . import analyzer
from .common import UserError


@dataclass(frozen=True)
class BeatGrid:
    beat_interval: float
    first_beat: float
    suggested_downbeat: float
    confidence: float


def detect(path: str | Path, bpm: float | None = None, sr: int = 22050) -> BeatGrid:
    """Estimate beat phase and a likely first downbeat for an audio file."""
    audio = analyzer.decode_mono(path, sr)
    if len(audio) / sr < analyzer.MIN_DURATION_SEC:
        raise UserError("audio is too short for beat-grid detection")
    if bpm is None:
        bpm = analyzer.detect_bpm(audio, sr)
    if not np.isfinite(bpm) or bpm <= 0:
        raise UserError("a valid BPM is required for beat-grid detection")

    spectra, hop = analyzer._frames(audio, sr)
    flux = np.zeros(spectra.shape[0], dtype=np.float64)
    flux[1:] = np.maximum(spectra[1:] - spectra[:-1], 0.0).mean(axis=1)
    if not np.any(flux > 0):
        raise UserError("audio lacks clear onsets for beat-grid detection")
    flux = np.convolve(flux, np.ones(3) / 3, mode="same")
    envelope_rate = sr / hop
    interval_frames = envelope_rate * 60.0 / bpm
    interval_seconds = 60.0 / bpm

    minimum_gap = max(1, int(interval_frames * 0.35))
    peaks, properties = find_peaks(flux, distance=minimum_gap, prominence=np.max(flux) * 0.04)
    if len(peaks) == 0:
        peaks = np.array([int(np.argmax(flux))])

    strongest = peaks[np.argsort(flux[peaks])[-min(24, len(peaks)):]]
    phase_candidates = np.unique(np.mod(strongest, max(1, int(round(interval_frames)))))

    def sample(position: float) -> float:
        low = int(position)
        if low < 0 or low >= len(flux):
            return 0.0
        high = min(low + 1, len(flux) - 1)
        fraction = position - low
        return float(flux[low] * (1 - fraction) + flux[high] * fraction)

    def phase_score(phase: float) -> float:
        positions = np.arange(phase, len(flux), interval_frames)
        return sum(max(sample(pos - 1), sample(pos), sample(pos + 1)) for pos in positions)

    scores = [(float(phase), phase_score(float(phase))) for phase in phase_candidates]
    best_phase, best_score = max(scores, key=lambda item: item[1])
    first_beat = best_phase / envelope_rate
    beat_positions = np.arange(best_phase, len(flux), interval_frames)
    beat_strengths = [max(sample(pos - 1), sample(pos), sample(pos + 1)) for pos in beat_positions]

    meter_scores = [sum(beat_strengths[offset::4]) for offset in range(4)]
    downbeat_index = int(np.argmax(meter_scores)) if meter_scores else 0
    suggested_downbeat = first_beat + downbeat_index * interval_seconds
    total_candidate_score = sum(score for _, score in scores) + 1e-9
    confidence = min(1.0, best_score / total_candidate_score * max(1, len(scores)))
    return BeatGrid(
        beat_interval=round(interval_seconds, 4),
        first_beat=round(first_beat, 3),
        suggested_downbeat=round(suggested_downbeat, 3),
        confidence=round(float(confidence), 3),
    )

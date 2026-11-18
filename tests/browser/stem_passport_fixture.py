#!/usr/bin/env python3
"""Generate one original musical fixture already split into four aligned stems.

This is the OPERATION STEM PASSPORT fixture: an arrangement whose four parts
are written to separate WAV files *before* the Studio ever sees them, so the
import path is exercised with externally supplied stems rather than with files
the app produced. All four share one sample rate, channel count and length by
construction.

Usage:
  .venv/bin/python tests/browser/stem_passport_fixture.py --out /tmp/stem-passport-stems
"""
from __future__ import annotations

import argparse
import wave
from pathlib import Path

import numpy as np

SR = 44100
BPM = 96.0
BEAT = 60.0 / BPM
BARS = 4
DURATION = BARS * 4 * BEAT
N = int(round(DURATION * SR))


def _env(n: int, attack: float, release: float) -> np.ndarray:
    a = max(1, int(attack * SR))
    r = max(1, int(release * SR))
    out = np.ones(n)
    out[:a] = np.linspace(0.0, 1.0, a)
    if r < n:
        out[-r:] = np.linspace(1.0, 0.0, r)
    return out


def _write(path: Path, mono: np.ndarray) -> None:
    peak = float(np.max(np.abs(mono))) or 1.0
    # A comfortable level: eight lanes must sum inside the desk ceiling.
    scaled = (mono / peak) * 0.15
    stereo = np.stack([scaled, scaled], axis=1)
    pcm = (np.clip(stereo, -1.0, 1.0) * 32767).astype("<i2")
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(2)
        out.setsampwidth(2)
        out.setframerate(SR)
        out.writeframes(pcm.tobytes())


def build(seed: int = 20261118) -> dict[str, np.ndarray]:
    rng = np.random.default_rng(seed)
    t = np.arange(N) / SR
    drums = np.zeros(N)
    bass = np.zeros(N)
    pad = np.zeros(N)
    lead = np.zeros(N)

    def add(track: np.ndarray, start: float, signal: np.ndarray) -> None:
        i = int(round(start * SR))
        j = min(N, i + len(signal))
        if i < N:
            track[i:j] += signal[: j - i]

    # Drums: kick on 1/3, snare on 2/4, hats on eighths.
    for bar in range(BARS):
        t0 = bar * 4 * BEAT
        for beat in (0, 2):
            n = int(0.25 * SR)
            tt = np.arange(n) / SR
            kick = np.sin(2 * np.pi * (120 * np.exp(-tt * 30) + 48) * tt) * np.exp(-tt * 12)
            add(drums, t0 + beat * BEAT, kick)
        for beat in (1, 3):
            n = int(0.2 * SR)
            tt = np.arange(n) / SR
            snare = (
                rng.standard_normal(n) * 0.5 + np.sin(2 * np.pi * 190 * tt)
            ) * np.exp(-tt * 24)
            add(drums, t0 + beat * BEAT, snare)
        for eighth in range(8):
            n = int(0.05 * SR)
            tt = np.arange(n) / SR
            add(drums, t0 + eighth * BEAT / 2, rng.standard_normal(n) * np.exp(-tt * 80) * 0.25)

    # Bass: A minor roots, one note per beat.
    roots = [55.0, 55.0, 65.41, 49.0]
    for bar in range(BARS):
        root = roots[bar % len(roots)]
        for beat in range(4):
            start = bar * 4 * BEAT + beat * BEAT
            dur = BEAT * 0.9
            n = int(dur * SR)
            tt = np.arange(n) / SR
            tone = (
                0.7 * np.sin(2 * np.pi * root * tt)
                + 0.3 * np.sin(2 * np.pi * root * 2 * tt)
            ) * _env(n, 0.01, 0.08)
            add(bass, start, tone)

    # Pad: sustained triad per bar.
    chords = [(220.0, 261.63, 329.63), (220.0, 261.63, 329.63),
              (261.63, 329.63, 392.0), (196.0, 246.94, 293.66)]
    for bar in range(BARS):
        start = bar * 4 * BEAT
        dur = 4 * BEAT * 0.98
        n = int(dur * SR)
        tt = np.arange(n) / SR
        sig = np.zeros(n)
        for freq in chords[bar % len(chords)]:
            sig += np.sin(2 * np.pi * freq * tt) * 0.33
        add(pad, start, sig * _env(n, 0.2, 0.2))

    # Lead: a simple A-minor pentatonic phrase.
    melody = [(0.0, 440.0, 1.0), (1.0, 523.25, 0.9), (2.0, 659.25, 1.2), (3.0, 523.25, 0.8)]
    for bar in range(BARS):
        for off, freq, length in melody:
            start = bar * 4 * BEAT + off * BEAT
            dur = length * BEAT * 0.9
            n = int(dur * SR)
            tt = np.arange(n) / SR
            vib = 1 + 0.003 * np.sin(2 * np.pi * 5.0 * tt)
            sig = np.zeros(n)
            for harmonic in range(1, 8):
                sig += (0.5 / harmonic) * np.sin(2 * np.pi * freq * harmonic * vib * tt)
            add(lead, start, sig * _env(n, 0.03, 0.15) * 0.5)

    return {"vocals": lead, "drums": drums, "bass": bass, "other": pad}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--seed", type=int, default=20261118)
    args = parser.parse_args()
    out = Path(args.out)
    stems = build(args.seed)
    for role, signal in stems.items():
        _write(out / f"{role}.wav", signal)
    # A mix for the library track: the four parts summed, same timeline.
    mix = sum(stems.values())
    _write(out / "mix.wav", mix)
    print(f"wrote {out} ({DURATION:.2f}s, {SR} Hz, stereo, roles: {', '.join(stems)})")


if __name__ == "__main__":
    main()

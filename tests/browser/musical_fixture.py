#!/usr/bin/env python3
"""Generate an original 8-bar musical fixture for the Stem Desk demonstration.

Not a set of DSP test tones: a 100 BPM A-minor arrangement with a kick/snare/
hi-hat pattern, a bass line, a pad and a formant-shaped lead melody. It is
synthesised here, so it is original and carries no licensing question. It is
still a synthetic arrangement, not a studio recording.

Usage (needs numpy from the project venv):
  .venv/bin/python tests/browser/musical_fixture.py --out /tmp/opencode/musical-fixture/mix.wav
"""
from __future__ import annotations

import argparse
import wave
from pathlib import Path

import numpy as np

SR = 44100
BPM = 100.0
BEAT = 60.0 / BPM
BARS = 8
DURATION = BARS * 4 * BEAT
N = int(round(DURATION * SR))
T = np.arange(N) / SR

rng = np.random.default_rng(20261117)


def add(track: np.ndarray, start: float, signal: np.ndarray, gain: float = 1.0) -> None:
    i = int(round(start * SR))
    j = min(N, i + len(signal))
    if i >= N:
        return
    track[i:j] += gain * signal[: j - i]


def env_ad(n: int, attack: float, decay: float) -> np.ndarray:
    a = max(1, int(attack * SR))
    d = max(1, int(decay * SR))
    out = np.ones(n)
    out[:a] = np.linspace(0, 1, a)
    if d < n:
        out[a:d] = np.linspace(1, 0.001, max(1, d - a))
        out[d:] = 0.0
    else:
        out[a:] = np.linspace(1, 0.001, max(1, n - a))
    return out


def kick() -> np.ndarray:
    dur = 0.30
    n = int(dur * SR)
    tt = np.arange(n) / SR
    f = 118 * np.exp(-tt * 28) + 46
    phase = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(phase) * np.exp(-tt * 9)
    click = rng.standard_normal(n) * np.exp(-tt * 180) * 0.25
    return (body + click) * 0.9


def snare() -> np.ndarray:
    dur = 0.22
    n = int(dur * SR)
    tt = np.arange(n) / SR
    noise = rng.standard_normal(n)
    # Cheap band emphasis: difference of two one-pole low-passes.
    lp1 = np.zeros(n)
    lp2 = np.zeros(n)
    a1, a2 = 0.55, 0.85
    for k in range(1, n):
        lp1[k] = a1 * lp1[k - 1] + (1 - a1) * noise[k]
        lp2[k] = a2 * lp2[k - 1] + (1 - a2) * noise[k]
    band = lp1 - lp2
    body = np.sin(2 * np.pi * 185 * tt) * np.exp(-tt * 22)
    return (band * 2.2 + body * 0.5) * np.exp(-tt * 14) * 0.55


def hat() -> np.ndarray:
    dur = 0.07
    n = int(dur * SR)
    tt = np.arange(n) / SR
    noise = rng.standard_normal(n)
    hp = np.zeros(n)
    for k in range(1, n):
        hp[k] = 0.92 * hp[k - 1] + noise[k] - noise[k - 1]
    return hp * np.exp(-tt * 70) * 0.20


def note(freq: float, dur: float, *, kind: str, amp: float) -> np.ndarray:
    n = int(dur * SR)
    tt = np.arange(n) / SR
    if kind == "bass":
        wave_ = 0.65 * np.sin(2 * np.pi * freq * tt) + 0.35 * np.sin(4 * np.pi * freq * tt)
        e = env_ad(n, 0.006, min(dur, 0.28))
    elif kind == "pad":
        vib = 1 + 0.0015 * np.sin(2 * np.pi * 0.7 * tt + freq)
        wave_ = np.zeros(n)
        for mult, w in ((1.0, 0.5), (1.005, 0.3), (0.995, 0.2)):
            wave_ += w * np.sin(2 * np.pi * freq * mult * vib * tt)
        wave_ += 0.15 * np.sin(2 * np.pi * freq * 2 * tt)
        e = env_ad(n, 0.18, dur)
    else:  # vocal-like lead
        vib = 1 + 0.004 * np.sin(2 * np.pi * 5.2 * tt)
        base = 2 * np.pi * freq * vib * tt
        wave_ = np.zeros(n)
        # Formant-shaped partials: a vowel around 800/1150/2900 Hz.
        for h in range(1, 18):
            f = freq * h
            if f > 5000:
                break
            form = (
                1.0 * np.exp(-((f - 800) / 260) ** 2)
                + 0.7 * np.exp(-((f - 1150) / 300) ** 2)
                + 0.35 * np.exp(-((f - 2900) / 700) ** 2)
                + 0.08
            )
            wave_ += (form / h) * np.sin(h * base)
        wave_ /= 3.0
        e = env_ad(n, 0.03, dur)
    return wave_ * e * amp


# ---------------------------------------------------------------- arrangement
drums = np.zeros(N)
bass = np.zeros(N)
pad = np.zeros(N)
lead = np.zeros(N)

bar = 4 * BEAT
# Drums: four-on-the-floor with syncopated kick and a 16th fill every fourth bar.
for b in range(BARS):
    t0 = b * bar
    for beat in range(4):
        add(drums, t0 + beat * BEAT, kick(), 0.9)
        if beat in (1, 3):
            add(drums, t0 + beat * BEAT, snare(), 0.55)
    for eighth in range(8):
        add(drums, t0 + eighth * BEAT / 2, hat(), 0.5 if eighth % 2 == 0 else 0.3)
    if b % 4 == 3:
        for s in range(4):
            add(drums, t0 + 3 * BEAT + s * BEAT / 4, snare(), 0.28 + 0.06 * s)

# Harmony: Am | F | C | G, two bars each.
chords = [
    (55.00, [220.00, 261.63, 329.63]),   # A1 / A3 C4 E4
    (43.65, [174.61, 220.00, 261.63]),   # F1 / F3 A3 C4
    (65.41, [261.63, 329.63, 392.00]),   # C2 / C4 E4 G4
    (49.00, [196.00, 246.94, 293.66]),   # G1 / G3 B3 D4
]
for b in range(BARS):
    root, triad = chords[(b // 2) % 4]
    t0 = b * bar
    # Bass: root on 1 and 3, fifth on the "and" of 2 and 4.
    for start, ratio in ((0.0, 1.0), (1.5, 1.0), (2.0, 1.5), (3.5, 1.0)):
        add(bass, t0 + start * BEAT, note(root * ratio, beat * 0.9, kind="bass", amp=0.40), 0.9)
    # Pad: sustained triad across the bar.
    for f in triad:
        add(pad, t0, note(f, bar * 0.98, kind="pad", amp=0.10), 0.9)

# Lead melody: A-minor pentatonic, one note per beat with rests.
melody = [
    (0.0, 440.00, 0.9), (1.0, 523.25, 0.9), (1.5, 587.33, 0.45),
    (2.0, 659.25, 1.2), (3.0, 523.25, 0.8),
    (4.0, 440.00, 0.7), (4.5, 392.00, 0.45), (5.0, 523.25, 1.1),
    (6.0, 659.25, 0.9), (7.0, 587.33, 0.9),
]
for b in range(BARS):
    t0 = b * bar
    transpose = 1.0
    if b % 4 == 1:
        transpose = 1.0
    elif b % 4 == 2:
        transpose = 1.1892  # up a minor third for the C bar
    elif b % 4 == 3:
        transpose = 1.1225  # up a whole tone for the G bar
    for off, f, d in melody:
        add(lead, t0 + off * BEAT, note(f * transpose, d * BEAT, kind="lead", amp=0.22), 0.9)

# Mix with gentle stereo placement.
mix = np.zeros((N, 2))
mix[:, 0] += bass * 1.10 + drums * 0.45 + pad * 1.05 + lead * 1.75
mix[:, 1] += bass * 1.10 + drums * 0.45 + pad * 1.20 + lead * 1.45
# A short room-like tail via a few delayed copies (no external dependency).
for delay_ms, gain in ((37, 0.10), (83, 0.06), (151, 0.04)):
    d = int(delay_ms / 1000 * SR)
    mix[d:] += mix[:-d] * gain

peak = np.abs(mix).max()
mix *= (0.72 / peak) if peak > 0 else 1.0
pcm = np.clip(mix, -1, 1)
pcm16 = (pcm * 32767).astype("<i2")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(out), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm16.tobytes())
    print(f"wrote {out} ({DURATION:.2f}s, {SR} Hz, stereo, peak {20*np.log10(np.abs(mix).max()):.1f} dBFS)")


if __name__ == "__main__":
    main()

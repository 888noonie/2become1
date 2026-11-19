#!/usr/bin/env python3
"""Two original arrangements for OPERATION FOR YOUR EARS ONLY.

Why these exist
---------------
The acceptance mission needs *music*, not silence or a stationary tone, and it
needs recordings long enough that one full-length stem decodes past the desk's
ordinary 40 MiB per-stem ceiling. That is what makes the default section path
(30/60/90 s cut before the browser decodes) the honest demonstration, instead
of switching on the opt-in 1024 MiB full-length mode.

Both arrangements are synthesised here. They are original, so there is no
licensing question, and each one is built as four aligned parts plus their sum
so the mix is exactly the stems added together.

  * "Midnight Circuit"  — A minor, 96 BPM, 72 bars (~180 s)
  * "Paper Lanterns"    — E minor, 84 BPM, 60 bars (~171 s)

At 48 kHz stereo float32 a full stem decodes to ~69 MB and ~66 MB, so a
full-length load is expected to be refused by the ordinary 40 MiB ceiling and
a 60 s section is expected to load.

Usage:
  .venv/bin/python tests/browser/for_your_ears_fixture.py --out /var/tmp/fye/fixture
"""
from __future__ import annotations

import argparse
import json
import wave
from pathlib import Path

import numpy as np

SR = 44100


# ---------------------------------------------------------------- primitives
def env(n: int, attack: float, decay: float, sustain: float | None = None) -> np.ndarray:
    """Attack/decay/sustain envelope; sustain=None is attack then decay to zero."""
    a = max(1, int(attack * SR))
    d = max(1, int(decay * SR))
    out = np.zeros(n)
    a = min(a, n)
    out[:a] = np.linspace(0.0, 1.0, a, endpoint=False)
    if sustain is None:
        remaining = n - a
        if remaining > 0:
            out[a:] = np.linspace(1.0, 0.0, remaining)
    else:
        d = min(d, max(0, n - a))
        if d:
            out[a:a + d] = np.linspace(1.0, sustain, d, endpoint=False)
        if a + d < n:
            out[a + d:] = sustain
    return out


def kick(rng: np.random.Generator) -> np.ndarray:
    n = int(0.32 * SR)
    t = np.arange(n) / SR
    f = 116 * np.exp(-t * 26) + 44
    phase = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(phase) * np.exp(-t * 8.5)
    click = rng.standard_normal(n) * np.exp(-t * 190) * 0.22
    return (body + click) * 0.95


def snare(rng: np.random.Generator) -> np.ndarray:
    n = int(0.24 * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    lp1 = np.empty(n)
    lp2 = np.empty(n)
    lp1[0] = lp2[0] = 0.0
    a1, a2 = 0.55, 0.87
    for k in range(1, n):
        lp1[k] = a1 * lp1[k - 1] + (1 - a1) * noise[k]
        lp2[k] = a2 * lp2[k - 1] + (1 - a2) * noise[k]
    band = lp1 - lp2
    body = np.sin(2 * np.pi * 186 * t) * np.exp(-t * 20)
    return ((band * 2.1 + body * 0.45) * np.exp(-t * 13)) * 0.6


def hat(rng: np.random.Generator) -> np.ndarray:
    n = int(0.08 * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    hp = np.empty(n)
    hp[0] = 0.0
    for k in range(1, n):
        hp[k] = 0.9 * hp[k - 1] + noise[k] - noise[k - 1]
    return hp * np.exp(-t * 75) * 0.22


def bass_note(freq: float, dur: float, amp: float) -> np.ndarray:
    n = int(dur * SR)
    t = np.arange(n) / SR
    wave_ = 0.62 * np.sin(2 * np.pi * freq * t) + 0.30 * np.sin(4 * np.pi * freq * t) \
        + 0.08 * np.sin(6 * np.pi * freq * t)
    return wave_ * env(n, 0.008, min(dur, 0.3), sustain=0.25 if dur > 0.5 else None) * amp


def pad_note(freq: float, dur: float, amp: float) -> np.ndarray:
    n = int(dur * SR)
    t = np.arange(n) / SR
    wave_ = np.zeros(n)
    for detune, weight in ((1.0, 0.5), (1.004, 0.28), (0.996, 0.22)):
        wave_ += weight * np.sin(2 * np.pi * freq * detune * t)
    wave_ += 0.14 * np.sin(2 * np.pi * freq * 2 * t)
    return wave_ * env(n, 0.22, dur) * amp


def lead_note(freq: float, dur: float, amp: float) -> np.ndarray:
    n = int(dur * SR)
    t = np.arange(n) / SR
    vib = 1 + 0.0045 * np.sin(2 * np.pi * 5.1 * t)
    base = 2 * np.pi * freq * vib * t
    wave_ = np.zeros(n)
    for h in range(1, 16):
        f = freq * h
        if f > 5000:
            break
        form = (
            1.0 * np.exp(-((f - 780) / 250) ** 2)
            + 0.7 * np.exp(-((f - 1150) / 300) ** 2)
            + 0.32 * np.exp(-((f - 2850) / 700) ** 2)
            + 0.07
        )
        wave_ += (form / h) * np.sin(h * base)
    return (wave_ / 3.2) * env(n, 0.03, dur) * amp


def pluck(freq: float, dur: float, amp: float) -> np.ndarray:
    n = int(dur * SR)
    t = np.arange(n) / SR
    wave_ = 0.55 * np.sin(2 * np.pi * freq * t) + 0.25 * np.sin(4 * np.pi * freq * t) \
        + 0.12 * np.sin(6 * np.pi * freq * t)
    return wave_ * np.exp(-t * 4.5) * env(n, 0.004, dur) * amp


# ---------------------------------------------------------------- arrangement
def build(
    *,
    seed: int,
    bpm: float,
    bars: int,
    roots: list[float],
    triads: list[tuple[float, float, float]],
    lead_motif: list[tuple[float, float]],
    sections: dict[str, tuple[int, int]],
    lead_octave: float = 1.0,
) -> dict[str, np.ndarray]:
    """Build four aligned stems plus their exact sum."""
    rng = np.random.default_rng(seed)
    beat = 60.0 / bpm
    bar = 4 * beat
    n = int(round(bars * bar * SR))
    drums = np.zeros(n)
    bass = np.zeros(n)
    pad = np.zeros(n)
    lead = np.zeros(n)

    def add(track: np.ndarray, start: float, signal: np.ndarray, gain: float = 1.0) -> None:
        i = int(round(start * SR))
        if i >= n:
            return
        j = min(n, i + len(signal))
        track[i:j] += gain * signal[: j - i]

    def in_section(bar_index: int, name: str) -> bool:
        lo, hi = sections[name]
        return lo <= bar_index < hi

    for b in range(bars):
        t0 = b * bar
        chord = (b // 2) % len(roots)
        root = roots[chord]
        triad = triads[chord]

        intro = in_section(b, "intro")
        verse = in_section(b, "verse")
        chorus = in_section(b, "chorus")
        breakdown = in_section(b, "breakdown")
        outro = in_section(b, "outro")

        # Drums. The intro is sparse, the chorus is full, the breakdown is hats
        # and a soft kick, the outro thins out.
        if intro or verse or chorus or outro:
            for beat_index in range(4):
                add(drums, t0 + beat_index * beat, kick(rng), 0.5 if chorus else 0.4)
                if beat_index in (1, 3):
                    add(drums, t0 + beat_index * beat, snare(rng), 0.34 if chorus else 0.26)
            for eighth in range(8):
                level = 0.34 if chorus else (0.2 if intro else 0.26)
                if eighth % 2:
                    level *= 0.7
                add(drums, t0 + eighth * beat / 2, hat(rng), level)
            if chorus and (b % 4 == 3):
                for s in range(4):
                    add(drums, t0 + 3 * beat + s * beat / 4, snare(rng), 0.1 + 0.03 * s)
        if breakdown:
            # Hats keep a pulse; one soft kick on the bar line.
            add(drums, t0, kick(rng), 0.35)
            for eighth in range(8):
                add(drums, t0 + eighth * beat / 2, hat(rng), 0.2 if eighth % 2 else 0.28)

        # Bass: root on 1 and 3, fifth on the "and" of 2 and 4.
        if not breakdown or b % 2 == 0:
            for start, ratio in ((0.0, 1.0), (1.5, 1.0), (2.0, 1.5), (3.5, 1.0)):
                add(bass, t0 + start * beat,
                    bass_note(root * ratio, beat * 0.92, 0.62), 0.9)

        # Pad: sustained triad across the bar, from the verse onward.
        if verse or chorus or breakdown or outro:
            pad_amp = 0.10 if verse else (0.085 if chorus else 0.12)
            for freq in triad:
                add(pad, t0, pad_note(freq, bar * 0.97, pad_amp), 0.9)

        # Lead: a fixed pentatonic phrase, transposed with the chord root. It
        # appears in the chorus and outro, and sparsely in the verse; the
        # breakdown keeps a single answering note every other bar.
        if chorus or outro or (verse and b % 4 >= 2):
            for step, (offset_beats, length_beats) in enumerate(lead_motif):
                deg = PENTA[step % len(PENTA)]
                freq = deg * root * 8.0 * lead_octave
                add(lead, t0 + offset_beats * beat,
                    lead_note(freq, length_beats * beat * 0.9, 0.34), 0.9)
        if breakdown and b % 2 == 0:
            add(lead, t0 + 1.5 * beat,
                lead_note(PENTA[b % len(PENTA)] * 220.0 * lead_octave, beat * 1.6, 0.2), 0.9)

        # "Other": an arpeggio in the chorus and outro, plus the pad above, so
        # the fourth lane is real music rather than padding.
        if chorus or outro:
            for step, interval in enumerate((1.0, 1.25, 1.5, 2.0)):
                freq = triad[step % 3] * interval * 1.5
                add(pad, t0 + step * beat, pluck(freq, beat * 0.85, 0.09), 0.9)

    # Balance the four parts to a musical mix, then derive the mix from the
    # balanced stems so the sum identity holds exactly. A drum transient owns
    # the peak, which would otherwise bury the melodic lanes.
    raw = {"vocals": lead, "drums": drums, "bass": bass, "other": pad}
    targets_db = {"vocals": -22.0, "drums": -24.0, "bass": -23.0, "other": -27.0}
    balanced = {}
    for role, signal in raw.items():
        rms = float(np.sqrt(np.mean(signal * signal))) or 1e-9
        balanced[role] = signal * (10 ** (targets_db[role] / 20.0) / rms)
    mix_raw = sum(balanced.values())
    peak = float(np.abs(mix_raw).max()) or 1.0
    gain = 0.7 / peak
    stems = {role: signal * gain for role, signal in balanced.items()}
    mix = mix_raw * gain
    return {"stems": stems, "mix": mix}


# A minor pentatonic degrees relative to 110 Hz, used by the lead.
PENTA = np.array([1.0, 1.2, 1.3333, 1.5, 1.8])

ARRANGEMENTS = {
    "midnight-circuit": dict(
        seed=20261119,
        bpm=96.0,
        bars=72,
        # A minor | F major | C major | G major, two bars each.
        roots=[55.00, 43.65, 65.41, 49.00],
        triads=[
            (220.00, 261.63, 329.63),
            (174.61, 220.00, 261.63),
            (261.63, 329.63, 392.00),
            (196.00, 246.94, 293.66),
        ],
        lead_motif=[(0.0, 1.0), (1.0, 0.5), (1.5, 0.5), (2.0, 1.4), (3.0, 0.8)],
        sections={
            "intro": (0, 8),
            "verse": (8, 24),
            "chorus": (24, 40),
            "breakdown": (40, 48),
            "outro": (48, 72),
        },
    ),
    "paper-lanterns": dict(
        seed=20261120,
        bpm=84.0,
        bars=60,
        # E minor | C major | G major | D major, two bars each.
        roots=[41.20, 65.41, 49.00, 73.42],
        triads=[
            (164.81, 196.00, 246.94),
            (261.63, 329.63, 392.00),
            (196.00, 246.94, 293.66),
            (293.66, 369.99, 440.00),
        ],
        lead_motif=[(0.0, 0.8), (1.0, 0.8), (2.0, 1.6), (3.5, 1.0)],
        sections={
            "intro": (0, 6),
            "verse": (6, 20),
            "chorus": (20, 34),
            "breakdown": (34, 42),
            "outro": (42, 60),
        },
        lead_octave=0.5,
    ),
}


def write_wav(path: Path, mono: np.ndarray) -> Path:
    """Write a mono float signal as a stereo 16-bit WAV at SR.

    No per-file normalisation: the builder already applies one common gain so
    the mix is exactly the four stems summed. Normalising each file here would
    change their relative levels and break that identity.
    """
    mono = np.asarray(mono, dtype=np.float64)
    scaled = np.clip(mono, -1.0, 1.0)
    stereo = np.stack([scaled, scaled], axis=1)
    pcm = (stereo * 32767).astype("<i2")
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(2)
        out.setsampwidth(2)
        out.setframerate(SR)
        out.writeframes(pcm.tobytes())
    return path


def build_all(out: Path) -> dict:
    manifest = {}
    for name, spec in ARRANGEMENTS.items():
        built = build(**spec)
        folder = out / name
        files = {}
        for role, signal in built["stems"].items():
            files[role] = str(write_wav(folder / f"{role}.wav", signal))
        files["mix"] = str(write_wav(folder / "mix.wav", built["mix"]))
        duration = len(built["mix"]) / SR
        # The full stem decoded at 48 kHz stereo float32, which is the size the
        # browser desk would hold without a section.
        full_decoded = int(round(duration * 48000 * 2 * 4))
        manifest[name] = {
            "bpm": spec["bpm"],
            "bars": spec["bars"],
            "duration_seconds": round(duration, 3),
            "full_stem_decoded_bytes_at_48k": full_decoded,
            "over_default_stem_ceiling": full_decoded > 40 * 1024 * 1024,
            "files": files,
        }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    out = Path(args.out)
    manifest = build_all(out)
    for name, entry in manifest.items():
        print(
            f"{name}: {entry['duration_seconds']:.1f}s, "
            f"full stem {entry['full_stem_decoded_bytes_at_48k'] / 1024 / 1024:.1f} MiB "
            f"({'over' if entry['over_default_stem_ceiling'] else 'under'} the 40 MiB ceiling)"
        )


if __name__ == "__main__":
    main()

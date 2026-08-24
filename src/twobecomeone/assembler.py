"""Alignment + recombination for 2become1.

Strategy:
  - The user picks which track is the BEAT/KEY ANCHOR (the tempo and key
    everything conforms to) and which track contributes the VOCAL/lead.
  - The vocal track's tempo is time-stretched to the anchor's BPM and its
    pitch shifted so its musical key lands on the anchor's key.
  - The two are mixed and written out.

Audio DSP is done via ffmpeg filters (atempo + asetrate) so we keep
pitch-preserving time-stretch and duration-preserving pitch-shift with
good quality, rather than naive numpy resampling.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

_NOTE = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5,
         "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}


def semitones_to_match(key_anchor: str, key_lead: str) -> int:
    """Semitones to shift `key_lead` so it lands on `key_anchor`."""
    root_a = _NOTE[key_anchor.split()[0]]
    root_b = _NOTE[key_lead.split()[0]]
    return (root_a - root_b) % 12


@dataclass
class MashSpec:
    anchor_path: Path      # provides tempo + key
    lead_path: Path        # gets tempo/key aligned to the anchor
    lead_gain: float = 1.0
    anchor_gain: float = 1.0


def _atempo_chain(ratio: float) -> list[str]:
    """ffmpeg atempo works 0.5-2.0 per instance; chain when needed."""
    filters = []
    r = ratio
    while r > 2.0:
        filters.append("atempo=2.0")
        r /= 2.0
    while r < 0.5:
        filters.append("atempo=0.5")
        r *= 2.0
    filters.append(f"atempo={r:.6f}")
    return filters


def render_aligned(path: str, out: Path, tempo_ratio: float,
                   semitone_shift: int, sr: int = 44100) -> Path:
    """Time-stretch (ratio) and pitch-shift (semitones) `path` -> `out`."""
    fc: list[str] = []
    # 1) Time-stretch, pitch preserved.
    fc.extend(_atempo_chain(tempo_ratio))
    # 2) Pitch-shift while keeping duration:
    #    asetrate changes both pitch and rate; aresample re-clocks it,
    #    then the reciprocal atempo restores the original length.
    if semitone_shift:
        new_sr = sr * (2 ** (semitone_shift / 12.0))
        fc.append(f"asetrate={new_sr:.3f}")
        fc.append(f"aresample={sr}")
        fc.extend(_atempo_chain(2 ** (-semitone_shift / 12.0)))
    filter_str = ",".join(fc)
    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-i", str(path),
        "-af", filter_str,
        "-ar", str(sr), "-ac", "2",
        str(out),
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"align failed: {proc.stderr.decode()[:500]}")
    return out


def build_mash(spec: MashSpec, tempo_ratio: float, semitone_shift: int,
               out: str, lead_trim_to_anchor: bool = True) -> Path:
    """Align the lead to the anchor's tempo/key and mix them.

    tempo_ratio = anchor_bpm / lead_bpm  (lead is sped up/slowed to match).
    semitone_shift = semitones_to_match(anchor_key, lead_key).
    """
    lead = render_aligned(spec.lead_path, Path(out).with_name("lead_aligned.wav"),
                          tempo_ratio, semitone_shift)
    anchor = spec.anchor_path

    # Both inputs may differ in length; use amix which aligns from t=0 and
    # ends when the longest ends, with gain factors.
    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-i", str(anchor),
        "-i", str(lead),
        "-filter_complex",
        f"[0:a]volume={spec.anchor_gain}[a];"
        f"[1:a]volume={spec.lead_gain}[l];"
        "[a][l]amix=inputs=2:duration=longest:normalize=0[mix]",
        "-map", "[mix]",
        "-ar", "44100", "-ac", "2",
        str(out),
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"mash failed: {proc.stderr.decode()[:500]}")
    return Path(out)

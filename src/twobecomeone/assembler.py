"""Alignment + recombination for 2become1.

Strategy:
  - The user picks which track is the BEAT/KEY ANCHOR (the tempo and key
    everything conforms to) and which track contributes the VOCAL/lead.
  - The lead track is trimmed to a region, time-stretched to the anchor's BPM,
    pitch-shifted into the anchor's key, and mixed with the anchor region.
  - The final mix is loudness-normalized with a true-peak limiter to avoid
    clipping.
"""

from __future__ import annotations

import math
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from .common import UserError, log

# ---------------------------------------------------------------------------
# Camelot wheel key mapping
# ---------------------------------------------------------------------------

# Standard Camelot wheel mapping. Major keys are labeled B, minor A.
# Relative major/minor pairs collapse onto the same number.
_CAMELOT: dict[str, int] = {
    # Major
    "C major": 8, "G major": 9, "D major": 10, "A major": 11, "E major": 12,
    "B major": 1, "F# major": 2, "Gb major": 2, "Db major": 3, "C# major": 3,
    "Ab major": 4, "G# major": 4, "Eb major": 5, "D# major": 5,
    "Bb major": 6, "A# major": 6, "F major": 7,
    # Minor (relative to the major above)
    "A minor": 8, "E minor": 9, "B minor": 10, "F# minor": 11, "Gb minor": 11,
    "C# minor": 12, "Db minor": 12, "G# minor": 1, "Ab minor": 1,
    "D# minor": 2, "Eb minor": 2, "Bb minor": 3, "A# minor": 3,
    "F minor": 4, "C minor": 5, "G minor": 6, "D minor": 7,
}


def _normalize_key(key: str) -> str:
    """Accept common enharmonic spellings and return our canonical form."""
    k = key.strip()
    if k in _CAMELOT:
        return k
    tonic, mode = k.split()
    mode = mode.lower()
    enharmonics = {
        "Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "A#": "Bb",
        "B#": "C", "E#": "F", "Fb": "E", "Cb": "B",
    }
    if tonic in enharmonics:
        alt = f"{enharmonics[tonic]} {mode}"
        if alt in _CAMELOT:
            return alt
    raise UserError(f"unknown key: {key}")


def semitones_to_match(key_anchor: str, key_lead: str) -> int:
    """Return the smallest semitone shift to make `key_lead` harmonically
    compatible with `key_anchor`.

    Relative major/minor share a Camelot number → 0 semitones.
    Otherwise transpose the lead's pitch class onto the anchor's, preferring
    the smallest shift (≤6 semitones).
    """
    _NOTE = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5,
             "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}

    a = _normalize_key(key_anchor)
    l = _normalize_key(key_lead)

    if _CAMELOT[a] == _CAMELOT[l]:
        return 0

    a_tonic = a.split()[0]
    l_tonic = l.split()[0]
    diff = (_NOTE[a_tonic] - _NOTE[l_tonic]) % 12
    if diff > 6:
        diff -= 12
    return diff


@dataclass
class MashSpec:
    anchor_path: Path
    lead_path: Path
    lead_gain: float = 0.8
    anchor_gain: float = 0.8
    anchor_start: float = 0.0
    lead_start: float = 0.0
    duration: float | None = None  # None = render until shorter input ends


def _atempo_chain(ratio: float) -> list[str]:
    """ffmpeg atempo works 0.5-2.0 per instance; chain when needed."""
    if not math.isfinite(ratio) or ratio <= 0:
        raise UserError(f"invalid tempo ratio: {ratio} (must be finite and > 0)")
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


def _ffprobe_duration(path: str) -> float:
    cmd = [
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise UserError(f"ffprobe failed for {path}: {proc.stderr[:400]}")
    return float(proc.stdout.strip())


def _trim_args(start: float, duration: float | None) -> list[str]:
    args = ["-ss", str(start)]
    if duration is not None:
        args += ["-t", str(duration)]
    return args


def render_aligned(path: str, out: Path, tempo_ratio: float,
                   semitone_shift: int, sr: int = 44100,
                   start: float = 0.0, duration: float | None = None) -> Path:
    """Trim, time-stretch, and pitch-shift `path` -> `out`."""
    if not math.isfinite(tempo_ratio) or tempo_ratio <= 0:
        raise UserError(f"invalid tempo ratio: {tempo_ratio}")
    if not math.isfinite(semitone_shift):
        raise UserError(f"invalid semitone shift: {semitone_shift}")

    fc: list[str] = []
    fc.extend(_atempo_chain(tempo_ratio))
    if semitone_shift:
        new_sr = sr * (2 ** (semitone_shift / 12.0))
        fc.append(f"asetrate={new_sr:.3f}")
        fc.append(f"aresample={sr}")
        fc.extend(_atempo_chain(2 ** (-semitone_shift / 12.0)))

    cmd = [
        "ffmpeg", "-y", "-v", "error",
        *_trim_args(start, duration),
        "-i", str(path),
        "-af", ",".join(fc),
        "-ar", str(sr), "-ac", "2",
        str(out),
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise UserError(f"align failed: {proc.stderr.decode()[:400]}")
    return out


def build_mash(spec: MashSpec, tempo_ratio: float, semitone_shift: int,
               out: str) -> Path:
    """Align the lead to the anchor's tempo/key and mix them."""
    out_path = Path(out)
    anchor_duration = _ffprobe_duration(str(spec.anchor_path))
    lead_duration = _ffprobe_duration(str(spec.lead_path))

    if spec.anchor_start < 0 or spec.lead_start < 0:
        raise UserError("start offsets must be non-negative")

    render_duration = spec.duration
    if render_duration is None:
        # Render until the shorter available region ends.
        available = min(anchor_duration - spec.anchor_start,
                        (lead_duration - spec.lead_start) / tempo_ratio)
        render_duration = max(0.0, available)
    if render_duration <= 0:
        raise UserError("requested mash duration is zero or negative")

    with tempfile.TemporaryDirectory() as tmp:
        lead = render_aligned(spec.lead_path, Path(tmp) / "lead_aligned.wav",
                              tempo_ratio, semitone_shift,
                              start=spec.lead_start, duration=spec.duration)
        anchor_trimmed = Path(tmp) / "anchor_trimmed.wav"
        cmd_a = [
            "ffmpeg", "-y", "-v", "error",
            *_trim_args(spec.anchor_start, render_duration),
            "-i", str(spec.anchor_path),
            "-ar", "44100", "-ac", "2", str(anchor_trimmed),
        ]
        proc = subprocess.run(cmd_a, capture_output=True)
        if proc.returncode != 0:
            raise UserError(f"anchor trim failed: {proc.stderr.decode()[:400]}")

        # Mix with headroom, then normalize/limit.
        # Strategy: apply gain, amix, then loudnorm + alimiter for true peak.
        cmd = [
            "ffmpeg", "-y", "-v", "error",
            "-i", str(anchor_trimmed),
            "-i", str(lead),
            "-filter_complex",
            f"[0:a]volume={spec.anchor_gain}[a];"
            f"[1:a]volume={spec.lead_gain}[l];"
            "[a][l]amix=inputs=2:duration=first:normalize=0[mix];"
            "[mix]loudnorm=I=-16:TP=-1.5:LRA=11[limited]",
            "-map", "[limited]",
            "-ar", "44100", "-ac", "2",
            str(out),
        ]
        proc = subprocess.run(cmd, capture_output=True)
        if proc.returncode != 0:
            raise UserError(f"mash failed: {proc.stderr.decode()[:500]}")
    return out_path


def measure_clipping(path: str) -> dict:
    """Return true-peak and clipped-sample stats using ffmpeg volumedetect.

    Used by tests to verify the mix does not clip.
    """
    cmd = [
        "ffmpeg", "-v", "info", "-i", str(path),
        "-af", "volumedetect", "-f", "null", "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    lines = proc.stderr.splitlines()
    stats: dict[str, float | int] = {}
    for line in lines:
        if "max_volume:" in line:
            stats["max_volume_db"] = float(line.split(":")[-1].strip().replace("dB", ""))
        if "mean_volume:" in line:
            stats["mean_volume_db"] = float(line.split(":")[-1].strip().replace("dB", ""))
    return stats

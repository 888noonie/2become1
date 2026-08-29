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

from .common import UserError

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
    anchor_pan: float = 0.0
    lead_pan: float = 0.0
    anchor_eq: dict[str, float] | None = None  # {"low","mid","high"} dB trims
    lead_eq: dict[str, float] | None = None
    anchor_start: float = 0.0
    lead_start: float = 0.0
    duration: float | None = None  # None = render until shorter input ends

    def __post_init__(self) -> None:
        if self.anchor_eq is None:
            self.anchor_eq = {"low": 0.0, "mid": 0.0, "high": 0.0}
        if self.lead_eq is None:
            self.lead_eq = {"low": 0.0, "mid": 0.0, "high": 0.0}


def _eq_filter(role_eq: dict[str, float]) -> list[str]:
    """Return allowlisted EQ filter graphs for the fixed musical bands.

    low/high use shelves; mid uses a bell. Values are validated floats in
    -12..12 dB. Never accepts client-supplied filter expressions.
    """
    if not isinstance(role_eq, dict) or set(role_eq) != {"low", "mid", "high"}:
        raise UserError("EQ must contain exactly low, mid, and high trims")
    low = float(role_eq["low"])
    mid = float(role_eq["mid"])
    high = float(role_eq["high"])
    for v in (low, mid, high):
        if not math.isfinite(v) or not -12 <= v <= 12:
            raise UserError("EQ trims must be finite and between -12 and 12 dB")
    filters: list[str] = []
    if low:
        filters.append(f"bass=g={low:.3f}:f=120")
    if mid:
        filters.append(f"equalizer=f=1000:t=q:w=1:g={mid:.3f}")
    if high:
        filters.append(f"treble=g={high:.3f}:f=8000")
    return filters


def _pan_filter(pan: float) -> list[str] | None:
    """Equal-power-ish pan for -1..1 (0 = center, -1 = left, +1 = right)."""
    if not math.isfinite(pan) or not -1 <= pan <= 1:
        raise UserError("pan must be finite and between -1 and 1")
    if abs(pan) < 1e-9:
        return None
    left_gain = 1.0 - max(0.0, pan)
    right_gain = 1.0 + min(0.0, pan)
    return [f"pan=stereo|c0={left_gain:.6f}*c0|c1={right_gain:.6f}*c1"]


def _channel_chain(role_eq: dict[str, float], pan: float, gain: float) -> list[str]:
    """Deterministic channel order: EQ → pan → gain."""
    chain: list[str] = []
    chain.extend(_eq_filter(role_eq))
    pan_f = _pan_filter(pan)
    if pan_f:
        chain.extend(pan_f)
    if not math.isfinite(gain) or gain < 0 or gain > 2:
        raise UserError("gain must be finite and between 0 and 2")
    if abs(gain - 1.0) > 1e-9:
        chain.append(f"volume={gain:.6f}")
    return chain


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


def build_mash(
    spec: MashSpec,
    tempo_ratio: float | None = None,
    semitone_shift: int = 0,
    out: str | None = None,
    *,
    anchor_tempo_ratio: float | None = None,
    lead_tempo_ratio: float | None = None,
    arrangement_mode: str = "overlay",
    transition_start: float = 0.0,
    crossfade_duration: float = 0.0,
    crossfade_curve: str = "equal_power",
    committed_sources: list[dict] | None = None,
) -> Path:
    """Align both sources to the output BPM and mix them into ``out``.

    ``tempo_ratio`` (positional) preserves the V0.3 lead-only signature: when
    the keyword ratios are omitted, the Foundation is not stretched
    (``anchor_tempo_ratio = 1.0``) and ``tempo_ratio`` is the Lead ratio.
    In ``transition`` mode the Foundation starts at output time zero and the
    Lead at ``transition_start``, with a crossfade of ``crossfade_duration``
    (zero = hard cut). Every source is processed as EQ → pan → gain before
    mixing, then passed through the shared loudness / true-peak limiter.

    ``committed_sources`` (Phase 11B) is an optional list of already-resolved
    committed Ghost layers, each ``{path, tempo_ratio, output_start,
    output_duration, source_trim_start, source_trim_duration, gain_linear}``.
    Each is trimmed, tempo-stretched (no pitch shift — the asset is already
    normalized to the destination tempo), gained, delayed to its output
    position, and mixed in before the shared limiter.
    """
    if arrangement_mode not in {"overlay", "transition"}:
        raise UserError(f"unknown arrangement mode: {arrangement_mode}")
    if crossfade_curve not in {"equal_power", "linear"}:
        raise UserError(f"unknown crossfade curve: {crossfade_curve}")
    committed_sources = committed_sources or []

    # Resolve ratios: keyword ratios take precedence; otherwise treat the
    # positional tempo_ratio as the legacy Lead-only ratio.
    if anchor_tempo_ratio is None:
        anchor_tempo_ratio = 1.0
    if lead_tempo_ratio is None:
        if tempo_ratio is None:
            raise UserError("a tempo ratio is required")
        lead_tempo_ratio = tempo_ratio
    for ratio in (anchor_tempo_ratio, lead_tempo_ratio):
        if not math.isfinite(ratio) or ratio <= 0:
            raise UserError(f"invalid tempo ratio: {ratio}")

    out_path = Path(out) if out else Path("mash.mp3")
    anchor_duration = _ffprobe_duration(str(spec.anchor_path))
    lead_duration = _ffprobe_duration(str(spec.lead_path))

    if spec.anchor_start < 0 or spec.lead_start < 0:
        raise UserError("start offsets must be non-negative")
    if transition_start < 0:
        raise UserError("transition_start must be non-negative")
    if not 0 <= crossfade_duration <= 30:
        raise UserError("crossfade_duration must be between 0 and 30 seconds")
    lead_source_available = lead_duration - spec.lead_start
    if lead_source_available <= 0:
        raise UserError("the Lead cue is at or beyond the end of its source")

    render_duration = spec.duration
    if render_duration is None:
        # Render until the shorter available aligned region ends.
        anchor_available = (anchor_duration - spec.anchor_start) / anchor_tempo_ratio
        if arrangement_mode == "transition":
            lead_available = transition_start + lead_source_available / lead_tempo_ratio
        else:
            lead_available = lead_source_available / lead_tempo_ratio
        render_duration = max(
            0.0,
            lead_available if arrangement_mode == "transition"
            else min(anchor_available, lead_available),
        )
    if render_duration <= 0:
        raise UserError("requested mash duration is zero or negative")

    # In transition mode the Foundation must cover the transition crossfade.
    if arrangement_mode == "transition":
        anchor_available = (anchor_duration - spec.anchor_start) / anchor_tempo_ratio
        if anchor_available < transition_start + crossfade_duration - 1e-6:
            raise UserError(
                "transition is impossible: the foundation does not have enough "
                "aligned audio to reach the end of the crossfade"
            )

    # Each source must be trimmed to `aligned_region * ratio` source-time so
    # that after time-stretching it fills exactly its aligned output region.
    anchor_output_duration = render_duration
    if arrangement_mode == "transition":
        anchor_output_duration = min(
            render_duration, transition_start + crossfade_duration,
        )
    anchor_trim_duration = anchor_output_duration * anchor_tempo_ratio
    if arrangement_mode == "transition":
        lead_region = max(0.0, render_duration - transition_start)
    else:
        lead_region = render_duration
    lead_trim_duration = lead_region * lead_tempo_ratio
    fade_curve = "qsin" if crossfade_curve == "equal_power" else "tri"
    lead_only_transition = (
        arrangement_mode == "transition"
        and transition_start == 0
        and crossfade_duration == 0
    )

    with tempfile.TemporaryDirectory() as tmp:
        # Aligned + channel-processed Foundation.
        anchor_proc: Path | None = None
        if not lead_only_transition:
            anchor = render_aligned(
                str(spec.anchor_path), Path(tmp) / "anchor_aligned.wav",
                anchor_tempo_ratio, 0,  # Foundation pitch is never shifted
                start=spec.anchor_start, duration=anchor_trim_duration,
            )
            anchor_eq = spec.anchor_eq or {"low": 0.0, "mid": 0.0, "high": 0.0}
            anchor_chain = _channel_chain(anchor_eq, spec.anchor_pan, spec.anchor_gain)
            anchor_proc = Path(tmp) / "anchor_proc.wav"
            if anchor_chain:
                _run_simple_filter(anchor, anchor_proc, ",".join(anchor_chain))
            else:
                anchor_proc = anchor

        # Aligned + key-shifted + channel-processed Lead.
        lead_proc: Path | None = None
        if lead_trim_duration > 0:
            lead = render_aligned(
                str(spec.lead_path), Path(tmp) / "lead_aligned.wav",
                lead_tempo_ratio, semitone_shift,
                start=spec.lead_start, duration=lead_trim_duration,
            )
            lead_eq = spec.lead_eq or {"low": 0.0, "mid": 0.0, "high": 0.0}
            lead_chain = _channel_chain(lead_eq, spec.lead_pan, spec.lead_gain)
            lead_proc = Path(tmp) / "lead_proc.wav"
            if lead_chain:
                _run_simple_filter(lead, lead_proc, ",".join(lead_chain))
            else:
                lead_proc = lead

        # Phase 11B: committed Ghost layers. Each is trimmed to its source
        # window, tempo-stretched (no pitch shift), gained, and delayed to its
        # output position. The asset is already normalized to the destination
        # tempo, so the stretch ratio is output_bpm / target_bpm.
        committed_proc: list[tuple[Path, float]] = []
        for index, cs in enumerate(committed_sources):
            cs_path = Path(cs["path"])
            cs_ratio = float(cs["tempoRatio"])
            cs_trim_start = float(cs["sourceTrimStart"])
            cs_trim_duration = float(cs["sourceTrimDuration"])
            cs_gain = float(cs["gainLinear"])
            cs_output_start = float(cs["outputStart"])
            aligned = render_aligned(
                str(cs_path), Path(tmp) / f"committed_{index}_aligned.wav",
                cs_ratio, 0,  # no pitch shift
                start=cs_trim_start, duration=cs_trim_duration,
            )
            if abs(cs_gain - 1.0) > 1e-9:
                gained = Path(tmp) / f"committed_{index}_proc.wav"
                _run_simple_filter(aligned, gained, f"volume={cs_gain:.6f}")
            else:
                gained = aligned
            committed_proc.append((gained, cs_output_start))

        # Build the mix. Overlay mixes both from time zero. Transition places
        # the lead at transition_start and applies the crossfade envelope.
        pre_mix: list[str] = []
        if lead_only_transition:
            pre_mix.append("[0:a]anull[mix]")
        elif arrangement_mode == "transition" and lead_proc is None:
            pre_mix.append(
                f"[0:a]atrim=duration={render_duration:.6f}[mix]"
            )
        elif arrangement_mode == "transition":
            delay_ms = int(round(transition_start * 1000.0))
            if crossfade_duration > 0:
                # Foundation fades out / Lead fades in over the crossfade.
                pre_mix.append(
                    f"[0:a]afade=t=out:st={transition_start:.6f}:"
                    f"d={crossfade_duration:.6f}:curve={fade_curve}[a]"
                )
                pre_mix.append(
                    f"[1:a]afade=t=in:st=0:d={crossfade_duration:.6f}:"
                    f"curve={fade_curve},adelay={delay_ms}:all=1[l]"
                )
                pre_mix.append("[a][l]amix=inputs=2:duration=longest:normalize=0[mix]")
            else:
                # Hard cut: Foundation ends exactly where the delayed Lead starts.
                if transition_start > 0:
                    pre_mix.append(
                        f"[0:a]atrim=duration={transition_start:.6f}[a]"
                    )
                    pre_mix.append(f"[1:a]adelay={delay_ms}:all=1[l]")
                    pre_mix.append("[a][l]amix=inputs=2:duration=longest:normalize=0[mix]")
        else:
            pre_mix.append("[0:a][1:a]amix=inputs=2:duration=first:normalize=0[mix]")

        # Phase 11B: mix committed Ghost layers into the base mix. Each is an
        # additional input (index 2, 3, ...), delayed to its output position,
        # then amixed with the base mix before the shared limiter.
        committed_inputs: list[str] = []
        if committed_proc:
            for index, (cpath, cstart) in enumerate(committed_proc):
                input_index = 2 + index
                delay_ms = int(round(cstart * 1000.0))
                label = f"c{index}"
                committed_inputs.append(
                    f"[{input_index}:a]adelay={delay_ms}:all=1[{label}]"
                )
            mix_inputs = "".join(
                f"[{label}]" for label in ["mix"] + [f"c{i}" for i in range(len(committed_proc))]
            )
            n_inputs = 1 + len(committed_proc)
            committed_inputs.append(
                f"{mix_inputs}amix=inputs={n_inputs}:duration=longest:normalize=0[mix]"
            )
        complex_graph = ";".join(pre_mix + committed_inputs)

        filter_complex = (
            f"{complex_graph};[mix]atrim=duration={render_duration:.6f},"
            "loudnorm=I=-16:TP=-1.5:LRA=11[limited]"
        )

        committed_input_args: list[str] = []
        for cpath, _ in committed_proc:
            committed_input_args.extend(["-i", str(cpath)])

        cmd = [
            "ffmpeg", "-y", "-v", "error",
            *( ["-i", str(anchor_proc)] if anchor_proc is not None else [] ),
            *( ["-i", str(lead_proc)] if lead_proc is not None else [] ),
            *committed_input_args,
            "-filter_complex", filter_complex,
            "-map", "[limited]",
            "-ar", "44100", "-ac", "2",
            str(out_path),
        ]
        proc = subprocess.run(cmd, capture_output=True)
        if proc.returncode != 0:
            raise UserError(f"mash failed: {proc.stderr.decode()[:500]}")
    return out_path


def _run_simple_filter(src: Path, out: Path, filter_expr: str) -> None:
    """Apply a validated audio filter chain to ``src`` producing ``out``."""
    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-i", str(src),
        "-af", filter_expr,
        "-ar", "44100", "-ac", "2",
        str(out),
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise UserError(f"channel filter failed: {proc.stderr.decode()[:400]}")


def measure_clipping(path: str) -> dict:
    """Return loudness and true-peak stats using ffmpeg ebur128.

    Used by tests to verify the mix does not clip.
    """
    cmd = [
        "ffmpeg", "-v", "info", "-i", str(path),
        "-af", "ebur128=peak=true", "-f", "null", "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise UserError(f"true-peak measurement failed: {proc.stderr[-400:]}")
    lines = proc.stderr.splitlines()
    stats: dict[str, float | int] = {}
    for i, line in enumerate(lines):
        if "True peak:" in line and i + 1 < len(lines):
            # Next line has "Peak:       -6.1 dBFS"
            next_line = lines[i + 1]
            if "Peak:" in next_line:
                val = next_line.split(":")[-1].strip().replace("dBFS", "")
                stats["true_peak_db"] = float(val)
        if "Loudness I:" in line:
            stats["integrated_loudness_db"] = float(line.split(":")[-1].strip().replace("dB", ""))
    return stats

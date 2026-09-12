"""Phase 14B.2: deterministic crate loop regions and pairwise compatibility.

Pure functions. No I/O, no derivative loop files, no per-stem analysis.
Regions stay beat references against an effective grid. Unknown keys are
``unknown``, never ``compatible``.
"""

from __future__ import annotations

import math
from typing import Any

from .assembler import semitones_to_match
from .common import UserError
from .stem_crate import LOOP_BARS, validate_loop_bars

BEATS_PER_BAR = 4
LOW_CONFIDENCE = 0.5
BPM_MATCH_RATIO_TOLERANCE = 0.005
GRID_MISSING = "crate_grid_missing"
UNKNOWN_KEY = "unknown"
PROVENANCE_INHERITED = "source_track_inherited"


def _finite(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise UserError(f"{name} is required", code=GRID_MISSING)
    if not math.isfinite(value):
        raise UserError(f"{name} must be finite", code=GRID_MISSING)
    return float(value)


def require_grid_facts(
    *,
    bpm: Any,
    first_beat: Any,
    suggested_downbeat: Any,
    interval: Any = None,
    grid_revision: Any = None,
    analysis_confidence: Any = None,
    beat_confidence: Any = None,
    overrides_active: bool = False,
) -> dict[str, Any]:
    """Fail closed when BPM or grid origin/downbeat/revision are unusable."""
    tempo = _finite(bpm, "bpm")
    if tempo <= 0:
        raise UserError("bpm must be positive", code=GRID_MISSING)

    origin = _finite(first_beat, "first_beat")
    if origin < 0:
        raise UserError("first_beat must be non-negative", code=GRID_MISSING)

    downbeat = _finite(suggested_downbeat, "suggested_downbeat")
    if downbeat < 0:
        raise UserError("suggested_downbeat must be non-negative", code=GRID_MISSING)

    if interval is None:
        beat_interval = 60.0 / tempo
    else:
        beat_interval = _finite(interval, "interval")
        if beat_interval <= 0:
            raise UserError("interval must be positive", code=GRID_MISSING)

    if not isinstance(grid_revision, str) or not grid_revision.strip():
        raise UserError("grid_revision is required", code=GRID_MISSING)

    confidence = _optional_confidence(analysis_confidence, beat_confidence)

    return {
        "bpm": tempo,
        "first_beat": origin,
        "suggested_downbeat": downbeat,
        "interval": beat_interval,
        "grid_revision": grid_revision.strip(),
        "analysis_confidence": confidence,
        "low_confidence": confidence is not None and confidence < LOW_CONFIDENCE,
        "overrides_active": bool(overrides_active),
    }


def grid_facts_from_track(track: dict[str, Any], grid_revision: str) -> dict[str, Any]:
    grid = track.get("beat_grid") if isinstance(track.get("beat_grid"), dict) else {}
    key = track.get("key") if isinstance(track.get("key"), dict) else {}
    return require_grid_facts(
        bpm=track.get("bpm"),
        first_beat=grid.get("first_beat"),
        suggested_downbeat=grid.get("suggested_downbeat"),
        interval=grid.get("interval"),
        grid_revision=grid_revision,
        analysis_confidence=key.get("confidence"),
        beat_confidence=grid.get("confidence"),
        overrides_active=bool(track.get("overrides_active")),
    )


def _optional_confidence(*values: Any) -> float | None:
    finite: list[float] = []
    for value in values:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        if math.isfinite(value):
            finite.append(float(value))
    if not finite:
        return None
    return min(finite)


def downbeat_beat(facts: dict[str, Any]) -> float:
    return (facts["suggested_downbeat"] - facts["first_beat"]) / facts["interval"]


def loop_beats(loop_bars: int) -> int:
    return validate_loop_bars(loop_bars) * BEATS_PER_BAR


def snap_to_bar_beat(start_beat: float, downbeat_beat_value: float) -> float:
    """Nearest 4/4 bar start on the downbeat lattice; never negative."""
    relative = start_beat - downbeat_beat_value
    k = math.floor(relative / BEATS_PER_BAR + 0.5)
    snapped = downbeat_beat_value + k * BEATS_PER_BAR
    while snapped < 0:
        k += 1
        snapped = downbeat_beat_value + k * BEATS_PER_BAR
    return snapped


def derive_bar_region(
    facts: dict[str, Any],
    loop_bars: int,
    start_beat: float | None = None,
    *,
    snap: bool = True,
) -> dict[str, Any]:
    """Beat-reference loop window. Does not write audio."""
    bars = validate_loop_bars(loop_bars)
    duration = bars * BEATS_PER_BAR
    raw_start = 0.0 if start_beat is None else _finite(start_beat, "region_start_beat")
    if raw_start < 0:
        raise UserError("region_start_beat must be non-negative", code=GRID_MISSING)
    start = snap_to_bar_beat(raw_start, downbeat_beat(facts)) if snap else raw_start
    return {
        "region_start_beat": start,
        "region_end_beat": start + duration,
        "loop_bars": bars,
        "loop_beats": duration,
        "grid_revision": facts["grid_revision"],
        "snapped": snap,
    }


def evaluate_loop_truth(
    *,
    stored_revision: str,
    stored_start: float,
    stored_end: float,
    stored_bars: int,
    current_facts: dict[str, Any] | None,
    current_error: str | None = None,
) -> dict[str, Any]:
    """Compare a stored crate region to live grid facts. Never rewrite it."""
    expected_duration = loop_beats(stored_bars)
    duration_ok = math.isclose(
        stored_end - stored_start, expected_duration, rel_tol=0.0, abs_tol=1e-9
    )
    if current_facts is None:
        return {
            "grid_status": "missing",
            "stored_grid_revision": stored_revision,
            "current_grid_revision": None,
            "region_duration_ok": duration_ok,
            "region_aligned": False,
            "low_confidence": True,
            "analysis_confidence": None,
            "overrides_active": False,
            "reason": current_error or GRID_MISSING,
        }

    current_revision = current_facts["grid_revision"]
    stale = stored_revision != current_revision
    derived = derive_bar_region(current_facts, stored_bars, start_beat=stored_start)
    aligned = (
        not stale
        and math.isclose(stored_start, derived["region_start_beat"], abs_tol=1e-9)
        and math.isclose(stored_end, derived["region_end_beat"], abs_tol=1e-9)
    )
    return {
        "grid_status": "stale_revision" if stale else "ok",
        "stored_grid_revision": stored_revision,
        "current_grid_revision": current_revision,
        "region_duration_ok": duration_ok,
        "region_aligned": aligned,
        "low_confidence": current_facts["low_confidence"],
        "analysis_confidence": current_facts["analysis_confidence"],
        "overrides_active": current_facts["overrides_active"],
        "reason": "stale_grid_revision" if stale else None,
    }


def _key_parts(tonic: Any, mode: Any) -> tuple[str | None, str | None]:
    if not isinstance(tonic, str) or not tonic.strip():
        return None, None
    if not isinstance(mode, str) or not mode.strip():
        return None, None
    return tonic.strip(), mode.strip().lower()


def compatibility(source: dict[str, Any], target: dict[str, Any]) -> dict[str, Any]:
    """Pairwise crate compatibility. Target is the anchor the source would match."""
    source_bpm = source.get("effective_bpm")
    target_bpm = target.get("effective_bpm")
    reasons: list[str] = []

    bpm_ok = (
        isinstance(source_bpm, (int, float))
        and isinstance(target_bpm, (int, float))
        and not isinstance(source_bpm, bool)
        and not isinstance(target_bpm, bool)
        and math.isfinite(source_bpm)
        and math.isfinite(target_bpm)
        and source_bpm > 0
        and target_bpm > 0
    )
    if not bpm_ok:
        reasons.append("unknown_bpm")
        bpm_delta = None
        bpm_ratio = None
    else:
        bpm_delta = float(target_bpm) - float(source_bpm)
        bpm_ratio = float(target_bpm) / float(source_bpm)
        if abs(bpm_ratio - 1.0) > BPM_MATCH_RATIO_TOLERANCE:
            reasons.append("bpm_delta")

    source_tonic, source_mode = _key_parts(
        source.get("effective_tonic"), source.get("effective_mode")
    )
    target_tonic, target_mode = _key_parts(
        target.get("effective_tonic"), target.get("effective_mode")
    )
    harmonic = UNKNOWN_KEY
    semitone_shift: int | None = None
    relationship = UNKNOWN_KEY
    if source_tonic is None or source_mode is None or target_tonic is None or target_mode is None:
        reasons.append("unknown_key")
    else:
        try:
            semitone_shift = semitones_to_match(
                f"{target_tonic} {target_mode}",
                f"{source_tonic} {source_mode}",
            )
        except UserError:
            reasons.append("unknown_key")
            semitone_shift = None
        else:
            if source_tonic == target_tonic and source_mode == target_mode:
                relationship = "same_key"
                harmonic = "compatible"
            elif semitone_shift == 0:
                relationship = "relative"
                harmonic = "transform_needed"
                reasons.append("relative_major_minor")
            else:
                relationship = "transposition"
                harmonic = "transform_needed"
                reasons.append("semitone_shift")

    provenance = source.get("provenance") or PROVENANCE_INHERITED
    if provenance == PROVENANCE_INHERITED:
        reasons.append("source_inherited")

    if "unknown_key" in reasons or "unknown_bpm" in reasons:
        verdict = UNKNOWN_KEY
        harmonic = UNKNOWN_KEY
    elif harmonic == "compatible" and "bpm_delta" not in reasons:
        verdict = "compatible"
    else:
        verdict = "transform_needed"

    explanation = _explanation(
        source_bpm if bpm_ok else None,
        target_bpm if bpm_ok else None,
        semitone_shift,
        provenance,
        verdict,
    )
    return {
        "verdict": verdict,
        "harmonic": harmonic,
        "bpm_delta": bpm_delta,
        "bpm_ratio": bpm_ratio,
        "semitone_shift": semitone_shift,
        "relationship": relationship,
        "reasons": reasons,
        "explanation": explanation,
        "provenance": provenance,
    }


def _explanation(
    source_bpm: float | None,
    target_bpm: float | None,
    semitone_shift: int | None,
    provenance: str,
    verdict: str,
) -> str:
    parts: list[str] = []
    if source_bpm is not None and target_bpm is not None:
        parts.append(f"{_format_bpm(source_bpm)}→{_format_bpm(target_bpm)} BPM")
    else:
        parts.append("BPM unknown")
    if verdict == UNKNOWN_KEY and semitone_shift is None:
        parts.append("key unknown")
    elif semitone_shift is None:
        parts.append("key unknown")
    else:
        sign = "+" if semitone_shift > 0 else ""
        parts.append(f"{sign}{semitone_shift} st")
    if provenance == PROVENANCE_INHERITED:
        parts.append("source inherited")
    return "; ".join(parts)


def _format_bpm(bpm: float) -> str:
    if math.isclose(bpm, round(bpm), abs_tol=1e-9):
        return str(int(round(bpm)))
    return f"{bpm:.3f}".rstrip("0").rstrip(".")

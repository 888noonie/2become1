"""Chorus Fit: rank one section of song B against a target section of song A.

The function reads numbers the listening document already has. It does not
open audio, call a model, or change a project. A chroma rotation is a pitch
hypothesis, not a chord-by-chord reading and not a claim about lyrics, groove,
or taste.

Swing is a separate measurement (``measure_swing``). The ranker only sees the
number. Straight is near one half of the beat. Triplet swing is near two thirds.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

import numpy as np

from .assembler import semitones_to_match
from .common import UserError

# Named, testable cutoffs. They are not prompts and they are not hidden.
CHROMA_AMBIGUITY_GAP = 0.05
SWING_DECISIVE_GAP = 0.12
WEAK_HARMONIC_COSINE = 0.55
QUALIFIED_STRETCH_MIN = 0.857
QUALIFIED_STRETCH_MAX = 1.2

_LIMITATIONS = (
    "Section-mean chroma is a pitch-class resemblance, not a chord progression, a lyric, or a judgement of taste.",
    "A rotated match is a pitch hypothesis. It is not proof the two passages belong together.",
    "The qualified stretch region is 0.857 to 1.2 at zero semitones. Any other pitch is outside that measurement.",
    "Half-time and double-time are relationships. They are not applied as stretch rates.",
    "One BPM cannot stay sample-accurate through a passage whose tempo changes.",
)


def _swing_from_flux(flux: np.ndarray, hop: int, sr: int, bpm: float, start: float, end: float) -> float | None:
    from scipy.signal import find_peaks

    if hop is None or not np.isfinite(bpm) or bpm <= 0 or end <= start or len(flux) < 8:
        return None
    env_sr = sr / hop
    beat = 60.0 / bpm
    a = max(0, int(start * env_sr))
    b = min(len(flux) - 1, int(end * env_sr))
    segment = flux[a:b]
    if len(segment) < 8 or float(np.max(segment)) <= 0:
        return None
    distance = max(1, int(env_sr * beat * 0.22))
    peaks, _props = find_peaks(segment, prominence=float(np.max(segment)) * 0.08, distance=distance)
    if len(peaks) < 4:
        return None
    times = (peaks + a) / env_sr
    amps = segment[peaks]
    cut = float(np.median(amps))
    strong = [i for i, amp in enumerate(amps) if amp >= cut]
    if len(strong) < 3:
        return None
    ratios: list[float] = []
    for n, i in enumerate(strong[:-1]):
        nxt = strong[n + 1]
        gap = float(times[nxt] - times[i])
        if not (0.75 * beat <= gap <= 1.35 * beat):
            continue
        between = range(i + 1, nxt)
        if not between:
            continue
        j = max(between, key=lambda k: amps[k])
        ratios.append(float((times[j] - times[i]) / gap))
    if len(ratios) < 4:
        return None
    return float(np.median(ratios))


def measure_swing(audio: np.ndarray, sr: int, bpm: float, start: float, end: float) -> float | None:
    """Median off-beat position as a fraction of the beat, from the onset envelope.

    Returns None when the span does not contain enough paired onsets. The
    caller passes samples it already holds. This does not open a file.
    """
    from .analyzer import spectral_flux

    flux, hop = spectral_flux(np.asarray(audio, dtype=np.float64), int(sr))
    return _swing_from_flux(flux, hop, sr, bpm, start, end)


def section_swings(audio: np.ndarray, sr: int, bpm: float, spans: Sequence[tuple[float, float]]) -> list[float | None]:
    """One onset pass, then a swing ratio for each ``(start, end)`` span."""
    from .analyzer import spectral_flux

    flux, hop = spectral_flux(np.asarray(audio, dtype=np.float64), int(sr))
    return [_swing_from_flux(flux, hop, sr, bpm, start, end) for start, end in spans]


def rank_fit(target: Mapping[str, Any], candidates: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Order ``candidates`` by how they sit against ``target``.

    Harmonic similarity is the best cosine over the twelve chroma rotations.
    Duration, vocal presence, tempo and swing stay separate, and they do not
    outrank a clearly better pitch-class match. Missing chroma is omitted from
    the score rather than stored as zero.
    """
    target_view = _view(target, "target")
    rows = _order([_score(target_view, _view(candidate, f"c{i}")) for i, candidate in enumerate(candidates)])
    for rank, row in enumerate(rows, start=1):
        row["rank"] = rank
    ask, decisive, distinguished, reason = _decision(rows)
    return {
        "version": "chorus-fit/v1",
        "decisive": decisive,
        "ask": ask,
        "askReason": reason,
        "ambiguityGap": CHROMA_AMBIGUITY_GAP,
        "swingGap": SWING_DECISIVE_GAP,
        "distinguishedBy": distinguished,
        "limitations": list(_LIMITATIONS),
        "candidates": rows,
    }


# ---------------------------------------------------------------- internals


def _first(section: Mapping[str, Any], *names: str) -> Any:
    for name in names:
        if name in section and section[name] is not None:
            return section[name]
    return None


def _chroma(section: Mapping[str, Any]) -> np.ndarray | None:
    raw = _first(section, "meanChroma", "mean_chroma")
    if raw is None:
        return None
    try:
        row = np.asarray(list(raw), dtype=np.float64)
    except (TypeError, ValueError):
        return None
    if row.shape != (12,) or not np.all(np.isfinite(row)):
        return None
    if float(np.linalg.norm(row)) < 1e-12:
        return None
    return row


def _number(section: Mapping[str, Any], *names: str) -> float | None:
    raw = _first(section, *names)
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    value = float(raw)
    if not np.isfinite(value):
        return None
    return value


def _view(section: Mapping[str, Any], fallback_id: str) -> dict[str, Any]:
    ident = _first(section, "id")
    return {
        "id": str(ident) if ident is not None else fallback_id,
        "label": _first(section, "label", "name"),
        "chroma": _chroma(section),
        "bars": _number(section, "bars", "barCount"),
        "vocal": _number(section, "vocalPresence", "vocal_presence"),
        "bpm": _number(section, "bpm"),
        "swing": _number(section, "swing", "swingRatio"),
        "key": _first(section, "key"),
        "startSec": _number(section, "startSec", "start_sec"),
        "endSec": _number(section, "endSec", "end_sec"),
        "downbeatSec": _number(section, "downbeatSec", "downbeat_sec"),
    }


def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def _best_rotation(target: np.ndarray, candidate: np.ndarray) -> tuple[int, float]:
    scores = [_cosine(target, np.roll(candidate, rotation)) for rotation in range(12)]
    rotation = int(np.argmax(scores))
    return rotation, scores[rotation]


def _signed(rotation: int) -> int:
    if rotation <= 6:
        return int(rotation)
    return int(rotation - 12)


def _key_shift(target_key: Any, source_key: Any) -> int | None:
    if not isinstance(target_key, str) or not isinstance(source_key, str):
        return None
    if not target_key.strip() or not source_key.strip():
        return None
    try:
        return int(semitones_to_match(target_key, source_key))
    except (UserError, TypeError, ValueError):
        return None


def _tempo(target_bpm: float | None, source_bpm: float | None) -> dict[str, Any]:
    if target_bpm is None or source_bpm is None or target_bpm <= 0 or source_bpm <= 0:
        return {
            "status": "missing",
            "targetBpm": target_bpm,
            "sourceBpm": source_bpm,
            "relationships": [],
            "applyStretch": None,
            "qualified": False,
        }
    as_read = target_bpm / source_bpm
    relationships = []
    for kind, factor in (("as_read", 1.0), ("half_time", 2.0), ("double_time", 0.5)):
        stretch = as_read / factor
        qualified = QUALIFIED_STRETCH_MIN <= stretch <= QUALIFIED_STRETCH_MAX
        relationships.append({
            "kind": kind,
            "stretch": stretch,
            "qualified": qualified,
            # Only the tempo as read, and only inside the measured band.
            "apply": bool(kind == "as_read" and qualified),
        })
    unison = relationships[0]
    return {
        "status": "measured",
        "targetBpm": target_bpm,
        "sourceBpm": source_bpm,
        "relationships": relationships,
        "applyStretch": unison["stretch"] if unison["apply"] else None,
        "qualified": bool(unison["qualified"]),
    }


def _pitch(signed: int | None, shift: int | None, stretch_in_band: bool, tempo_known: bool) -> dict[str, Any]:
    if signed is None or shift is None:
        return {
            "signedSemitones": signed,
            "keySemitones": shift,
            "agreement": "unknown",
            "suggested": 0,
            "qualified": False,
            "autoApply": False,
            "note": "The pitch is unchanged: a key or a chroma rotation is missing.",
        }
    if abs(signed - shift) <= 1:
        suggested = int(signed)
        qualified = suggested == 0 and (not tempo_known or stretch_in_band)
        if suggested == 0:
            note = "The chroma rotation and the key calculation both leave the pitch where it is."
        else:
            note = (
                f"A shift of {suggested:+d} semitones is within one semitone of the key calculation. "
                "It is outside the qualified stretch range of 0.857 to 1.2 at zero semitones."
            )
        return {
            "signedSemitones": signed,
            "keySemitones": shift,
            "agreement": "agree",
            "suggested": suggested,
            "qualified": qualified,
            "autoApply": True,
            "note": note,
        }
    return {
        "signedSemitones": signed,
        "keySemitones": shift,
        "agreement": "disagree",
        "suggested": 0,
        "qualified": False,
        "autoApply": False,
        "note": "The chroma rotation and the key calculation disagree by more than a semitone, so ask before shifting. The pitch stays put.",
    }


def _score(target: dict[str, Any], source: dict[str, Any]) -> dict[str, Any]:
    tempo = _tempo(target["bpm"], source["bpm"])
    if target["chroma"] is None or source["chroma"] is None:
        harmonic = {"cosine": None, "rotation": None, "signedSemitones": None, "proof": False}
        evidence = "missing"
        pitch = _pitch(None, _key_shift(target["key"], source["key"]), tempo["qualified"], tempo["status"] == "measured")
        pitch["autoApply"] = False
        pitch["suggested"] = 0
    else:
        rotation, cosine = _best_rotation(target["chroma"], source["chroma"])
        signed = _signed(rotation)
        evidence = "weak" if cosine < WEAK_HARMONIC_COSINE else "estimate"
        harmonic = {"cosine": cosine, "rotation": rotation, "signedSemitones": signed, "proof": False}
        pitch = _pitch(signed, _key_shift(target["key"], source["key"]), tempo["qualified"], tempo["status"] == "measured")
    if target["swing"] is None or source["swing"] is None:
        swing = {"target": target["swing"], "source": source["swing"], "distance": None, "status": "missing"}
    else:
        swing = {
            "target": target["swing"],
            "source": source["swing"],
            "distance": abs(source["swing"] - target["swing"]),
            "status": "measured",
        }
    if source["vocal"] is None:
        vocal = {"presence": None, "status": "missing"}
    elif source["vocal"] >= 0.2:
        vocal = {"presence": source["vocal"], "status": "present"}
    else:
        vocal = {"presence": source["vocal"], "status": "low"}
    bars = source["bars"]
    target_bars = target["bars"]
    distance = None if bars is None or target_bars is None else abs(bars - target_bars)
    reasons = _reasons(source, harmonic, evidence, swing, tempo, pitch, distance)
    return {
        "id": source["id"],
        "label": source["label"],
        "startSec": source["startSec"],
        "endSec": source["endSec"],
        "downbeatSec": source["downbeatSec"],
        "evidence": evidence,
        "harmonic": harmonic,
        "duration": {"bars": bars, "targetBars": target_bars, "distance": distance},
        "vocal": vocal,
        "tempo": tempo,
        "swing": swing,
        "pitch": pitch,
        "reasons": reasons,
    }


def _reasons(source, harmonic, evidence, swing, tempo, pitch, distance) -> list[str]:
    lines = []
    if evidence == "missing":
        lines.append(f"{source['id']}: chroma is missing, so this is not scored as a poor match.")
    else:
        lines.append(
            f"{source['id']}: section-mean chroma cosine {harmonic['cosine']:.3f} "
            f"at a rotation of {harmonic['signedSemitones']:+d} semitones. "
            "That rotation is a pitch hypothesis, not a chord-by-chord proof."
        )
        if evidence == "weak":
            lines.append("The resemblance is weak. Ask rather than treat it as the passage.")
    if swing["status"] == "measured":
        lines.append(
            f"Swing {swing['source']:.2f} against the target {swing['target']:.2f} "
            f"(distance {swing['distance']:.2f}). Chroma did not decide this."
        )
    else:
        lines.append("Swing was not measured for this comparison.")
    if tempo["status"] == "measured":
        as_read = tempo["relationships"][0]
        lines.append(
            f"Tempo as read wants stretch {as_read['stretch']:.3f}. "
            + ("It is inside the qualified band at zero semitones." if as_read["qualified"]
               else "It is outside the qualified band and is not applied.")
        )
        for rel in tempo["relationships"][1:]:
            lines.append(f"{rel['kind'].replace('_', '-')} is stretch {rel['stretch']:.3f} and is not applied.")
    else:
        lines.append("Tempo is missing, so no stretch is proposed.")
    lines.append(pitch["note"])
    if distance is not None:
        lines.append(f"Section length differs by {distance:g} bars. Length is not harmonic proof.")
    return lines


def _order(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Cosine first. Inside the ambiguity gap, swing, length and vocal break the tie.

    A tiny cosine difference must not hide a swing gap of 0.12. A clearly
    different pitch-class match stays behind that cluster.
    """
    rows.sort(key=_sort_key)
    if not rows or rows[0]["harmonic"]["cosine"] is None:
        return rows
    best = rows[0]["harmonic"]["cosine"]
    close, rest = [], []
    for row in rows:
        cosine = row["harmonic"]["cosine"]
        if cosine is None or best - cosine >= CHROMA_AMBIGUITY_GAP:
            rest.append(row)
        else:
            close.append(row)
    close.sort(key=_tie_key)
    return close + rest


def _tie_key(row: dict[str, Any]):
    swing_penalty = 0.0 if row["swing"]["distance"] is None else row["swing"]["distance"]
    bar_penalty = 0.0 if row["duration"]["distance"] is None else row["duration"]["distance"]
    presence = row["vocal"]["presence"]
    vocal_penalty = 0.5 if presence is None else 1.0 - min(1.0, max(0.0, presence))
    return (swing_penalty, bar_penalty, vocal_penalty, row["id"])


def _sort_key(row: dict[str, Any]):
    cosine = row["harmonic"]["cosine"]
    if cosine is None:
        return (1, 0.0, 0.0, 0.0, 0.0, row["id"])
    swing_penalty = 0.0 if row["swing"]["distance"] is None else row["swing"]["distance"]
    bar_penalty = 0.0 if row["duration"]["distance"] is None else row["duration"]["distance"]
    presence = row["vocal"]["presence"]
    vocal_penalty = 0.5 if presence is None else 1.0 - min(1.0, max(0.0, presence))
    return (0, -cosine, swing_penalty, bar_penalty, vocal_penalty, row["id"])


def _decision(rows: list[dict[str, Any]]) -> tuple[bool, bool, str | None, str | None]:
    scored = [row for row in rows if row["harmonic"]["cosine"] is not None]
    if not scored:
        return True, False, None, "No section has chroma, so there is nothing to rank. The missing evidence is not a low score."
    best = scored[0]
    if len(scored) == 1:
        if best["evidence"] == "weak":
            return True, False, None, "The only resemblance is weak. Ask which passage to try."
        return False, True, "harmony", None
    delta = best["harmonic"]["cosine"] - scored[1]["harmonic"]["cosine"]
    if delta < CHROMA_AMBIGUITY_GAP:
        first, second = best["swing"], scored[1]["swing"]
        if (
            first["source"] is not None and second["source"] is not None
            and abs(first["source"] - second["source"]) >= SWING_DECISIVE_GAP
            and first["distance"] is not None and second["distance"] is not None
            and first["distance"] < second["distance"]
        ):
            return False, True, "swing", None
        return True, False, None, (
            "The closest pitch-class matches are within "
            f"{CHROMA_AMBIGUITY_GAP:.2f} cosine and the swing does not separate them. Ask which one to try."
        )
    if best["evidence"] == "weak":
        return True, False, None, "The leading resemblance is weak. Ask which passage to try."
    return False, True, "harmony", None


def _descriptor_from_section(analysis: Mapping[str, Any], section: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "id": section.get("id"),
        "label": section.get("name") or section.get("label"),
        "meanChroma": section.get("meanChroma"),
        "bars": section.get("bars"),
        "vocalPresence": section.get("vocalPresence"),
        "bpm": analysis.get("bpm"),
        "swing": section.get("swingRatio"),
        "key": analysis.get("key"),
        "startSec": section.get("startSec"),
        "endSec": section.get("endSec"),
    }


def _preferred_target(analysis: Mapping[str, Any]) -> Mapping[str, Any] | None:
    sections = [s for s in analysis.get("sections") or [] if isinstance(s, Mapping)]
    choruses = [s for s in sections if s.get("label") == "chorus"]
    pool = choruses or sections
    if not pool:
        return None
    named = [s for s in pool if s.get("basis") == "musician"]
    pool = named or pool
    return max(pool, key=lambda s: float(s.get("vocalPresence") or 0))


def fit_lines(analyses: Mapping[str, Any]) -> list[str]:
    """Session lines for the Producer. Numbers only: no audio and no model call."""
    song_a = analyses.get("A") if isinstance(analyses, Mapping) else None
    song_b = analyses.get("B") if isinstance(analyses, Mapping) else None
    if not isinstance(song_a, Mapping) or not isinstance(song_b, Mapping):
        return []
    target = _preferred_target(song_a)
    sections = [s for s in song_b.get("sections") or [] if isinstance(s, Mapping)]
    if target is None or not sections:
        return []
    if target.get("meanChroma") is None and not any(s.get("meanChroma") is not None for s in sections):
        return ["CHORUS FIT: section chroma is not on these analyses, so nothing is scored."]
    ranked = rank_fit(_descriptor_from_section(song_a, target), [_descriptor_from_section(song_b, s) for s in sections])
    if not ranked["candidates"]:
        return []
    top = ranked["candidates"][0]
    target_name = target.get("name") or target.get("label") or "the target"
    if top["evidence"] == "missing":
        return [f"CHORUS FIT: A's {target_name} has no usable chroma against B, so this is missing evidence, not a poor match."]
    cosine = top["harmonic"]["cosine"]
    signed = top["harmonic"]["signedSemitones"]
    lines = [
        f"CHORUS FIT (an estimate from section-mean chroma, not a chord chart or a lyric reading): "
        f"against A's {target_name}, the closest part of B is {top.get('label') or top['id']} "
        f"(cosine {cosine:.2f}, rotation {signed:+d} semitones). A rotation is not proof the passages belong together."
    ]
    if ranked["ask"]:
        second = ranked["candidates"][1]["label"] if len(ranked["candidates"]) > 1 else "another section"
        lines.append(f"CHORUS FIT is asking, not deciding. The next reading is {second}. {ranked['askReason']}")
    else:
        lines.append(f"CHORUS FIT would offer {top.get('label') or top['id']} of B. The musician still decides whether it sounds right.")
    lines.append(f"CHORUS FIT pitch and tempo: {top['pitch']['note']}")
    return lines

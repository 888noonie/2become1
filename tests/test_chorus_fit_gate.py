"""The dossier's synthetic Chorus Fit gate.

Clicks plus steady tones. No recordings, no stems, no Demucs. The ranker
sees only the descriptors this file measures with the existing BPM detector,
a constant grid, and the listening chroma. Thresholds are not relaxed here.
"""

import math
import wave
from pathlib import Path

import numpy as np
import pytest

from twobecomeone.analyzer import detect_bpm
from twobecomeone.beatgrid import detect as detect_grid
from twobecomeone.chorus_fit import SWING_DECISIVE_GAP, measure_swing, rank_fit
from twobecomeone.listening import SR, _per_bar, _spectral_features

# Tempos the existing detector resolves within one BPM. 120 and 140 collapse
# toward half time; they are not used to make this gate pass.
_BPMS = [
    100, 96, 90, 84, 108, 80, 92, 104, 88, 112,
    116, 122, 128, 78, 86, 94, 102, 72, 118, 130,
]
_TRIADS = [
    (0, 4, 7), (2, 5, 9), (4, 7, 11), (5, 9, 0), (7, 11, 2),
    (9, 0, 4), (11, 2, 6), (0, 3, 7), (2, 7, 11), (4, 9, 0),
]
# A chromatic cluster is not a rotation of a triad. A transposed triad is the
# same harmony and must be found by searching the twelve rotations.
_DECOY = (0, 1, 2)
_BARS = 8
_LEAD = 0.05


def _click(sr: int) -> np.ndarray:
    n = int(0.008 * sr)
    env = np.exp(-np.linspace(0, 8, n))
    return env * np.sin(2 * np.pi * 2000 * np.arange(n) / sr)


def _render_regions(bpm: float, regions: list[tuple[int, tuple, float]], sr: int = SR) -> np.ndarray:
    """One continuous click track. Each region keeps its own tones and swing."""
    beat = 60.0 / bpm
    # Repeat the last region's feel for two bars so a slightly slower grid
    # still contains three complete 8-bar windows. Those extra bars are not a region.
    regions = list(regions)
    last_bars, last_pcs, last_swing = regions[-1]
    regions[-1] = (last_bars + 2, last_pcs, last_swing)
    total_bars = sum(bars for bars, _pcs, _swing in regions)
    dur = _LEAD + total_bars * 4 * beat + 0.2
    audio = np.zeros(int(dur * sr))
    time = np.arange(len(audio)) / sr
    click = _click(sr)
    n = len(click)
    beat_index = 0
    for bars, pitch_classes, swing in regions:
        start = int((_LEAD + beat_index * beat) * sr)
        end = int((_LEAD + (beat_index + bars * 4) * beat) * sr)
        segment = time[start:end]
        for pc in pitch_classes:
            freq = 261.6256 * (2 ** (pc / 12))
            audio[start:end] += 0.22 * np.sin(2 * np.pi * freq * segment)
            audio[start:end] += 0.06 * np.sin(2 * np.pi * 2 * freq * segment)
        for k in range(bars * 4):
            onset = _LEAD + (beat_index + k) * beat
            i = int(onset * sr)
            audio[i:i + n] += click
            j = int((onset + swing * beat) * sr)
            if 0 <= j and j + n < len(audio):
                audio[j:j + n] += 0.35 * click
        beat_index += bars * 4
    peak = float(np.max(np.abs(audio))) or 1.0
    return audio / peak * 0.8


def _write(path: Path, audio: np.ndarray, sr: int = SR) -> None:
    frames = np.clip(audio, -1.0, 1.0)
    pcm = (frames * 32767.0).astype(np.int16)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sr)
        handle.writeframes(pcm.tobytes())


def _grid_chroma(audio: np.ndarray, bpm: float, downbeat: float):
    beat = 60.0 / bpm
    bar = beat * 4
    duration = len(audio) / SR
    first = downbeat - math.floor(downbeat / bar + 1e-9) * bar
    starts = []
    t = first
    while t + bar <= duration + 1e-6:
        starts.append(round(t, 6))
        t += bar
    chroma = _per_bar(_spectral_features(audio)["chroma"], starts, bar)
    return chroma, starts, bar


def _windows(chroma: np.ndarray, starts: list[float], bar: float, count: int = 3):
    """Non-overlapping downbeat-aligned 8-bar windows, in time order."""
    out = []
    for index in range(count):
        a = index * _BARS
        b = a + _BARS
        if b > len(chroma):
            break
        out.append({
            "index": index,
            "mean": chroma[a:b].mean(axis=0),
            "start": starts[a],
            "end": starts[b - 1] + bar,
        })
    return out


def _pair(index: int, root: Path) -> dict:
    bpm = _BPMS[index]
    triad = _TRIADS[index % len(_TRIADS)]
    # Four pairs plant the match a fifth up, so rotation 0 is the wrong reading.
    transpose = 5 if index % 5 == 4 else 0
    match = tuple((pc + transpose) % 12 for pc in triad)
    target_audio = _render_regions(bpm, [(_BARS, triad, 0.50)])
    # Straight match, swung twin, different harmony. The order rotates so
    # position in the file is not the answer.
    regions = [
        ("straight", match, 0.50),
        ("swung", match, 0.66),
        ("decoy", _DECOY, 0.50),
    ]
    shift = index % 3
    regions = regions[shift:] + regions[:shift]
    source = _render_regions(bpm, [(_BARS, pcs, swing) for _name, pcs, swing in regions])
    target_path = root / f"a-{index}.wav"
    source_path = root / f"b-{index}.wav"
    _write(target_path, target_audio)
    _write(source_path, source)
    target_bpm = detect_bpm(target_audio, SR)
    source_bpm = detect_bpm(source, SR)
    target_grid = detect_grid(target_path, bpm=target_bpm, sr=SR)
    source_grid = detect_grid(source_path, bpm=source_bpm, sr=SR)
    target_chroma, _starts, _bar = _grid_chroma(target_audio, target_bpm, target_grid.suggested_downbeat)
    source_chroma, source_starts, source_bar = _grid_chroma(source, source_bpm, source_grid.suggested_downbeat)
    windows = _windows(source_chroma, source_starts, source_bar)
    return {
        "index": index,
        "plantedBpm": bpm,
        "targetBpm": target_bpm,
        "sourceBpm": source_bpm,
        "transpose": transpose,
        "regions": [name for name, _pcs, _swing in regions],
        "targetChroma": target_chroma.mean(axis=0),
        "targetSwing": measure_swing(target_audio, SR, target_bpm, 0.0, len(target_audio) / SR),
        "windows": windows,
        "source": source,
    }


def _rank_pair(pair: dict) -> dict:
    target = {
        "id": "chorus",
        "label": "chorus",
        "meanChroma": pair["targetChroma"].tolist(),
        "bars": _BARS,
        "vocalPresence": None,
        "bpm": pair["targetBpm"],
        "swing": pair["targetSwing"],
        "key": None,
        "startSec": 0.0,
    }
    candidates = []
    for window in pair["windows"]:
        swing = measure_swing(pair["source"], SR, pair["sourceBpm"], window["start"], window["end"])
        candidates.append({
            "id": pair["regions"][window["index"]],
            "label": pair["regions"][window["index"]],
            "meanChroma": window["mean"].tolist(),
            "bars": _BARS,
            "vocalPresence": None,
            "bpm": pair["sourceBpm"],
            "swing": swing,
            "key": None,
            "startSec": window["start"],
            "endSec": window["end"],
        })
    ranked = rank_fit(target, candidates)
    ranked["measuredSwingGap"] = _swing_gap(candidates)
    return ranked


def _swing_gap(candidates: list[dict]) -> float | None:
    by_id = {row["id"]: row.get("swing") for row in candidates}
    if by_id.get("straight") is None or by_id.get("swung") is None:
        return None
    return abs(by_id["straight"] - by_id["swung"])


def test_synthetic_gate(tmp_path):
    harmonic_hits = 0
    swing_hits = 0
    swing_eligible = 0
    transposed_ok = 0
    transposed = 0
    failures = []
    first = None
    for index in range(20):
        pair = _pair(index, tmp_path)
        if index == 0:
            first = pair
        ranked = _rank_pair(pair)
        winner = ranked["candidates"][0]["id"]
        if winner == "straight":
            harmonic_hits += 1
        else:
            failures.append(f"pair {index} winner {winner} regions {pair['regions']} bpm {pair['targetBpm']}")
        gap = ranked["measuredSwingGap"]
        if gap is not None and gap >= SWING_DECISIVE_GAP and abs(pair["targetBpm"] - pair["plantedBpm"]) <= 1:
            swing_eligible += 1
            order = [row["id"] for row in ranked["candidates"] if row["evidence"] != "missing"]
            if order.index("straight") < order.index("swung"):
                swing_hits += 1
        if pair["transpose"]:
            transposed += 1
            rotation = ranked["candidates"][0]["harmonic"]["rotation"]
            if winner == "straight" and rotation not in (0, None):
                transposed_ok += 1
    assert first is not None
    assert abs(first["targetBpm"] - first["plantedBpm"]) <= 1, first["targetBpm"]
    assert harmonic_hits >= 18, f"{harmonic_hits}/20\n" + "\n".join(failures)
    assert swing_eligible >= 16, f"only {swing_eligible} pairs kept a measured swing gap of {SWING_DECISIVE_GAP}"
    assert swing_hits >= 16, f"{swing_hits} preferred the straight twin ({swing_eligible} eligible)"
    assert transposed >= 4
    assert transposed_ok == transposed, f"rotation search missed {transposed - transposed_ok} of {transposed}"


def test_tempo_step_breaks_a_single_bpm(tmp_path):
    """One constant BPM must be wrong once the tempo steps. This is a limit, not a success to remove."""
    sr = SR
    bpm_a, bpm_b = 100.0, 120.0
    beat_a, beat_b = 60.0 / bpm_a, 60.0 / bpm_b
    bars = 8
    dur = _LEAD + bars * 4 * beat_a + bars * 4 * beat_b + 0.3
    audio = np.zeros(int(dur * sr))
    click = _click(sr)
    n = len(click)

    def place(onset: float) -> None:
        i = int(onset * sr)
        if i + n < len(audio):
            audio[i:i + n] += click

    for index in range(bars * 4):
        place(_LEAD + index * beat_a)
    boundary = _LEAD + bars * 4 * beat_a
    for index in range(bars * 4):
        place(boundary + index * beat_b)
    detected = detect_bpm(audio, sr)
    path = tmp_path / "step.wav"
    _write(path, audio)
    grid = detect_grid(path, bpm=detected, sr=sr)
    interval = 60.0 / detected
    errors = []
    for index in range(bars * 4):
        planted = boundary + index * beat_b
        k = round((planted - grid.suggested_downbeat) / interval)
        predicted = grid.suggested_downbeat + k * interval
        errors.append(abs(predicted - planted))
    assert max(errors) > 0.040

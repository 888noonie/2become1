"""Section-mean chroma persisted on the listening document.

A short synthetic tone stands in for a recording. Nothing here reads the
library or ~/.local/share/2become1.
"""

from __future__ import annotations

import hashlib
import json
import math
import sys
import wave
from pathlib import Path

# The worktree venv is the main checkout's environment, which does not carry
# this branch. Import the listening package that sits next to this test.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import numpy as np
import pytest

from twobecomeone import listening
from twobecomeone.analyzer import decode_mono

BPM = 120.0
BARS = 12


def _write_wav(path: Path, samples: np.ndarray, sr: int) -> None:
    frames = (np.clip(samples, -1.0, 1.0) * 32767.0).astype(np.int16)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sr)
        handle.writeframes(frames.tobytes())


def _synthetic_mix(sr: int = listening.SR, bpm: float = BPM, bars: int = BARS) -> np.ndarray:
    """Twelve bars whose pitch changes every four bars."""
    bar = 60.0 / bpm * listening.BEATS_PER_BAR
    count = int(round(bars * bar * sr))
    t = np.arange(count) / sr
    bar_index = np.minimum((t / bar).astype(int), bars - 1)
    freqs = np.full(count, 220.0)
    freqs[bar_index >= 4] = 277.18
    freqs[bar_index >= 8] = 329.63
    phase = np.cumsum(2.0 * np.pi * freqs / sr)
    return 0.55 * np.sin(phase) + 0.2 * np.sin(2.0 * phase)


def _track() -> dict:
    return {
        "id": "section-chroma-tone",
        "name": "section chroma tone",
        "bpm": BPM,
        "beat_grid": {"suggested_downbeat": 0.0},
    }


@pytest.fixture(scope="module")
def analysed(tmp_path_factory):
    folder = tmp_path_factory.mktemp("section-chroma")
    path = folder / "tone.wav"
    _write_wav(path, _synthetic_mix(), listening.SR)
    track = _track()
    return {"path": path, "track": track, "analysis": listening.analyse(track, path, None)}


def _bar_chroma(path: Path, track: dict) -> np.ndarray:
    mix = decode_mono(path, sr=listening.SR)
    _bpm, bar, starts = listening._bar_grid(track, len(mix) / listening.SR)
    assert bar > 0
    features = listening._spectral_features(mix)
    return listening._per_bar(features["chroma"], starts, bar)


def test_analyse_persists_the_section_mean_of_the_bar_chroma(analysed):
    analysis = analysed["analysis"]
    assert analysis["version"] == 2
    assert listening.ANALYSIS_VERSION == 2
    assert analysis["descriptors"] == {
        "chromaBins": 12,
        "field": "meanChroma",
        "swingField": "swingRatio",
        "kind": "section-mean pitch-class energy",
    }
    encoded = json.dumps(analysis)
    assert "NaN" not in encoded and "Infinity" not in encoded
    roundtrip = json.loads(encoded)
    chroma = _bar_chroma(analysed["path"], analysed["track"])
    assert roundtrip["sections"]
    for section in roundtrip["sections"]:
        mean = section["meanChroma"]
        assert isinstance(mean, list) and len(mean) == 12
        assert all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) for value in mean)
        start = section["startBar"] - 1
        stop = start + section["bars"]
        expected = chroma[start:stop].mean(axis=0)
        assert np.allclose(mean, expected, atol=1e-5, rtol=0)


def test_corrections_keep_chroma_only_when_the_span_still_matches(analysed):
    analysis = analysed["analysis"]
    section = analysis["sections"][0]
    half = analysis["barSec"] / 2
    assert section["bars"] >= 3

    kept = listening.apply_corrections(analysis, [{
        "startSec": section["startSec"],
        "endSec": section["endSec"],
        "label": "chorus",
    }])
    assert kept["sections"][0]["meanChroma"] == section["meanChroma"]
    assert kept["sections"][0]["letter"] == section["letter"]
    assert kept["sections"][0]["energyDb"] == section["energyDb"]
    assert kept["sections"][0]["vocalPresence"] == section["vocalPresence"]
    assert kept["estimatedSections"][0]["meanChroma"] == section["meanChroma"]

    edge_start = section["startSec"] + half
    edged = listening.apply_corrections(analysis, [{
        "startSec": edge_start,
        "endSec": section["endSec"] + half,
        "label": "chorus",
    }])
    assert abs(edged["sections"][0]["startSec"] - section["startSec"]) <= half
    assert edged["sections"][0]["meanChroma"] == section["meanChroma"]
    assert edged["estimatedSections"][0]["meanChroma"] == section["meanChroma"]

    far_start = section["startSec"] + half + 0.05
    assert all(abs(item["startSec"] - far_start) > half for item in analysis["sections"])
    missed = listening.apply_corrections(analysis, [{
        "startSec": far_start,
        "endSec": section["endSec"] + (far_start - section["startSec"]),
        "label": "verse",
    }])
    nearest = min(analysis["sections"], key=lambda item: abs(item["startSec"] - far_start))
    assert "meanChroma" not in missed["sections"][0]
    assert missed["sections"][0]["energyDb"] == nearest["energyDb"]
    assert missed["sections"][0]["vocalPresence"] == nearest["vocalPresence"]
    assert missed["sections"][0]["letter"] == ("?" if abs(nearest["startSec"] - far_start) >= half else nearest["letter"])
    assert missed["estimatedSections"][0]["meanChroma"] == section["meanChroma"]

    shortened = listening.apply_corrections(analysis, [{
        "startSec": section["startSec"],
        "endSec": section["startSec"] + analysis["barSec"],
        "label": "verse",
    }])
    assert "meanChroma" not in shortened["sections"][0]
    assert shortened["sections"][0]["energyDb"] == section["energyDb"]
    assert shortened["estimatedSections"][0]["meanChroma"] == section["meanChroma"]


def test_old_or_incomplete_documents_do_not_invent_chroma():
    chroma = [round(0.1 * (index + 1), 6) for index in range(12)]
    estimated = {
        "id": "s1",
        "index": 0,
        "letter": "A",
        "startBar": 1,
        "bars": 4,
        "startSec": 0.0,
        "endSec": 8.0,
        "energyDb": -12.5,
        "vocalPresence": 0.4,
        "meanChroma": chroma,
    }
    old = {"version": 1, "barSec": 2.0, "firstBarSec": 0.0, "sections": [dict(estimated)], "words": []}
    out = listening.apply_corrections(old, [{"startSec": 0.0, "endSec": 8.0, "label": "verse"}])
    assert "meanChroma" not in out["sections"][0]
    assert out["sections"][0]["energyDb"] == -12.5
    assert out["sections"][0]["vocalPresence"] == 0.4
    assert out["sections"][0]["letter"] == "A"
    assert out["estimatedSections"][0]["meanChroma"] == chroma

    bare = dict(estimated)
    del bare["meanChroma"]
    missing = {"version": 2, "barSec": 2.0, "firstBarSec": 0.0, "sections": [bare], "words": []}
    out = listening.apply_corrections(missing, [{"startSec": 0.0, "endSec": 8.0, "label": "verse"}])
    assert "meanChroma" not in out["sections"][0]
    assert out["sections"][0]["energyDb"] == -12.5
    assert "meanChroma" not in out["estimatedSections"][0]

    blank = dict(estimated)
    blank["meanChroma"] = None
    nulled = {"version": 2, "barSec": 2.0, "firstBarSec": 0.0, "sections": [blank], "words": []}
    out = listening.apply_corrections(nulled, [{"startSec": 0.0, "endSec": 8.0, "label": "verse"}])
    assert "meanChroma" not in out["sections"][0]
    assert out["estimatedSections"][0]["meanChroma"] is None


def test_a_non_finite_section_mean_is_null_rather_than_nan():
    finite = np.ones((4, 12))
    assert listening._section_mean_chroma(finite, 0, 4) == [1.0] * 12
    broken = finite.copy()
    broken[1, 3] = np.nan
    assert listening._section_mean_chroma(broken, 0, 4) is None
    assert listening._section_mean_chroma(finite, 2, 2) is None


def test_listening_store_key_includes_analysis_version(tmp_path, monkeypatch):
    store = listening.ListeningStore(tmp_path)
    track = {
        "id": "cache-tone",
        "bpm": BPM,
        "beat_grid": {"suggested_downbeat": 0.25, "first_beat": 0.0},
    }
    sha = "0123456789abcdef" * 4
    analysis = {"version": 2, "sections": [{"meanChroma": [0.25] * 12}]}
    assert listening.ANALYSIS_VERSION == 2
    store.store(sha, "stem-set", track, None, analysis)
    assert store.cached(sha, "stem-set", track, None) == analysis

    current = store._key(sha, "stem-set", track, None)
    assert [path.stem for path in tmp_path.glob("*.json")] == [current]
    grid = track["beat_grid"]
    version_one = json.dumps([
        1, "stem-set", track.get("bpm"), grid.get("suggested_downbeat"), grid.get("first_beat"), None,
    ])
    other = f"{sha[:16]}-{hashlib.sha256(version_one.encode()).hexdigest()[:12]}"
    assert other != current

    monkeypatch.setattr(listening, "ANALYSIS_VERSION", 1)
    assert store._key(sha, "stem-set", track, None) == other
    assert store.cached(sha, "stem-set", track, None) is None
    stale = {"version": 1, "sections": []}
    (tmp_path / f"{other}.json").write_text(json.dumps(stale), encoding="utf-8")
    assert store.cached(sha, "stem-set", track, None) == stale

    monkeypatch.setattr(listening, "ANALYSIS_VERSION", 2)
    assert store.cached(sha, "stem-set", track, None) == analysis


def test_analysed_section_chroma_outranks_a_cluster(analysed):
    """The vector comes from analyse(), not from a hand-written winner."""
    from twobecomeone.chorus_fit import rank_fit

    section = analysed["analysis"]["sections"][0]
    assert section["meanChroma"] and len(section["meanChroma"]) == 12
    target = {
        "id": section["id"],
        "meanChroma": section["meanChroma"],
        "bars": section["bars"],
        "bpm": analysed["analysis"]["bpm"],
        "key": "C major",
        "startSec": section["startSec"],
        "endSec": section["endSec"],
    }
    same = dict(target, id="same-passage")
    cluster = {
        "id": "cluster",
        "meanChroma": [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        "bars": section["bars"],
        "bpm": analysed["analysis"]["bpm"],
        "key": "C major",
    }
    ranked = rank_fit(target, [cluster, same])
    assert ranked["candidates"][0]["id"] == "same-passage"
    assert ranked["candidates"][0]["evidence"] != "missing"
    assert ranked["candidates"][0]["harmonic"]["proof"] is False
    assert ranked["candidates"][-1]["id"] == "cluster" or ranked["candidates"][1]["harmonic"]["cosine"] < ranked["candidates"][0]["harmonic"]["cosine"]

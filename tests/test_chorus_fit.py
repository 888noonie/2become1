"""Chorus Fit ranking: pure descriptors, no audio and no model.

The ambiguity gap is the named constant on the module. These tests build
chroma by hand so a missing descriptor cannot hide as a zero score, a
rotation cannot be skipped, and a close pair has to ask.
"""

import copy

import numpy as np
import pytest

from twobecomeone.listening import effective_key_name
from twobecomeone.chorus_fit import (
    CHROMA_AMBIGUITY_GAP,
    QUALIFIED_STRETCH_MAX,
    QUALIFIED_STRETCH_MIN,
    SWING_DECISIVE_GAP,
    WEAK_HARMONIC_COSINE,
    rank_fit,
)


def _chroma(values):
    row = np.zeros(12)
    for i, value in enumerate(values):
        row[i] = value
    return row.tolist()


def _section(section_id, chroma, **extra):
    base = {
        "id": section_id,
        "label": "chorus",
        "meanChroma": chroma,
        "bars": 8,
        "vocalPresence": 0.8,
        "bpm": 100.0,
        "swing": 0.5,
        "key": "C major",
        "startSec": 10.0,
        "endSec": 20.0,
        "downbeatSec": 10.0,
    }
    base.update(extra)
    return base


def _top(result):
    return result["candidates"][0]


def test_named_thresholds_are_real_numbers():
    assert isinstance(CHROMA_AMBIGUITY_GAP, float)
    assert 0.02 <= CHROMA_AMBIGUITY_GAP <= 0.15
    assert SWING_DECISIVE_GAP == 0.12
    assert QUALIFIED_STRETCH_MIN == 0.857
    assert QUALIFIED_STRETCH_MAX == 1.2
    assert 0.3 <= WEAK_HARMONIC_COSINE < 0.8


def test_identical_chroma_ranks_first_and_does_not_mutate_inputs():
    target = _section("a", _chroma([1, 0, 0, 0, 1, 0, 0, 1]))
    match = _section("match", _chroma([1, 0, 0, 0, 1, 0, 0, 1]), startSec=30.0, key="C major")
    other = _section("other", _chroma([0, 0, 1, 0, 0, 0, 1, 0]), startSec=40.0, key="F# major")
    before = copy.deepcopy([target, match, other])
    result = rank_fit(target, [other, match])
    assert [target, match, other] == before
    assert result["version"] == "chorus-fit/v1"
    assert _top(result)["id"] == "match"
    assert _top(result)["harmonic"]["rotation"] == 0
    assert _top(result)["harmonic"]["proof"] is False
    assert _top(result)["startSec"] == 30.0
    assert result["ask"] is False
    assert result["decisive"] is True


def test_all_twelve_rotations_are_searched():
    base = np.array([1.0, 0.0, 0.2, 0.0, 0.8, 0.0, 0.1, 0.7, 0.0, 0.0, 0.0, 0.0])
    rolled = np.roll(base, 5)
    plain = float(np.dot(base, rolled) / (np.linalg.norm(base) * np.linalg.norm(rolled)))
    target = _section("a", base.tolist(), key="C major")
    moved = _section("moved", rolled.tolist(), key="F major")
    decoy = _section("decoy", [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0], key="C major")
    result = rank_fit(target, [decoy, moved])
    winner = _top(result)
    assert winner["id"] == "moved"
    assert winner["harmonic"]["rotation"] != 0
    assert winner["harmonic"]["cosine"] > plain + 0.2
    assert winner["harmonic"]["proof"] is False
    # F is five semitones above C; semitones_to_match("C major", "F major") is -5.
    assert winner["pitch"]["keySemitones"] == -5
    assert winner["pitch"]["agreement"] == "agree"
    assert winner["pitch"]["suggested"] == -5
    assert winner["pitch"]["qualified"] is False


def test_rotation_that_disagrees_with_the_key_does_not_apply_pitch():
    base = np.array([1.0, 0.0, 0.0, 0.0, 0.8, 0.0, 0.0, 0.6, 0.0, 0.0, 0.0, 0.0])
    target = _section("a", base.tolist(), key="C major")
    # Same bins, so the chroma rotation is 0, but the key asks for -5.
    candidate = _section("b", base.tolist(), key="F major")
    winner = _top(rank_fit(target, [candidate]))
    assert winner["harmonic"]["rotation"] == 0
    assert winner["pitch"]["agreement"] == "disagree"
    assert winner["pitch"]["suggested"] == 0
    assert winner["pitch"]["autoApply"] is False
    assert result_asks_or_notes(winner)


def result_asks_or_notes(winner):
    return winner["pitch"]["agreement"] == "disagree" and "ask" in winner["pitch"]["note"].lower()


def test_missing_chroma_is_not_a_zero_score():
    target = _section("a", _chroma([1, 0, 0, 0, 1, 0, 0, 1]))
    missing = _section("gone", None, startSec=3.0)
    zeros = _section("flat", [0] * 12, startSec=4.0)
    real = _section("real", _chroma([1, 0, 0, 0, 1, 0, 0, 1]), startSec=5.0)
    result = rank_fit(target, [missing, zeros, real])
    by_id = {row["id"]: row for row in result["candidates"]}
    assert by_id["gone"]["evidence"] == "missing"
    assert by_id["gone"]["harmonic"]["cosine"] is None
    assert by_id["flat"]["evidence"] == "missing"
    assert by_id["flat"]["harmonic"]["cosine"] is None
    assert _top(result)["id"] == "real"
    assert result["candidates"][-1]["evidence"] == "missing"


def _at_cosine(base: np.ndarray, cosine: float) -> np.ndarray:
    """A 12-bin vector whose cosine with `base` is exactly `cosine`."""
    unit = base / np.linalg.norm(base)
    ortho = np.zeros(12)
    ortho[int(np.argmin(np.abs(unit)))] = 1.0
    ortho = ortho - unit * float(np.dot(ortho, unit))
    ortho = ortho / np.linalg.norm(ortho)
    angle = float(np.arccos(np.clip(cosine, -1.0, 1.0)))
    return np.cos(angle) * unit + np.sin(angle) * ortho


def test_close_chroma_asks_until_swing_separates_them():
    base = np.array([1.0, 0.0, 0.0, 0.0, 0.5, 0.0, 0.0, 0.4, 0.0, 0.0, 0.0, 0.0])
    inside = _at_cosine(base, 1.0 - CHROMA_AMBIGUITY_GAP / 2)
    target = _section("a", base.tolist(), swing=0.50)
    near = _section("near", inside.tolist(), swing=0.50, startSec=1)
    same = _section("same", base.tolist(), swing=0.51, startSec=2)
    close = rank_fit(target, [near, same])
    assert close["ask"] is True
    assert close["decisive"] is False
    assert close["ambiguityGap"] == CHROMA_AMBIGUITY_GAP

    straight = _section("straight", base.tolist(), swing=0.50, startSec=1)
    swung = _section("swung", base.tolist(), swing=0.50 + SWING_DECISIVE_GAP + 0.01, startSec=2)
    separated = rank_fit(target, [swung, straight])
    assert _top(separated)["id"] == "straight"
    assert separated["ask"] is False
    assert separated["decisive"] is True
    assert separated["distinguishedBy"] == "swing"


def test_a_third_close_swing_keeps_the_rank_a_question():
    """Clearing the runner-up is not enough when another close candidate is still near."""
    base = np.array([1.0, 0.0, 0.0, 0.0, 0.5, 0.0, 0.0, 0.4, 0.0, 0.0, 0.0, 0.0])
    target = _section("a", base.tolist(), swing=0.63)
    near = _section("near", base.tolist(), swing=0.59, startSec=1)
    far = _section("far", base.tolist(), swing=0.72, startSec=2)
    still = _section("still", base.tolist(), swing=0.50, startSec=3)
    result = rank_fit(target, [far, still, near])
    assert result["ask"] is True
    assert result["decisive"] is False
    assert result["distinguishedBy"] is None
    assert "does not separate" in result["askReason"]


def test_the_listening_document_can_carry_the_track_key_it_already_has():
    assert effective_key_name({"key": {"tonic": "C", "mode": "major"}}) == "C major"
    assert effective_key_name({"key": {"tonic": "F#", "mode": "minor"}}) == "F# minor"
    assert effective_key_name({"key": {"tonic": None, "mode": "major"}}) is None
    assert effective_key_name({"key": {"tonic": " ", "mode": " "}}) is None
    assert effective_key_name({}) is None


def test_a_nested_label_is_not_echoed_as_audio():
    chroma = _chroma([1, 0, 0, 0, 0, 0, 0, 0])
    result = rank_fit(
        {"id": "a", "meanChroma": chroma, "label": {"pcm": [0.25, -0.25]}},
        [{"id": "b", "meanChroma": chroma, "label": {"audio": [0.25, -0.25]}}],
    )
    assert result["candidates"][0]["label"] is None


def test_swing_does_not_rescue_a_different_harmony():
    target_ch = _chroma([1, 0, 0, 0, 1, 0, 0, 1])
    target = _section("a", target_ch, swing=0.50)
    swung_match = _section("swung-match", target_ch, swing=0.67, startSec=1)
    straight_other = _section("straight-other", _chroma([0, 1, 1, 1, 0, 0, 0, 0]), swing=0.50, startSec=2)
    result = rank_fit(target, [straight_other, swung_match])
    assert _top(result)["id"] == "swung-match"


def test_half_time_is_listed_and_not_applied():
    target = _section("a", _chroma([1, 0, 0, 0, 1, 0, 0, 1]), bpm=120)
    slow = _section("slow", _chroma([1, 0, 0, 0, 1, 0, 0, 1]), bpm=60, key="C major")
    tempo = _top(rank_fit(target, [slow]))["tempo"]
    kinds = {row["kind"]: row for row in tempo["relationships"]}
    assert kinds["as_read"]["stretch"] == pytest.approx(2.0)
    assert kinds["as_read"]["qualified"] is False
    assert kinds["as_read"]["apply"] is False
    assert kinds["half_time"]["stretch"] == pytest.approx(1.0)
    assert kinds["half_time"]["apply"] is False
    assert tempo["applyStretch"] is None


def test_unison_stretch_inside_the_band_may_be_applied():
    target = _section("a", _chroma([1, 0, 0, 0, 1, 0, 0, 1]), bpm=100)
    source = _section("b", _chroma([1, 0, 0, 0, 1, 0, 0, 1]), bpm=104, key="C major")
    tempo = _top(rank_fit(target, [source]))["tempo"]
    assert tempo["relationships"][0]["kind"] == "as_read"
    assert QUALIFIED_STRETCH_MIN <= tempo["relationships"][0]["stretch"] <= QUALIFIED_STRETCH_MAX
    assert tempo["applyStretch"] == pytest.approx(100 / 104)
    assert tempo["qualified"] is True


def test_relative_major_minor_with_matching_chroma_leaves_pitch_at_zero():
    chroma = _chroma([1, 0, 0, 0, 1, 0, 0, 1])
    target = _section("a", chroma, key="C major")
    relative = _section("b", chroma, key="A minor")
    pitch = _top(rank_fit(target, [relative]))["pitch"]
    assert pitch["keySemitones"] == 0
    assert pitch["agreement"] == "agree"
    assert pitch["suggested"] == 0
    assert pitch["qualified"] is True


def test_weak_match_asks_instead_of_declaring_a_winner():
    # A peaked pattern against a flat one stays weak at every rotation.
    # A single moved spike would be a rotation, and must not be called weak.
    peaked = np.array([1.0, 0.0, 0.0, 0.0, 0.2, 0.0, 0.0, 0.8, 0.0, 0.0, 0.0, 0.0])
    flat = np.ones(12)
    best = max(
        float(np.dot(peaked, np.roll(flat, r)) / (np.linalg.norm(peaked) * np.linalg.norm(flat)))
        for r in range(12)
    )
    assert best < WEAK_HARMONIC_COSINE
    result = rank_fit(_section("a", peaked.tolist()), [_section("poor", flat.tolist())])
    assert _top(result)["evidence"] == "weak"
    assert _top(result)["harmonic"]["cosine"] == pytest.approx(best)
    assert result["ask"] is True
    assert result["decisive"] is False


def test_duration_and_vocal_do_not_outrank_a_clear_harmonic_winner():
    target_ch = _chroma([1, 0, 0, 0, 1, 0, 0, 1])
    target = _section("a", target_ch, bars=8, vocalPresence=0.9)
    short_quiet = _section("right", target_ch, bars=4, vocalPresence=0.1, startSec=1)
    long_loud = _section("wrong", _chroma([0, 1, 1, 0, 0, 1, 0, 0]), bars=8, vocalPresence=1.0, startSec=2)
    assert _top(rank_fit(target, [long_loud, short_quiet]))["id"] == "right"


def test_missing_vocal_is_not_treated_as_silence():
    chroma = _chroma([1, 0, 0, 0, 1, 0, 0, 1])
    target = _section("a", chroma, vocalPresence=0.8)
    unknown = _section("unknown", chroma, vocalPresence=None, startSec=1)
    silent = _section("silent", chroma, vocalPresence=0.0, startSec=2)
    result = rank_fit(target, [silent, unknown])
    unknown_row = next(row for row in result["candidates"] if row["id"] == "unknown")
    assert unknown_row["vocal"]["status"] == "missing"
    assert unknown_row["vocal"]["presence"] is None
    assert _top(result)["id"] == "unknown"


def test_bar_count_breaks_a_harmonic_tie_without_hiding_it():
    chroma = _chroma([1, 0, 0, 0, 1, 0, 0, 1])
    target = _section("a", chroma, bars=8, swing=None, vocalPresence=None)
    short = _section("short", chroma, bars=4, swing=None, vocalPresence=None, startSec=1)
    right = _section("right", chroma, bars=8, swing=None, vocalPresence=None, startSec=2)
    result = rank_fit(target, [short, right])
    assert _top(result)["id"] == "right"
    assert result["ask"] is True  # harmonically identical; length is not a musical proof


def test_fit_lines_names_an_estimate_and_does_not_invent_chroma():
    from twobecomeone.chorus_fit import fit_lines

    major = _chroma([1, 0, 0, 0, 1, 0, 0, 1])
    song_a = {"bpm": 100, "key": "C major", "sections": [
        {"id": "a1", "name": "chorus 1", "label": "chorus", "meanChroma": major, "bars": 8, "vocalPresence": 0.9, "startSec": 0, "endSec": 8},
    ]}
    song_b = {"bpm": 100, "key": "C major", "sections": [
        {"id": "b-decoy", "name": "verse 1", "label": "verse", "meanChroma": [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0], "bars": 8, "vocalPresence": 0.4, "startSec": 8, "endSec": 16},
        {"id": "b-match", "name": "chorus 1", "label": "chorus", "meanChroma": major, "bars": 8, "vocalPresence": 0.8, "startSec": 0, "endSec": 8},
    ]}
    lines = fit_lines({"A": song_a, "B": song_b})
    text = " ".join(lines)
    assert "chorus 1" in text
    assert "not a chord chart" in text
    assert "not proof" in text
    assert fit_lines({"B": song_b}) == []
    blank = {"bpm": 100, "sections": [{"id": "x", "label": "chorus", "name": "chorus", "bars": 4}]}
    assert fit_lines({"A": blank, "B": blank}) == ["CHORUS FIT: section chroma is not on these analyses, so nothing is scored."]


def test_chorus_fit_route_accepts_descriptors_and_refuses_extra_fields(tmp_path):
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    from twobecomeone.webapp import create_app

    app = create_app(tmp_path / "chorus-fit")
    client = TestClient(app, base_url="http://localhost")
    major = _chroma([1, 0, 0, 0, 1, 0, 0, 1])
    body = {
        "target": {"id": "a", "meanChroma": major, "bars": 8, "bpm": 100, "key": "C major", "startSec": 0, "endSec": 19.2},
        "candidates": [
            {"id": "cluster", "meanChroma": [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0], "bars": 8, "bpm": 100, "key": "C major"},
            {"id": "match", "meanChroma": major, "bars": 8, "bpm": 100, "key": "C major", "startSec": 4.8, "endSec": 14.4, "downbeatSec": 4.8},
        ],
    }
    response = client.post("/api/chorus-fit", json=body)
    assert response.status_code == 200
    payload = response.json()
    assert payload["version"] == "chorus-fit/v1"
    assert payload["candidates"][0]["id"] == "match"
    assert payload["candidates"][0]["harmonic"]["proof"] is False
    assert payload["candidates"][0]["downbeatSec"] == 4.8
    refused = client.post("/api/chorus-fit", json={**body, "audio": "not-allowed"})
    assert refused.status_code == 422
    nested = client.post("/api/chorus-fit", json={
        "target": {"audio": [0, 0.25, -0.25]},
        "candidates": [{"id": "B", "label": {"pcm": [0, 0.25, -0.25]}}],
    })
    assert nested.status_code == 422
    missing = client.post("/api/chorus-fit", json={
        "target": {"id": "a", "meanChroma": None, "label": "chorus"},
        "candidates": [{"id": "b", "label": "verse"}],
    })
    assert missing.status_code == 200
    assert missing.json()["candidates"][0]["evidence"] == "missing"
    app.state.studio.close()

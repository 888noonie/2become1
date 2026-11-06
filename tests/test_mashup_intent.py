"""Grammar-only mashup intent. No model calls."""

from __future__ import annotations

import json

from twobecomeone.mashup_contracts import (
    COMPLEX_MODEL,
    DISALLOWED_DEFAULT_MODELS,
    SYSTEM1_MODEL,
)
from twobecomeone.mashup_intent import (
    directive_from_model_json,
    escalation,
    interpret,
    transition_between,
)


def test_drop_bass_on_deck_a():
    result = interpret("drop the bass on deck A")
    assert result["ok"] is True
    assert result["tier"] == "deterministic"
    assert result["source"] == "grammar"
    assert result["model"] is None
    assert result["ops"] == [{"op": "eq", "deck": "A", "band": "low", "db": -12.0}]
    assert result["declined"] == []
    assert result["error"] is None


def test_bass_and_loop_are_two_ops():
    result = interpret("drop the bass on deck A and loop 4 bars on deck B")
    assert result["ok"] is True
    assert result["ops"] == [
        {"op": "eq", "deck": "A", "band": "low", "db": -12.0},
        {"op": "loop", "deck": "B", "bars": 4, "enabled": True},
    ]
    assert result["declined"] == []


def test_vocal_loop_declines_without_separation():
    result = interpret("loop the vocal on deck B")
    assert result["ok"] is True
    assert result["ops"] == []
    assert result["declined"] == [{
        "code": "STEM_LOOP_UNAVAILABLE",
        "message": (
            "Vocal loops need a separated vocal stem; "
            "this phrase does not start separation."
        ),
    }]


def test_make_it_slap_is_system1_grammar_miss():
    result = interpret("make it slap")
    assert result["ok"] is False
    assert result["error"]["code"] == "GRAMMAR_MISS"
    assert result["ops"] == []
    assert result["declined"] == []
    decision = escalation("make it slap")
    assert decision == {
        "escalate": True,
        "tier": "system1",
        "model": "deepseek-v4-flash:cloud",
        "reason": "grammar-miss",
    }
    assert decision["model"] == SYSTEM1_MODEL
    assert decision["model"] not in DISALLOWED_DEFAULT_MODELS


def test_mashup_journey_escalates_complex():
    decision = escalation("mashup these into a journey")
    assert decision["escalate"] is True
    assert decision["tier"] == "complex"
    assert decision["model"] == "deepseek-v4-pro:cloud"
    assert decision["model"] == COMPLEX_MODEL
    assert decision["reason"] == "multi-step"
    assert decision["model"] not in DISALLOWED_DEFAULT_MODELS


def test_model_draft_rejects_unknown_op_without_raising():
    extra = json.dumps({
        "ops": [{"op": "eq", "deck": "A", "band": "low", "db": -12, "extra": True}],
        "declined": [],
    })
    stems = json.dumps({"ops": [{"op": "stems", "deck": "A"}], "declined": []})
    assert directive_from_model_json(extra, tier="system1")["error"]["code"] == "PR_DRAFT_INVALID"
    assert directive_from_model_json(stems, tier="system1")["ok"] is False
    assert directive_from_model_json(stems, tier="system1")["error"]["code"] == "PR_DRAFT_INVALID"
    assert directive_from_model_json(stems, tier="system1")["ops"] == []


def test_model_draft_valid_eq_uses_system1_model():
    raw = json.dumps({
        "ops": [{"op": "eq", "deck": "A", "band": "low", "db": -12}],
        "declined": [],
    })
    result = directive_from_model_json(raw, tier="system1")
    assert result["ok"] is True
    assert result["tier"] == "system1"
    assert result["source"] == "model"
    assert result["model"] == SYSTEM1_MODEL
    assert result["ops"][0]["band"] == "low"
    assert result["ops"][0]["db"] == -12.0


def test_disallowed_model_cannot_be_smuggled():
    raw = json.dumps({
        "model": "mistral-large-3:675b-cloud",
        "ops": [{"op": "gain", "deck": "B", "value": 0}],
        "declined": [],
    })
    result = directive_from_model_json(raw, tier="system1")
    assert result["ok"] is True
    assert result["model"] == SYSTEM1_MODEL
    assert result["model"] not in DISALLOWED_DEFAULT_MODELS
    assert result["model"] != "mistral-large-3:675b-cloud"


def test_transition_between_a_and_b_is_full_right():
    result = transition_between("A", "B")
    assert result["ok"] is True
    assert result["source"] == "transition"
    assert result["ops"] == [{"op": "crossfader", "position": 100.0}]


def test_more_than_four_clauses_is_too_many():
    text = "play deck a; pause deck b; mute deck a; play deck b; silence deck a"
    result = interpret(text)
    assert result["ok"] is False
    assert result["error"]["code"] == "TOO_MANY"
    assert result["ops"] == []
    assert result["declined"] == []
    decision = escalation(text)
    assert decision["escalate"] is True
    assert decision["tier"] == "complex"
    assert decision["reason"] == "multi-step"
    assert decision["model"] == COMPLEX_MODEL

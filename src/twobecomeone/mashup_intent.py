"""Deterministic mashup phrase grammar. No I/O and no model calls."""

from __future__ import annotations

import json
import re
from typing import Any

from twobecomeone.mashup_contracts import (
    COMPLEX_MODEL,
    DISALLOWED_DEFAULT_MODELS,
    SYSTEM1_MODEL,
    playback_directive,
    select_model,
    transition_directive,
)

_LOOP_BARS = (1, 2, 4, 8)
_VOCAL_LOOP = re.compile(r"\bloop\s+(?:the\s+)?vocals?\b")
_EQ_LOW_CUT = re.compile(r"\b(?:drop|kill|cut|remove)\s+(?:the\s+)?(?:bass|low\s+end|lows)\b")
_EQ_LOW_BOOST = re.compile(r"\b(?:boost|lift|raise)\s+(?:the\s+)?(?:bass|low\s+end)\b")
_EQ_MID_CUT = re.compile(r"\b(?:drop|cut)\s+(?:the\s+)?(?:mids|mid)\b")
_EQ_HIGH_CUT = re.compile(r"\b(?:drop|cut)\s+(?:the\s+)?(?:highs|treble|top)\b")
_MUTE = re.compile(r"\b(?:mute|silence)\b")
_UNITY = re.compile(r"\b(?:restore\s+gain|full\s+volume|unity\s+gain)\b")
_CROSSFADE_TO = re.compile(r"\bcrossfade\s+to\b")
_BRING_IN = re.compile(r"\bbring\s+in\b")
_CROSSFADER_CENTER = re.compile(r"\b(?:center\s+the\s+crossfader|crossfader\s+center)\b")
_HIGHPASS = re.compile(r"\bhigh-?pass\b")
_LOWPASS = re.compile(r"\blow-?pass\b")
_FILTER_OFF = re.compile(r"\b(?:filter\s+off|clear\s+filter)\b")
_LOOP_N = re.compile(r"\bloop\s+(\d+)\s+bars?\b")
_LOOP_ANY = re.compile(r"\bloop\b")
_STOP_LOOP = re.compile(r"\b(?:stop|clear)\s+loop\b")
_PLAY = re.compile(r"\bplay\b")
_PAUSE = re.compile(r"\b(?:pause|stop)\b")
_VOCAL_MESSAGE = (
    "Vocal loops need a separated vocal stem; this phrase does not start separation."
)


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower())


def _clauses(text: str) -> list[str]:
    normalized = _normalize(text)
    if not normalized:
        return []
    parts = re.split(r"\s*;\s*|\s+and\s+", normalized)
    return [part.strip() for part in parts if part.strip()]


def _fail(code: str, message: str) -> dict[str, Any]:
    return playback_directive(
        ok=False,
        tier="deterministic",
        source="grammar",
        model=None,
        error={"code": code, "message": message},
    )


def _decks_in(clause: str) -> set[str]:
    found: set[str] = set()
    if re.search(r"\b(?:deck\s+a|foundation|anchor)\b", clause) or re.search(r"\ba\b", clause):
        found.add("A")
    if re.search(r"\b(?:deck\s+b|lead)\b", clause) or re.search(r"\bb\b", clause):
        found.add("B")
    return found


def _decline(code: str, message: str) -> tuple[str, dict[str, str]]:
    return "declined", {"code": code, "message": message}


def _with_deck(clause: str, op: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    decks = _decks_in(clause)
    if len(decks) != 1:
        return _decline("AMBIGUOUS_DECK", f"Deck is ambiguous in: {clause}")
    op["deck"] = next(iter(decks))
    return "op", op


def _crossfade(clause: str, *, bring_in: bool) -> tuple[str, dict[str, Any]]:
    decks = _decks_in(clause)
    if len(decks) != 1:
        return _decline("AMBIGUOUS_DECK", f"Deck is ambiguous in: {clause}")
    deck = next(iter(decks))
    if bring_in:
        position = 75 if deck == "B" else 25
    else:
        position = 100 if deck == "B" else 0
    return "op", {"op": "crossfader", "position": position}


def _interpret_clause(clause: str) -> tuple[str, dict[str, Any]]:
    # Vocal loops are declined before any generic loop so separation never starts.
    if _VOCAL_LOOP.search(clause):
        return _decline("STEM_LOOP_UNAVAILABLE", _VOCAL_MESSAGE)
    if _EQ_LOW_CUT.search(clause):
        return _with_deck(clause, {"op": "eq", "band": "low", "db": -12})
    if _EQ_LOW_BOOST.search(clause):
        return _with_deck(clause, {"op": "eq", "band": "low", "db": 6})
    if _EQ_MID_CUT.search(clause):
        return _with_deck(clause, {"op": "eq", "band": "mid", "db": -6})
    if _EQ_HIGH_CUT.search(clause):
        return _with_deck(clause, {"op": "eq", "band": "high", "db": -6})
    if _MUTE.search(clause):
        return _with_deck(clause, {"op": "gain", "value": 0})
    if _UNITY.search(clause):
        return _with_deck(clause, {"op": "gain", "value": 1})
    if _CROSSFADE_TO.search(clause):
        return _crossfade(clause, bring_in=False)
    if _BRING_IN.search(clause):
        return _crossfade(clause, bring_in=True)
    if _CROSSFADER_CENTER.search(clause):
        return "op", {"op": "crossfader", "position": 50}
    if _HIGHPASS.search(clause):
        return _with_deck(clause, {"op": "filter", "mode": "highpass", "amount": 0.7})
    if _LOWPASS.search(clause):
        return _with_deck(clause, {"op": "filter", "mode": "lowpass", "amount": 0.7})
    if _FILTER_OFF.search(clause):
        return _with_deck(clause, {"op": "filter", "mode": "off", "amount": 0})
    if _STOP_LOOP.search(clause):
        return _with_deck(clause, {"op": "loop", "bars": 4, "enabled": False})
    loop_bars = _LOOP_N.search(clause)
    if loop_bars:
        bars = int(loop_bars.group(1))
        if bars not in _LOOP_BARS:
            return _decline("GRAMMAR_MISS", clause)
        return _with_deck(clause, {"op": "loop", "bars": bars, "enabled": True})
    if _LOOP_ANY.search(clause):
        return _with_deck(clause, {"op": "loop", "bars": 4, "enabled": True})
    if _PLAY.search(clause):
        return _with_deck(clause, {"op": "play"})
    if _PAUSE.search(clause):
        return _with_deck(clause, {"op": "pause"})
    return _decline("GRAMMAR_MISS", clause)


def interpret(text: str) -> dict[str, Any]:
    """Map a phrase to one playback directive. Grammar only."""
    clauses = _clauses(text)
    if not clauses:
        return _fail("EMPTY", "Nothing to interpret.")
    if len(clauses) > 4:
        return _fail("TOO_MANY", "At most 4 clauses.")
    ops: list[dict[str, Any]] = []
    declined: list[dict[str, str]] = []
    for clause in clauses:
        kind, payload = _interpret_clause(clause)
        if kind == "op":
            ops.append(payload)
        else:
            declined.append(payload)
    if not ops and all(item["code"] == "GRAMMAR_MISS" for item in declined):
        return _fail("GRAMMAR_MISS", "No clause matched the grammar.")
    return playback_directive(
        ok=True,
        tier="deterministic",
        source="grammar",
        model=None,
        ops=ops,
        declined=declined,
    )


def escalation(text: str) -> dict[str, Any]:
    """Say whether a model may be asked. Does not call a model."""
    result = interpret(text)
    if result["ok"]:
        return {"escalate": False, "tier": None, "model": None, "reason": "grammar"}
    clause_count = len(_clauses(text))
    lowered = text.lower()
    grammar_miss = result["error"]["code"] == "GRAMMAR_MISS"
    if clause_count > 4 or "mashup" in lowered or (grammar_miss and "transition" in lowered):
        model = select_model(tier="complex")
        if model != COMPLEX_MODEL or model in DISALLOWED_DEFAULT_MODELS:
            raise RuntimeError("MODEL_ROUTE")
        return {"escalate": True, "tier": "complex", "model": model, "reason": "multi-step"}
    if grammar_miss:
        model = select_model(tier="system1")
        if model != SYSTEM1_MODEL or model in DISALLOWED_DEFAULT_MODELS:
            raise RuntimeError("MODEL_ROUTE")
        return {"escalate": True, "tier": "system1", "model": model, "reason": "grammar-miss"}
    return {"escalate": False, "tier": None, "model": None, "reason": result["error"]["code"]}


def _invalid_draft() -> dict[str, Any]:
    return playback_directive(
        ok=False,
        tier="deterministic",
        source="grammar",
        model=None,
        error={"code": "PR_DRAFT_INVALID", "message": "Model draft rejected."},
    )


def directive_from_model_json(raw: str, *, tier: str) -> dict[str, Any]:
    """Accept a model draft only when it is a legal playback directive.

    The model name is always ``select_model(tier)``. A name inside the JSON
    is ignored so a disallowed model cannot be smuggled onto the mixer.
    """
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return _invalid_draft()
    if not isinstance(payload, dict):
        return _invalid_draft()
    ops = payload.get("ops")
    declined = payload.get("declined", [])
    if not isinstance(ops, list) or not isinstance(declined, list):
        return _invalid_draft()
    if len(ops) > 4 or len(declined) > 4 or (not ops and not declined):
        return _invalid_draft()
    try:
        model = select_model(tier=tier)
        if model in DISALLOWED_DEFAULT_MODELS:
            return _invalid_draft()
        if tier == "system1" and model != SYSTEM1_MODEL:
            return _invalid_draft()
        if tier == "complex" and model != COMPLEX_MODEL:
            return _invalid_draft()
        return playback_directive(
            ok=True,
            tier=tier,
            source="model",
            model=model,
            ops=ops,
            declined=declined,
        )
    except (TypeError, ValueError):
        return _invalid_draft()


def transition_between(from_deck: str, to_deck: str) -> dict[str, Any]:
    try:
        return transition_directive(from_deck, to_deck)
    except ValueError:
        return _fail("TRANSITION_DECK", "Transition needs two different decks.")

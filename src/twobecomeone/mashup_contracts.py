"""Fail-closed contracts for the autonomous mashup queue.

These schemas are the only objects agents may pass across the acquisition,
intent, queue, and UI boundaries. Unknown keys, unknown operations, and
out-of-range values are rejected. Nothing here performs I/O.

Model routing (from /home/richardn/API/Ollama-API.md, read 2026-11-06):

- The registry lists local ``http://localhost:11434/v1`` and cloud
  ``https://ollama.com`` models. It does not state a token, dollar, or VRAM
  budget. Local was not running at the registry's last test.
- System 1 (a grammar miss that is still a single edit) may call
  ``deepseek-v4-flash:cloud`` only. That is the registry's documented
  quick-test model.
- A multi-step mash plan that the grammar cannot split may call
  ``deepseek-v4-pro:cloud`` only after flash returns an invalid draft.
- ``mistral-large-3:675b-cloud`` is listed and must not be selected. The
  registry gives it no hardware or budget headroom, and Demucs already owns
  the GPU.
- Stem separation is not a model call. It stays on the existing Demucs or
  honest center/side job path.
- Credentials stay in the process environment (``OLLAMA_API_KEY``). This
  module never reads or stores a key.
"""

from __future__ import annotations

from typing import Any

SCHEMA_DECK_LOAD = "deck-load-asset/v1"
SCHEMA_DIRECTIVE = "playback-directive/v1"
SCHEMA_QUEUE_EVENT = "queue-progress/v1"

SYSTEM1_MODEL = "deepseek-v4-flash:cloud"
COMPLEX_MODEL = "deepseek-v4-pro:cloud"
DISALLOWED_DEFAULT_MODELS = frozenset({"mistral-large-3:675b-cloud"})

DECKS = ("A", "B")
TARGET_DECKS = ("A", "B", "auto")
ASSET_STATUSES = ("rejected", "queued", "running", "complete", "failed")
OPS = ("eq", "gain", "crossfader", "filter", "loop", "play", "pause")
BANDS = ("low", "mid", "high")
FILTER_MODES = ("lowpass", "highpass", "off")
LOOP_BARS = (1, 2, 4, 8)
EVENT_TYPES = (
    "import_next",
    "assign_deck",
    "transition",
    "blocked",
    "idle",
)
NEAR_END_SECONDS = 8.0

_DECK_LOAD_KEYS = frozenset({
    "schema", "ok", "canonicalUrl", "jobId", "trackId", "status",
    "targetDeck", "error",
})
_DIRECTIVE_KEYS = frozenset({
    "schema", "ok", "tier", "source", "model", "ops", "declined", "error",
})
_EVENT_KEYS = frozenset({
    "schema", "type", "itemId", "deck", "fromDeck", "toDeck", "trackId",
    "url", "code", "message",
})


def _error(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message}


def _reject_unknown(payload: dict[str, Any], allowed: frozenset[str]) -> None:
    extra = set(payload) - allowed
    if extra:
        names = ", ".join(sorted(extra))
        raise ValueError(f"UNKNOWN_FIELD:{names}")


def deck_load_asset(
    *,
    ok: bool,
    status: str,
    target_deck: str = "auto",
    canonical_url: str | None = None,
    job_id: str | None = None,
    track_id: str | None = None,
    error: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Build a deck-load asset. Raises ValueError when the shape is illegal."""
    asset = {
        "schema": SCHEMA_DECK_LOAD,
        "ok": bool(ok),
        "canonicalUrl": canonical_url,
        "jobId": job_id,
        "trackId": track_id,
        "status": status,
        "targetDeck": target_deck,
        "error": error,
    }
    return validate_deck_load_asset(asset)


def validate_deck_load_asset(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("ASSET_TYPE")
    _reject_unknown(payload, _DECK_LOAD_KEYS)
    if payload.get("schema") != SCHEMA_DECK_LOAD:
        raise ValueError("ASSET_SCHEMA")
    if not isinstance(payload.get("ok"), bool):
        raise ValueError("ASSET_OK")
    if payload.get("status") not in ASSET_STATUSES:
        raise ValueError("ASSET_STATUS")
    if payload.get("targetDeck") not in TARGET_DECKS:
        raise ValueError("ASSET_DECK")
    for key in ("canonicalUrl", "jobId", "trackId"):
        value = payload.get(key)
        if value is not None and (not isinstance(value, str) or not value.strip()):
            raise ValueError(f"ASSET_{key.upper()}")
    error = payload.get("error")
    if error is not None:
        if not isinstance(error, dict) or set(error) - {"code", "message"}:
            raise ValueError("ASSET_ERROR")
        if not isinstance(error.get("code"), str) or not isinstance(error.get("message"), str):
            raise ValueError("ASSET_ERROR")
    if payload["ok"] and payload["status"] == "rejected":
        raise ValueError("ASSET_OK_STATUS")
    if not payload["ok"] and payload.get("error") is None:
        raise ValueError("ASSET_ERROR_REQUIRED")
    if payload["status"] == "complete" and payload["ok"] and not payload.get("trackId"):
        raise ValueError("ASSET_TRACK_REQUIRED")
    if payload["status"] in {"queued", "running"} and payload.get("trackId"):
        raise ValueError("ASSET_TRACK_EARLY")
    if payload["status"] != "rejected" and payload["ok"] and not payload.get("jobId"):
        raise ValueError("ASSET_JOB_REQUIRED")
    return payload


def rejected_asset(code: str, message: str, *, target_deck: str = "auto") -> dict[str, Any]:
    return deck_load_asset(
        ok=False,
        status="rejected",
        target_deck=target_deck,
        error=_error(code, message),
    )


def _validate_op(op: Any) -> dict[str, Any]:
    if not isinstance(op, dict):
        raise ValueError("OP_TYPE")
    kind = op.get("op")
    if kind not in OPS:
        raise ValueError("OP_UNKNOWN")
    extra = set(op) - {"op", "deck", "band", "db", "value", "position", "mode", "amount", "bars", "enabled"}
    if extra:
        raise ValueError("OP_FIELD:" + ",".join(sorted(extra)))
    if kind == "crossfader":
        if set(op) != {"op", "position"}:
            raise ValueError("OP_CROSSFADER")
        position = op["position"]
        if isinstance(position, bool) or not isinstance(position, (int, float)):
            raise ValueError("OP_CROSSFADER")
        if not 0 <= float(position) <= 100:
            raise ValueError("OP_CROSSFADER_RANGE")
        return {"op": "crossfader", "position": float(position)}
    deck = op.get("deck")
    if deck not in DECKS:
        raise ValueError("OP_DECK")
    if kind == "eq":
        if op.get("band") not in BANDS:
            raise ValueError("OP_BAND")
        db = op.get("db")
        if isinstance(db, bool) or not isinstance(db, (int, float)) or not -12 <= float(db) <= 12:
            raise ValueError("OP_DB")
        return {"op": "eq", "deck": deck, "band": op["band"], "db": float(db)}
    if kind == "gain":
        value = op.get("value")
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= float(value) <= 1:
            raise ValueError("OP_GAIN")
        return {"op": "gain", "deck": deck, "value": float(value)}
    if kind == "filter":
        if op.get("mode") not in FILTER_MODES:
            raise ValueError("OP_FILTER")
        amount = op.get("amount")
        if isinstance(amount, bool) or not isinstance(amount, (int, float)) or not 0 <= float(amount) <= 1:
            raise ValueError("OP_FILTER_AMOUNT")
        return {"op": "filter", "deck": deck, "mode": op["mode"], "amount": float(amount)}
    if kind == "loop":
        bars = op.get("bars")
        if bars not in LOOP_BARS:
            raise ValueError("OP_BARS")
        enabled = op.get("enabled", True)
        if not isinstance(enabled, bool):
            raise ValueError("OP_LOOP_ENABLED")
        return {"op": "loop", "deck": deck, "bars": bars, "enabled": enabled}
    if kind in {"play", "pause"}:
        if set(op) != {"op", "deck"}:
            raise ValueError("OP_TRANSPORT")
        return {"op": kind, "deck": deck}
    raise ValueError("OP_UNKNOWN")


def playback_directive(
    *,
    ok: bool,
    tier: str,
    source: str,
    ops: list[dict[str, Any]] | None = None,
    declined: list[dict[str, str]] | None = None,
    model: str | None = None,
    error: dict[str, str] | None = None,
) -> dict[str, Any]:
    directive = {
        "schema": SCHEMA_DIRECTIVE,
        "ok": ok,
        "tier": tier,
        "source": source,
        "model": model,
        "ops": list(ops or []),
        "declined": list(declined or []),
        "error": error,
    }
    return validate_playback_directive(directive)


def validate_playback_directive(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("DIRECTIVE_TYPE")
    _reject_unknown(payload, _DIRECTIVE_KEYS)
    if payload.get("schema") != SCHEMA_DIRECTIVE:
        raise ValueError("DIRECTIVE_SCHEMA")
    if payload.get("tier") not in {"deterministic", "system1", "complex"}:
        raise ValueError("DIRECTIVE_TIER")
    if payload.get("source") not in {"grammar", "model", "transition"}:
        raise ValueError("DIRECTIVE_SOURCE")
    if not isinstance(payload.get("ok"), bool):
        raise ValueError("DIRECTIVE_OK")
    model = payload.get("model")
    if model is not None:
        if not isinstance(model, str) or model in DISALLOWED_DEFAULT_MODELS:
            raise ValueError("DIRECTIVE_MODEL")
        if payload["tier"] == "system1" and model != SYSTEM1_MODEL:
            raise ValueError("DIRECTIVE_MODEL")
        if payload["tier"] == "complex" and model != COMPLEX_MODEL:
            raise ValueError("DIRECTIVE_MODEL")
        if payload["tier"] == "deterministic":
            raise ValueError("DIRECTIVE_MODEL")
    elif payload["tier"] != "deterministic":
        raise ValueError("DIRECTIVE_MODEL_REQUIRED")
    ops_in = payload.get("ops")
    declined_in = payload.get("declined")
    if not isinstance(ops_in, list) or not isinstance(declined_in, list):
        raise ValueError("DIRECTIVE_LIST")
    if len(ops_in) > 4 or len(declined_in) > 4:
        raise ValueError("DIRECTIVE_LIMIT")
    ops = [_validate_op(op) for op in ops_in]
    declined: list[dict[str, str]] = []
    for item in declined_in:
        if not isinstance(item, dict) or set(item) - {"code", "message"}:
            raise ValueError("DIRECTIVE_DECLINED")
        if not isinstance(item.get("code"), str) or not isinstance(item.get("message"), str):
            raise ValueError("DIRECTIVE_DECLINED")
        declined.append({"code": item["code"], "message": item["message"]})
    error = payload.get("error")
    if error is not None:
        if not isinstance(error, dict) or set(error) - {"code", "message"}:
            raise ValueError("DIRECTIVE_ERROR")
        if not isinstance(error.get("code"), str) or not error.get("message"):
            raise ValueError("DIRECTIVE_ERROR")
    if payload["ok"] and not ops and not declined:
        raise ValueError("DIRECTIVE_EMPTY")
    if not payload["ok"] and error is None:
        raise ValueError("DIRECTIVE_ERROR_REQUIRED")
    if not payload["ok"] and ops:
        raise ValueError("DIRECTIVE_OPS_ON_FAILURE")
    return {
        **payload,
        "ops": ops,
        "declined": declined,
    }


def transition_directive(from_deck: str, to_deck: str) -> dict[str, Any]:
    """Equal-power handoff. 0 is deck A only, 100 is deck B only."""
    if from_deck not in DECKS or to_deck not in DECKS or from_deck == to_deck:
        raise ValueError("TRANSITION_DECK")
    position = 100.0 if to_deck == "B" else 0.0
    return playback_directive(
        ok=True,
        tier="deterministic",
        source="transition",
        ops=[{"op": "crossfader", "position": position}],
    )


def queue_event(
    event_type: str,
    *,
    item_id: str | None = None,
    deck: str | None = None,
    from_deck: str | None = None,
    to_deck: str | None = None,
    track_id: str | None = None,
    url: str | None = None,
    code: str | None = None,
    message: str | None = None,
) -> dict[str, Any]:
    event = {
        "schema": SCHEMA_QUEUE_EVENT,
        "type": event_type,
        "itemId": item_id,
        "deck": deck,
        "fromDeck": from_deck,
        "toDeck": to_deck,
        "trackId": track_id,
        "url": url,
        "code": code,
        "message": message,
    }
    return validate_queue_event(event)


def validate_queue_event(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("EVENT_TYPE")
    _reject_unknown(payload, _EVENT_KEYS)
    if payload.get("schema") != SCHEMA_QUEUE_EVENT:
        raise ValueError("EVENT_SCHEMA")
    if payload.get("type") not in EVENT_TYPES:
        raise ValueError("EVENT_NAME")
    for key in ("itemId", "trackId", "url", "code", "message"):
        value = payload.get(key)
        if value is not None and not isinstance(value, str):
            raise ValueError("EVENT_FIELD")
    for key in ("deck", "fromDeck", "toDeck"):
        value = payload.get(key)
        if value is not None and value not in DECKS and not (key == "deck" and value == "auto"):
            raise ValueError("EVENT_DECK")
    kind = payload["type"]
    if kind == "import_next":
        if not payload.get("itemId") or not payload.get("url"):
            raise ValueError("EVENT_IMPORT")
        if payload.get("deck") not in TARGET_DECKS:
            raise ValueError("EVENT_IMPORT")
    elif kind == "assign_deck":
        if payload.get("deck") not in DECKS or not payload.get("trackId") or not payload.get("itemId"):
            raise ValueError("EVENT_ASSIGN")
    elif kind == "transition":
        if payload.get("fromDeck") not in DECKS or payload.get("toDeck") not in DECKS:
            raise ValueError("EVENT_TRANSITION")
        if payload["fromDeck"] == payload["toDeck"]:
            raise ValueError("EVENT_TRANSITION")
    elif kind == "blocked":
        if not payload.get("code") or not payload.get("message"):
            raise ValueError("EVENT_BLOCKED")
    return payload


def select_model(*, tier: str) -> str:
    """Return the only model allowed for a tier. Raises for anything else."""
    if tier == "system1":
        return SYSTEM1_MODEL
    if tier == "complex":
        return COMPLEX_MODEL
    raise ValueError("MODEL_TIER")

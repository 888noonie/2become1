"""Pure V1 Action validation and normalization for 2become1.

Phase 9A. This module is the server-side twin of the frozen Node contract in
``studio_static/js/actions/contracts.js``. It validates the exact same wire
names, ranges, unknown-field rejection, finite-number rule, region rule, and
actor policy — independently, in pure Python, without executing JavaScript
and without weakening anything to fit Pydantic coercion.

Public surface:

- ``validate_action(raw) -> dict``            — canonical action or ``UserError``
- ``normalize_payload_json(action) -> str``   — deterministic JSON for storage
- ``compare_actions(a, b) -> bool``           — semantic idempotency equality
- ``make_projection_record(action, lifecycle) -> dict``
- ``make_committed_layer(commit_action, proposal) -> dict``

The error vocabulary mirrors the Node ``ERROR_CODES`` table (V_*, P_*, L_*,
I_*) so cross-language contract vectors can assert deliberate parity.
"""

from __future__ import annotations

import json
import math
from typing import Any

from .common import UserError

SCHEMA_VERSION = 1

ACTION_TYPES = ("preview_layer", "commit_layer", "reject_proposal")

ACTOR_TYPES = ("human", "producer")

ALLOWED_TOP_KEYS = ("id", "schemaVersion", "type", "actor", "requestedAt", "idempotencyKey", "payload")
ALLOWED_ACTOR_KEYS = ("type", "id")
ALLOWED_PREVIEW_KEYS = ("source", "destination", "timing", "gainDb")
ALLOWED_PREVIEW_SOURCE_KEYS = ("deck", "stem", "region")
ALLOWED_PREVIEW_DESTINATION_KEYS = ("deck",)
ALLOWED_PREVIEW_TIMING_KEYS = ("launch", "quantize")
ALLOWED_COMMIT_KEYS = ("proposalId", "acceptedAsset", "acceptedAt")
ALLOWED_ACCEPTED_ASSET_KEYS = ("id", "contentHash", "transformSpec")
ALLOWED_REJECT_KEYS = ("proposalId", "rejectedAt", "reason")
ALLOWED_REGION_KEYS = ("id", "label", "startBeat", "endBeat", "gridRevision")

GAIN_MIN_DB = -24.0
GAIN_MAX_DB = 12.0

DECKS = ("A", "B")


class ActionValidationError(UserError):
    """A V1 Action failed contract validation (HTTP 422).

    The envelope's machine-readable ``code`` is the stable public vocabulary
    shared with the Node contract (e.g. ``V_INVALID_GAIN``) so cross-language
    contract vectors can assert exact parity over HTTP too.
    """

    status = 422

    def __init__(self, node_code: str, message: str, *, detail: dict | None = None):
        super().__init__(message, detail=json.dumps(detail, sort_keys=True) if detail else None, code=node_code)
        self.node_code = node_code


def _fail(node_code: str, message: str, **detail: Any) -> None:
    raise ActionValidationError(node_code, message, detail=detail or None)


def _plain_object(value: Any) -> bool:
    return isinstance(value, dict)


def _non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and len(value) > 0


def _finite_number(value: Any) -> bool:
    # Strict parity with the Node validator: a JSON number (int or float at
    # the Python layer — both parse from JSON numbers), never a bool, always
    # finite. ``json.loads`` yields ``inf`` for ``1e999``; isfinite rejects it.
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def _reject_keys(value: dict, allowed: tuple[str, ...], node_code: str) -> None:
    for key in value:
        if key not in allowed:
            _fail(node_code, f"unknown key '{key}'", unexpectedKey=key, allowed=list(allowed))


def _validate_deck(value: Any, node_code: str) -> None:
    if value not in DECKS:
        _fail(node_code, "deck must be exactly 'A' or 'B'", value=value)


def _validate_region(region: Any) -> None:
    if region is None:
        _fail("V_MISSING_REGION", "preview_layer source.region is required")
    if not isinstance(region, dict):
        _fail("V_REGION_NOT_OBJECT", "region must be an object")
    for key in region:
        if key not in ALLOWED_REGION_KEYS:
            _fail("V_UNEXPECTED_PAYLOAD_KEY", f"unknown region key '{key}'", unexpectedKey=key)
    if not _non_empty_string(region.get("id")):
        _fail("V_MISSING_ID", "region.id is required and must be a non-empty string")
    start = region.get("startBeat")
    end = region.get("endBeat")
    if "startBeat" in region and (not _finite_number(start) or start < 0):
        _fail("V_REGION_INVALID_BOUNDS", "region.startBeat must be a finite non-negative number")
    if "endBeat" in region and (not _finite_number(end) or end < 0):
        _fail("V_REGION_INVALID_BOUNDS", "region.endBeat must be a finite non-negative number")
    if "startBeat" in region and "endBeat" in region and end <= start:
        _fail("V_REGION_INVALID_BOUNDS", "region endBeat must be strictly greater than startBeat")
    if "gridRevision" in region and not _non_empty_string(region.get("gridRevision")):
        _fail("V_REGION_INVALID_BOUNDS", "region.gridRevision must be a non-empty string")


def _validate_preview_payload(payload: Any) -> None:
    if not _plain_object(payload):
        _fail("V_MISSING_PAYLOAD", "preview_layer payload must be an object")
    for key in payload:
        if key not in ALLOWED_PREVIEW_KEYS:
            _fail("V_UNEXPECTED_PAYLOAD_KEY", f"unknown payload key '{key}'", unexpectedKey=key)

    source = payload.get("source")
    if not _plain_object(source):
        _fail("V_MISSING_SOURCE", "preview_layer payload.source is required")
    for key in source:
        if key not in ALLOWED_PREVIEW_SOURCE_KEYS:
            _fail("V_UNEXPECTED_PAYLOAD_KEY", f"unknown source key '{key}'", unexpectedKey=key)
    _validate_deck(source.get("deck"), "V_INVALID_DECK")
    if not _non_empty_string(source.get("stem")):
        _fail("V_INVALID_STEM", "source.stem must be a non-empty string")
    _validate_region(source.get("region"))

    destination = payload.get("destination")
    if not _plain_object(destination):
        _fail("V_MISSING_DESTINATION", "preview_layer payload.destination is required")
    for key in destination:
        if key not in ALLOWED_PREVIEW_DESTINATION_KEYS:
            _fail("V_UNEXPECTED_PAYLOAD_KEY", f"unknown destination key '{key}'", unexpectedKey=key)
    _validate_deck(destination.get("deck"), "V_INVALID_DECK")
    if source.get("deck") == destination.get("deck"):
        _fail("V_SAME_DECK", "source.deck and destination.deck must differ")

    timing = payload.get("timing")
    if not _plain_object(timing):
        _fail("V_MISSING_TIMING", "preview_layer payload.timing is required")
    for key in timing:
        if key not in ALLOWED_PREVIEW_TIMING_KEYS:
            _fail("V_UNEXPECTED_PAYLOAD_KEY", f"unknown timing key '{key}'", unexpectedKey=key)
    if timing.get("launch") != "next_phrase":
        _fail("V_INVALID_LAUNCH", 'timing.launch must be exactly "next_phrase"', value=timing.get("launch"))
    if not isinstance(timing.get("quantize"), bool):
        _fail("V_INVALID_QUANTIZE", "timing.quantize must be a boolean")

    if "gainDb" not in payload:
        _fail("V_INVALID_GAIN", "gainDb is required", reason="gainDb missing")
    gain = payload.get("gainDb")
    if not _finite_number(gain) or gain < GAIN_MIN_DB or gain > GAIN_MAX_DB:
        _fail("V_INVALID_GAIN", "gainDb must be a finite number within [-24, 12] dB", value=gain)


def _validate_accepted_asset(asset: Any) -> None:
    if not _plain_object(asset):
        _fail("V_MISSING_ACCEPTED_ASSET", "commit_layer payload.acceptedAsset is required")
    for key in asset:
        if key not in ALLOWED_ACCEPTED_ASSET_KEYS:
            _fail("V_UNEXPECTED_PAYLOAD_KEY", f"unknown acceptedAsset key '{key}'", unexpectedKey=key)
    if not _non_empty_string(asset.get("id")):
        _fail("V_INVALID_ACCEPTED_ASSET", "acceptedAsset.id must be a non-empty string")
    if not _non_empty_string(asset.get("contentHash")):
        _fail("V_MISSING_CONTENT_HASH", "acceptedAsset.contentHash is required")
    if not _plain_object(asset.get("transformSpec")):
        _fail("V_MISSING_TRANSFORM_SPEC", "acceptedAsset.transformSpec must be an object")
    _ensure_json_serializable(asset.get("transformSpec"), "V_INVALID_TRANSFORM_SPEC",
                              "acceptedAsset.transformSpec must be JSON-serializable")


def _validate_commit_payload(payload: Any) -> None:
    if not _plain_object(payload):
        _fail("V_MISSING_PAYLOAD", "commit_layer payload must be an object")
    for key in payload:
        if key not in ALLOWED_COMMIT_KEYS:
            _fail("V_UNEXPECTED_PAYLOAD_KEY", f"unknown payload key '{key}'", unexpectedKey=key)
    if not _non_empty_string(payload.get("proposalId")):
        _fail("V_MISSING_PROPOSAL_ID", "payload.proposalId is required")
    if not _non_empty_string(payload.get("acceptedAt")):
        _fail("V_MISSING_REQUESTED_AT", "payload.acceptedAt is required")
    _validate_accepted_asset(payload.get("acceptedAsset"))


def _validate_reject_payload(payload: Any) -> None:
    if not _plain_object(payload):
        _fail("V_MISSING_PAYLOAD", "reject_proposal payload must be an object")
    for key in payload:
        if key not in ALLOWED_REJECT_KEYS:
            _fail("V_UNEXPECTED_PAYLOAD_KEY", f"unknown payload key '{key}'", unexpectedKey=key)
    if not _non_empty_string(payload.get("proposalId")):
        _fail("V_MISSING_PROPOSAL_ID", "payload.proposalId is required")
    if not _non_empty_string(payload.get("rejectedAt")):
        _fail("V_MISSING_REQUESTED_AT", "payload.rejectedAt is required")
    reason = payload.get("reason")
    if "reason" in payload and reason is not None and not _non_empty_string(reason):
        _fail("V_REASON_NOT_STRING", "payload.reason must be a non-empty string when present")


def _ensure_json_serializable(value: Any, node_code: str, message: str) -> None:
    try:
        json.dumps(value, allow_nan=False)
    except (TypeError, ValueError):
        _fail(node_code, message)


def validate_action(raw: Any) -> dict:
    """Validate one raw Action against the frozen V1 contract.

    Returns the action unchanged (as a plain dict) on success. Raises
    ``ActionValidationError`` (a ``UserError`` with a stable ``node_code``)
    on any violation. Deliberately strict: unknown keys anywhere, booleans
    masquerading as numbers, non-finite numerics, and non-JSON values are
    all rejections.
    """
    if not _plain_object(raw):
        _fail("V_INVALID_TYPE", "Action must be a non-null object")
    for key in raw:
        if key not in ALLOWED_TOP_KEYS:
            _fail("V_UNEXPECTED_PAYLOAD_KEY", f"unknown top-level key '{key}'", unexpectedKey=key)
    if not _non_empty_string(raw.get("id")):
        _fail("V_MISSING_ID", "Action.id is required")
    if raw.get("schemaVersion") != SCHEMA_VERSION:
        _fail("V_INVALID_TYPE", "schemaVersion must be 1", got=raw.get("schemaVersion"))
    if raw.get("type") not in ACTION_TYPES:
        _fail("V_UNKNOWN_TYPE", "Action.type is not one of the allowed V1 types", type=raw.get("type"))

    actor = raw.get("actor")
    if not _plain_object(actor):
        _fail("V_MISSING_ACTOR", "Action.actor is required")
    for key in actor:
        if key not in ALLOWED_ACTOR_KEYS:
            _fail("V_UNEXPECTED_PAYLOAD_KEY", f"unknown actor key '{key}'", unexpectedKey=key)
    if not _non_empty_string(actor.get("type")) or not _non_empty_string(actor.get("id")):
        _fail("V_INVALID_ACTOR", "actor.type and actor.id must be non-empty strings")
    if actor.get("type") not in ACTOR_TYPES:
        _fail("V_INVALID_ACTOR", "actor.type must be 'human' or 'producer'")

    if not _non_empty_string(raw.get("type")):
        _fail("V_MISSING_TYPE", "Action.type is required")
    if not _non_empty_string(raw.get("requestedAt")):
        _fail("V_MISSING_REQUESTED_AT", "Action.requestedAt is required")
    if not _non_empty_string(raw.get("idempotencyKey")):
        _fail("V_MISSING_IDEMPOTENCY_KEY", "Action.idempotencyKey is required")

    payload = raw.get("payload")
    if raw["type"] == "preview_layer":
        _validate_preview_payload(payload)
    elif raw["type"] == "commit_layer":
        _validate_commit_payload(payload)
    else:
        _validate_reject_payload(payload)

    _ensure_json_serializable(raw, "V_NON_SERIALIZABLE", "Action contains a non-serializable value")
    return raw


# ---------------------------------------------------------------------------
# Storage helpers
# ---------------------------------------------------------------------------

def canonical_json(value: Any) -> str:
    """Deterministic JSON for storage: sorted keys, compact separators."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def compare_actions(a: dict, b: dict) -> bool:
    """Semantic idempotency equality: same actor, type, and payload."""
    if not a or not b:
        return False
    if (a.get("actor") or {}).get("type") != (b.get("actor") or {}).get("type"):
        return False
    if (a.get("actor") or {}).get("id") != (b.get("actor") or {}).get("id"):
        return False
    if a.get("type") != b.get("type"):
        return False
    return canonical_json_payload(a) == canonical_json_payload(b)


def canonical_json_payload(action: dict) -> str:
    return canonical_json(action.get("payload"))


LIFECYCLE_STATES = ("ready", "scheduled", "auditioning", "accepted", "rejected")

TRANSITIONS = {
    "ready": ("scheduled", "rejected"),
    "scheduled": ("auditioning", "rejected"),
    "auditioning": ("accepted", "rejected"),
    "accepted": (),
    "rejected": (),
}


def can_transition(current: str, to: str) -> bool:
    return to in TRANSITIONS.get(current, ())


def make_projection_record(action: dict, lifecycle: str) -> dict:
    return {
        "id": action["id"],
        "actionType": action["type"],
        "actor": {"type": action["actor"]["type"], "id": action["actor"]["id"]},
        "requestedAt": action["requestedAt"],
        "idempotencyKey": action["idempotencyKey"],
        "lifecycle": lifecycle,
        "payload": action["payload"],
    }


def make_committed_layer(commit_action: dict, proposal: dict) -> dict:
    payload = commit_action["payload"]
    proposal_payload = proposal["payload"]
    return {
        "layerId": f"layer-{commit_action['id']}",
        "actionId": commit_action["id"],
        "actionType": commit_action["type"],
        "actionSchemaVersion": SCHEMA_VERSION,
        "proposalId": proposal["id"],
        "sourceRegionRef": proposal_payload.get("source", {}).get("region"),
        "acceptedAsset": {
            "id": payload["acceptedAsset"]["id"],
            "contentHash": payload["acceptedAsset"]["contentHash"],
            "transformSpec": payload["acceptedAsset"]["transformSpec"],
        },
        "transformSpec": payload["acceptedAsset"]["transformSpec"],
        "placement": {
            "source": proposal_payload.get("source"),
            "destination": proposal_payload.get("destination"),
            "timing": proposal_payload.get("timing"),
            "gainDb": proposal_payload.get("gainDb"),
        },
        "acceptedAt": payload.get("acceptedAt"),
        "acceptedBy": {"type": commit_action["actor"]["type"], "id": commit_action["actor"]["id"]},
    }


def initial_projection() -> dict:
    return {
        "session": {"deckAssignments": {"A": None, "B": None}, "committedLayers": [], "acceptedActionIds": []},
        "proposals": {"byId": {}, "order": [], "activeIds": []},
    }
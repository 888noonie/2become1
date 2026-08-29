"""Pure proposal lifecycle-fact validation and transition policy (Phase 10A).

Server-side contract for the durable runtime lifecycle facts endpoint:

    POST /api/projects/{project_id}/proposals/{proposal_id}/lifecycle

These facts are RUNTIME provenance (``scheduled``/``auditioning``), not musical
Actions: the append-only ``actions`` ledger stays musical-Action-only, and this
module's vocabulary reuses the shared error codes wherever semantics match
(``V_UNEXPECTED_PAYLOAD_KEY``, ``V_INVALID_ACTOR``, ``V_MISSING_REQUESTED_AT``,
``P_ACTOR_NOT_ALLOWED``, ``L_UNKNOWN_PROPOSAL``, ``L_INVALID_TRANSITION``) and
adds exactly one new code (``V_LIFECYCLE_FACT_INVALID``) for receipt-echo
violations with no existing analog. ``V_*`` schema codes map to 422;
permission/lifecycle codes use the existing 404/409 envelopes.

Frozen receipt-echo schema (Sol amendment 5): the echo may contain ONLY the
fields named in the plan, with strict opaque formats, finite numeric bounds,
bounded string lengths, canonical JSON, and a small maximum encoded size.
Client ``at`` is validated provenance only: it never orders facts and never
overrides server time (``recorded_at`` is server time).
"""

from __future__ import annotations

import json
import re
from typing import Any

from .common import ConflictError, NotFoundError, UserError
from .ghost_assets import ASSET_ID_RE

# Frozen V1 lifecycle states (mirrors js/actions/lifecycle.js).
LIFECYCLE_READY = "ready"
LIFECYCLE_SCHEDULED = "scheduled"
LIFECYCLE_AUDITIONING = "auditioning"
LIFECYCLE_ACCEPTED = "accepted"
LIFECYCLE_REJECTED = "rejected"

TERMINAL_STATES = (LIFECYCLE_ACCEPTED, LIFECYCLE_REJECTED)

# Forward runtime transitions permitted by the lifecycle endpoint. These are a
# subset of the frozen frontend table: only the two runtime hops that Phase 10
# makes durable. Terminal and backward transitions are never writable here.
RUNTIME_TRANSITIONS = {
    (LIFECYCLE_READY, LIFECYCLE_SCHEDULED),
    (LIFECYCLE_SCHEDULED, LIFECYCLE_AUDITIONING),
}

ALLOWED_BODY_KEYS = ("to", "actor", "at", "fact")
ALLOWED_ACTOR_KEYS = ("type", "id")
# A5: exactly the fields named in the plan, nothing else.
ALLOWED_FACT_KEYS = (
    "assetId",
    "contentHash",
    "launchBeat",
    "launchAudioTime",
    "gridRevision",
)

MAX_ACTOR_ID_LENGTH = 120
MAX_AT_LENGTH = 40
MAX_LAUNCH_BEAT = 10_000_000.0
MAX_LAUNCH_AUDIO_TIME = 10_000_000.0
# Canonical encoded ceiling for the scrubbed echo (5b, "small maximum").
MAX_FACT_JSON_BYTES = 512

CONTENT_HASH_RE = re.compile(r"\Asha256:[0-9a-f]{64}\Z")
GRID_REVISION_RE = re.compile(r"\Agrid-v1:[0-9a-f]{64}\Z")


class LifecycleRequestError(UserError):
    """A lifecycle request failed the frozen schema (HTTP 422)."""

    status = 422

    def __init__(self, code: str, message: str, *, detail=None):
        super().__init__(message, detail=json.dumps(detail, sort_keys=True) if detail else None, code=code)


def _fail(code: str, message: str, **detail) -> None:
    raise LifecycleRequestError(code, message, detail=detail or None)


def _non_empty_bounded_string(value, field: str, limit: int) -> str:
    if not isinstance(value, str) or len(value) == 0:
        _fail("V_LIFECYCLE_FACT_INVALID", "expected a non-empty string", field=field)
    if len(value) > limit:
        _fail("V_LIFECYCLE_FACT_INVALID", "string exceeds bounded length", field=field, limit=limit)
    return value


def valid_runtime_transition(current: str, target: str) -> bool:
    """True when (current -> target) is a permitted forward runtime hop."""
    return (current, target) in RUNTIME_TRANSITIONS


def scrub_fact(raw_fact) -> dict:
    """Validate and canonically scrub the optional receipt echo.

    Unknown keys, wrong types, out-of-range numbers, and any non-plain value
    are rejected (never silently stripped): provenance is small and exact.
    """
    if raw_fact is None:
        return {}
    if not isinstance(raw_fact, dict):
        _fail("V_LIFECYCLE_FACT_INVALID", "fact must be an object")
    for key in raw_fact:
        if key not in ALLOWED_FACT_KEYS:
            _fail("V_UNEXPECTED_PAYLOAD_KEY", "unexpected fact key", key=key, allowed=list(ALLOWED_FACT_KEYS))
    scrubbed: dict = {}
    if "assetId" in raw_fact:
        value = raw_fact["assetId"]
        if not isinstance(value, str) or not ASSET_ID_RE.match(value):
            _fail("V_LIFECYCLE_FACT_INVALID", "assetId must be an opaque ga-<32 hex> identifier")
        scrubbed["assetId"] = value
    if "contentHash" in raw_fact:
        if not isinstance(raw_fact["contentHash"], str) or not CONTENT_HASH_RE.match(raw_fact["contentHash"]):
            _fail("V_LIFECYCLE_FACT_INVALID", "contentHash must be sha256:<64 hex>")
        scrubbed["contentHash"] = raw_fact["contentHash"]
    if "gridRevision" in raw_fact:
        if not isinstance(raw_fact["gridRevision"], str) or not GRID_REVISION_RE.match(raw_fact["gridRevision"]):
            _fail("V_LIFECYCLE_FACT_INVALID", "gridRevision must be the server-authored grid-v1:<64 hex>")
        scrubbed["gridRevision"] = raw_fact["gridRevision"]
    for numeric_key, upper in (("launchBeat", MAX_LAUNCH_BEAT), ("launchAudioTime", MAX_LAUNCH_AUDIO_TIME)):
        if numeric_key in raw_fact:
            value = raw_fact[numeric_key]
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not _is_finite(value)
                or value < 0
                or value > upper
            ):
                _fail("V_LIFECYCLE_FACT_INVALID", "expected a finite non-negative number", field=numeric_key)
            scrubbed[numeric_key] = float(value)
    encoded = canonical_fact_json(scrubbed)
    if len(encoded.encode("utf-8")) > MAX_FACT_JSON_BYTES:
        _fail("V_LIFECYCLE_FACT_INVALID", "receipt echo exceeds encoded size limit", limit=MAX_FACT_JSON_BYTES)
    return scrubbed


def _is_finite(value) -> bool:
    try:
        return bool(__import__("math").isfinite(value))
    except (TypeError, ValueError):
        return False


def canonical_fact_json(fact: dict) -> str:
    return json.dumps(fact, sort_keys=True, separators=(",", ":"), allow_nan=False)


def validate_lifecycle_request(raw_body) -> dict:
    """Validate one lifecycle request; return the canonical normalized form.

    Result: {to, actor {type, id}, at, fact}. Raises LifecycleRequestError on
    any schema violation with a stable public code.
    """
    if not isinstance(raw_body, dict):
        _fail("V_LIFECYCLE_FACT_INVALID", "lifecycle request must be an object")
    for key in raw_body:
        if key not in ALLOWED_BODY_KEYS:
            _fail("V_UNEXPECTED_PAYLOAD_KEY", "unexpected body key", key=key, allowed=list(ALLOWED_BODY_KEYS))
    if "to" not in raw_body:
        _fail("L_INVALID_TRANSITION", "unknown to-state", to=None)
    to_state = raw_body["to"]
    if to_state not in (LIFECYCLE_SCHEDULED, LIFECYCLE_AUDITIONING):
        _fail("L_INVALID_TRANSITION", "unknown to-state", to=to_state if isinstance(to_state, str) else None)

    if "actor" not in raw_body or not isinstance(raw_body["actor"], dict):
        _fail("V_MISSING_ACTOR", "actor is required")
    actor = raw_body["actor"]
    for key in actor:
        if key not in ("type", "id"):
            _fail("V_UNEXPECTED_PAYLOAD_KEY", "unexpected actor key", key=key)
    actor_type = actor.get("type")
    actor_id = actor.get("id")
    if not isinstance(actor_type, str) or not actor_type:
        _fail("V_INVALID_ACTOR", "actor.type must be a non-empty string", field="actor.type")
    if not isinstance(actor_id, str) or not actor_id:
        _fail("V_INVALID_ACTOR", "actor.id must be a non-empty string", field="actor.id")
    if len(actor_id) > MAX_ACTOR_ID_LENGTH:
        _fail("V_INVALID_ACTOR", "actor.id exceeds bounded length", field="actor.id")
    if actor_type != "human":
        # Constitutional: only a human schedules/auditions; a producer could
        # not have proposed through the public API either.
        raise ConflictError("only a human may record a proposal lifecycle fact", code="P_ACTOR_NOT_ALLOWED")
    _non_empty_bounded_string(actor_id, "actor.id", MAX_ACTOR_ID_LENGTH)

    if "at" not in raw_body:
        _fail("V_MISSING_REQUESTED_AT", "at (client timestamp) is required provenance", field="at")
    at = _non_empty_bounded_string(raw_body["at"], "at", 40)

    fact = scrub_fact(raw_body.get("fact"))
    return {
        "to": to_state,
        "actor": {"type": "human", "id": actor_id},
        "at": at,
        "fact": fact,
    }


def unknown_proposal(proposal_id: str) -> NotFoundError:
    return NotFoundError(
        "proposalId does not reference a known proposal in this project",
        code="L_UNKNOWN_PROPOSAL",
    )
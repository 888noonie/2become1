"""Classify a two-slot source and hand it to the existing import path.

This module does not download, open a socket, or start a job. A YouTube URL
that parses is still not permission to import. ``authorised`` must be the
caller's own True. The handoff names the existing service method; the caller
submits it.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

from .common import UserError
from .queue_acquisition import _TRACK_ID_RE
from .sources import canonicalize_youtube_url, is_youtube_url
from .studio import ALLOWED_AUDIO_SUFFIXES

Slot = Literal["A", "B"]
SourceKind = Literal["youtube", "upload", "library"]

_SLOTS = frozenset({"A", "B"})


def _reject(code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "code": code, "message": message}


def _staging_key(value: str) -> str | None:
    if Path(value).name != value or "/" in value or "\\" in value:
        return None
    suffix = Path(value).suffix.lower()
    if suffix not in ALLOWED_AUDIO_SUFFIXES or not Path(value).stem:
        return None
    return value


def classify(raw: object) -> dict[str, Any]:
    """Name the existing intake for *raw*, or reject it. Never downloads."""
    if not isinstance(raw, str) or not raw.strip():
        return _reject("BAD_URL", "enter a YouTube link, a staged upload, or a library track")
    value = raw.strip()
    if is_youtube_url(value):
        try:
            canonicalize_youtube_url(value)
        except UserError as exc:
            message = exc.message if isinstance(exc.message, str) and exc.message else str(exc)
            return _reject("BAD_URL", message)
        return {"ok": True, "kind": "youtube"}
    if ":" in value:
        return _reject(
            "UNSUPPORTED_SOURCE",
            "only a YouTube link, an already-staged upload, or a library track is accepted",
        )
    if _TRACK_ID_RE.fullmatch(value):
        return {"ok": True, "kind": "library"}
    if _staging_key(value) is not None:
        return {"ok": True, "kind": "upload"}
    if "." in value or "/" in value or "\\" in value:
        return _reject("BAD_STAGING_KEY", "staging key must be a bare audio filename")
    return _reject(
        "BAD_TRACK",
        "track id must be 8-64 letters, digits, underscores, or hyphens",
    )


def validate(raw: object, *, slot: Slot, authorised: bool) -> dict[str, Any]:
    """Return a handoff for one slot, or a rejection. Does not submit a job."""
    if slot not in _SLOTS:
        return _reject("BAD_URL", "slot must be A or B")
    if authorised is not True:
        return _reject("NOT_AUTHORISED", "this source is not marked as authorised to import")
    kind = classify(raw)
    if not kind.get("ok"):
        return kind
    value = str(raw).strip()
    if kind["kind"] == "youtube":
        return {
            "ok": True,
            "slot": slot,
            "kind": "youtube",
            "canonical_url": canonicalize_youtube_url(value),
            "submit": "submit_youtube_import",
        }
    if kind["kind"] == "upload":
        return {
            "ok": True,
            "slot": slot,
            "kind": "upload",
            "staging_key": value,
            "original_name": None,
            "submit": "submit_upload_import",
        }
    return {
        "ok": True,
        "slot": slot,
        "kind": "library",
        "track_id": value,
        "submit": "assign_deck",
    }

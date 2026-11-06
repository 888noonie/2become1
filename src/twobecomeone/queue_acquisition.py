"""Plan a YouTube deck load without downloading or touching the network.

``plan_youtube_acquisition`` only checks the URL and target deck. It does not
download, call the network, or touch the filesystem. A successful plan is not
a deck-load asset: status ``queued`` requires a job id, and a plan has none.
The pre-job success shape, built by ``accepted_url``, is exactly::

    {"schema": "acquisition-plan/v1", "ok": True,
     "canonicalUrl": "<canonical>", "targetDeck": "A"|"B"|"auto"}

``asset_from_import_job`` maps an existing Studio job snapshot
(``get_job`` / ``submit_youtube_import``) onto ``deck-load-asset/v1``.
``separation_request`` only describes a request for the existing separation
job endpoint. It does not start Demucs and does not claim vocals exist.
"""

from __future__ import annotations

import re
from typing import Any

from .common import UserError
from .mashup_contracts import TARGET_DECKS, deck_load_asset, rejected_asset
from .sources import canonicalize_youtube_url

_PLAN_SCHEMA = "acquisition-plan/v1"
_TRACK_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
_OPEN_STATUSES = frozenset({"queued", "running"})
_FAILED_STATUSES = frozenset({"failed", "cancelled", "interrupted"})


def accepted_url(canonical: str, target_deck: str) -> dict[str, Any]:
    """Return the pre-job acquisition plan. No extra keys."""
    return {
        "schema": _PLAN_SCHEMA,
        "ok": True,
        "canonicalUrl": canonical,
        "targetDeck": target_deck,
    }


def _reject_deck() -> dict[str, Any]:
    return rejected_asset("BAD_DECK", "target deck must be A, B, or auto")


def _canonical(url: str, target_deck: str) -> tuple[str | None, dict[str, Any] | None]:
    if not isinstance(url, str):
        return None, rejected_asset(
            "BAD_URL",
            "enter a valid youtube.com or youtu.be URL",
            target_deck=target_deck,
        )
    try:
        return canonicalize_youtube_url(url), None
    except UserError as exc:
        message = exc.message if isinstance(exc.message, str) and exc.message else str(exc)
        return None, rejected_asset("BAD_URL", message, target_deck=target_deck)


def plan_youtube_acquisition(url: str, *, target_deck: str = "auto") -> dict[str, Any]:
    """Validate a YouTube URL and target deck. Never downloads."""
    if target_deck not in TARGET_DECKS:
        return _reject_deck()
    canonical, rejected = _canonical(url, target_deck)
    if rejected is not None:
        return rejected
    assert canonical is not None
    return accepted_url(canonical, target_deck)


def _job_id(job: dict[str, Any]) -> str | None:
    value = job.get("id")
    if isinstance(value, str) and value.strip():
        return value
    return None


def _failed_asset(
    *,
    canonical: str,
    target_deck: str,
    job_id: str | None,
    message: str,
) -> dict[str, Any]:
    return deck_load_asset(
        ok=False,
        status="failed",
        target_deck=target_deck,
        canonical_url=canonical,
        job_id=job_id,
        track_id=None,
        error={"code": "JOB_FAILED", "message": message},
    )


def _track_id_from_result(result: Any) -> str | None:
    if not isinstance(result, dict):
        return None
    track_id = result.get("track_id")
    if isinstance(track_id, str) and track_id.strip():
        return track_id
    return None


def asset_from_import_job(
    job: dict,
    *,
    canonical_url: str,
    target_deck: str = "auto",
) -> dict[str, Any]:
    """Map a Studio import job snapshot to a deck-load asset.

    Filesystem paths on ``result`` are ignored. ``queued`` and ``running``
    never carry a track id. ``complete`` is ok only when ``result["track_id"]``
    is a non-empty string.
    """
    if target_deck not in TARGET_DECKS:
        return _reject_deck()
    canonical, rejected = _canonical(canonical_url, target_deck)
    if rejected is not None:
        return rejected
    assert canonical is not None
    if not isinstance(job, dict):
        return rejected_asset("ASSET_JOB", "import job id is required", target_deck=target_deck)
    job_id = _job_id(job)
    if job_id is None:
        return rejected_asset("ASSET_JOB", "import job id is required", target_deck=target_deck)

    status = job.get("status")
    if status in _OPEN_STATUSES:
        return deck_load_asset(
            ok=True,
            status=status,
            target_deck=target_deck,
            canonical_url=canonical,
            job_id=job_id,
            track_id=None,
        )
    if status == "complete":
        track_id = _track_id_from_result(job.get("result"))
        if track_id is None:
            return _failed_asset(
                canonical=canonical,
                target_deck=target_deck,
                job_id=job_id,
                message="import completed without a track id",
            )
        return deck_load_asset(
            ok=True,
            status="complete",
            target_deck=target_deck,
            canonical_url=canonical,
            job_id=job_id,
            track_id=track_id,
        )

    error = job.get("error")
    if isinstance(error, str) and error.strip():
        message = error
    elif isinstance(status, str) and status.strip():
        message = status
    else:
        message = "import job failed"
    return _failed_asset(
        canonical=canonical,
        target_deck=target_deck,
        job_id=job_id,
        message=message,
    )


def separation_request(track_id: str) -> dict[str, Any]:
    """Return a request the existing separation job endpoint can accept.

    Does not run Demucs and does not claim that vocals exist.
    """
    if not isinstance(track_id, str) or _TRACK_ID_RE.fullmatch(track_id) is None:
        return {
            "ok": False,
            "code": "BAD_TRACK",
            "message": "track id must be 8-64 letters, digits, underscores, or hyphens",
        }
    return {
        "ok": True,
        "trackId": track_id,
        "method": "auto",
        "note": "existing separation job; not started",
    }

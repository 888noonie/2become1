"""Canonical domain contracts for 2become1 V0.3.

These enums and dataclasses are the single source of truth for the shapes the
service layer, CLI, and web API exchange. In Phase 0 they are additive: nothing
is rewired to consume them yet, but later phases must implement against these
shapes rather than inventing parallel ones.

The job kind/status enums are the cross-cutting contract every other module
depends on, so they are defined here first and kept strict.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class JobKind(str, Enum):
    """The four kinds of long-running work the Studio can perform."""

    IMPORT = "import"
    SEPARATE = "separate"
    PREVIEW = "preview"
    RENDER = "render"


class JobStatus(str, Enum):
    """Lifecycle states for a job.

    ``interrupted`` is distinct from ``failed``: it means the Studio stopped
    before the job could finish, and the job may be resumable/retryable.
    """

    QUEUED = "queued"
    RUNNING = "running"
    COMPLETE = "complete"
    FAILED = "failed"
    CANCELLED = "cancelled"
    INTERRUPTED = "interrupted"


# States that mean "no more work will happen for this job".
TERMINAL_JOB_STATES: frozenset[JobStatus] = frozenset({
    JobStatus.COMPLETE,
    JobStatus.FAILED,
    JobStatus.CANCELLED,
    JobStatus.INTERRUPTED,
})

# States that mean "work is pending or in flight".
ACTIVE_JOB_STATES: frozenset[JobStatus] = frozenset({
    JobStatus.QUEUED,
    JobStatus.RUNNING,
})


@dataclass(frozen=True)
class ErrorEnvelope:
    """The single JSON error shape returned by every API endpoint."""

    code: str
    message: str
    detail: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "error": {
                "code": self.code,
                "message": self.message,
                "detail": self.detail,
            }
        }


@dataclass(frozen=True)
class ListResponse:
    """The paginated list shape for library/activity endpoints."""

    items: list[Any]
    total: int
    limit: int
    offset: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "items": self.items,
            "total": self.total,
            "limit": self.limit,
            "offset": self.offset,
        }


@dataclass(frozen=True)
class Job:
    """A long-running job as persisted and returned over the API."""

    id: str
    kind: JobKind
    status: JobStatus
    stage: str
    progress: int
    message: str
    request: dict[str, Any]
    result: dict[str, Any] | None = None
    error: str | None = None
    executor: str | None = None
    cancel_requested: bool = False
    parent_job_id: str | None = None
    output_path: str | None = None
    created_at: float = 0.0
    updated_at: float = 0.0

    @property
    def is_terminal(self) -> bool:
        return self.status in TERMINAL_JOB_STATES


@dataclass(frozen=True)
class Project:
    """A persisted arrangement: two decks plus their settings."""

    id: str
    name: str
    anchor_track_id: str | None = None
    lead_track_id: str | None = None
    anchor_variant: str | None = None
    lead_variant: str | None = None
    settings: dict[str, Any] = field(default_factory=dict)
    created_at: float = 0.0
    updated_at: float = 0.0


@dataclass(frozen=True)
class StemSet:
    """A cached separation result for one track."""

    id: str
    track_id: str
    method: str
    model: str | None = None
    device: str | None = None
    status: str = "complete"
    paths: dict[str, str] = field(default_factory=dict)
    created_at: float = 0.0


@dataclass(frozen=True)
class ProgressDetail:
    """Structured, honest progress for a long-running job.

    ``percent`` is measured progress (0-100) when known, else None. ``bytes``,
    ``speed``, and ``eta`` are optional and may be None/unknown. ``stage`` is a
    human label; ``measured`` is True when ``percent`` comes from a real
    measurement (e.g. yt-dlp byte progress) and False when it is stage-based.
    """

    stage: str
    percent: float | None = None
    bytes: int | None = None
    total_bytes: int | None = None
    speed: float | None = None
    eta: float | None = None
    measured: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "stage": self.stage,
            "percent": self.percent,
            "bytes": self.bytes,
            "total_bytes": self.total_bytes,
            "speed": self.speed,
            "eta": self.eta,
            "measured": self.measured,
        }


@dataclass(frozen=True)
class TrackModel:
    """A track as returned over the API.

    ``bpm``/``key``/``beat_grid`` are *effective* values (detected values with
    any user overrides applied). ``detected`` always carries the raw detected
    values so the UI can show and reset overrides without losing provenance.
    """

    id: str
    name: str
    bpm: float
    key: dict[str, Any]
    duration: float
    beat_grid: dict[str, Any]
    detected: dict[str, Any]
    source: dict[str, Any]
    created_at: float = 0.0

"""Job lifecycle, executors, cancellation, and retry for 2become1.

Phase 1 extracted job orchestration out of ``studio.py``. Phase 2.0 hardens it:

- transitions are atomic compare-and-swap (``WHERE id = ? AND status = ?`` with
  a rowcount check), so two callers cannot both validate against a stale status;
- writable job fields are whitelisted; caller-controlled column names are never
  interpolated into SQL;
- terminal states are immutable (no terminal → queued transition); retry clones
  a new job instead of mutating the original;
- a cancellation check runs immediately before a worker is marked complete;
- shutdown cancels queued futures, terminates registered acquisition
  subprocesses, and drains active audio work.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from .common import UserError, CapabilityError
from .contracts import (
    TERMINAL_JOB_STATES,
    JobKind,
    JobStatus,
)


# ---------------------------------------------------------------------------
# Transition matrix
# ---------------------------------------------------------------------------

# Allowed transitions: from -> set of allowed "to" states.
# Terminal states (complete/failed/cancelled/interrupted) are immutable: they
# have no outgoing transitions. Retry/resume always clones a NEW job.
TRANSITIONS: dict[JobStatus, frozenset[JobStatus]] = {
    JobStatus.QUEUED: frozenset({
        JobStatus.RUNNING,
        JobStatus.CANCELLED,
        JobStatus.INTERRUPTED,
    }),
    JobStatus.RUNNING: frozenset({
        JobStatus.COMPLETE,
        JobStatus.FAILED,
        JobStatus.CANCELLED,
        JobStatus.INTERRUPTED,
    }),
    JobStatus.FAILED: frozenset(),
    JobStatus.INTERRUPTED: frozenset(),
    JobStatus.CANCELLED: frozenset(),
    JobStatus.COMPLETE: frozenset(),
}


def can_transition(from_status: JobStatus, to_status: JobStatus) -> bool:
    """Return whether ``to_status`` may legally follow ``from_status``."""
    return to_status in TRANSITIONS.get(from_status, frozenset())


class InvalidTransition(UserError):
    """Raised when a job is asked to move to an illegal state."""


class JobCancelled(Exception):
    """Raised inside a run function to signal cooperative cancellation."""


# ---------------------------------------------------------------------------
# Cancellation token
# ---------------------------------------------------------------------------

class CancellationToken:
    """A thread-safe, cooperative cancellation flag."""

    def __init__(self) -> None:
        self._event = threading.Event()

    def cancel(self) -> None:
        self._event.set()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def raise_if_cancelled(self) -> None:
        if self.cancelled:
            raise JobCancelled()


# ---------------------------------------------------------------------------
# JobStore
# ---------------------------------------------------------------------------

# Fields a caller may write, mapped to their column name. ``result`` and
# ``request`` serialize to JSON columns; everything else maps 1:1. Any field
# not in this table is rejected — caller-controlled column names are never
# interpolated into SQL.
_WRITABLE_FIELDS: dict[str, str] = {
    "stage": "stage",
    "progress": "progress",
    "message": "message",
    "error": "error",
    "output_path": "output_path",
    "executor": "executor",
    "cancel_requested": "cancel_requested",
    "parent_job_id": "parent_job_id",
    "result": "result_json",
    "request": "request_json",
    "progress_detail": "progress_json",
}


class JobStore:
    """SQLite persistence for jobs, enforcing the transition matrix.

    ``connect`` is a zero-argument callable returning a ``sqlite3.Connection``
    (with ``row_factory`` already set). The store never opens its own
    connection factory; the owning service supplies it.
    """

    def __init__(self, connect: Callable[[], sqlite3.Connection]):
        self._connect = connect

    # -- serialization ------------------------------------------------------

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
        """Serialize a job row to the API shape.

        ``output_path`` is internal and is deliberately NOT included here; the
        API exposes ``audio_url`` instead (added by the web layer).
        """
        return {
            "id": row["id"],
            "kind": row["kind"],
            "status": row["status"],
            "stage": row["stage"],
            "progress": row["progress"],
            "message": row["message"],
            "request": json.loads(row["request_json"]) if row["request_json"] else None,
            "result": json.loads(row["result_json"]) if row["result_json"] else None,
            "error": row["error"],
            "executor": row["executor"],
            "cancel_requested": bool(row["cancel_requested"]),
            "parent_job_id": row["parent_job_id"],
            "progress_detail": (
                json.loads(row["progress_json"]) if row["progress_json"] else None
            ),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    @staticmethod
    def _build_assignments(fields: dict[str, Any]) -> tuple[list[str], list[Any]]:
        """Validate and map writable fields to (assignments, values)."""
        assignments: list[str] = []
        values: list[Any] = []
        for name, value in fields.items():
            column = _WRITABLE_FIELDS.get(name)
            if column is None:
                raise UserError(f"unknown job field: {name}")
            if name in {"result", "request", "progress_detail"}:
                assignments.append(f"{column} = ?")
                values.append(json.dumps(value))
            else:
                assignments.append(f"{column} = ?")
                values.append(value)
        return assignments, values

    # -- create / read ------------------------------------------------------

    def create(
        self,
        kind: JobKind,
        request: dict[str, Any],
        *,
        executor: str | None = None,
        parent_job_id: str | None = None,
    ) -> str:
        job_id = uuid.uuid4().hex
        now = time.time()
        with self._connect() as conn:
            conn.execute(
                """INSERT INTO jobs
                   (id, kind, status, stage, progress, message, request_json,
                    result_json, output_path, error, executor, cancel_requested,
                    parent_job_id, created_at, updated_at)
                   VALUES (?, ?, 'queued', 'queued', 0, 'Waiting for the engine',
                           ?, NULL, NULL, NULL, ?, 0, ?, ?, ?)""",
                (
                    job_id, kind.value, json.dumps(request),
                    executor, parent_job_id, now, now,
                ),
            )
        return job_id

    def get(self, job_id: str) -> dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            raise UserError(f"unknown job: {job_id}")
        return self._row_to_dict(row)

    def get_output_path(self, job_id: str) -> str | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT output_path FROM jobs WHERE id = ?", (job_id,)
            ).fetchone()
        if row is None:
            raise UserError(f"unknown job: {job_id}")
        return row["output_path"]

    def list(
        self,
        *,
        limit: int = 20,
        offset: int = 0,
        status: JobStatus | None = None,
        kind: JobKind | None = None,
    ) -> tuple[list[dict[str, Any]], int]:
        where: list[str] = []
        params: list[Any] = []
        if status is not None:
            where.append("status = ?")
            params.append(status.value)
        if kind is not None:
            where.append("kind = ?")
            params.append(kind.value)
        clause = f"WHERE {' AND '.join(where)}" if where else ""
        with self._connect() as conn:
            total = conn.execute(
                f"SELECT COUNT(*) FROM jobs {clause}", params
            ).fetchone()[0]
            rows = conn.execute(
                f"SELECT * FROM jobs {clause} ORDER BY created_at DESC LIMIT ? OFFSET ?",
                params + [limit, offset],
            ).fetchall()
        return [self._row_to_dict(row) for row in rows], total

    # -- transitions --------------------------------------------------------

    def transition(
        self,
        job_id: str,
        to_status: JobStatus,
        **fields: Any,
    ) -> None:
        """Atomically move a job to ``to_status``, validating the matrix.

        The update is a compare-and-swap: it only succeeds if the row's current
        status still matches the status we validated against. If another caller
        changed the status concurrently, the update matches zero rows and we
        raise, so two callers can never both win against a stale status.
        """
        assignments, values = self._build_assignments(fields)
        assignments.insert(0, "status = ?")
        values.insert(0, to_status.value)
        assignments.append("updated_at = ?")
        values.append(time.time())

        with self._connect() as conn:
            row = conn.execute(
                "SELECT status FROM jobs WHERE id = ?", (job_id,)
            ).fetchone()
            if row is None:
                raise UserError(f"unknown job: {job_id}")
            current = JobStatus(row["status"])
            if not can_transition(current, to_status):
                raise InvalidTransition(
                    f"illegal job transition: {current.value} -> {to_status.value}"
                )

            cur = conn.execute(
                f"UPDATE jobs SET {', '.join(assignments)} WHERE id = ? AND status = ?",
                values + [job_id, current.value],
            )
            if cur.rowcount == 0:
                raise InvalidTransition(
                    f"job {job_id} changed state concurrently; transition aborted"
                )

    def update(self, job_id: str, **fields: Any) -> None:
        """Update non-status fields (progress, stage, message, ...) in place."""
        if not fields:
            return
        assignments, values = self._build_assignments(fields)
        assignments.append("updated_at = ?")
        values.append(time.time())
        values.append(job_id)
        with self._connect() as conn:
            conn.execute(
                f"UPDATE jobs SET {', '.join(assignments)} WHERE id = ?", values
            )

    def request_cancel(self, job_id: str) -> None:
        with self._connect() as conn:
            conn.execute(
                "UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?",
                (time.time(), job_id),
            )

    def cancel_if_queued(self, job_id: str) -> bool:
        """Atomically cancel ``job_id`` only while it is still queued.

        Returning ``False`` means a worker won the queued-to-running race; the
        cancellation request and in-memory token will then be observed by that
        worker instead.
        """
        now = time.time()
        with self._connect() as conn:
            cur = conn.execute(
                """
                UPDATE jobs
                SET status = ?, stage = ?, progress = ?, message = ?, updated_at = ?
                WHERE id = ? AND status = ?
                """,
                (
                    JobStatus.CANCELLED.value,
                    "cancelled",
                    100,
                    "Cancelled",
                    now,
                    job_id,
                    JobStatus.QUEUED.value,
                ),
            )
        return cur.rowcount == 1

    def clone_for_retry(self, job_id: str) -> str:
        """Clone a failed/interrupted/cancelled job's request into a fresh job.

        The original terminal job is never mutated; a new queued job is created
        carrying the same request (and therefore the same ``work_key`` for
        resumable imports).
        """
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM jobs WHERE id = ?", (job_id,)
            ).fetchone()
            if row is None:
                raise UserError(f"unknown job: {job_id}")
            if row["status"] not in {
                JobStatus.FAILED.value,
                JobStatus.INTERRUPTED.value,
                JobStatus.CANCELLED.value,
            }:
                raise UserError(
                    f"only failed, interrupted, or cancelled jobs can be retried "
                    f"(got {row['status']})"
                )
            new_id = uuid.uuid4().hex
            now = time.time()
            conn.execute(
                """INSERT INTO jobs
                   (id, kind, status, stage, progress, message, request_json,
                    result_json, output_path, error, executor, cancel_requested,
                    parent_job_id, created_at, updated_at)
                   VALUES (?, ?, 'queued', 'queued', 0, 'Waiting for the engine',
                           ?, NULL, NULL, NULL, ?, 0, ?, ?, ?)""",
                (
                    new_id, row["kind"], row["request_json"],
                    row["executor"], job_id, now, now,
                ),
            )
        return new_id

    def mark_interrupted_on_startup(self) -> int:
        """Mark any queued/running jobs as interrupted (restart recovery).

        Returns the number of jobs affected.
        """
        with self._connect() as conn:
            cur = conn.execute(
                """UPDATE jobs
                   SET status = 'interrupted', stage = 'interrupted', progress = 100,
                       message = 'Interrupted by a Studio restart',
                       error = 'Studio stopped before this job completed',
                       updated_at = ?
                   WHERE status IN ('queued', 'running')""",
                (time.time(),),
            )
        return cur.rowcount


# ---------------------------------------------------------------------------
# JobEngine
# ---------------------------------------------------------------------------

class JobEngine:
    """Owns the executor pools, cancellation tokens, and job lifecycle.

    Two pools:
      - acquisition: two workers (downloads/analysis of separate tracks);
      - audio: one worker (Demucs, previews, renders) to protect GPU headroom.

    Run functions may register a "terminator" callable (e.g. to kill a spawned
    subprocess) via :meth:`register_terminator`; shutdown invokes them so
    active acquisition subprocesses are terminated rather than left orphaned.
    """

    def __init__(
        self,
        store: JobStore,
        *,
        error_formatter: Callable[[Exception], str] | None = None,
        max_pending: int = 32,
    ):
        self.store = store
        self._max_pending = max_pending
        self._error_formatter = error_formatter or str
        self._acquisition = ThreadPoolExecutor(
            max_workers=2, thread_name_prefix="2become1-acq"
        )
        self._audio = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="2become1-audio"
        )
        self._tokens: dict[str, CancellationToken] = {}
        self._terminators: dict[str, Callable[[], None]] = {}
        self._lock = threading.Lock()
        self._closed = False

    def _pool_for(self, kind: JobKind) -> ThreadPoolExecutor:
        if kind == JobKind.IMPORT:
            return self._acquisition
        return self._audio

    def register_terminator(self, job_id: str, fn: Callable[[], None]) -> None:
        with self._lock:
            self._terminators[job_id] = fn

    def unregister_terminator(self, job_id: str) -> None:
        with self._lock:
            self._terminators.pop(job_id, None)

    def submit(
        self,
        kind: JobKind,
        request: dict[str, Any],
        run_fn: Callable[[str, CancellationToken], dict[str, Any]],
        *,
        executor: str | None = None,
        parent_job_id: str | None = None,
    ) -> dict[str, Any]:
        """Create a queued job and dispatch it to the right executor."""
        with self._lock:
            if self._closed:
                raise UserError("job engine is closed")
            if len(self._tokens) >= self._max_pending:
                raise CapabilityError("The job queue is full; wait for a job to finish", code="queue_full")
            job_id = self.store.create(
                kind, request, executor=executor, parent_job_id=parent_job_id
            )
            token = CancellationToken()
            self._tokens[job_id] = token
            try:
                self._pool_for(kind).submit(self._run, job_id, run_fn, token)
            except Exception:
                self._tokens.pop(job_id, None)
                self.store.transition(job_id, JobStatus.INTERRUPTED,
                                      message="Job could not be scheduled")
                raise

        return self.store.get(job_id)

    def _run(
        self,
        job_id: str,
        run_fn: Callable[[str, CancellationToken], dict[str, Any]],
        token: CancellationToken,
    ) -> None:
        try:
            try:
                self.store.transition(
                    job_id, JobStatus.RUNNING, stage="running", progress=0,
                    message="Started",
                )
            except InvalidTransition:
                # A queued cancellation may win immediately before this worker
                # claims the job.  That is a normal terminal outcome, not a
                # worker failure to rewrite as ``failed``.
                if self.store.get(job_id)["status"] == JobStatus.CANCELLED:
                    return
                raise
            result = run_fn(job_id, token)
        except JobCancelled:
            self.store.transition(
                job_id, JobStatus.CANCELLED, stage="cancelled", progress=100,
                message="Cancelled",
            )
        except Exception as exc:  # noqa: BLE001 - boundary of the worker thread
            self.store.transition(
                job_id, JobStatus.FAILED, stage="failed", progress=100,
                message="Job failed", error=self._error_formatter(exc),
            )
        else:
            # A cancellation may have been requested while the run function was
            # finishing; honour it before marking complete.
            if token.cancelled:
                self.store.transition(
                    job_id, JobStatus.CANCELLED, stage="cancelled", progress=100,
                    message="Cancelled",
                )
            else:
                self.store.transition(
                    job_id, JobStatus.COMPLETE, stage="complete", progress=100,
                    message=result.get("message", "Complete"),
                    result=result.get("result"),
                    output_path=result.get("output_path"),
                )
        finally:
            with self._lock:
                self._tokens.pop(job_id, None)
                self._terminators.pop(job_id, None)

    def cancel(self, job_id: str) -> dict[str, Any]:
        """Request cancellation of a job.

        Queued jobs are cancelled immediately; running jobs are flagged and
        cancelled cooperatively at the next safe checkpoint.
        """
        job = self.store.get(job_id)
        if job["status"] in TERMINAL_JOB_STATES:
            raise UserError(f"job is already {job['status']}")
        self.store.request_cancel(job_id)
        with self._lock:
            token = self._tokens.get(job_id)
        if token is not None:
            token.cancel()
        # A queued job has no running worker to observe the token, so cancel it
        # directly.
        if job["status"] == JobStatus.QUEUED:
            self.store.cancel_if_queued(job_id)
        return self.store.get(job_id)

    def retry(
        self,
        job_id: str,
        run_fn: Callable[[str, CancellationToken], dict[str, Any]],
    ) -> dict[str, Any]:
        """Clone a failed/interrupted/cancelled job and dispatch it again."""
        if self._closed:
            raise UserError("job engine is closed")
        new_id = self.store.clone_for_retry(job_id)
        token = CancellationToken()
        with self._lock:
            self._tokens[new_id] = token
        kind = JobKind(self.store.get(new_id)["kind"])
        self._pool_for(kind).submit(self._run, new_id, run_fn, token)
        return self.store.get(new_id)

    def shutdown(self, wait: bool = True) -> None:
        """Stop accepting work and shut down both pools.

        Semantics:
          - stop accepting new submissions;
          - cancel all outstanding tokens (cooperative);
          - invoke registered terminators to kill active acquisition
            subprocesses;
          - cancel queued futures in both pools;
          - drain the active audio job (unsafe to interrupt) to completion.
        """
        with self._lock:
            if self._closed:
                return
            self._closed = True
            tokens = list(self._tokens.values())
            terminators = list(self._terminators.values())
        for token in tokens:
            token.cancel()
        for fn in terminators:
            try:
                fn()
            except Exception:  # noqa: BLE001 - best-effort termination
                pass
        self._acquisition.shutdown(wait=wait, cancel_futures=True)
        self._audio.shutdown(wait=wait, cancel_futures=True)

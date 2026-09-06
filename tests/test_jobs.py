"""Phase 1 tests: job lifecycle, executors, cancellation, retry, recovery."""

import sqlite3
import threading
import time
from pathlib import Path

import pytest

from twobecomeone import jobs
from twobecomeone.contracts import JobKind, JobStatus
from twobecomeone.jobs import (
    CancellationToken,
    InvalidTransition,
    JobCancelled,
    JobEngine,
    JobStore,
    can_transition,
)
from twobecomeone.studio import StudioService


def _make_store(tmp_path: Path) -> JobStore:
    db = tmp_path / "jobs.sqlite3"

    def connect() -> sqlite3.Connection:
        conn = sqlite3.connect(db)
        conn.row_factory = sqlite3.Row
        return conn

    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE jobs (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                stage TEXT NOT NULL,
                progress INTEGER NOT NULL,
                message TEXT NOT NULL,
                request_json TEXT NOT NULL,
                result_json TEXT,
                output_path TEXT,
                error TEXT,
                executor TEXT,
                cancel_requested INTEGER NOT NULL DEFAULT 0,
                parent_job_id TEXT,
                progress_json TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );
            """
        )
    return JobStore(connect)


class TestTransitionMatrix:
    def test_allowed_transitions(self):
        assert can_transition(JobStatus.QUEUED, JobStatus.RUNNING)
        assert can_transition(JobStatus.QUEUED, JobStatus.CANCELLED)
        assert can_transition(JobStatus.QUEUED, JobStatus.INTERRUPTED)
        assert can_transition(JobStatus.RUNNING, JobStatus.COMPLETE)
        assert can_transition(JobStatus.RUNNING, JobStatus.FAILED)
        assert can_transition(JobStatus.RUNNING, JobStatus.CANCELLED)
        assert can_transition(JobStatus.RUNNING, JobStatus.INTERRUPTED)

    def test_terminal_states_are_immutable(self):
        # Terminal states have no outgoing transitions.
        for terminal in (
            JobStatus.COMPLETE,
            JobStatus.FAILED,
            JobStatus.CANCELLED,
            JobStatus.INTERRUPTED,
        ):
            for target in JobStatus:
                assert not can_transition(terminal, target), (
                    f"{terminal.value} must not transition to {target.value}"
                )

    def test_forbidden_transitions(self):
        assert not can_transition(JobStatus.COMPLETE, JobStatus.RUNNING)
        assert not can_transition(JobStatus.COMPLETE, JobStatus.FAILED)
        assert not can_transition(JobStatus.QUEUED, JobStatus.COMPLETE)
        assert not can_transition(JobStatus.FAILED, JobStatus.COMPLETE)
        assert not can_transition(JobStatus.CANCELLED, JobStatus.COMPLETE)
        assert not can_transition(JobStatus.FAILED, JobStatus.QUEUED)
        assert not can_transition(JobStatus.INTERRUPTED, JobStatus.QUEUED)
        assert not can_transition(JobStatus.CANCELLED, JobStatus.QUEUED)

    def test_store_enforces_matrix(self, tmp_path):
        store = _make_store(tmp_path)
        job_id = store.create(JobKind.RENDER, {"x": 1})
        store.transition(job_id, JobStatus.RUNNING)
        store.transition(job_id, JobStatus.COMPLETE)
        with pytest.raises(InvalidTransition):
            store.transition(job_id, JobStatus.RUNNING)

    def test_store_rejects_unknown_job(self, tmp_path):
        store = _make_store(tmp_path)
        with pytest.raises(Exception, match="unknown job"):
            store.transition("nope", JobStatus.RUNNING)

    def test_store_rejects_unknown_field(self, tmp_path):
        store = _make_store(tmp_path)
        job_id = store.create(JobKind.RENDER, {})
        with pytest.raises(Exception, match="unknown job field"):
            store.update(job_id, malicious_column="DROP TABLE jobs")


class TestJobStore:
    def test_create_and_get(self, tmp_path):
        store = _make_store(tmp_path)
        job_id = store.create(JobKind.RENDER, {"anchor_id": "a"}, executor="audio")
        job = store.get(job_id)
        assert job["status"] == "queued"
        assert job["kind"] == "render"
        assert job["request"] == {"anchor_id": "a"}
        assert job["executor"] == "audio"
        assert job["cancel_requested"] is False

    def test_output_path_not_in_api_dict(self, tmp_path):
        store = _make_store(tmp_path)
        job_id = store.create(JobKind.RENDER, {})
        store.transition(job_id, JobStatus.RUNNING)
        store.transition(
            job_id, JobStatus.COMPLETE, output_path="/data/renders/x.mp3",
            result={"ok": True},
        )
        job = store.get(job_id)
        assert "output_path" not in job
        assert job["result"] == {"ok": True}
        # internal accessor still works
        assert store.get_output_path(job_id) == "/data/renders/x.mp3"

    def test_list_filters(self, tmp_path):
        store = _make_store(tmp_path)
        a = store.create(JobKind.RENDER, {})
        b = store.create(JobKind.IMPORT, {})
        store.transition(a, JobStatus.RUNNING)
        store.transition(a, JobStatus.COMPLETE)
        items, total = store.list(status=JobStatus.COMPLETE)
        assert total == 1
        assert items[0]["id"] == a
        items, total = store.list(kind=JobKind.IMPORT)
        assert total == 1
        assert items[0]["id"] == b

    def test_clone_for_retry(self, tmp_path):
        store = _make_store(tmp_path)
        job_id = store.create(JobKind.RENDER, {"anchor_id": "a"})
        store.transition(job_id, JobStatus.RUNNING)
        store.transition(job_id, JobStatus.FAILED, error="boom")
        new_id = store.clone_for_retry(job_id)
        assert new_id != job_id
        new = store.get(new_id)
        assert new["status"] == "queued"
        assert new["request"] == {"anchor_id": "a"}
        assert new["parent_job_id"] == job_id

    def test_clone_rejects_non_retryable(self, tmp_path):
        store = _make_store(tmp_path)
        job_id = store.create(JobKind.RENDER, {})
        store.transition(job_id, JobStatus.RUNNING)
        store.transition(job_id, JobStatus.COMPLETE)
        with pytest.raises(Exception, match="only failed, interrupted, or cancelled"):
            store.clone_for_retry(job_id)

    def test_mark_interrupted_on_startup(self, tmp_path):
        store = _make_store(tmp_path)
        queued = store.create(JobKind.RENDER, {})
        running = store.create(JobKind.RENDER, {})
        store.transition(running, JobStatus.RUNNING)
        done = store.create(JobKind.RENDER, {})
        store.transition(done, JobStatus.RUNNING)
        store.transition(done, JobStatus.COMPLETE)

        affected = store.mark_interrupted_on_startup()
        assert affected == 2
        assert store.get(queued)["status"] == "interrupted"
        assert store.get(running)["status"] == "interrupted"
        assert store.get(done)["status"] == "complete"


class TestCancellationToken:
    def test_cancel_and_raise(self):
        token = CancellationToken()
        assert not token.cancelled
        token.cancel()
        assert token.cancelled
        with pytest.raises(JobCancelled):
            token.raise_if_cancelled()


class TestJobEngine:
    def test_submit_completes(self, tmp_path):
        store = _make_store(tmp_path)
        engine = JobEngine(store)
        try:
            def run(job_id, token):
                return {"result": {"n": 42}, "message": "done"}

            job = engine.submit(JobKind.RENDER, {}, run)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                current = store.get(job["id"])
                if current["status"] in {"complete", "failed"}:
                    break
                time.sleep(0.01)
            assert current["status"] == "complete"
            assert current["result"] == {"n": 42}
        finally:
            engine.shutdown()

    def test_submit_failure_marks_failed(self, tmp_path):
        store = _make_store(tmp_path)
        engine = JobEngine(store)
        try:
            def run(job_id, token):
                raise RuntimeError("kaboom")

            job = engine.submit(JobKind.RENDER, {}, run)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                current = store.get(job["id"])
                if current["status"] in {"complete", "failed"}:
                    break
                time.sleep(0.01)
            assert current["status"] == "failed"
            assert "kaboom" in current["error"]
        finally:
            engine.shutdown()

    def test_cancel_queued_job(self, tmp_path):
        store = _make_store(tmp_path)
        engine = JobEngine(store)
        try:
            # Block the single audio worker so the second job stays queued.
            started = threading.Event()
            release = threading.Event()

            def blocker(job_id, token):
                started.set()
                release.wait(5)
                return {"result": {}, "message": "done"}

            engine.submit(JobKind.RENDER, {}, blocker)
            started.wait(5)

            second_ran = threading.Event()

            def second(job_id, token):
                second_ran.set()
                return {"result": {}, "message": "done"}

            job = engine.submit(JobKind.RENDER, {}, second)
            assert job["status"] == "queued"
            cancelled = engine.cancel(job["id"])
            assert cancelled["status"] == "cancelled"
            release.set()
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and job["id"] in engine._tokens:
                time.sleep(0.01)
            assert store.get(job["id"])["status"] == "cancelled"
            assert not second_ran.is_set()
        finally:
            engine.shutdown()

    def test_cancel_tolerates_worker_winning_queued_race(self, tmp_path, monkeypatch):
        store = _make_store(tmp_path)
        engine = JobEngine(store)
        try:
            job_id = store.create(JobKind.RENDER, {})
            token = CancellationToken()
            with engine._lock:
                engine._tokens[job_id] = token

            original = store.cancel_if_queued

            def worker_wins(job_id):
                store.transition(job_id, JobStatus.RUNNING, stage="running")
                return original(job_id)

            monkeypatch.setattr(store, "cancel_if_queued", worker_wins)
            cancelled = engine.cancel(job_id)

            assert cancelled["status"] == "running"
            assert cancelled["cancel_requested"] is True
            assert token.cancelled is True
            store.transition(job_id, JobStatus.CANCELLED, stage="cancelled")
            with engine._lock:
                engine._tokens.pop(job_id, None)
        finally:
            engine.shutdown()

    def test_cancel_running_job_cooperatively(self, tmp_path):
        store = _make_store(tmp_path)
        engine = JobEngine(store)
        try:
            def run(job_id, token):
                for _ in range(1000):
                    token.raise_if_cancelled()
                    time.sleep(0.005)
                return {"result": {}, "message": "done"}

            job = engine.submit(JobKind.RENDER, {}, run)
            # wait until running
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if store.get(job["id"])["status"] == "running":
                    break
                time.sleep(0.01)
            engine.cancel(job["id"])
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                current = store.get(job["id"])
                if current["status"] in {"complete", "failed", "cancelled"}:
                    break
                time.sleep(0.01)
            assert current["status"] == "cancelled"
        finally:
            engine.shutdown()

    def test_cancel_terminal_raises(self, tmp_path):
        store = _make_store(tmp_path)
        engine = JobEngine(store)
        try:
            def run(job_id, token):
                return {"result": {}, "message": "done"}

            job = engine.submit(JobKind.RENDER, {}, run)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if store.get(job["id"])["status"] == "complete":
                    break
                time.sleep(0.01)
            with pytest.raises(Exception, match="already complete"):
                engine.cancel(job["id"])
        finally:
            engine.shutdown()

    def test_retry_clones_and_reruns(self, tmp_path):
        store = _make_store(tmp_path)
        engine = JobEngine(store)
        try:
            attempts = {"n": 0}

            def run(job_id, token):
                attempts["n"] += 1
                if attempts["n"] == 1:
                    raise RuntimeError("first fails")
                return {"result": {"ok": True}, "message": "done"}

            job = engine.submit(JobKind.RENDER, {}, run)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if store.get(job["id"])["status"] == "failed":
                    break
                time.sleep(0.01)
            retried = engine.retry(job["id"], run)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                current = store.get(retried["id"])
                if current["status"] in {"complete", "failed"}:
                    break
                time.sleep(0.01)
            assert current["status"] == "complete"
            assert attempts["n"] == 2
        finally:
            engine.shutdown()

    def test_shutdown_stops_accepting(self, tmp_path):
        store = _make_store(tmp_path)
        engine = JobEngine(store)
        engine.shutdown()
        with pytest.raises(Exception, match="closed"):
            engine.submit(JobKind.RENDER, {}, lambda *a: {})

    def test_three_worker_sqlite_stress(self, tmp_path):
        # Two acquisition workers + one audio worker hammering the store
        # concurrently must not produce SQLite lock errors.
        store = _make_store(tmp_path)
        engine = JobEngine(store)
        errors = []
        try:
            def run(job_id, token):
                for _ in range(50):
                    store.update(job_id, progress=1, message="tick")
                return {"result": {}, "message": "done"}

            # Two imports (acquisition pool) + one render (audio pool).
            jobs = [
                engine.submit(JobKind.IMPORT, {"url": "a"}, run),
                engine.submit(JobKind.IMPORT, {"url": "b"}, run),
                engine.submit(JobKind.RENDER, {}, run),
            ]
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                statuses = {store.get(j["id"])["status"] for j in jobs}
                if statuses <= {"complete", "failed"}:
                    break
                time.sleep(0.05)
            for j in jobs:
                final = store.get(j["id"])
                if final["status"] == "failed":
                    errors.append(final["error"])
            assert not errors, f"stress test produced failures: {errors}"
        finally:
            engine.shutdown()


class TestStudioServiceJobs:
    def test_render_job_uses_engine_and_no_output_path_leak(self, tmp_path):
        import math
        import struct
        import wave

        def synth(path, bpm, root, duration=4.0):
            sr = 22050
            beat = 60.0 / bpm
            samples = bytearray()
            for i in range(int(sr * duration)):
                t = i / sr
                chord = (math.sin(2 * math.pi * root * t)
                         + 0.7 * math.sin(2 * math.pi * root * 1.25 * t)
                         + 0.6 * math.sin(2 * math.pi * root * 1.5 * t)) / 3
                click = 0.45 * math.sin(2 * math.pi * 90 * t) if (t % beat) < 0.04 else 0
                v = int(max(-1, min(1, chord + click)) * 22000)
                samples += struct.pack("<hh", v, v)
            with wave.open(str(path), "wb") as w:
                w.setnchannels(2)
                w.setsampwidth(2)
                w.setframerate(sr)
                w.writeframes(samples)

        anchor = tmp_path / "anchor.wav"
        lead = tmp_path / "lead.wav"
        synth(anchor, 100, 261.63)
        synth(lead, 140, 220.0)

        service = StudioService(tmp_path / "data")
        try:
            with anchor.open("rb") as f:
                a = service.ingest(f, "anchor.wav")
            with lead.open("rb") as f:
                l = service.ingest(f, "lead.wav")

            from twobecomeone.studio import RenderOptions
            job = service.submit_render(RenderOptions(
                anchor_id=a["id"], lead_id=l["id"], duration=2.0, preview=True,
            ))
            assert "output_path" not in job
            assert job["audio_url"] is not None or job["status"] in {"queued", "running"}

            completed = service.wait_for_job(job["id"], timeout=30)
            assert completed["status"] == "complete", completed.get("error")
            assert "output_path" not in completed
            assert completed["audio_url"].endswith("/audio")
        finally:
            service.close()

    def test_restart_marks_jobs_interrupted(self, tmp_path):
        # Seed a queued job directly into the database, then reopen the service
        # to simulate a crash/restart. The queued job must be marked
        # interrupted (not failed, not cancelled) on startup.
        data_dir = tmp_path / "data"
        service = StudioService(data_dir)
        # Create a queued job via the store, then abandon WITHOUT clean close
        # (simulate a crash by not calling close()).
        from twobecomeone.contracts import JobKind
        job_id = service._store.create(JobKind.RENDER, {"anchor_id": "x"})
        # Abandon the service without close() to simulate a crash.
        service._engine.shutdown(wait=False)
        del service

        service2 = StudioService(data_dir)
        try:
            reopened = service2.get_job(job_id)
            assert reopened["status"] == "interrupted"
        finally:
            service2.close()


class TestSSE:
    @pytest.fixture
    def anyio_backend(self):
        return "asyncio"

    @pytest.mark.anyio
    async def test_events_stream_closes_on_terminal(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "web-data")
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
                # Create a job directly via the service, then complete it.
                service = app.state.studio
                from twobecomeone.jobs import JobStore
                from twobecomeone.contracts import JobKind, JobStatus
                store = service._store
                job_id = store.create(JobKind.RENDER, {"x": 1})
                store.transition(job_id, JobStatus.RUNNING)
                store.transition(job_id, JobStatus.COMPLETE, result={"ok": True})

                # The stream should emit the terminal snapshot and close.
                async with client.stream("GET", f"/api/jobs/{job_id}/events") as resp:
                    assert resp.status_code == 200
                    body = b""
                    async for chunk in resp.aiter_bytes():
                        body += chunk
                    text = body.decode()
                    assert "event: job" in text
                    assert '"status":"complete"' in text
        finally:
            app.state.studio.close()

    @pytest.mark.anyio
    async def test_events_stream_unknown_job_400(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "web-data")
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
                resp = await client.get("/api/jobs/nope/events")
                assert resp.status_code == 400
        finally:
            app.state.studio.close()

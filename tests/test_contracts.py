"""Tests for Phase 0: contract models and numbered migration infrastructure."""

import sqlite3
from pathlib import Path

import pytest

from twobecomeone import contracts, migrations


FIXTURES = Path(__file__).with_name("fixtures")
V02_SCHEMA = FIXTURES / "v0.2_schema.sql"


def _load_v02_db() -> sqlite3.Connection:
    """Build an in-memory database at the V0.2 schema with seed rows."""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(V02_SCHEMA.read_text())
    return conn


class TestContracts:
    def test_job_kind_values(self):
        assert {k.value for k in contracts.JobKind} == {
            "import", "separate", "preview", "render",
        }

    def test_job_status_values(self):
        assert {s.value for s in contracts.JobStatus} == {
            "queued", "running", "complete", "failed", "cancelled", "interrupted",
        }

    def test_terminal_states(self):
        assert contracts.JobStatus.COMPLETE in contracts.TERMINAL_JOB_STATES
        assert contracts.JobStatus.FAILED in contracts.TERMINAL_JOB_STATES
        assert contracts.JobStatus.CANCELLED in contracts.TERMINAL_JOB_STATES
        assert contracts.JobStatus.INTERRUPTED in contracts.TERMINAL_JOB_STATES
        assert contracts.JobStatus.RUNNING not in contracts.TERMINAL_JOB_STATES
        assert contracts.JobStatus.QUEUED not in contracts.TERMINAL_JOB_STATES

    def test_job_is_terminal(self):
        running = contracts.Job(
            id="j", kind=contracts.JobKind.RENDER,
            status=contracts.JobStatus.RUNNING, stage="rendering",
            progress=50, message="", request={},
        )
        assert not running.is_terminal
        done = contracts.Job(
            id="j", kind=contracts.JobKind.RENDER,
            status=contracts.JobStatus.COMPLETE, stage="complete",
            progress=100, message="", request={},
        )
        assert done.is_terminal

    def test_error_envelope_shape(self):
        env = contracts.ErrorEnvelope("not_found", "missing", "track x")
        assert env.to_dict() == {
            "error": {"code": "not_found", "message": "missing", "detail": "track x"},
        }

    def test_list_response_shape(self):
        resp = contracts.ListResponse(items=[1, 2], total=2, limit=10, offset=0)
        assert resp.to_dict() == {"items": [1, 2], "total": 2, "limit": 10, "offset": 0}


class TestMigrations:
    def test_migrations_are_ordered_and_unique(self):
        versions = [m[0] for m in migrations.MIGRATIONS]
        assert versions == sorted(versions)
        assert len(versions) == len(set(versions))

    def test_latest_version_matches_last(self):
        assert migrations.latest_version() == migrations.MIGRATIONS[-1][0]

    def test_v02_database_migrates_in_place(self):
        conn = _load_v02_db()
        applied = migrations.run_migrations(conn)
        assert applied == [m[0] for m in migrations.MIGRATIONS]

        # V0.3 columns now exist on tracks
        cols = {row[1] for row in conn.execute("PRAGMA table_info(tracks)")}
        for expected in (
            "display_name", "content_sha256", "metadata_json", "artwork_path",
            "waveform_path", "bpm_override", "tonic_override", "mode_override",
            "first_beat_override", "downbeat_override", "deleted_at",
        ):
            assert expected in cols, f"missing tracks column {expected}"

        # V0.3 columns now exist on jobs
        job_cols = {row[1] for row in conn.execute("PRAGMA table_info(jobs)")}
        for expected in ("executor", "cancel_requested", "parent_job_id"):
            assert expected in job_cols, f"missing jobs column {expected}"

        # New tables exist
        tables = {row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        assert "projects" in tables
        assert "stem_sets" in tables
        assert "schema_migrations" in tables

    def test_seed_rows_survive_migration(self):
        conn = _load_v02_db()
        migrations.run_migrations(conn)

        track = conn.execute(
            "SELECT original_name, bpm, tonic, mode, source_kind, source_ref"
            " FROM tracks WHERE id = 'track-v02-1'"
        ).fetchone()
        assert track is not None
        assert track["original_name"] == "anchor.wav"
        assert track["bpm"] == pytest.approx(100.6)
        assert track["tonic"] == "C"
        assert track["mode"] == "major"
        assert track["source_kind"] == "local"
        assert track["source_ref"] == "/tmp/anchor.wav"

        job = conn.execute(
            "SELECT kind, status, output_path FROM jobs WHERE id = 'job-v02-1'"
        ).fetchone()
        assert job is not None
        assert job["kind"] == "preview"
        assert job["status"] == "complete"
        assert job["output_path"] == "/data/renders/job-v02-1.mp3"

    def test_migrations_are_idempotent(self):
        conn = _load_v02_db()
        first = migrations.run_migrations(conn)
        second = migrations.run_migrations(conn)
        assert first == [m[0] for m in migrations.MIGRATIONS]
        assert second == []

    def test_failed_migration_rolls_back(self):
        # A migration that fails mid-way must not record its version or leave
        # partial columns. We simulate by monkeypatching MIGRATIONS with a
        # broken statement.
        conn = _load_v02_db()
        original = migrations.MIGRATIONS
        migrations.MIGRATIONS = [
            (1, "broken", [
                "ALTER TABLE tracks ADD COLUMN display_name TEXT",
                "THIS IS NOT VALID SQL",
            ]),
        ]
        try:
            with pytest.raises(sqlite3.OperationalError):
                migrations.run_migrations(conn)
        finally:
            migrations.MIGRATIONS = original

        # Version 1 must not be recorded, and the partial column must be gone.
        assert migrations.applied_versions(conn) == set()
        cols = {row[1] for row in conn.execute("PRAGMA table_info(tracks)")}
        assert "display_name" not in cols

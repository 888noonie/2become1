"""Phase 7B real-system hardening: migration and restart verification.

These tests exercise the numbered migration chain and application restart
against *temporary copies* — never the live user database. The live data root
(``~/.local/share/2become1``) is treated as irreplaceable and is only ever
read, never written, by this module.

Covered:
- V0.2 fixture migrates in place and the app restarts cleanly over it;
- a temporary copy of the real local database opens, reports the latest
  migration version, preserves row/media invariants, and restarts cleanly;
- restart marks queued/running jobs ``interrupted`` (not failed/cancelled).
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

from twobecomeone import migrations
from twobecomeone.studio import StudioService

FIXTURES = Path(__file__).parent / "fixtures"
V02_SCHEMA = FIXTURES / "v0.2_schema.sql"
REAL_DATA_DIR = Path.home() / ".local" / "share" / "2become1"


def _copy_real_db(tmp_path: Path) -> Path | None:
    """Copy the live database (and only the database) to a temp location.

    Returns the temp data dir, or ``None`` when no live database exists.
    """
    src = REAL_DATA_DIR / "studio.sqlite3"
    if not src.is_file():
        return None
    dest = tmp_path / "real-copy"
    dest.mkdir(parents=True, exist_ok=True)
    source = sqlite3.connect(f"file:{src.resolve()}?mode=ro", uri=True)
    target = sqlite3.connect(dest / "studio.sqlite3")
    try:
        # SQLite's online backup API produces a consistent snapshot even when
        # the live database uses WAL or another process has it open. The source
        # connection is explicitly read-only.
        source.backup(target)
    finally:
        target.close()
        source.close()
    return dest


def _row_counts(db_path: Path) -> dict[str, int]:
    conn = sqlite3.connect(db_path)
    try:
        return {
            "tracks": conn.execute("SELECT COUNT(*) FROM tracks").fetchone()[0],
            "jobs": conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0],
            "projects": conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0],
            "stem_sets": conn.execute("SELECT COUNT(*) FROM stem_sets").fetchone()[0],
        }
    finally:
        conn.close()


class TestMigrationFromV02Fixture:
    def test_v02_fixture_migrates_and_app_restarts(self, tmp_path):
        """A V0.2 database migrates in place and the app opens over it."""
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        db = data_dir / "studio.sqlite3"
        conn = sqlite3.connect(db)
        conn.executescript(V02_SCHEMA.read_text())
        conn.close()

        # Migrate in place.
        conn = sqlite3.connect(db)
        applied = migrations.run_migrations(conn)
        conn.close()
        assert applied == [m[0] for m in migrations.MIGRATIONS]

        # The app opens over the migrated database without error.
        service = StudioService(data_dir)
        try:
            # The seeded track row survives and is listed (its media file is
            # absent, but the row itself is intact and readable).
            tracks = service.list_tracks()
            assert [t["id"] for t in tracks] == ["track-v02-1"]
            assert tracks[0]["name"] == "anchor.wav"
            # The seeded job row survives and is readable.
            jobs, total = service._store.list(limit=100)
            assert total == 1
            assert jobs[0]["id"] == "job-v02-1"
        finally:
            service.close()

    def test_v02_fixture_seed_rows_survive(self, tmp_path):
        """Seed rows survive the full migration chain unchanged."""
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.executescript(V02_SCHEMA.read_text())
        migrations.run_migrations(conn)
        track = conn.execute(
            "SELECT original_name, bpm, tonic, mode, source_kind FROM tracks WHERE id = 'track-v02-1'"
        ).fetchone()
        assert track["original_name"] == "anchor.wav"
        assert track["bpm"] == pytest.approx(100.6)
        assert track["source_kind"] == "local"


class TestRealDatabaseCopy:
    def test_copy_uses_consistent_read_only_sqlite_snapshot(self, tmp_path, monkeypatch):
        live = tmp_path / "live"
        live.mkdir()
        live_db = live / "studio.sqlite3"
        conn = sqlite3.connect(live_db)
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("CREATE TABLE evidence (value TEXT NOT NULL)")
            conn.execute("INSERT INTO evidence VALUES ('preserved')")
            conn.commit()

            monkeypatch.setattr(sys.modules[__name__], "REAL_DATA_DIR", live)
            copied = _copy_real_db(tmp_path / "copy-root")
            assert copied is not None
            with sqlite3.connect(copied / "studio.sqlite3") as snapshot:
                value = snapshot.execute("SELECT value FROM evidence").fetchone()[0]
            assert value == "preserved"
        finally:
            conn.close()

    def test_real_db_copy_opens_and_preserves_invariants(self, tmp_path):
        """A temp copy of the live DB opens at the latest migration version.

        This is read-only with respect to the live database: only the copy is
        opened. Row counts and media invariants are recorded, not modified.
        """
        dest = _copy_real_db(tmp_path)
        if dest is None:
            pytest.skip("no live database present to copy")

        before = _row_counts(dest / "studio.sqlite3")

        service = StudioService(dest)
        try:
            # Latest migration version is applied.
            with service._connect() as conn:
                versions = {r[0] for r in conn.execute("SELECT version FROM schema_migrations")}
            assert migrations.latest_version() in versions

            # Row counts are unchanged by opening the app.
            after = _row_counts(dest / "studio.sqlite3")
            assert after == before

            # Every active track advertises a playable, managed audio path.
            for track in service.list_tracks():
                assert track["audio_url"].startswith("/api/tracks/")
        finally:
            service.close()

    def test_restart_marks_queued_jobs_interrupted(self, tmp_path):
        """A queued job left by a prior process becomes ``interrupted`` on restart."""
        data_dir = tmp_path / "data"
        service = StudioService(data_dir)
        from twobecomeone.contracts import JobKind
        job_id = service._store.create(JobKind.RENDER, {"anchor_id": "x"})
        # Abandon without a clean close (simulate a crash).
        service._engine.shutdown(wait=False)
        del service

        reopened = StudioService(data_dir)
        try:
            job = reopened.get_job(job_id)
            assert job["status"] == "interrupted"
            assert job["recovery"]["can_retry"] is True
        finally:
            reopened.close()

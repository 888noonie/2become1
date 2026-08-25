"""Numbered, transactional schema migrations for 2become1.

Phase 0 introduces the migration registry and runner as standalone
infrastructure. Later phases wire ``run_migrations`` into
``StudioService._init_db`` so every database is migrated in place on open,
replacing the ad-hoc ``ALTER TABLE`` loop currently in ``studio.py``.

Each migration is a ``(version, name, statements)`` tuple. Versions are
strictly increasing and applied exactly once. All statements in a migration
run inside a single transaction, and the version is recorded in the
``schema_migrations`` table only after the statements succeed, so a failed
migration leaves no partial state.
"""

from __future__ import annotations

import sqlite3
import time

# (version, name, [statements])
MIGRATIONS: list[tuple[int, str, list[str]]] = [
    (
        1,
        "v0.3 track and job columns",
        [
            "ALTER TABLE tracks ADD COLUMN display_name TEXT",
            "ALTER TABLE tracks ADD COLUMN content_sha256 TEXT",
            "ALTER TABLE tracks ADD COLUMN metadata_json TEXT",
            "ALTER TABLE tracks ADD COLUMN artwork_path TEXT",
            "ALTER TABLE tracks ADD COLUMN waveform_path TEXT",
            "ALTER TABLE tracks ADD COLUMN bpm_override REAL",
            "ALTER TABLE tracks ADD COLUMN tonic_override TEXT",
            "ALTER TABLE tracks ADD COLUMN mode_override TEXT",
            "ALTER TABLE tracks ADD COLUMN first_beat_override REAL",
            "ALTER TABLE tracks ADD COLUMN downbeat_override REAL",
            "ALTER TABLE tracks ADD COLUMN deleted_at REAL",
            "ALTER TABLE jobs ADD COLUMN executor TEXT",
            "ALTER TABLE jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE jobs ADD COLUMN parent_job_id TEXT",
        ],
    ),
    (
        2,
        "projects table",
        [
            "CREATE TABLE projects ("
            " id TEXT PRIMARY KEY,"
            " name TEXT NOT NULL,"
            " anchor_track_id TEXT,"
            " lead_track_id TEXT,"
            " anchor_variant TEXT,"
            " lead_variant TEXT,"
            " settings_json TEXT NOT NULL DEFAULT '{}',"
            " created_at REAL NOT NULL,"
            " updated_at REAL NOT NULL"
            ")",
        ],
    ),
    (
        3,
        "stem_sets table",
        [
            "CREATE TABLE stem_sets ("
            " id TEXT PRIMARY KEY,"
            " track_id TEXT NOT NULL,"
            " method TEXT NOT NULL,"
            " model TEXT,"
            " device TEXT,"
            " status TEXT NOT NULL DEFAULT 'complete',"
            " paths_json TEXT NOT NULL DEFAULT '{}',"
            " created_at REAL NOT NULL"
            ")",
            "CREATE INDEX idx_stem_sets_track ON stem_sets(track_id)",
        ],
    ),
]


def _ensure_migrations_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations ("
        " version INTEGER PRIMARY KEY,"
        " name TEXT NOT NULL,"
        " applied_at REAL NOT NULL"
        ")"
    )


def applied_versions(conn: sqlite3.Connection) -> set[int]:
    """Return the set of migration versions already recorded as applied."""
    _ensure_migrations_table(conn)
    rows = conn.execute("SELECT version FROM schema_migrations").fetchall()
    return {row[0] for row in rows}


def run_migrations(conn: sqlite3.Connection) -> list[int]:
    """Apply any pending migrations transactionally.

    Returns the list of versions applied by this call (empty if up to date).

    DDL (``ALTER TABLE``/``CREATE TABLE``) is not covered by sqlite3's implicit
    ``with conn:`` transaction, so we drive the transaction explicitly with
    ``BEGIN``/``COMMIT``/``ROLLBACK`` to guarantee a failed migration leaves no
    partial columns or recorded version.
    """
    _ensure_migrations_table(conn)
    done = applied_versions(conn)
    applied: list[int] = []
    for version, name, statements in MIGRATIONS:
        if version in done:
            continue
        conn.execute("BEGIN")
        try:
            for statement in statements:
                conn.execute(statement)
            conn.execute(
                "INSERT INTO schema_migrations (version, name, applied_at)"
                " VALUES (?, ?, ?)",
                (version, name, time.time()),
            )
        except Exception:
            conn.rollback()
            raise
        else:
            conn.commit()
        applied.append(version)
    return applied


def latest_version() -> int:
    """Return the highest migration version defined in this module."""
    return MIGRATIONS[-1][0] if MIGRATIONS else 0

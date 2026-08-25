"""Numbered, transactional schema migrations for 2become1.

Phase 0 introduced the registry and runner. Phase 1 wires ``run_migrations``
into ``StudioService._init_db``, replacing the ad-hoc ``ALTER TABLE`` loop.

Each migration is a ``(version, name, action)`` tuple where ``action`` is
either a list of SQL statements or a callable ``(conn) -> None``. Callables
exist for migrations that need conditional logic (e.g. ``ADD COLUMN`` guarded
by a ``PRAGMA table_info`` check, since SQLite has no ``ADD COLUMN IF NOT
EXISTS``).

Versions are strictly increasing and applied exactly once. Each migration runs
inside an explicit ``BEGIN``/``COMMIT``/``ROLLBACK`` transaction (sqlite3's
implicit ``with conn:`` does not cover DDL), and the version is recorded only
after the action succeeds, so a failed migration leaves no partial state.
"""

from __future__ import annotations

import sqlite3
import time
from typing import Callable

MigrationAction = list[str] | Callable[[sqlite3.Connection], None]


def _add_column_if_missing(conn: sqlite3.Connection, table: str, column: str,
                           declaration: str) -> None:
    """Add ``column`` to ``table`` only if it does not already exist."""
    existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")


def _migration_0_v01_to_v02(conn: sqlite3.Connection) -> None:
    """Bring a V0.1 database up to the V0.2 column shape.

    New databases already create these columns in the base ``CREATE TABLE``,
    so this migration must be conditional to avoid duplicate-column errors.
    """
    _add_column_if_missing(conn, "tracks", "beat_interval", "REAL")
    _add_column_if_missing(conn, "tracks", "first_beat", "REAL")
    _add_column_if_missing(conn, "tracks", "suggested_downbeat", "REAL")
    _add_column_if_missing(conn, "tracks", "beat_confidence", "REAL")
    _add_column_if_missing(conn, "tracks", "source_kind", "TEXT NOT NULL DEFAULT 'upload'")
    _add_column_if_missing(conn, "tracks", "source_ref", "TEXT")


def _migration_7_stem_cache_identity(conn: sqlite3.Connection) -> None:
    """Give ``stem_sets`` an enforceable cache identity.

    The cache key is ``track_sha256 + method + model_name``. ``model_name`` is
    stable and version-sensitive (e.g. ``htdemucs@4.1.0`` or ``center-side-v1``)
    so upgrading the model invalidates old cache entries automatically. All
    three components are NOT NULL (no nullable cache components), enforced by a
    unique composite index.
    """
    _add_column_if_missing(conn, "stem_sets", "track_sha256", "TEXT NOT NULL DEFAULT ''")
    _add_column_if_missing(conn, "stem_sets", "model_name", "TEXT NOT NULL DEFAULT ''")
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_stem_sets_cache"
        " ON stem_sets(track_sha256, method, model_name)"
    )


# (version, name, action)
MIGRATIONS: list[tuple[int, str, MigrationAction]] = [
    (0, "v0.1 to v0.2 track columns", _migration_0_v01_to_v02),
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
    (
        4,
        "job progress_json",
        [
            "ALTER TABLE jobs ADD COLUMN progress_json TEXT",
        ],
    ),
    (
        5,
        "content hash index",
        [
            "CREATE INDEX idx_tracks_content_sha256 ON tracks(content_sha256)",
        ],
    ),
    (
        6,
        "content hash unique index",
        [
            "DROP INDEX idx_tracks_content_sha256",
            "CREATE UNIQUE INDEX idx_tracks_content_sha256 ON tracks(content_sha256)",
        ],
    ),
    (
        7,
        "stem_sets cache identity",
        _migration_7_stem_cache_identity,
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
    for version, name, action in MIGRATIONS:
        if version in done:
            continue
        conn.execute("BEGIN")
        try:
            if callable(action):
                action(conn)
            else:
                for statement in action:
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

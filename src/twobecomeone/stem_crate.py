"""Persistent stem crate items for Phase 14B.1.

Each row references existing managed stem media by opaque IDs. Filesystem paths
are never stored or returned. ``StudioService`` enriches rows with live media
status and server-authored audio URLs.
"""

from __future__ import annotations

import json
import math
import sqlite3
import time
import uuid
from typing import Any, Callable

from .common import ConflictError, NotFoundError, UserError
from .projects import ALL_VARIANTS, FULL_VARIANT

SCHEMA_VERSION = 1
ROLES = ("beat", "bass", "other", "voice")
LOOP_BARS = (1, 2, 4, 8)
PROVENANCE = "source_track_inherited"
MAX_LABEL_LEN = 200
MIN_GAIN_DB = -24.0
MAX_GAIN_DB = 12.0
MAX_LIST_LIMIT = 100


def _finite_number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise UserError(f"{name} must be a number")
    if not math.isfinite(value):
        raise UserError(f"{name} must be finite")
    return float(value)


def validate_role(role: str) -> str:
    if role not in ROLES:
        raise UserError(f"role must be one of: {', '.join(ROLES)}")
    return role


def validate_loop_bars(loop_bars: int) -> int:
    if isinstance(loop_bars, bool) or not isinstance(loop_bars, int):
        raise UserError("loop_bars must be an integer")
    if loop_bars not in LOOP_BARS:
        raise UserError(f"loop_bars must be one of: {', '.join(str(v) for v in LOOP_BARS)}")
    return loop_bars


def validate_stem_name(stem_name: str) -> str:
    if not isinstance(stem_name, str) or not stem_name:
        raise UserError("stem_name is required")
    if stem_name == FULL_VARIANT or stem_name not in ALL_VARIANTS:
        raise UserError(f"unknown stem name: {stem_name}")
    return stem_name


def validate_region(start_beat: float, end_beat: float) -> tuple[float, float]:
    start = _finite_number(start_beat, "region_start_beat")
    end = _finite_number(end_beat, "region_end_beat")
    if start < 0:
        raise UserError("region_start_beat must be non-negative")
    if end <= start:
        raise UserError("region_end_beat must be greater than region_start_beat")
    return start, end


def validate_gain_db(value: float | None) -> float | None:
    if value is None:
        return None
    gain = _finite_number(value, "gain_db")
    if not MIN_GAIN_DB <= gain <= MAX_GAIN_DB:
        raise UserError(f"gain_db must be between {MIN_GAIN_DB} and {MAX_GAIN_DB}")
    return gain


class StemCrateStore:
    """SQLite persistence for stem crate items."""

    def __init__(self, connect: Callable[[], sqlite3.Connection]):
        self._connect = connect

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "schema_version": row["schema_version"],
            "track_id": row["track_id"],
            "content_sha256": row["content_sha256"],
            "stem_set_id": row["stem_set_id"],
            "stem_name": row["stem_name"],
            "method": row["method"],
            "model_name": row["model_name"],
            "device": row["device"],
            "role": row["role"],
            "provenance": row["provenance"],
            "effective_bpm": row["effective_bpm"],
            "effective_tonic": row["effective_tonic"],
            "effective_mode": row["effective_mode"],
            "grid_revision": row["grid_revision"],
            "analysis_confidence": row["analysis_confidence"],
            "overrides_active": bool(row["overrides_active"]),
            "region_start_beat": row["region_start_beat"],
            "region_end_beat": row["region_end_beat"],
            "loop_bars": row["loop_bars"],
            "label": row["label"],
            "gain_db": row["gain_db"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def insert(self, record: dict[str, Any]) -> dict[str, Any]:
        item_id = uuid.uuid4().hex
        now = time.time()
        with self._connect() as conn:
            try:
                conn.execute(
                    """INSERT INTO stem_crate_items (
                        id, schema_version, track_id, content_sha256, stem_set_id,
                        stem_name, method, model_name, device, role, provenance,
                        effective_bpm, effective_tonic, effective_mode, grid_revision,
                        analysis_confidence, overrides_active, region_start_beat,
                        region_end_beat, loop_bars, label, gain_db, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        item_id,
                        record["schema_version"],
                        record["track_id"],
                        record["content_sha256"],
                        record["stem_set_id"],
                        record["stem_name"],
                        record["method"],
                        record["model_name"],
                        record["device"],
                        record["role"],
                        record["provenance"],
                        record["effective_bpm"],
                        record["effective_tonic"],
                        record["effective_mode"],
                        record["grid_revision"],
                        record["analysis_confidence"],
                        1 if record["overrides_active"] else 0,
                        record["region_start_beat"],
                        record["region_end_beat"],
                        record["loop_bars"],
                        record["label"],
                        record["gain_db"],
                        now,
                        now,
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise ConflictError(
                    "a crate item already exists for this track, stem, and region"
                ) from exc
        return self.get(item_id)

    def get(self, item_id: str) -> dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM stem_crate_items WHERE id = ?", (item_id,)
            ).fetchone()
        if row is None:
            raise NotFoundError(f"unknown stem crate item: {item_id}")
        return self._row_to_dict(row)

    def list(
        self,
        *,
        limit: int,
        offset: int,
        query: str | None = None,
        role: str | None = None,
    ) -> tuple[list[dict[str, Any]], int]:
        clauses = ["1=1"]
        params: list[Any] = []
        if role is not None:
            validate_role(role)
            clauses.append("stem_crate_items.role = ?")
            params.append(role)
        if query:
            like = f"%{query.strip()}%"
            clauses.append(
                "(stem_crate_items.label LIKE ? OR stem_crate_items.stem_name LIKE ?"
                " OR COALESCE(tracks.display_name, tracks.original_name) LIKE ?)"
            )
            params.extend([like, like, like])
        where = " AND ".join(clauses)
        with self._connect() as conn:
            total = conn.execute(
                f"SELECT COUNT(*) FROM stem_crate_items"
                f" LEFT JOIN tracks ON tracks.id = stem_crate_items.track_id"
                f" WHERE {where}",
                params,
            ).fetchone()[0]
            rows = conn.execute(
                f"SELECT stem_crate_items.* FROM stem_crate_items"
                f" LEFT JOIN tracks ON tracks.id = stem_crate_items.track_id"
                f" WHERE {where}"
                f" ORDER BY stem_crate_items.created_at DESC"
                f" LIMIT ? OFFSET ?",
                [*params, limit, offset],
            ).fetchall()
        return [self._row_to_dict(row) for row in rows], total

    def update(self, item_id: str, **fields: Any) -> dict[str, Any]:
        allowed = {
            "label",
            "role",
            "loop_bars",
            "region_start_beat",
            "region_end_beat",
            "gain_db",
        }
        unknown = set(fields) - allowed
        if unknown:
            raise UserError(f"unknown stem crate field: {sorted(unknown)[0]}")
        if not fields:
            return self.get(item_id)

        current = self.get(item_id)
        label = fields.get("label", current["label"])
        role = validate_role(fields.get("role", current["role"]))
        loop_bars = validate_loop_bars(fields.get("loop_bars", current["loop_bars"]))
        start, end = validate_region(
            fields.get("region_start_beat", current["region_start_beat"]),
            fields.get("region_end_beat", current["region_end_beat"]),
        )
        gain_db = (
            validate_gain_db(fields["gain_db"])
            if "gain_db" in fields
            else current["gain_db"]
        )
        if label is not None:
            from . import media

            label = media.sanitize_text(str(label), MAX_LABEL_LEN) or None

        assignments = [
            "label = ?",
            "role = ?",
            "loop_bars = ?",
            "region_start_beat = ?",
            "region_end_beat = ?",
            "gain_db = ?",
            "updated_at = ?",
        ]
        values = [label, role, loop_bars, start, end, gain_db, time.time(), item_id]
        with self._connect() as conn:
            try:
                cur = conn.execute(
                    f"UPDATE stem_crate_items SET {', '.join(assignments)} WHERE id = ?",
                    values,
                )
            except sqlite3.IntegrityError as exc:
                raise ConflictError(
                    "a crate item already exists for this track, stem, and region"
                ) from exc
            if cur.rowcount == 0:
                raise NotFoundError(f"unknown stem crate item: {item_id}")
        return self.get(item_id)

    def delete(self, item_id: str) -> None:
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM stem_crate_items WHERE id = ?", (item_id,))
            if cur.rowcount == 0:
                raise NotFoundError(f"unknown stem crate item: {item_id}")

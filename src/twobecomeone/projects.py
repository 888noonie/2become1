"""Project persistence and validation for 2become1.

Phase 3.3. A project is a persisted arrangement: two decks (anchor + lead),
their selected stem variants, and a settings blob (cues, duration, gains, snap,
pitch mode). The save strategy is explicitly Last-Write-Wins: no If-Match,
revision token, or updated_at conflict response. Every valid PATCH atomically
overwrites the supplied state; the server controls ``updated_at``.

This module owns validation and the SQL mapping. ``StudioService`` remains the
facade that resolves track/variant existence against the library.
"""

from __future__ import annotations

import json
import math
import sqlite3
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from .common import NotFoundError, UserError

# Truthful stem variants. ``full`` always exists for a valid track; the others
# exist only when a completed, path-valid stem set provides them.
FULL_VARIANT = "full"
DEMUCS_VARIANTS = ("vocals", "drums", "bass", "other")
CENTER_SIDE_VARIANTS = ("center", "sides")
ALL_VARIANTS = (FULL_VARIANT,) + DEMUCS_VARIANTS + CENTER_SIDE_VARIANTS

PITCH_MODES = ("preserve", "match")

# Settings keys the project stores, with their validation rules.
_SETTINGS_KEYS = {
    "anchor_start": "cue",
    "lead_start": "cue",
    "duration": "duration",
    "anchor_gain": "gain",
    "lead_gain": "gain",
    "snap": "bool",
    "pitch_mode": "pitch_mode",
}

MAX_PROJECT_NAME_LEN = 200
MAX_SETTINGS_BYTES = 64 * 1024


@dataclass(frozen=True)
class ProjectRecord:
    id: str
    name: str
    anchor_track_id: str | None
    lead_track_id: str | None
    anchor_variant: str | None
    lead_variant: str | None
    settings: dict[str, Any]
    created_at: float
    updated_at: float


def _finite(value: Any, name: str) -> float:
    try:
        value = float(value)
    except (TypeError, ValueError):
        raise UserError(f"{name} must be a number")
    if not math.isfinite(value):
        raise UserError(f"{name} must be finite")
    return value


def validate_settings(settings: dict[str, Any]) -> dict[str, Any]:
    """Validate and normalize a project settings blob.

    Unknown keys are rejected. Cues/duration/gains must be finite and
    range-safe; ``snap`` must be a boolean; ``pitch_mode`` must be a known
    enum. Returns a normalized copy.
    """
    if not isinstance(settings, dict):
        raise UserError("settings must be an object")

    normalized: dict[str, Any] = {}
    for key, value in settings.items():
        if key not in _SETTINGS_KEYS:
            raise UserError(f"unknown project setting: {key}")
        kind = _SETTINGS_KEYS[key]
        if kind == "cue":
            v = _finite(value, key)
            if v < 0:
                raise UserError(f"{key} must be non-negative")
            normalized[key] = v
        elif kind == "duration":
            if value is None:
                normalized[key] = None
                continue
            v = _finite(value, key)
            if v <= 0:
                raise UserError(f"{key} must be greater than zero")
            normalized[key] = v
        elif kind == "gain":
            v = _finite(value, key)
            if not 0 <= v <= 2:
                raise UserError(f"{key} must be between 0 and 2")
            normalized[key] = v
        elif kind == "bool":
            if not isinstance(value, bool):
                raise UserError(f"{key} must be a boolean")
            normalized[key] = value
        elif kind == "pitch_mode":
            if value not in PITCH_MODES:
                raise UserError(f"{key} must be one of: {', '.join(PITCH_MODES)}")
            normalized[key] = value
    return normalized


def validate_variant(variant: str | None) -> str | None:
    """Validate a stem variant name; ``None``/``full`` are the full mix."""
    if variant is None or variant == FULL_VARIANT:
        return FULL_VARIANT
    if variant not in ALL_VARIANTS:
        raise UserError(f"unknown variant: {variant}")
    return variant


class ProjectStore:
    """SQLite persistence for projects (Last-Write-Wins)."""

    def __init__(self, connect: Callable[[], sqlite3.Connection]):
        self._connect = connect

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "name": row["name"],
            "anchor_track_id": row["anchor_track_id"],
            "lead_track_id": row["lead_track_id"],
            "anchor_variant": row["anchor_variant"],
            "lead_variant": row["lead_variant"],
            "settings": json.loads(row["settings_json"]) if row["settings_json"] else {},
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def create(self, name: str) -> dict[str, Any]:
        project_id = uuid.uuid4().hex
        now = time.time()
        with self._connect() as conn:
            conn.execute(
                """INSERT INTO projects
                   (id, name, anchor_track_id, lead_track_id, anchor_variant,
                    lead_variant, settings_json, created_at, updated_at)
                   VALUES (?, ?, NULL, NULL, NULL, NULL, '{}', ?, ?)""",
                (project_id, name, now, now),
            )
        return self.get(project_id)

    def get(self, project_id: str) -> dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM projects WHERE id = ?", (project_id,)
            ).fetchone()
        if row is None:
            raise NotFoundError(f"unknown project: {project_id}")
        return self._row_to_dict(row)

    def list(self, limit: int = 50, offset: int = 0) -> tuple[list[dict[str, Any]], int]:
        with self._connect() as conn:
            total = conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0]
            rows = conn.execute(
                "SELECT * FROM projects ORDER BY updated_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
        return [self._row_to_dict(row) for row in rows], total

    def update(self, project_id: str, **fields: Any) -> dict[str, Any]:
        """Atomically overwrite the supplied fields (Last-Write-Wins).

        ``fields`` may include name, anchor_track_id, lead_track_id,
        anchor_variant, lead_variant, and settings. The server sets
        ``updated_at``; client timestamps never participate.
        """
        allowed = {
            "name", "anchor_track_id", "lead_track_id",
            "anchor_variant", "lead_variant", "settings",
        }
        unknown = set(fields) - allowed
        if unknown:
            raise UserError(f"unknown project field: {sorted(unknown)[0]}")

        assignments: list[str] = []
        values: list[Any] = []
        for key, value in fields.items():
            if key == "settings":
                assignments.append("settings_json = ?")
                values.append(json.dumps(value))
            else:
                assignments.append(f"{key} = ?")
                values.append(value)
        assignments.append("updated_at = ?")
        values.append(time.time())
        values.append(project_id)

        with self._connect() as conn:
            cur = conn.execute(
                f"UPDATE projects SET {', '.join(assignments)} WHERE id = ?", values
            )
            if cur.rowcount == 0:
                raise NotFoundError(f"unknown project: {project_id}")
        return self.get(project_id)

    def delete(self, project_id: str) -> None:
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
            if cur.rowcount == 0:
                raise NotFoundError(f"unknown project: {project_id}")

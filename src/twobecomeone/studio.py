"""Local-first service and job layer for 2become1 Studio.

The CLI and web app share this module instead of wrapping one another. It owns
safe media ingestion, persistent project metadata, and the job engine that
protects a laptop GPU from concurrent Demucs jobs.

Phase 1: job persistence/lifecycle now lives in :mod:`twobecomeone.jobs`
(``JobStore`` + ``JobEngine``). This module keeps the media/library facade and
the render orchestration, delegating job state transitions to the engine.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import sqlite3
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, BinaryIO

from . import __version__, analyzer, assembler, beatgrid, media, migrations, projects, separator, sources
from .common import (
    MAX_MEDIA_BYTES,
    CapabilityError,
    ConflictError,
    NotFoundError,
    PayloadTooLargeError,
    UserError,
)
from .contracts import TERMINAL_JOB_STATES, JobKind
from .jobs import CancellationToken, JobEngine, JobStore


ALLOWED_AUDIO_SUFFIXES = {
    ".aac", ".aiff", ".alac", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav",
}
MAX_UPLOAD_BYTES = MAX_MEDIA_BYTES

# Valid tonic names (matches analyzer._NOTE_NAMES).
_NOTE_NAMES = {"C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"}


def _finite_positive(value: Any, name: str) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise UserError(f"{name} must be a number")
    if not math.isfinite(v) or v <= 0:
        raise UserError(f"{name} must be a positive finite number")
    return v


def _finite_nonnegative(value: Any, name: str) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise UserError(f"{name} must be a number")
    if not math.isfinite(v) or v < 0:
        raise UserError(f"{name} must be a non-negative finite number")
    return v


def default_data_dir() -> Path:
    return Path.home() / ".local" / "share" / "2become1"


@dataclass(frozen=True)
class RenderOptions:
    anchor_id: str
    lead_id: str
    anchor_start: float = 0.0
    lead_start: float = 0.0
    duration: float | None = None
    anchor_gain: float = 0.8
    lead_gain: float = 0.8
    use_vocals: bool = False
    stem_method: str = "auto"
    preview: bool = False
    anchor_variant: str | None = None
    lead_variant: str | None = None
    pitch_mode: str = "match"

    def validate(self) -> None:
        numeric = {
            "anchor_start": self.anchor_start,
            "lead_start": self.lead_start,
            "anchor_gain": self.anchor_gain,
            "lead_gain": self.lead_gain,
        }
        if self.duration is not None:
            numeric["duration"] = self.duration
        for name, value in numeric.items():
            if not math.isfinite(value):
                raise UserError(f"{name} must be finite")
        if self.anchor_start < 0 or self.lead_start < 0:
            raise UserError("start offsets must be non-negative")
        if self.duration is not None and self.duration <= 0:
            raise UserError("duration must be greater than zero")
        if not 0 <= self.anchor_gain <= 2 or not 0 <= self.lead_gain <= 2:
            raise UserError("gains must be between 0 and 2")
        if self.stem_method not in {"auto", "demucs", "ffmpeg"}:
            raise UserError(f"unknown stem method: {self.stem_method}")
        if self.pitch_mode not in {"preserve", "match"}:
            raise UserError(f"unknown pitch mode: {self.pitch_mode}")
        # Reject contradictory legacy + explicit variant payloads.
        if self.use_vocals and self.lead_variant not in (None, "vocals"):
            raise UserError("use_vocals conflicts with lead_variant; use one or the other")
        if self.anchor_variant is not None:
            projects.validate_variant(self.anchor_variant)
        if self.lead_variant is not None:
            projects.validate_variant(self.lead_variant)

    def resolved_lead_variant(self) -> str:
        """Map legacy ``use_vocals`` to an explicit lead variant."""
        if self.lead_variant is not None:
            return self.lead_variant
        return "vocals" if self.use_vocals else "full"


class StudioService:
    """Persistent local studio with a serialized audio/GPU job engine."""

    def __init__(self, data_dir: str | Path | None = None):
        self.data_dir = Path(data_dir) if data_dir else default_data_dir()
        self.track_dir = self.data_dir / "tracks"
        self.incoming_dir = self.data_dir / "incoming"
        self.render_dir = self.data_dir / "renders"
        self.stem_dir = self.data_dir / "stems"
        self.waveform_dir = self.data_dir / "waveforms"
        self.artwork_dir = self.data_dir / "artwork"
        self.temp_dir = self.data_dir / "temp"
        self.db_path = self.data_dir / "studio.sqlite3"
        for directory in (
            self.data_dir, self.track_dir, self.incoming_dir, self.render_dir,
            self.stem_dir, self.waveform_dir, self.artwork_dir, self.temp_dir,
        ):
            directory.mkdir(parents=True, exist_ok=True)
        self._init_db()
        self._store = JobStore(self._connect)
        self._engine = JobEngine(self._store)
        self._projects = projects.ProjectStore(self._connect)
        self._closed = False

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            # Base tables are created at the V0.2 shape; numbered migrations
            # then bring the schema forward. Keeping the base at V0.2 avoids
            # duplicate-column errors when migrations also add those columns.
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS tracks (
                    id TEXT PRIMARY KEY,
                    original_name TEXT NOT NULL,
                    path TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    bpm REAL NOT NULL,
                    tonic TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    confidence REAL NOT NULL,
                    duration REAL NOT NULL,
                    beat_interval REAL,
                    first_beat REAL,
                    suggested_downbeat REAL,
                    beat_confidence REAL,
                    source_kind TEXT NOT NULL DEFAULT 'upload',
                    source_ref TEXT,
                    created_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS jobs (
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
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
                """
            )
            migrations.run_migrations(conn)
        # Recover any jobs left queued/running by a previous process.
        JobStore(self._connect).mark_interrupted_on_startup()

    @staticmethod
    def _track_dict(row: sqlite3.Row) -> dict:
        # Effective = override when override is not null, otherwise detected.
        bpm = row["bpm_override"] if row["bpm_override"] is not None else row["bpm"]
        tonic = row["tonic_override"] if row["tonic_override"] is not None else row["tonic"]
        mode = row["mode_override"] if row["mode_override"] is not None else row["mode"]
        first_beat = (
            row["first_beat_override"]
            if row["first_beat_override"] is not None
            else row["first_beat"]
        )
        suggested_downbeat = (
            row["downbeat_override"]
            if row["downbeat_override"] is not None
            else row["suggested_downbeat"]
        )

        display_name = row["display_name"] or row["original_name"]

        return {
            "id": row["id"],
            "name": display_name,
            "size_bytes": row["size_bytes"],
            "bpm": bpm,
            "key": {
                "tonic": tonic,
                "mode": mode,
                "confidence": row["confidence"],
            },
            "duration": row["duration"],
            "beat_grid": {
                "interval": row["beat_interval"],
                "first_beat": first_beat,
                "suggested_downbeat": suggested_downbeat,
                "confidence": row["beat_confidence"],
            },
            "detected": {
                "bpm": row["bpm"],
                "key": {
                    "tonic": row["tonic"],
                    "mode": row["mode"],
                    "confidence": row["confidence"],
                },
                "beat_grid": {
                    "interval": row["beat_interval"],
                    "first_beat": row["first_beat"],
                    "suggested_downbeat": row["suggested_downbeat"],
                    "confidence": row["beat_confidence"],
                },
            },
            "overrides": {
                "bpm": row["bpm_override"],
                "tonic": row["tonic_override"],
                "mode": row["mode_override"],
                "first_beat": row["first_beat_override"],
                "suggested_downbeat": row["downbeat_override"],
            },
            "source": {
                "kind": row["source_kind"],
                "reference": row["source_ref"],
            },
            "deleted_at": row["deleted_at"],
            "created_at": row["created_at"],
            "audio_url": f"/api/tracks/{row['id']}/audio",
            "artwork_url": f"/api/tracks/{row['id']}/artwork",
            "waveform_url": f"/api/tracks/{row['id']}/waveform",
        }

    def ingest(
        self,
        source: BinaryIO,
        original_name: str,
        *,
        source_kind: str = "upload",
        source_ref: str | None = None,
        metadata: dict | None = None,
        artwork_source: str | Path | None = None,
    ) -> dict:
        if source_kind not in {"upload", "local", "youtube"}:
            raise UserError(f"unknown media source: {source_kind}")
        suffix = Path(original_name).suffix.lower()
        if suffix not in ALLOWED_AUDIO_SUFFIXES:
            supported = ", ".join(sorted(ALLOWED_AUDIO_SUFFIXES))
            raise UserError(f"unsupported audio type '{suffix or 'none'}'; choose one of: {supported}")

        # Sanitize the display name (never trust the uploader's filename).
        display_name = media.sanitize_text(Path(original_name).name, 300) or "untitled"

        track_id = uuid.uuid4().hex
        destination = self.track_dir / f"{track_id}{suffix}"
        size = 0
        try:
            with destination.open("xb") as output:
                while chunk := source.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        raise PayloadTooLargeError("audio file exceeds the 750 MB local upload limit")
                    output.write(chunk)
            if size == 0:
                raise UserError("uploaded file is empty")
            result = analyzer.analyze(destination)
            try:
                grid = beatgrid.detect(destination, bpm=result.bpm)
            except UserError:
                grid = None
        except Exception:
            destination.unlink(missing_ok=True)
            raise

        # Content hash for deduplication.
        content_hash = media.sha256_file(destination)

        # Generate waveform peaks and write them atomically to the managed
        # waveform directory; store only the relative managed path.
        waveform_rel: str | None = None
        try:
            waveform = media.generate_waveform(destination)
            waveform_rel = f"waveforms/{track_id}.json"
            waveform_path = self.data_dir / waveform_rel
            tmp = waveform_path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(waveform), encoding="utf-8")
            tmp.replace(waveform_path)
        except UserError:
            waveform = None

        # Sanitize metadata (whitelist + normalization) if provided.
        metadata_json = media.metadata_json(metadata) if metadata else None

        # Artwork: prefer an explicit source image (e.g. a YouTube thumbnail),
        # else extract embedded cover art, then re-encode to a clean WebP.
        # Failure is diagnostic only — it must not destroy a valid audio import.
        artwork_rel: str | None = None
        try:
            artwork_rel = f"artwork/{track_id}.webp"
            artwork_path = self.data_dir / artwork_rel
            if artwork_source is not None:
                # Re-encode the untrusted source image to a normalized WebP.
                media.reencode_artwork(artwork_source, artwork_path)
            elif media.extract_embedded_artwork(destination, artwork_path):
                # Re-encode the extracted frame to strip metadata/payloads.
                media.reencode_artwork(artwork_path, artwork_path)
            else:
                artwork_rel = None
        except UserError:
            artwork_rel = None

        now = time.time()
        try:
            with self._connect() as conn:
                conn.execute(
                    """INSERT INTO tracks
                       (id, original_name, path, size_bytes, bpm, tonic, mode, confidence, duration,
                        beat_interval, first_beat, suggested_downbeat, beat_confidence,
                        source_kind, source_ref, content_sha256, metadata_json,
                        waveform_path, artwork_path, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        track_id, display_name, str(destination), size,
                        float(result.bpm), result.key["tonic"], result.key["mode"],
                        float(result.key["confidence"]), float(result.duration),
                        grid.beat_interval if grid else None,
                        grid.first_beat if grid else None,
                        grid.suggested_downbeat if grid else None,
                        grid.confidence if grid else None,
                        source_kind, source_ref,
                        content_hash,
                        metadata_json,
                        waveform_rel,
                        artwork_rel,
                        now,
                    ),
                )
        except sqlite3.IntegrityError:
            # A concurrent worker inserted identical content first. Clean up our
            # duplicate and return the winning track.
            destination.unlink(missing_ok=True)
            if waveform_rel:
                (self.data_dir / waveform_rel).unlink(missing_ok=True)
            if artwork_rel:
                (self.data_dir / artwork_rel).unlink(missing_ok=True)
            winner = self._find_by_hash(content_hash)
            if winner is None:
                raise UserError("duplicate import detected but the original track is missing")
            return winner

        return self.get_track(track_id)

    def _find_by_hash(self, content_hash: str) -> dict | None:
        """Return an existing track with the given content hash, or None."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM tracks WHERE content_sha256 = ? AND deleted_at IS NULL "
                "ORDER BY created_at ASC LIMIT 1",
                (content_hash,),
            ).fetchone()
        if row is None:
            return None
        return self._track_dict(row)

    def ingest_path(
        self,
        path: str | Path,
        *,
        source_kind: str = "local",
        source_ref: str | None = None,
        metadata: dict | None = None,
        artwork_source: str | Path | None = None,
    ) -> dict:
        """Copy a local audio file into the managed Studio library."""
        media_path = sources.from_local(path)
        reference = source_ref if source_ref is not None else str(media_path.resolve())
        with media_path.open("rb") as source:
            return self.ingest(
                source,
                media_path.name,
                source_kind=source_kind,
                source_ref=reference,
                metadata=metadata,
                artwork_source=artwork_source,
            )

    def ingest_youtube(self, url: str) -> dict:
        """Download one YouTube video's audio and ingest it as a managed track."""
        import_id = hashlib.sha256(url.strip().encode("utf-8")).hexdigest()[:20]
        work_dir = self.incoming_dir / import_id
        downloaded = sources.from_youtube(url, work_dir)
        track = self.ingest_path(downloaded, source_kind="youtube", source_ref=url.strip())
        shutil.rmtree(work_dir, ignore_errors=True)
        return track

    def get_track(self, track_id: str) -> dict:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
        if row is None:
            raise NotFoundError(f"unknown track: {track_id}")
        return self._track_dict(row)

    def _get_track_row(self, track_id: str) -> sqlite3.Row:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
        if row is None:
            raise NotFoundError(f"unknown track: {track_id}")
        return row

    def track_path(self, track_id: str) -> Path:
        row = self._get_track_row(track_id)
        path = Path(row["path"])
        if not path.is_file() or self.track_dir.resolve() not in path.resolve().parents:
            raise UserError(f"track media is unavailable: {track_id}")
        return path

    def artwork_path(self, track_id: str) -> Path | None:
        """Return the managed artwork path, or None if the track has no artwork."""
        row = self._get_track_row(track_id)
        rel = row["artwork_path"]
        if not rel:
            return None
        path = self.data_dir / rel
        if not path.is_file() or self.artwork_dir.resolve() not in path.resolve().parents:
            return None
        return path

    def waveform_path(self, track_id: str) -> Path | None:
        """Return the managed waveform path, or None if unavailable."""
        row = self._get_track_row(track_id)
        rel = row["waveform_path"]
        if not rel:
            return None
        path = self.data_dir / rel
        if not path.is_file() or self.waveform_dir.resolve() not in path.resolve().parents:
            return None
        return path

    # ------------------------------------------------------------------
    # Library: search / filter / sort / trash / restore / overrides
    # ------------------------------------------------------------------

    _SORT_COLUMNS = {
        "name": "COALESCE(display_name, original_name)",
        "created": "created_at",
        "bpm": "bpm",
        "duration": "duration",
    }

    def list_tracks(self, limit: int = 40) -> list[dict]:
        """Backward-compatible list of active tracks (most recent first)."""
        return self.list_tracks_page(limit=limit)["items"]

    def list_tracks_page(
        self,
        *,
        limit: int = 50,
        offset: int = 0,
        query: str | None = None,
        status: str = "active",
        sort: str = "created",
        source: str | None = None,
    ) -> dict:
        """Paginated, searchable, filterable library listing.

        Returns ``{items, total, limit, offset}``. ``status`` is one of
        ``active``, ``trash``, or ``all``. ``sort`` is allowlisted to name,
        created, bpm, or duration. ``source`` optionally filters by
        ``source_kind`` (upload/local/youtube).
        """
        limit = max(1, min(100, limit))
        offset = max(0, offset)
        if status not in {"active", "trash", "all"}:
            raise UserError("status must be active, trash, or all")
        if sort not in self._SORT_COLUMNS:
            raise UserError(f"unknown sort: {sort}")
        if source is not None and source not in {"upload", "local", "youtube"}:
            raise UserError(f"unknown source: {source}")

        where: list[str] = []
        params: list[Any] = []
        if status == "active":
            where.append("deleted_at IS NULL")
        elif status == "trash":
            where.append("deleted_at IS NOT NULL")
        if source is not None:
            where.append("source_kind = ?")
            params.append(source)
        if query:
            where.append(
                "(COALESCE(display_name, original_name) LIKE ? OR metadata_json LIKE ?)"
            )
            like = f"%{query}%"
            params.extend([like, like])

        clause = f"WHERE {' AND '.join(where)}" if where else ""
        order_col = self._SORT_COLUMNS[sort]

        with self._connect() as conn:
            total = conn.execute(
                f"SELECT COUNT(*) FROM tracks {clause}", params
            ).fetchone()[0]
            rows = conn.execute(
                f"SELECT * FROM tracks {clause} ORDER BY {order_col} DESC LIMIT ? OFFSET ?",
                params + [limit, offset],
            ).fetchall()
        return {
            "items": [self._track_dict(row) for row in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }

    def update_track(self, track_id: str, **fields: Any) -> dict:
        """Apply a whitelisted PATCH to a track (display name + overrides).

        JSON ``null`` resets an override. Unknown fields are rejected. The whole
        patch is validated before any write, so an invalid multi-field patch
        makes no changes.
        """
        allowed = {
            "display_name", "bpm", "tonic", "mode",
            "first_beat", "suggested_downbeat",
        }
        unknown = set(fields) - allowed
        if unknown:
            raise UserError(f"unknown track field: {sorted(unknown)[0]}")

        # Validate everything first (no partial writes).
        assignments: list[str] = []
        values: list[Any] = []
        for key, value in fields.items():
            if key == "display_name":
                if value is None:
                    assignments.append("display_name = NULL")
                else:
                    assignments.append("display_name = ?")
                    values.append(media.sanitize_text(str(value), 300))
            elif key == "bpm":
                column = "bpm_override"
                if value is None:
                    assignments.append(f"{column} = NULL")
                else:
                    v = _finite_positive(value, "bpm")
                    assignments.append(f"{column} = ?")
                    values.append(v)
            elif key == "tonic":
                column = "tonic_override"
                if value is None:
                    assignments.append(f"{column} = NULL")
                else:
                    if value not in _NOTE_NAMES:
                        raise UserError(f"invalid tonic: {value}")
                    assignments.append(f"{column} = ?")
                    values.append(value)
            elif key == "mode":
                column = "mode_override"
                if value is None:
                    assignments.append(f"{column} = NULL")
                else:
                    if value not in {"major", "minor"}:
                        raise UserError(f"invalid mode: {value}")
                    assignments.append(f"{column} = ?")
                    values.append(value)
            elif key == "first_beat":
                column = "first_beat_override"
                if value is None:
                    assignments.append(f"{column} = NULL")
                else:
                    v = _finite_nonnegative(value, "first_beat")
                    assignments.append(f"{column} = ?")
                    values.append(v)
            elif key == "suggested_downbeat":
                column = "downbeat_override"
                if value is None:
                    assignments.append(f"{column} = NULL")
                else:
                    v = _finite_nonnegative(value, "suggested_downbeat")
                    assignments.append(f"{column} = ?")
                    values.append(v)

        values.append(track_id)
        with self._connect() as conn:
            cur = conn.execute(
                f"UPDATE tracks SET {', '.join(assignments)} WHERE id = ?", values
            )
            if cur.rowcount == 0:
                raise UserError(f"unknown track: {track_id}")
        return self.get_track(track_id)

    def trash_track(self, track_id: str) -> dict:
        """Soft-delete a track by setting ``deleted_at`` (files are kept)."""
        with self._connect() as conn:
            cur = conn.execute(
                "UPDATE tracks SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
                (time.time(), track_id),
            )
            if cur.rowcount == 0:
                # Either unknown or already trashed.
                self._get_track_row(track_id)
        return self.get_track(track_id)

    def restore_track(self, track_id: str) -> dict:
        """Restore a trashed track by clearing ``deleted_at``."""
        with self._connect() as conn:
            cur = conn.execute(
                "UPDATE tracks SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL",
                (track_id,),
            )
            if cur.rowcount == 0:
                self._get_track_row(track_id)
        return self.get_track(track_id)

    def is_track_active(self, track_id: str) -> bool:
        row = self._get_track_row(track_id)
        return row["deleted_at"] is None

    # ------------------------------------------------------------------
    # Projects (Last-Write-Wins)
    # ------------------------------------------------------------------

    def _validate_project_track(self, track_id: str | None, field: str) -> None:
        """Validate a project's referenced track exists and is active."""
        if track_id is None:
            return
        self._get_track_row(track_id)  # raises if unknown
        if not self.is_track_active(track_id):
            raise ConflictError(f"{field} references a trashed track; restore it first")

    def create_project(self, name: str) -> dict:
        name = media.sanitize_text(name, projects.MAX_PROJECT_NAME_LEN)
        if not name:
            raise UserError("project name is required")
        return self._projects.create(name)

    def get_project(self, project_id: str) -> dict:
        return self._projects.get(project_id)

    def list_projects(self, limit: int = 50, offset: int = 0) -> dict:
        items, total = self._projects.list(limit=limit, offset=offset)
        return {"items": items, "total": total, "limit": limit, "offset": offset}

    def update_project(self, project_id: str, **fields: Any) -> dict:
        """Validate and atomically overwrite project state (Last-Write-Wins)."""
        # Validate name.
        if "name" in fields:
            name = media.sanitize_text(str(fields["name"]), projects.MAX_PROJECT_NAME_LEN)
            if not name:
                raise UserError("project name is required")
            fields["name"] = name

        # Validate track existence + active status for newly assigned tracks.
        if "anchor_track_id" in fields:
            self._validate_project_track(fields["anchor_track_id"], "anchor_track_id")
        if "lead_track_id" in fields:
            self._validate_project_track(fields["lead_track_id"], "lead_track_id")

        # Validate variants against the track assigned to each role, checking
        # the *prospective* project as one atomic whole so a multi-field PATCH
        # can assign a track and its variant together or not at all.
        current = self._projects.get(project_id)  # 404s for unknown projects
        prospective_anchor = fields.get("anchor_track_id", current["anchor_track_id"])
        prospective_lead = fields.get("lead_track_id", current["lead_track_id"])
        anchor_variant = projects.validate_variant(
            fields.get("anchor_variant", current["anchor_variant"])
        )
        lead_variant = projects.validate_variant(
            fields.get("lead_variant", current["lead_variant"])
        )
        for role, tid, variant in (
            ("anchor", prospective_anchor, anchor_variant),
            ("lead", prospective_lead, lead_variant),
        ):
            if variant is None or variant == "full":
                continue
            if tid is None:
                raise UserError(f"{role}_variant '{variant}' requires an assigned {role} track")
            if not self._variant_available(self._track_content_hash(tid), variant):
                raise UserError(
                    f"stem variant '{variant}' is not available for the assigned {role} track"
                )
        if "anchor_variant" in fields:
            fields["anchor_variant"] = anchor_variant
        if "lead_variant" in fields:
            fields["lead_variant"] = lead_variant

        # Validate settings.
        if "settings" in fields:
            fields["settings"] = projects.validate_settings(fields["settings"])

        return self._projects.update(project_id, **fields)

    def delete_project(self, project_id: str) -> None:
        self._projects.delete(project_id)

    # ------------------------------------------------------------------
    # Job facade (delegates to JobStore / JobEngine)
    # ------------------------------------------------------------------

    def _job_api_dict(self, job: dict) -> dict:
        """Add the API-only ``audio_url`` derived from the internal output path.

        ``output_path`` itself is never exposed; only the route is.
        """
        output_path = self._store.get_output_path(job["id"])
        job["audio_url"] = f"/api/jobs/{job['id']}/audio" if output_path else None
        return job

    def get_job(self, job_id: str) -> dict:
        return self._job_api_dict(self._store.get(job_id))

    def list_jobs(self, limit: int = 20) -> list[dict]:
        jobs, _total = self._store.list(limit=limit)
        return [self._job_api_dict(job) for job in jobs]

    def list_jobs_page(
        self,
        *,
        limit: int = 50,
        offset: int = 0,
        status: str | None = None,
        kind: str | None = None,
    ) -> dict:
        """Paginated, filterable job listing for the Activity view.

        Returns ``{items, total, limit, offset}``. ``status`` and ``kind`` are
        optional filters (allowlisted against the job enums).
        """
        from .contracts import JobKind as _JobKind, JobStatus as _JobStatus

        limit = max(1, min(100, limit))
        offset = max(0, offset)
        status_filter = None
        kind_filter = None
        if status is not None:
            try:
                status_filter = _JobStatus(status)
            except ValueError:
                raise UserError(f"unknown job status: {status}")
        if kind is not None:
            try:
                kind_filter = _JobKind(kind)
            except ValueError:
                raise UserError(f"unknown job kind: {kind}")
        jobs, total = self._store.list(
            limit=limit, offset=offset, status=status_filter, kind=kind_filter,
        )
        return {
            "items": [self._job_api_dict(job) for job in jobs],
            "total": total,
            "limit": limit,
            "offset": offset,
        }

    def job_counts(self) -> dict:
        """Return active/queued job counts for the Engine view and nav badge."""
        from .contracts import ACTIVE_JOB_STATES, JobStatus

        with self._connect() as conn:
            rows = conn.execute(
                "SELECT status, COUNT(*) AS n FROM jobs GROUP BY status"
            ).fetchall()
        counts = {row["status"]: row["n"] for row in rows}
        active = sum(counts.get(s.value, 0) for s in ACTIVE_JOB_STATES)
        queued = counts.get(JobStatus.QUEUED.value, 0)
        running = counts.get(JobStatus.RUNNING.value, 0)
        return {
            "active": active,
            "queued": queued,
            "running": running,
            "by_status": counts,
        }

    def storage_usage(self) -> dict:
        """Return the total bytes under the managed data directory."""
        total = 0
        for path in self.data_dir.rglob("*"):
            try:
                if path.is_file():
                    total += path.stat().st_size
            except OSError:
                continue
        return {"data_dir": str(self.data_dir), "bytes": total}

    def health(self) -> dict:
        """Return backend-reported facts for the Engine view.

        Only genuinely available values are reported; nothing is invented.
        """
        import importlib.metadata as metadata
        import shutil as _shutil

        def _version(name: str) -> str | None:
            try:
                return metadata.version(name)
            except Exception:
                return None

        demucs_available = False
        try:
            import demucs.api  # noqa: F401
            demucs_available = True
        except Exception:
            pass

        return {
            "status": "ready",
            "version": __version__,
            "ffmpeg": bool(_shutil.which("ffmpeg")),
            "yt_dlp": bool(_shutil.which("yt-dlp")),
            "preferred_device": separator._pick_demucs_device(),
            "current_device": separator.demucs_device(),
            "demucs_available": demucs_available,
            "demucs_version": _version("demucs"),
            "torch_version": _version("torch"),
            "data_dir": str(self.data_dir),
            "queue": self.job_counts(),
            "storage": self.storage_usage(),
        }

    def job_output_path(self, job_id: str) -> Path:
        output_path = self._store.get_output_path(job_id)
        if output_path is None:
            raise UserError("render is not complete")
        path = Path(output_path)
        if not path.is_file() or self.render_dir.resolve() not in path.resolve().parents:
            raise UserError("render output is unavailable")
        return path

    # ------------------------------------------------------------------
    # Render orchestration
    # ------------------------------------------------------------------

    def plan_render(self, options: RenderOptions) -> dict:
        """Compute the exact arrangement plan a real render would execute.

        This is the single source of truth shared by ``POST /api/renders/plan``
        and ``_run_render``; the Frontend must not reimplement key or tempo
        math. It never queues a job, decodes media, runs Demucs, or writes
        output. Variants are resolved against completed, path-valid stem sets
        only; an unavailable variant is an error, never a silent fallback.
        """
        return self._compute_arrangement(options).to_api_dict()

    def _compute_arrangement(self, options: RenderOptions):
        """Internal shared planning result.

        Returns an ArrangementPlan exposing tempo_ratio, semitone_shift,
        duration, anchor_path, lead_path, and an API dict. Preview capping is
        applied here so the read-only plan matches the actual render.
        """
        options.validate()
        anchor = self.get_track(options.anchor_id)
        lead = self.get_track(options.lead_id)

        anchor_variant = options.anchor_variant or "full"
        lead_variant = options.resolved_lead_variant()

        # Resolve the concrete audio paths. A non-full variant must resolve to
        # a real, path-valid stem file; otherwise this raises (never silently
        # renders the full mix). This is the single source of truth for what
        # actually reaches MashSpec.
        anchor_path = self._resolve_stem_variant(options.anchor_id, anchor_variant)
        lead_path = self._resolve_stem_variant(options.lead_id, lead_variant)

        anchor_info = (
            self._stem_set_audio_info(
                self._track_content_hash(options.anchor_id), anchor_variant,
            )
            if anchor_variant != "full"
            else None
        )
        lead_info = (
            self._stem_set_audio_info(self._track_content_hash(options.lead_id), lead_variant)
            if lead_variant != "full"
            else None
        )
        if anchor_variant != "full" and anchor_info is None:
            raise UserError(f"stem variant '{anchor_variant}' is not available for this track")
        if lead_variant != "full" and lead_info is None:
            raise UserError(f"stem variant '{lead_variant}' is not available for this track")

        tempo_ratio = float(anchor["bpm"]) / float(lead["bpm"])
        anchor_key = f"{anchor['key']['tonic']} {anchor['key']['mode']}"
        lead_key = f"{lead['key']['tonic']} {lead['key']['mode']}"
        semitone_shift = (
            0 if options.pitch_mode == "preserve"
            else assembler.semitones_to_match(anchor_key, lead_key)
        )

        # Mirror build_mash's duration derivation from stored durations.
        anchor_available = float(anchor["duration"]) - options.anchor_start
        lead_available = (float(lead["duration"]) - options.lead_start) / tempo_ratio
        available = max(0.0, min(anchor_available, lead_available))
        requested = options.duration
        output_duration = requested if requested is not None else available
        # Cap to the available overlap so the plan reports exactly what the
        # renderer will produce (ffmpeg stops at the shorter source's EOF).
        if output_duration > available:
            output_duration = available
        # Preview duration cap is part of the shared plan so the read-only
        # endpoint shows exactly the same value the renderer will produce.
        if options.preview:
            if requested is None:
                output_duration = min(output_duration, 12.0)
            if output_duration > 20.0:
                output_duration = 20.0
        if output_duration <= 0:
            raise UserError("requested mash duration is zero or negative")

        bpm_change_percent = (tempo_ratio - 1.0) * 100.0

        warnings: list[str] = []

        def _almost_int(value: float, tolerance: float = 0.05) -> bool:
            return abs(value - round(value)) <= tolerance

        ratio_label: str
        if _almost_int(tempo_ratio) and round(tempo_ratio) >= 2:
            n = int(round(tempo_ratio))
            ratio_label = f"{n}:1"
            warnings.append(
                f"The lead is at {ratio_label} tempo ratio to the foundation "
                "and will be heavily time-stretched; expect audible artifacts."
            )
        elif _almost_int(1.0 / tempo_ratio) and round(1.0 / tempo_ratio) >= 2:
            n = int(round(1.0 / tempo_ratio))
            ratio_label = f"1:{n}"
            warnings.append(
                f"The lead is at a {ratio_label} tempo ratio to the foundation "
                "and will be heavily time-stretched; expect audible artifacts."
            )
        elif not (0.5 <= tempo_ratio <= 2.0):
            warnings.append(
                "The tempo ratio is outside ffmpeg's comfortable 0.5–2.0 range; "
                "a chained stretch will be used."
            )

        if requested is not None and requested > available + 1e-6:
            warnings.append(
                "Requested duration exceeds the available overlap; the output "
                "will end with the shorter source region."
            )
        if abs(semitone_shift) >= 4:
            warnings.append(
                f"A {semitone_shift:+d}-semitone shift is large; expect audible "
                f"pitch artifacts on the lead."
            )
        if options.pitch_mode == "preserve":
            warnings.append(
                "Pitch is preserved: the lead keeps its original key even if it "
                "clashes with the foundation."
            )
        if lead_variant in {"center", "sides"}:
            warnings.append(
                f"The lead uses the '{lead_variant}' center/side transform, not "
                "an isolated stem; residual content is expected."
            )
        if anchor_variant in {"center", "sides"}:
            warnings.append(
                f"The foundation uses the '{anchor_variant}' center/side "
                "transform, not an isolated stem."
            )

        def _source(track: dict, variant: str, info) -> dict:
            return {
                "track_id": track["id"],
                "variant": variant,
                "name": variant,
                "method": info[1] if info else None,
                "model_name": info[2] if info else None,
                "device": info[3] if info else None,
                "stem_set_id": info[0] if info else None,
            }

        api_dict = {
            "tempo_ratio": round(tempo_ratio, 4),
            "bpm_change_percent": round(bpm_change_percent, 2),
            "semitone_shift": semitone_shift,
            "effective_bpm": {"anchor": anchor["bpm"], "lead": lead["bpm"]},
            "effective_keys": {"anchor": anchor["key"], "lead": lead["key"]},
            "anchor_variant": anchor_variant,
            "lead_variant": lead_variant,
            "pitch_mode": options.pitch_mode,
            "selected_sources": {
                "anchor": _source(anchor, anchor_variant, anchor_info),
                "lead": _source(lead, lead_variant, lead_info),
            },
            "duration": {
                "requested": requested,
                "available": round(available, 3),
                "output": round(output_duration, 3),
            },
            # Backward-compatible alias used by older frontends.
            "output_duration": round(output_duration, 3),
            "warnings": warnings,
        }

        class ArrangementPlan:
            __slots__ = (
                "tempo_ratio", "semitone_shift", "output_duration", "duration",
                "anchor_path", "lead_path", "anchor_start", "lead_start",
                "anchor_gain", "lead_gain", "pitch_mode", "api_dict",
            )

            def __init__(self):
                self.tempo_ratio = tempo_ratio
                self.semitone_shift = semitone_shift
                self.output_duration = output_duration
                self.duration = output_duration
                self.anchor_path = anchor_path
                self.lead_path = lead_path
                self.anchor_start = options.anchor_start
                self.lead_start = options.lead_start
                self.anchor_gain = options.anchor_gain
                self.lead_gain = options.lead_gain
                self.pitch_mode = options.pitch_mode
                self.api_dict = api_dict

            def to_api_dict(self) -> dict:
                return self.api_dict

        return ArrangementPlan()

    def _run_render(
        self,
        job_id: str,
        token: CancellationToken,
        options: RenderOptions,
    ) -> dict:
        """Perform a render; returns the engine result payload."""
        self._store.update(
            job_id, stage="planning", progress=8,
            message="Reading tempo, key and arrangement settings",
        )
        token.raise_if_cancelled()

        # Legacy use_vocals: true triggers separation through the cache (reusing
        # any existing stem set) rather than a second unmanaged Demucs path.
        # This must run BEFORE planning, because planning now resolves the
        # concrete stem path and would otherwise fail when vocals are not yet
        # cached.
        if options.use_vocals and options.resolved_lead_variant() == "vocals":
            self._ensure_stem_variant(options.lead_id, "vocals", job_id, token)

        # Single source of truth: planning handles tempo, key, duration, and
        # stem variant resolution (including the concrete audio paths).
        plan = self._compute_arrangement(options)

        anchor_path = plan.anchor_path
        lead_path = plan.lead_path
        tempo_ratio = plan.tempo_ratio
        semitone_shift = plan.semitone_shift
        duration = plan.output_duration

        self._store.update(
            job_id, stage="rendering", progress=58,
            message="Aligning tempo and key, then shaping the final mix",
        )
        token.raise_if_cancelled()

        output_path = self.render_dir / f"{job_id}.mp3"
        spec = assembler.MashSpec(
            anchor_path=anchor_path,
            lead_path=lead_path,
            anchor_gain=plan.anchor_gain,
            lead_gain=plan.lead_gain,
            anchor_start=plan.anchor_start,
            lead_start=plan.lead_start,
            duration=duration,
        )
        assembler.build_mash(spec, tempo_ratio, semitone_shift, str(output_path))
        peak = assembler.measure_clipping(str(output_path))
        result = {
            "tempo_ratio": round(tempo_ratio, 4),
            "semitone_shift": semitone_shift,
            "duration": assembler._ffprobe_duration(str(output_path)),
            "true_peak_db": peak.get("true_peak_db"),
            "anchor_variant": options.anchor_variant or "full",
            "lead_variant": options.resolved_lead_variant(),
            "pitch_mode": options.pitch_mode,
        }
        return {
            "result": result,
            "output_path": str(output_path),
            "message": "Your preview is ready" if options.preview else "Your mashup is ready",
        }

    def _render_run_fn(self, options: RenderOptions):
        def run(job_id: str, token: CancellationToken) -> dict:
            return self._run_render(job_id, token, options)
        return run

    def submit_render(self, options: RenderOptions) -> dict:
        if self._closed:
            raise UserError("studio service is closed")
        options.validate()
        self.get_track(options.anchor_id)
        self.get_track(options.lead_id)
        kind = JobKind.PREVIEW if options.preview else JobKind.RENDER
        job = self._engine.submit(
            kind, asdict(options), self._render_run_fn(options), executor="audio",
        )
        return self.get_job(job["id"])

    def retry_job(self, job_id: str) -> dict:
        """Retry a failed/interrupted/cancelled job by cloning its request.

        Import jobs resume from the same ``work_key`` (partial download); render
        jobs re-run from scratch.
        """
        if self._closed:
            raise UserError("studio service is closed")
        job = self._store.get(job_id)
        kind = JobKind(job["kind"])
        if kind == JobKind.IMPORT:
            new_job = self._engine.retry(job_id, self._import_run_fn(job["request"]))
        elif kind in {JobKind.PREVIEW, JobKind.RENDER}:
            options = RenderOptions(**job["request"])
            new_job = self._engine.retry(job_id, self._render_run_fn(options))
        else:
            raise UserError(f"retry is not yet supported for {kind.value} jobs")
        return self.get_job(new_job["id"])

    def cancel_job(self, job_id: str) -> dict:
        if self._closed:
            raise UserError("studio service is closed")
        job = self._engine.cancel(job_id)
        return self._job_api_dict(job)

    # ------------------------------------------------------------------
    # Import orchestration (asynchronous acquisition)
    # ------------------------------------------------------------------

    @staticmethod
    def _work_key(url: str) -> str:
        """Stable, relative work key for a canonical URL (resolves under incoming/)."""
        return hashlib.sha256(url.strip().encode("utf-8")).hexdigest()[:20]

    def _import_run_fn(self, request: dict):
        def run(job_id: str, token: CancellationToken) -> dict:
            return self._run_import(job_id, token, request)
        return run

    def _run_import(
        self,
        job_id: str,
        token: CancellationToken,
        request: dict,
    ) -> dict:
        """Perform an asynchronous import (YouTube download or upload analysis)."""
        source_kind = request.get("source_kind", "youtube")
        if source_kind == "youtube":
            url = request["canonical_url"]
            work_key = request.get("work_key") or self._work_key(url)
            work_dir = self.incoming_dir / work_key
            work_dir.mkdir(parents=True, exist_ok=True)

            self._store.update(
                job_id, stage="downloading", progress=5,
                message="Downloading audio",
            )

            def on_progress(detail: dict) -> None:
                percent = detail.get("percent")
                fields: dict = {
                    "progress_detail": {
                        "stage": "downloading",
                        "percent": percent,
                        "bytes": detail.get("bytes"),
                        "total_bytes": detail.get("total_bytes"),
                        "speed": detail.get("speed"),
                        "eta": detail.get("eta"),
                        "measured": percent is not None,
                    },
                }
                if percent is not None:
                    fields["progress"] = int(percent)
                self._store.update(job_id, **fields)

            from . import acquisition
            from .jobs import JobCancelled
            result = acquisition.download_youtube(
                url, work_dir, token=token, on_progress=on_progress,
            )
            if result.cancelled:
                raise JobCancelled()
            if result.returncode != 0:
                detail = media.sanitize_text(result.stderr_tail[-400:], 400)
                raise UserError(
                    f"download failed: {detail or 'yt-dlp exited unsuccessfully'}"
                )

            # Resolve the downloaded artifact from an explicit, validated path.
            video_id = sources.canonicalize_youtube_url(url).rsplit("=", 1)[-1]
            downloaded = self._resolve_downloaded_audio(work_dir, video_id)
            if downloaded is None:
                raise UserError("download completed but no audio file was produced")

            # Read the controlled .info.json sidecar and sanitize its metadata.
            metadata = self._read_info_json(work_dir, video_id)

            # Resolve the exact video-ID thumbnail (image-extension allowlist).
            thumbnail = self._resolve_thumbnail(work_dir, video_id)

            self._store.update(
                job_id, stage="analyzing", progress=80,
                message="Analyzing tempo, key and beat grid",
            )
            token.raise_if_cancelled()
            track = self.ingest_path(
                downloaded, source_kind="youtube", source_ref=url,
                metadata=metadata, artwork_source=thumbnail,
            )
            # Clean staging only after successful managed ingestion.
            shutil.rmtree(work_dir, ignore_errors=True)
            return {
                "result": {"track_id": track["id"], "name": track["name"]},
                "message": "Import complete",
            }

        if source_kind == "upload":
            # Uploads are staged by the HTTP layer under an opaque key; resolve
            # and containment-check it server-side.
            staging_key = request.get("staging_key")
            if not staging_key:
                raise UserError("upload import requires a staging key")
            staged_path = self._resolve_staging_key(staging_key)
            original_name = request.get("original_name") or staged_path.name
            self._store.update(
                job_id, stage="analyzing", progress=50,
                message="Analyzing tempo, key and beat grid",
            )
            token.raise_if_cancelled()
            with staged_path.open("rb") as source:
                track = self.ingest(
                    source, original_name, source_kind="upload",
                )
            staged_path.unlink(missing_ok=True)
            return {
                "result": {"track_id": track["id"], "name": track["name"]},
                "message": "Import complete",
            }

        raise UserError(f"unknown import source: {source_kind}")

    def _resolve_downloaded_audio(self, work_dir: Path, video_id: str) -> Path | None:
        """Resolve the downloaded artifact by its explicit ID-based name.

        yt-dlp writes ``<video_id>.<ext>`` (with ``--continue`` it may leave a
        ``.part``). We look for the exact ID-based file, not "first matching
        extension in the directory".
        """
        for suffix in ALLOWED_AUDIO_SUFFIXES:
            candidate = work_dir / f"{video_id}{suffix}"
            if candidate.is_symlink() or not candidate.is_file():
                continue
            if candidate.stat().st_size > MAX_UPLOAD_BYTES:
                candidate.unlink(missing_ok=True)
                raise PayloadTooLargeError("downloaded audio exceeds the 750 MB library limit")
            if candidate.stat().st_size > 0:
                return candidate
        return None

    def _read_info_json(self, work_dir: Path, video_id: str) -> dict | None:
        """Read and sanitize the controlled ``.info.json`` sidecar, if present."""
        info_path = work_dir / f"{video_id}.info.json"
        if info_path.is_symlink() or not info_path.is_file():
            return None
        if info_path.stat().st_size > 2 * 1024 * 1024:
            return None
        try:
            raw = json.loads(info_path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return None
        return media.sanitize_metadata(raw)

    # Image extensions yt-dlp may write a thumbnail as (allowlist only).
    _THUMBNAIL_SUFFIXES = (".webp", ".jpg", ".jpeg", ".png")

    def _resolve_thumbnail(self, work_dir: Path, video_id: str) -> Path | None:
        """Resolve the exact video-ID thumbnail file, if present.

        Only the exact ``<video_id>.<image-ext>`` file is accepted, with an
        image-extension allowlist. Symlinks and non-regular files are rejected.
        The caller re-encodes it to a normalized WebP and cleans the untrusted
        source after conversion.
        """
        for suffix in self._THUMBNAIL_SUFFIXES:
            candidate = work_dir / f"{video_id}{suffix}"
            if candidate.is_symlink() or not candidate.is_file():
                continue
            if candidate.stat().st_size > media.MAX_ARTWORK_INPUT_BYTES:
                continue
            return candidate
        return None

    def _resolve_staging_key(self, staging_key: str) -> Path:
        """Resolve an opaque staging key to a path beneath ``incoming/``.

        The key is a bare filename (never a path); any traversal or escape is
        rejected.
        """
        if Path(staging_key).name != staging_key or "/" in staging_key or "\\" in staging_key:
            raise UserError("invalid staging key")
        return media.validate_managed_path(self.incoming_dir / staging_key, self.incoming_dir)

    def submit_youtube_import(self, url: str) -> dict:
        """Queue an asynchronous YouTube import and return the job snapshot."""
        if self._closed:
            raise UserError("studio service is closed")
        canonical = sources.canonicalize_youtube_url(url)
        request = {
            "source_kind": "youtube",
            "canonical_url": canonical,
            "work_key": self._work_key(canonical),
        }
        job = self._engine.submit(
            JobKind.IMPORT, request, self._import_run_fn(request), executor="acquisition",
        )
        return self.get_job(job["id"])

    def submit_upload_import(self, staging_key: str, original_name: str | None = None) -> dict:
        """Queue an asynchronous upload import for an already-staged file.

        ``staging_key`` is an opaque bare filename (never a path); the original
        upload name is preserved (sanitized) for the track's display name.
        """
        if self._closed:
            raise UserError("studio service is closed")
        self._resolve_staging_key(staging_key)  # validate up front
        request = {
            "source_kind": "upload",
            "staging_key": staging_key,
            "original_name": original_name,
        }
        job = self._engine.submit(
            JobKind.IMPORT, request, self._import_run_fn(request), executor="acquisition",
        )
        return self.get_job(job["id"])

    def stage_upload(self, source: BinaryIO, original_name: str) -> str:
        """Stage an uploaded file beneath ``incoming/`` and return its opaque key.

        Enforces the 750 MB ceiling and a safe, ID-based filename (never the
        uploader's name). Returns the bare staging key (filename only).
        """
        suffix = Path(original_name).suffix.lower()
        if suffix not in ALLOWED_AUDIO_SUFFIXES:
            supported = ", ".join(sorted(ALLOWED_AUDIO_SUFFIXES))
            raise UserError(f"unsupported audio type '{suffix or 'none'}'; choose one of: {supported}")
        staged_id = uuid.uuid4().hex
        staged = self.incoming_dir / f"{staged_id}{suffix}"
        size = 0
        try:
            with staged.open("xb") as output:
                while chunk := source.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        raise PayloadTooLargeError("audio file exceeds the 750 MB local upload limit")
                    output.write(chunk)
            if size == 0:
                raise UserError("uploaded file is empty")
        except Exception:
            staged.unlink(missing_ok=True)
            raise
        return staged.name

    def wait_for_job(self, job_id: str, timeout: float = 60.0) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            job = self.get_job(job_id)
            if job["status"] in {s.value for s in TERMINAL_JOB_STATES}:
                return job
            time.sleep(0.05)
        raise TimeoutError(f"job {job_id} did not finish within {timeout}s")

    # ------------------------------------------------------------------
    # Separation jobs and stem cache
    # ------------------------------------------------------------------

    def _track_content_hash(self, track_id: str) -> str:
        row = self._get_track_row(track_id)
        return row["content_sha256"]

    def _resolve_separation_method(self, method: str) -> tuple[str, str]:
        """Resolve ``auto`` to a concrete (method, model_name) pair.

        Returns ``(method, model_name)`` where method is ``demucs`` or
        ``ffmpeg`` and model_name is a stable, version-sensitive string.
        """
        if method == "auto":
            try:
                import demucs.api  # noqa: F401
                return "demucs", separator.demucs_model_name()
            except Exception:
                return "ffmpeg", separator.center_side_model_name()
        if method == "demucs":
            return "demucs", separator.demucs_model_name()
        if method == "ffmpeg":
            return "ffmpeg", separator.center_side_model_name()
        raise UserError(f"unknown separation method: {method}")

    def _find_cached_stem_set(
        self, track_sha256: str, method: str, model_name: str
    ) -> dict | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM stem_sets WHERE track_sha256 = ? AND method = ?"
                " AND model_name = ? AND status = 'complete' ORDER BY created_at DESC LIMIT 1",
                (track_sha256, method, model_name),
            ).fetchone()
        if row is None:
            return None
        return self._stem_set_dict(row)

    @staticmethod
    def _stem_set_dict(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "track_id": row["track_id"],
            "method": row["method"],
            "model": row["model_name"],
            "device": row["device"],
            "status": row["status"],
            "stems": json.loads(row["paths_json"]) if row["paths_json"] else {},
            "created_at": row["created_at"],
        }

    def _run_separation(
        self, job_id: str, token: CancellationToken, request: dict
    ) -> dict:
        track_id = request["track_id"]
        method = request.get("method", "auto")
        track_path = self.track_path(track_id)
        track_sha256 = self._track_content_hash(track_id)

        concrete_method, model_name = self._resolve_separation_method(method)

        # Cache hit: reuse without invoking Demucs/ffmpeg.
        cached = self._find_cached_stem_set(track_sha256, concrete_method, model_name)
        if cached is not None:
            return {
                "result": {"stem_set_id": cached["id"], "cached": True},
                "message": "Separation already cached",
            }

        self._store.update(
            job_id, stage="separating", progress=20,
            message="Separating stems",
        )
        token.raise_if_cancelled()

        # Build in a temp dir under the managed root (same filesystem), then
        # atomically finalize under stems/.
        temp_dir = self.temp_dir / job_id
        temp_dir.mkdir(parents=True, exist_ok=True)

        oom_warning = {"fired": False}

        def on_oom() -> None:
            oom_warning["fired"] = True
            self._store.update(
                job_id,
                progress_detail={
                    "stage": "separating",
                    "warning": "GPU Memory Limit Reached - Falling back to CPU (This will take longer).",
                },
            )

        try:
            stems = separator.separate(
                str(track_path), temp_dir, method=concrete_method, on_oom=on_oom,
            )
        except UserError as exc:
            shutil.rmtree(temp_dir, ignore_errors=True)
            raise

        # Validate every advertised stem: reject symlinks, unexpected names,
        # empty files, and paths outside the staging root; then run a genuine
        # ffmpeg decode check so truncated/corrupt output is refused.
        for name, stem_path in stems.items():
            stem_path = Path(stem_path)
            if name not in separator._STEM_NAMES and name not in {"center", "sides"}:
                shutil.rmtree(temp_dir, ignore_errors=True)
                raise UserError(f"unexpected stem name: {name}")
            if stem_path.is_symlink() or not stem_path.is_file():
                shutil.rmtree(temp_dir, ignore_errors=True)
                raise UserError(f"separation produced no file for stem: {name}")
            if stem_path.stat().st_size == 0:
                shutil.rmtree(temp_dir, ignore_errors=True)
                raise UserError(f"separation produced an empty stem: {name}")
            try:
                stem_path.resolve(strict=True)
            except (OSError, RuntimeError):
                shutil.rmtree(temp_dir, ignore_errors=True)
                raise UserError(f"stem path is unavailable: {name}")
            if temp_dir.resolve() not in stem_path.resolve().parents:
                shutil.rmtree(temp_dir, ignore_errors=True)
                raise UserError(f"stem path escapes the staging root: {name}")
            if not media.validate_audio_decodes(stem_path):
                shutil.rmtree(temp_dir, ignore_errors=True)
                raise UserError(f"stem failed decode validation: {name}")

        # Poll cancellation after separation and before finalization.
        token.raise_if_cancelled()

        # Build the complete layout in a staging directory on the stems
        # filesystem, then atomically rename it into place. The destination is
        # never pre-created, so a crash cannot leave a visible partial dir.
        stem_set_id = uuid.uuid4().hex
        staging_dir = self.stem_dir / f".tmp_{stem_set_id}"
        staging_dir.mkdir(parents=True, exist_ok=False)
        relative_paths: dict[str, str] = {}
        try:
            for name, stem_path in stems.items():
                final_path = staging_dir / f"{name}.wav"
                Path(stem_path).replace(final_path)
                relative_paths[name] = f"stems/{stem_set_id}/{name}.wav"
        except Exception:
            shutil.rmtree(staging_dir, ignore_errors=True)
            shutil.rmtree(temp_dir, ignore_errors=True)
            raise

        final_dir = self.stem_dir / stem_set_id
        try:
            os.replace(staging_dir, final_dir)
        except Exception:
            shutil.rmtree(staging_dir, ignore_errors=True)
            shutil.rmtree(temp_dir, ignore_errors=True)
            raise
        shutil.rmtree(temp_dir, ignore_errors=True)

        device = separator.demucs_device() if concrete_method == "demucs" else "cpu"
        now = time.time()
        try:
            with self._connect() as conn:
                conn.execute(
                    """INSERT INTO stem_sets
                       (id, track_id, method, model, device, status, paths_json,
                        track_sha256, model_name, created_at)
                       VALUES (?, ?, ?, ?, ?, 'complete', ?, ?, ?, ?)""",
                    (
                        stem_set_id, track_id, concrete_method, model_name, device,
                        json.dumps(relative_paths), track_sha256, model_name, now,
                    ),
                )
        except sqlite3.IntegrityError:
            # A concurrent identical separation won; reuse it and clean up.
            shutil.rmtree(final_dir, ignore_errors=True)
            winner = self._find_cached_stem_set(track_sha256, concrete_method, model_name)
            if winner is None:
                raise UserError("concurrent separation lost but no cache row exists")
            return {
                "result": {"stem_set_id": winner["id"], "cached": True},
                "message": "Separation already cached",
            }

        return {
            "result": {
                "stem_set_id": stem_set_id,
                "cached": False,
                "device": device,
                "stems": sorted(relative_paths.keys()),
            },
            "message": "Separation complete",
        }

    def _separation_run_fn(self, request: dict):
        def run(job_id: str, token: CancellationToken) -> dict:
            return self._run_separation(job_id, token, request)
        return run

    def submit_separation(self, track_id: str, method: str = "auto") -> dict:
        if self._closed:
            raise UserError("studio service is closed")
        self.get_track(track_id)
        if method not in {"auto", "demucs", "ffmpeg"}:
            raise UserError(f"unknown separation method: {method}")
        # Explicit demucs without the capability -> 503 (never silently claim an
        # ffmpeg center channel is a vocal).
        if method == "demucs":
            try:
                import demucs.api  # noqa: F401
            except Exception:
                raise CapabilityError(
                    "Demucs is not installed; vocal/drums/bass/other separation is unavailable"
                )
        request = {"track_id": track_id, "method": method}
        job = self._engine.submit(
            JobKind.SEPARATE, request, self._separation_run_fn(request), executor="audio",
        )
        return self.get_job(job["id"])

    def _validated_stem_path(self, rel: str) -> Path | None:
        """Return the resolved stem file if ``rel`` is playable under stems/.

        ``rel`` is a database-stored path relative to the data root (e.g.
        ``stems/<id>/<name>.wav``). It is only accepted when it resolves to a
        real file beneath the dedicated ``stems/`` root — never the broad data
        root — so a corrupt row pointing at ``tracks/...`` cannot be advertised
        as a playable stem.
        """
        if not rel:
            return None
        try:
            resolved = media.validate_managed_path(self.data_dir / rel, self.stem_dir)
        except UserError:
            return None
        if not resolved.is_file():
            return None
        return resolved

    def _variant_available(self, track_sha256: str, variant: str) -> bool:
        """True when a completed stem set provides a playable ``variant`` file."""
        try:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT paths_json FROM stem_sets WHERE track_sha256 = ? AND status = 'complete'",
                    (track_sha256,),
                ).fetchall()
        except sqlite3.Error:
            return False
        for row in rows:
            paths = json.loads(row["paths_json"]) if row["paths_json"] else {}
            rel = paths.get(variant)
            if rel is None:
                continue
            if self._validated_stem_path(rel) is not None:
                return True
        return False

    def _stem_set_audio_info(
        self, track_sha256: str, variant: str
    ) -> tuple[str, str, str, str | None] | None:
        """Return (stem_set_id, method, model_name, device) for a variant."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM stem_sets WHERE track_sha256 = ? AND status = 'complete'"
                " ORDER BY created_at DESC",
                (track_sha256,),
            ).fetchall()
        for row in rows:
            paths = json.loads(row["paths_json"]) if row["paths_json"] else {}
            rel = paths.get(variant)
            if rel is None:
                continue
            if self._validated_stem_path(rel) is not None:
                return (row["id"], row["method"], row["model_name"], row["device"])
        return None

    def list_stems(self, track_id: str) -> dict:
        """List truthful available stems for a track.

        ``full`` always exists for a valid track. Other variants exist only when
        a completed, path-valid stem set provides them. Responses never contain
        absolute filesystem paths; the audio route is server-authored.

        Returns the backward-compatible top-level ``stems: [name, ...]`` alias
        plus structured ``variants`` entries with ``name``, ``stem_set_id``,
        ``method``, ``model_name``, ``device``, and a playable ``audio_url``.
        The structured entries re-validate files on every call, so a cached
        stem set stays playable after a server restart without any remembered
        in-process job result.
        """
        self.get_track(track_id)
        track_sha256 = self._track_content_hash(track_id)
        available: dict[str, bool] = {}
        order: list[str] = []
        variants: list[dict] = [
            {
                "name": "full",
                "stem_set_id": None,
                "method": None,
                "model_name": None,
                "device": None,
                "audio_url": f"/api/tracks/{track_id}/audio",
            }
        ]
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM stem_sets WHERE track_sha256 = ? AND status = 'complete'"
                " ORDER BY created_at DESC",
                (track_sha256,),
            ).fetchall()
        for row in rows:
            paths = json.loads(row["paths_json"]) if row["paths_json"] else {}
            for name, rel in paths.items():
                if self._validated_stem_path(rel) is None:
                    continue
                available[name] = True
                if name in order:
                    continue
                order.append(name)
                variants.append(
                    {
                        "name": name,
                        "stem_set_id": row["id"],
                        "method": row["method"],
                        "model_name": row["model_name"],
                        "device": row["device"],
                        "audio_url": (
                            f"/api/stems/{row['id']}/audio?name={name}"
                        ),
                    }
                )
        stems = sorted({"full", *available.keys()})
        variants.sort(key=lambda v: stems.index(v["name"]))
        return {"track_id": track_id, "stems": stems, "variants": variants}

    def stem_audio_path(self, stem_set_id: str, name: str) -> Path:
        """Resolve a stem's audio path via strict stem-set/name lookup.

        Never accepts filesystem paths from the request. Refuses corrupt or
        traversal-containing database paths.
        """
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM stem_sets WHERE id = ?", (stem_set_id,)
            ).fetchone()
        if row is None:
            raise UserError(f"unknown stem set: {stem_set_id}")
        paths = json.loads(row["paths_json"]) if row["paths_json"] else {}
        rel = paths.get(name)
        if rel is None:
            raise UserError(f"stem '{name}' not found in stem set {stem_set_id}")
        # Validate the stored path is a bare relative path under stems/ whose
        # filename matches the requested stem name (plus a known extension).
        if Path(rel).stem != name:
            raise UserError(f"corrupt stem path for '{name}'")
        path = self.data_dir / rel
        try:
            resolved = path.resolve(strict=True)
        except (OSError, RuntimeError):
            raise UserError(f"stem media is unavailable: {name}")
        if self.stem_dir.resolve() not in resolved.parents:
            raise UserError(f"stem path escapes the managed root: {name}")
        return resolved

    def _resolve_stem_variant(self, track_id: str, variant: str | None) -> Path:
        """Resolve a requested stem variant to a concrete audio path.

        ``None``/``full`` returns the full track. Other variants must be backed
        by a completed, path-valid stem set; otherwise a clear conflict is
        raised (never silently render the full mix).
        """
        if variant is None or variant == "full":
            return self.track_path(track_id)
        track_sha256 = self._track_content_hash(track_id)
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM stem_sets WHERE track_sha256 = ? AND status = 'complete'",
                (track_sha256,),
            ).fetchall()
        for row in rows:
            paths = json.loads(row["paths_json"]) if row["paths_json"] else {}
            rel = paths.get(variant)
            if rel is not None:
                resolved = self._validated_stem_path(rel)
                if resolved is not None:
                    return resolved
        raise UserError(f"stem variant '{variant}' is not available for this track")

    def _ensure_stem_variant(
        self, track_id: str, variant: str, job_id: str, token: CancellationToken
    ) -> None:
        """Ensure a stem variant exists, separating on demand (legacy use_vocals).

        Reuses the stem cache; only separates if no completed, path-valid stem
        set provides the variant. Runs synchronously within the render job.
        """
        try:
            self._resolve_stem_variant(track_id, variant)
            return  # already cached
        except UserError:
            pass

        self._store.update(
            job_id, stage="separating", progress=18,
            message="Separating the lead vocal with Demucs",
        )
        token.raise_if_cancelled()
        # Run separation inline (reusing the cache path) and wait for it.
        request = {"track_id": track_id, "method": "auto"}
        self._run_separation(job_id, token, request)

    def close(self) -> None:
        if not self._closed:
            self._engine.shutdown(wait=True)
            self._closed = True

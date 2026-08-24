"""Local-first service and job layer for 2become1 Studio.

The CLI and web app share this module instead of wrapping one another.  It owns
safe media ingestion, persistent project metadata, and the single render queue
that protects a laptop GPU from concurrent Demucs jobs.
"""

from __future__ import annotations

import json
import math
import sqlite3
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import BinaryIO

from . import analyzer, assembler, beatgrid, separator
from .common import UserError


ALLOWED_AUDIO_SUFFIXES = {
    ".aac", ".aiff", ".alac", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav",
}
MAX_UPLOAD_BYTES = 750 * 1024 * 1024


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


class StudioService:
    """Persistent local studio with a deliberately single-worker render queue."""

    def __init__(self, data_dir: str | Path | None = None):
        self.data_dir = Path(data_dir) if data_dir else default_data_dir()
        self.track_dir = self.data_dir / "tracks"
        self.render_dir = self.data_dir / "renders"
        self.stem_dir = self.data_dir / "stems"
        self.db_path = self.data_dir / "studio.sqlite3"
        for directory in (self.data_dir, self.track_dir, self.render_dir, self.stem_dir):
            directory.mkdir(parents=True, exist_ok=True)
        self._init_db()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="2become1-render")
        self._closed = False

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
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
            columns = {row[1] for row in conn.execute("PRAGMA table_info(tracks)")}
            for name in ("beat_interval", "first_beat", "suggested_downbeat", "beat_confidence"):
                if name not in columns:
                    conn.execute(f"ALTER TABLE tracks ADD COLUMN {name} REAL")
            conn.execute(
                """UPDATE jobs
                   SET status = 'failed', stage = 'failed', progress = 100,
                       message = 'Render interrupted by a Studio restart',
                       error = 'Studio stopped before this render completed', updated_at = ?
                   WHERE status IN ('queued', 'running')""",
                (time.time(),),
            )

    @staticmethod
    def _track_dict(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "name": row["original_name"],
            "size_bytes": row["size_bytes"],
            "bpm": row["bpm"],
            "key": {
                "tonic": row["tonic"],
                "mode": row["mode"],
                "confidence": row["confidence"],
            },
            "duration": row["duration"],
            "beat_grid": {
                "interval": row["beat_interval"],
                "first_beat": row["first_beat"],
                "suggested_downbeat": row["suggested_downbeat"],
                "confidence": row["beat_confidence"],
            },
            "created_at": row["created_at"],
            "audio_url": f"/api/tracks/{row['id']}/audio",
        }

    def ingest(self, source: BinaryIO, original_name: str) -> dict:
        suffix = Path(original_name).suffix.lower()
        if suffix not in ALLOWED_AUDIO_SUFFIXES:
            supported = ", ".join(sorted(ALLOWED_AUDIO_SUFFIXES))
            raise UserError(f"unsupported audio type '{suffix or 'none'}'; choose one of: {supported}")

        track_id = uuid.uuid4().hex
        destination = self.track_dir / f"{track_id}{suffix}"
        size = 0
        try:
            with destination.open("xb") as output:
                while chunk := source.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        raise UserError("audio file exceeds the 750 MB local upload limit")
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

        now = time.time()
        with self._connect() as conn:
            conn.execute(
                """INSERT INTO tracks
                   (id, original_name, path, size_bytes, bpm, tonic, mode, confidence, duration,
                    beat_interval, first_beat, suggested_downbeat, beat_confidence, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    track_id, Path(original_name).name, str(destination), size,
                    float(result.bpm), result.key["tonic"], result.key["mode"],
                    float(result.key["confidence"]), float(result.duration),
                    grid.beat_interval if grid else None,
                    grid.first_beat if grid else None,
                    grid.suggested_downbeat if grid else None,
                    grid.confidence if grid else None,
                    now,
                ),
            )
        return self.get_track(track_id)

    def get_track(self, track_id: str) -> dict:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
        if row is None:
            raise UserError(f"unknown track: {track_id}")
        return self._track_dict(row)

    def track_path(self, track_id: str) -> Path:
        with self._connect() as conn:
            row = conn.execute("SELECT path FROM tracks WHERE id = ?", (track_id,)).fetchone()
        if row is None:
            raise UserError(f"unknown track: {track_id}")
        path = Path(row["path"])
        if not path.is_file() or self.track_dir.resolve() not in path.resolve().parents:
            raise UserError(f"track media is unavailable: {track_id}")
        return path

    def list_tracks(self, limit: int = 40) -> list[dict]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM tracks ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [self._track_dict(row) for row in rows]

    @staticmethod
    def _job_dict(row: sqlite3.Row) -> dict:
        result = json.loads(row["result_json"]) if row["result_json"] else None
        return {
            "id": row["id"],
            "kind": row["kind"],
            "status": row["status"],
            "stage": row["stage"],
            "progress": row["progress"],
            "message": row["message"],
            "request": json.loads(row["request_json"]),
            "result": result,
            "error": row["error"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "audio_url": f"/api/jobs/{row['id']}/audio" if row["output_path"] else None,
        }

    def get_job(self, job_id: str) -> dict:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            raise UserError(f"unknown job: {job_id}")
        return self._job_dict(row)

    def job_output_path(self, job_id: str) -> Path:
        with self._connect() as conn:
            row = conn.execute("SELECT output_path, status FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            raise UserError(f"unknown job: {job_id}")
        if row["status"] != "complete" or not row["output_path"]:
            raise UserError("render is not complete")
        path = Path(row["output_path"])
        if not path.is_file() or self.render_dir.resolve() not in path.resolve().parents:
            raise UserError("render output is unavailable")
        return path

    def list_jobs(self, limit: int = 20) -> list[dict]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [self._job_dict(row) for row in rows]

    def _update_job(self, job_id: str, **fields: object) -> None:
        if not fields:
            return
        fields["updated_at"] = time.time()
        assignments = ", ".join(f"{name} = ?" for name in fields)
        values = list(fields.values()) + [job_id]
        with self._connect() as conn:
            conn.execute(f"UPDATE jobs SET {assignments} WHERE id = ?", values)

    def submit_render(self, options: RenderOptions) -> dict:
        if self._closed:
            raise UserError("studio service is closed")
        options.validate()
        self.get_track(options.anchor_id)
        self.get_track(options.lead_id)
        job_id = uuid.uuid4().hex
        now = time.time()
        payload = asdict(options)
        with self._connect() as conn:
            conn.execute(
                """INSERT INTO jobs
                   (id, kind, status, stage, progress, message, request_json,
                    result_json, output_path, error, created_at, updated_at)
                   VALUES (?, ?, 'queued', 'queued', 0, 'Waiting for the render engine', ?,
                           NULL, NULL, NULL, ?, ?)""",
                (job_id, "preview" if options.preview else "render", json.dumps(payload), now, now),
            )
        self._executor.submit(self._run_render, job_id, options)
        return self.get_job(job_id)

    def _run_render(self, job_id: str, options: RenderOptions) -> None:
        try:
            self._update_job(
                job_id, status="running", stage="planning", progress=8,
                message="Reading tempo, key and arrangement settings",
            )
            anchor = self.get_track(options.anchor_id)
            lead = self.get_track(options.lead_id)
            anchor_path = self.track_path(options.anchor_id)
            lead_path = self.track_path(options.lead_id)
            tempo_ratio = float(anchor["bpm"]) / float(lead["bpm"])
            anchor_key = f"{anchor['key']['tonic']} {anchor['key']['mode']}"
            lead_key = f"{lead['key']['tonic']} {lead['key']['mode']}"
            semitone_shift = assembler.semitones_to_match(anchor_key, lead_key)

            if options.use_vocals:
                self._update_job(
                    job_id, stage="separating", progress=18,
                    message="Separating the lead vocal with Demucs",
                )
                stems = separator.separate(
                    str(lead_path), self.stem_dir / job_id, method=options.stem_method,
                )
                if "vocals" not in stems:
                    raise UserError(
                        "vocal isolation requires Demucs; center/side fallback cannot provide a vocal stem"
                    )
                lead_path = stems["vocals"]

            duration = options.duration
            if options.preview:
                duration = min(duration if duration is not None else 12.0, 20.0)

            self._update_job(
                job_id, stage="rendering", progress=58,
                message="Aligning tempo and key, then shaping the final mix",
            )
            output_path = self.render_dir / f"{job_id}.mp3"
            spec = assembler.MashSpec(
                anchor_path=anchor_path,
                lead_path=lead_path,
                anchor_gain=options.anchor_gain,
                lead_gain=options.lead_gain,
                anchor_start=options.anchor_start,
                lead_start=options.lead_start,
                duration=duration,
            )
            assembler.build_mash(spec, tempo_ratio, semitone_shift, str(output_path))
            peak = assembler.measure_clipping(str(output_path))
            result = {
                "tempo_ratio": round(tempo_ratio, 4),
                "semitone_shift": semitone_shift,
                "duration": assembler._ffprobe_duration(str(output_path)),
                "true_peak_db": peak.get("true_peak_db"),
                "demucs_device": separator.demucs_device() if options.use_vocals else None,
            }
            self._update_job(
                job_id, status="complete", stage="complete", progress=100,
                message="Your preview is ready" if options.preview else "Your mashup is ready",
                output_path=str(output_path), result_json=json.dumps(result), error=None,
            )
        except Exception as exc:
            self._update_job(
                job_id, status="failed", stage="failed", progress=100,
                message="Render failed", error=str(exc),
            )

    def wait_for_job(self, job_id: str, timeout: float = 60.0) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            job = self.get_job(job_id)
            if job["status"] in {"complete", "failed"}:
                return job
            time.sleep(0.05)
        raise TimeoutError(f"job {job_id} did not finish within {timeout}s")

    def close(self) -> None:
        if not self._closed:
            self._executor.shutdown(wait=True, cancel_futures=False)
            self._closed = True

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
import shutil
import sqlite3
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import BinaryIO

from . import analyzer, assembler, beatgrid, media, migrations, separator, sources
from .common import UserError
from .contracts import TERMINAL_JOB_STATES, JobKind
from .jobs import CancellationToken, JobEngine, JobStore


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
    """Persistent local studio with a serialized audio/GPU job engine."""

    def __init__(self, data_dir: str | Path | None = None):
        self.data_dir = Path(data_dir) if data_dir else default_data_dir()
        self.track_dir = self.data_dir / "tracks"
        self.incoming_dir = self.data_dir / "incoming"
        self.render_dir = self.data_dir / "renders"
        self.stem_dir = self.data_dir / "stems"
        self.waveform_dir = self.data_dir / "waveforms"
        self.db_path = self.data_dir / "studio.sqlite3"
        for directory in (
            self.data_dir, self.track_dir, self.incoming_dir, self.render_dir,
            self.stem_dir, self.waveform_dir,
        ):
            directory.mkdir(parents=True, exist_ok=True)
        self._init_db()
        self._store = JobStore(self._connect)
        self._engine = JobEngine(self._store)
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
            "source": {
                "kind": row["source_kind"],
                "reference": row["source_ref"],
            },
            "created_at": row["created_at"],
            "audio_url": f"/api/tracks/{row['id']}/audio",
        }

    def ingest(
        self,
        source: BinaryIO,
        original_name: str,
        *,
        source_kind: str = "upload",
        source_ref: str | None = None,
        metadata: dict | None = None,
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

        now = time.time()
        try:
            with self._connect() as conn:
                conn.execute(
                    """INSERT INTO tracks
                       (id, original_name, path, size_bytes, bpm, tonic, mode, confidence, duration,
                        beat_interval, first_beat, suggested_downbeat, beat_confidence,
                        source_kind, source_ref, content_sha256, metadata_json,
                        waveform_path, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
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
                        now,
                    ),
                )
        except sqlite3.IntegrityError:
            # A concurrent worker inserted identical content first. Clean up our
            # duplicate and return the winning track.
            destination.unlink(missing_ok=True)
            if waveform_rel:
                (self.data_dir / waveform_rel).unlink(missing_ok=True)
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

        anchor = self.get_track(options.anchor_id)
        lead = self.get_track(options.lead_id)
        anchor_path = self.track_path(options.anchor_id)
        lead_path = self.track_path(options.lead_id)
        tempo_ratio = float(anchor["bpm"]) / float(lead["bpm"])
        anchor_key = f"{anchor['key']['tonic']} {anchor['key']['mode']}"
        lead_key = f"{lead['key']['tonic']} {lead['key']['mode']}"
        semitone_shift = assembler.semitones_to_match(anchor_key, lead_key)

        if options.use_vocals:
            self._store.update(
                job_id, stage="separating", progress=18,
                message="Separating the lead vocal with Demucs",
            )
            token.raise_if_cancelled()
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

        self._store.update(
            job_id, stage="rendering", progress=58,
            message="Aligning tempo and key, then shaping the final mix",
        )
        token.raise_if_cancelled()

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
                raise UserError(
                    f"download failed: {result.stderr_tail[-400:]}"
                )

            # Resolve the downloaded artifact from an explicit, validated path.
            video_id = sources.canonicalize_youtube_url(url).rsplit("=", 1)[-1]
            downloaded = self._resolve_downloaded_audio(work_dir, video_id)
            if downloaded is None:
                raise UserError("download completed but no audio file was produced")

            # Read the controlled .info.json sidecar and sanitize its metadata.
            metadata = self._read_info_json(work_dir, video_id)

            self._store.update(
                job_id, stage="analyzing", progress=80,
                message="Analyzing tempo, key and beat grid",
            )
            token.raise_if_cancelled()
            track = self.ingest_path(
                downloaded, source_kind="youtube", source_ref=url,
                metadata=metadata,
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
            if candidate.is_file():
                return candidate
        return None

    def _read_info_json(self, work_dir: Path, video_id: str) -> dict | None:
        """Read and sanitize the controlled ``.info.json`` sidecar, if present."""
        info_path = work_dir / f"{video_id}.info.json"
        if not info_path.is_file():
            return None
        try:
            raw = json.loads(info_path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return None
        return media.sanitize_metadata(raw)

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
                        raise UserError("audio file exceeds the 750 MB local upload limit")
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

    def close(self) -> None:
        if not self._closed:
            self._engine.shutdown(wait=True)
            self._closed = True

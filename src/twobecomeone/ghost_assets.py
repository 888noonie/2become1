"""Managed pre-rendered vocal Ghost asset backend (Phase 9B).

Prepares exactly one tempo-stretched vocal preview asset per proposal from an
explicit, already-separated Demucs ``vocals`` stem. Server-only: no scheduling,
no playback, no Demucs runs on request paths.

Security posture (Zero-Trust File Paths):
- The caller never supplies a path. Source stems are resolved from the database
  by project/deck/track, then re-validated against the dedicated ``stems/``
  root through the existing ``_validated_stem_path`` helper.
- Only server-resolved numbers (offsets, durations, ratios) reach ffmpeg.
- Output paths are generated server-side under the managed ``ghost_assets/``
  root through a same-filesystem temporary file and atomic replace.
- The audio route resolves by opaque asset ID + database row + strict
  managed-root validation; a client can never name a file.

Transform spec records immutable reproduction facts (content hash, stem-set
identity, semantic region, seconds, BPMs, ratio, format, grid revisions, tool
version) — never an absolute path or client-controlled fragment.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import subprocess
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from . import __version__
from .common import ConflictError, NotFoundError, UserError

GHOST_ASSET_TTL_SECONDS = 6 * 3600
MAX_GHOST_SOURCE_BYTES = 750 * 1024 * 1024
GHOST_SAMPLE_RATE = 44100
GHOST_CHANNELS = 2
# Bounded atempo: renderer-consistent ratio bounds (assembler allows chaining,
# but we bound the ratio itself to keep previews sane).
MIN_TEMPO_RATIO = 0.25
MAX_TEMPO_RATIO = 4.0
# Phase 10A: server-side region span bounds (16 bars at 4/4).
MIN_GHOST_REGION_BEATS = 1.0
MAX_GHOST_REGION_BEATS = 64.0
# Phase 10A (Sol amendment 6): the derived source region must land inside the
# resolved media/stem duration. The tolerance mirrors the server's six-decimal
# ffmpeg argument serialization (half of the last serialized digit).
MEDIA_EDGE_TOLERANCE_SECONDS = 5e-7
ASSET_ID_RE = re.compile(r"\Aga-[0-9a-f]{32}\Z")


class GhostAssetPreparationError(UserError):
    """A Ghost asset could not be prepared (HTTP 422)."""

    status = 422

    def __init__(self, code: str, message: str, *, detail: str | None = None):
        super().__init__(message, detail=detail, code=code)


def _precondition(code: str) -> GhostAssetPreparationError:
    return GhostAssetPreparationError(code, {
        "S_STEM_NOT_VOCAL": "source stem must be exactly 'vocal' and resolve to a completed Demucs 'vocals' stem",
        "S_DECK_NOT_TRACK": "source deck does not map to a real track in this project",
        "S_REGION_INCOMPLETE": "region needs finite startBeat and endBeat with startBeat < endBeat",
        "S_REGION_OUT_OF_RANGE": "region span must be between 1 and 64 beats",
        "S_REGION_BEYOND_MEDIA": "region extends beyond the available media duration",
        "S_GRID_MISSING": "source or destination effective BPM/beat-grid metadata is missing; refusing to guess phrase timing",
        "S_STEM_UNAVAILABLE": "the referenced vocal stem file is unavailable",
        "S_DESTINATION_INVALID": "destination deck does not map to a real track with valid BPM facts",
    }.get(code, "asset preparation failed"))


class GhostAssetStore:
    """Registry + preparation service for managed Ghost preview assets."""

    def __init__(
        self,
        connect: Callable[[], sqlite3.Connection],
        data_dir: Path,
        *,
        ttl_seconds: int = GHOST_ASSET_TTL_SECONDS,
        clock=time.time,
        run_ffmpeg: Callable[[list[str]], None] | None = None,
    ):
        self._connect = connect
        self.data_dir = Path(data_dir)
        self.asset_dir = self.data_dir / "ghost_assets"
        self.asset_dir = self.asset_root()
        self.ttl_seconds = ttl_seconds
        self._clock = clock
        self._run_ffmpeg = run_ffmpeg or self._run_ffmpeg_subprocess

    def asset_root(self) -> Path:
        """Managed ghost_assets root; created lazily and validated."""
        root = self.data_dir / "ghost_assets"
        root.mkdir(parents=True, exist_ok=True)
        return root

    # ------------------------------------------------------------------
    # Preparation pipeline
    # ------------------------------------------------------------------

    def prepare_for_preview(
        self,
        project: dict,
        action: dict,
        *,
        resolve_track: Callable[[str], dict | None],
        resolve_stem: Callable[[str, str], Path | None],
        track_bpm: Callable[[str], float | None],
        ffmpeg_version: Callable[[], str] | None = None,
    ) -> dict:
        """Resolve, slice, stretch, hash, and register one preview asset.

        All injected resolvers come from ``StudioService`` so this module
        never trusts the request: tracks resolve by ID from the scoped
        project, stems resolve only through the validated stems root, BPMs
        resolve from effective analysis facts.
        """
        payload = action["payload"]
        source = payload["source"]
        region = source["region"]
        deck = source["deck"]
        stem = source["stem"]

        # 1. Deck -> real track in the scoped project (V1: A=anchor, B=lead).
        track = resolve_track(deck)
        if track is None:
            raise _precondition("S_DECK_NOT_TRACK")

        # 2. Stem must be exactly vocal and resolve to a completed Demucs
        #    'vocals' stem. center/sides are never silently substituted.
        if stem != "vocal":
            raise _precondition("S_STEM_NOT_VOCAL")
        stem_path = resolve_stem(track["id"], "vocals")
        if stem_path is None:
            raise _precondition("S_STEM_UNAVAILABLE")

        # 3. Region: finite, non-negative, strictly ordered, span-bounded.
        start_beat = region.get("startBeat")
        end_beat = region.get("endBeat")
        for value in (start_beat, end_beat):
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value < 0:
                raise _precondition("S_REGION_INCOMPLETE")
        if end_beat <= start_beat:
            raise _precondition("S_REGION_INCOMPLETE")
        span = end_beat - start_beat
        if span < MIN_GHOST_REGION_BEATS or span > MAX_GHOST_REGION_BEATS:
            raise _precondition("S_REGION_OUT_OF_RANGE")

        # 4. Grid/BPM facts must exist; missing metadata fails honestly.
        source_bpm = track_bpm(track["id"])
        if not isinstance(source_bpm, (int, float)) or isinstance(source_bpm, bool):
            raise _precondition("S_GRID_MISSING")
        destination_deck = payload["destination"]["deck"]
        destination_track = resolve_track(destination_deck)
        if destination_track is None:
            raise _precondition("S_DESTINATION_INVALID")
        target_bpm = track_bpm(destination_track["id"])
        if not isinstance(target_bpm, (int, float)) or isinstance(target_bpm, bool):
            raise _precondition("S_GRID_MISSING")
        source_bpm = float(source_bpm)
        target_bpm = float(target_bpm)
        if source_bpm <= 0 or target_bpm <= 0:
            raise _precondition("S_GRID_MISSING")
        source_grid = self._server_grid_facts(track, source_bpm)
        destination_grid = self._server_grid_facts(destination_track, target_bpm)

        tempo_ratio = target_bpm / source_bpm
        if not (MIN_TEMPO_RATIO <= tempo_ratio <= MAX_TEMPO_RATIO):
            raise GhostAssetPreparationError(
                "S_TEMPO_RATIO_OUT_OF_RANGE",
                "tempo ratio is outside the supported stretch range",
                detail=f"{tempo_ratio:.4f}",
            )

        # 5. Server-resolved slice facts. Beats -> seconds on the SOURCE grid.
        source_offset_seconds = source_grid["originSeconds"] + start_beat * 60.0 / source_bpm
        source_duration_seconds = (end_beat - start_beat) * 60.0 / source_bpm

        # 5b. Media bounds (Phase 10A, Sol amendment 6): an untrusted region
        # must land inside the resolved Foundation stem. One documented
        # tolerance covers the six-decimal ffmpeg argument serialization.
        if (
            not math.isfinite(source_offset_seconds)
            or source_offset_seconds < 0
            or not math.isfinite(source_duration_seconds)
            or source_duration_seconds <= 0
        ):
            raise _precondition("S_REGION_BEYOND_MEDIA")
        stem_duration = self._probe_media_duration(stem_path)
        if (
            not math.isfinite(stem_duration)
            or source_offset_seconds + source_duration_seconds
            > stem_duration + MEDIA_EDGE_TOLERANCE_SECONDS
        ):
            raise _precondition("S_REGION_BEYOND_MEDIA")

        # 6. Prepare and publish the opaque file before the short SQLite write
        #    transaction begins. The caller either registers it in the action
        #    transaction or calls discard_prepared() on any failure/race.
        asset_id = f"ga-{uuid.uuid4().hex}"
        final_path = self.asset_dir / f"{asset_id}.wav"
        tmp_path = self.asset_dir / f".{asset_id}.tmp"

        try:
            self._render_ghost_asset(
                stem_path, tmp_path, source_offset_seconds,
                source_duration_seconds, tempo_ratio,
            )
            # Decode-validate before publishing.
            decoded = self._probe_audio(tmp_path)
            content_hash = self._hash_file(tmp_path)
            size = tmp_path.stat().st_size
            duration = decoded["duration"]
            stem_identity = self._stem_set_identity_for(track["id"])
            if stem_identity is None:
                raise _precondition("S_STEM_UNAVAILABLE")
            transform_spec = {
                "sourceTrackContentHash": track.get("content_sha256") or track.get("contentHash"),
                "stemSetId": stem_identity["id"],
                "separationMethod": "demucs",
                "model": stem_identity["model"],
                "stem": "vocals",
                "semanticRegion": {
                    "id": region.get("id"),
                    "startBeat": start_beat,
                    "endBeat": end_beat,
                    "gridRevision": region.get("gridRevision"),
                },
                "sourceOffsetSeconds": source_offset_seconds,
                "sourceDurationSeconds": source_duration_seconds,
                "sourceBpm": source_bpm,
                "targetBpm": target_bpm,
                "tempoRatio": tempo_ratio,
                "outputSampleRate": GHOST_SAMPLE_RATE,
                "outputChannels": GHOST_CHANNELS,
                "sourceGrid": source_grid,
                "destinationGrid": destination_grid,
                "sourceGridRevision": source_grid["revision"],
                "destinationGridRevision": destination_grid["revision"],
                "toolVersion": ffmpeg_version() if ffmpeg_version else None,
                "rendererVersion": __version__,
            }
            # Atomic publish: rename is atomic on the same filesystem.
            tmp_path.replace(final_path)
        except UserError:
            tmp_path.unlink(missing_ok=True)
            raise
        except Exception as exc:
            tmp_path.unlink(missing_ok=True)
            raise GhostAssetPreparationError(
                "S_PREPARATION_FAILED", "the preview asset could not be prepared"
            ) from exc

        now = self._clock()
        expires_at = now + self.ttl_seconds
        return {
            "asset": {
                "id": asset_id,
                "contentHash": content_hash,
                "transformSpec": transform_spec,
                "audioUrl": f"/api/ghost-assets/{asset_id}/audio",
                "expiresAt": expires_at,
            },
            "_record": {
                "id": asset_id,
                "project_id": project["id"],
                "proposal_id": action["id"],
                "track_id": track["id"],
                "content_sha256": content_hash,
                "relative_path": final_path.name,
                "transform_spec_json": json.dumps(transform_spec, sort_keys=True, separators=(",", ":")),
                "sample_rate": decoded["sample_rate"],
                "channels": decoded["channels"],
                "duration_seconds": duration,
                "file_size_bytes": size,
                "created_at": now,
                "expires_at": expires_at,
            },
        }

    def register_prepared(self, preparation: dict, conn: sqlite3.Connection) -> None:
        """Register already-rendered bytes inside the short action transaction."""
        record = preparation.get("_record") or {}
        asset_id = record.get("id")
        if not isinstance(asset_id, str) or ASSET_ID_RE.fullmatch(asset_id) is None:
            raise GhostAssetPreparationError("S_PREPARATION_FAILED", "invalid prepared asset identity")
        if record.get("relative_path") != f"{asset_id}.wav":
            raise GhostAssetPreparationError("S_PREPARATION_FAILED", "invalid prepared asset location")
        conn.execute(
            "INSERT INTO ghost_assets ("
            " id, project_id, proposal_id, track_id, content_sha256,"
            " relative_path, transform_spec_json, sample_rate, channels,"
            " duration_seconds, file_size_bytes, pinned, created_at, expires_at"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
            tuple(record[key] for key in (
                "id", "project_id", "proposal_id", "track_id", "content_sha256",
                "relative_path", "transform_spec_json", "sample_rate", "channels",
                "duration_seconds", "file_size_bytes", "created_at", "expires_at",
            )),
        )

    def discard_prepared(self, preparation: dict) -> None:
        """Remove an unregistered prepared file without following arbitrary paths."""
        asset_id = (preparation.get("_record") or {}).get("id")
        if isinstance(asset_id, str) and ASSET_ID_RE.fullmatch(asset_id):
            (self.asset_root() / f"{asset_id}.wav").unlink(missing_ok=True)

    # ------------------------------------------------------------------
    # ffmpeg execution (bounded, scrubbed)
    # ------------------------------------------------------------------

    @staticmethod
    def _run_ffmpeg_subprocess(cmd: list[str]) -> None:
        proc = subprocess.run(cmd, capture_output=True)
        if proc.returncode != 0:
            detail = proc.stderr.decode("utf-8", "replace")[:400]
            raise GhostAssetPreparationError(
                "S_PREPARATION_FAILED", "the preview asset could not be encoded",
                detail=detail,
            )

    def _render_ghost_asset(
        self,
        source_path: Path,
        destination_path: Path,
        offset_seconds: float,
        duration_seconds: float,
        tempo_ratio: float,
    ) -> None:
        """Slice + bounded atempo via the renderer-consistent chain."""
        # Import here to reuse the existing alignment primitive (no second
        # divergent filter-chain implementation).
        from .assembler import _atempo_chain

        if not math.isfinite(offset_seconds) or offset_seconds < 0:
            raise GhostAssetPreparationError("S_PREPARATION_FAILED", "invalid offset")
        if not math.isfinite(duration_seconds) or duration_seconds <= 0:
            raise GhostAssetPreparationError("S_PREPARATION_FAILED", "invalid duration")
        chain = _atempo_chain(tempo_ratio)
        cmd = [
            "ffmpeg", "-y", "-v", "error",
            "-ss", f"{offset_seconds:.6f}",
            "-t", f"{duration_seconds:.6f}",
            "-i", str(source_path),
            "-af", ",".join(chain),
            "-ar", str(GHOST_SAMPLE_RATE),
            "-ac", str(GHOST_CHANNELS),
            "-f", "wav",
            str(destination_path),
        ]
        self._run_ffmpeg(cmd)

    def _tmp_wav(self) -> Path:
        return self.asset_dir / ".prepare-tmp.wav"

    def _probe_audio(self, path: Path) -> dict:
        """Decode-validate with ffprobe; return format facts."""
        cmd = [
            "ffprobe", "-v", "error",
            "-show_entries", "stream=sample_rate,channels:format=duration",
            "-of", "json", str(path),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise GhostAssetPreparationError(
                "S_PREPARATION_FAILED", "the preview asset failed decode validation"
            )
        try:
            data = json.loads(proc.stdout)
            stream = data["streams"][0]
            return {
                "sample_rate": int(stream["sample_rate"]),
                "channels": int(stream["channels"]),
                "duration": float(data["format"]["duration"]),
            }
        except (KeyError, IndexError, ValueError, json.JSONDecodeError):
            raise GhostAssetPreparationError(
                "S_PREPARATION_FAILED", "the preview asset failed decode validation"
            )

    def _probe_media_duration(self, path: Path) -> float:
        """Metadata-only duration probe for media-bounds validation (A6).

        A missing/unreadable duration fails honestly rather than allowing an
        out-of-bounds slice to reach ffmpeg.
        """
        cmd = [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "json", str(path),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise _precondition("S_STEM_UNAVAILABLE")
        try:
            data = json.loads(proc.stdout)
            return float(data["format"]["duration"])
        except (KeyError, ValueError, json.JSONDecodeError):
            raise _precondition("S_STEM_UNAVAILABLE")

    @staticmethod
    def _hash_file(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return f"sha256:{digest.hexdigest()}"

    @staticmethod
    def _server_grid_facts(track: dict, bpm: float) -> dict:
        grid = track.get("beat_grid")
        if not isinstance(grid, dict):
            raise _precondition("S_GRID_MISSING")
        origin = grid.get("first_beat")
        interval = grid.get("interval")
        if (
            not isinstance(origin, (int, float))
            or isinstance(origin, bool)
            or not math.isfinite(origin)
            or origin < 0
            or not isinstance(interval, (int, float))
            or isinstance(interval, bool)
            or not math.isfinite(interval)
            or interval <= 0
        ):
            raise _precondition("S_GRID_MISSING")
        identity = {
            "trackContentHash": track.get("content_sha256") or track.get("contentHash"),
            "bpm": bpm,
            "intervalSeconds": float(interval),
            "originSeconds": float(origin),
            "suggestedDownbeatSeconds": grid.get("suggested_downbeat"),
        }
        encoded = json.dumps(identity, sort_keys=True, separators=(",", ":"), allow_nan=False)
        return {
            "revision": f"grid-v1:{hashlib.sha256(encoded.encode('utf-8')).hexdigest()}",
            "intervalSeconds": identity["intervalSeconds"],
            "originSeconds": identity["originSeconds"],
            "suggestedDownbeatSeconds": identity["suggestedDownbeatSeconds"],
        }

    def _stem_set_identity_for(self, track_id: str) -> dict | None:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT stem_sets.id, stem_sets.model_name, stem_sets.paths_json FROM stem_sets"
                " JOIN tracks ON tracks.id = stem_sets.track_id"
                " WHERE tracks.id = ? AND stem_sets.status = 'complete'"
                " AND stem_sets.method = 'demucs'"
                " ORDER BY stem_sets.created_at DESC",
                (track_id,),
            ).fetchall()
        for row in rows:
            paths = json.loads(row["paths_json"]) if row["paths_json"] else {}
            if isinstance(paths, dict) and paths.get("vocals"):
                return {"id": row["id"], "model": row["model_name"]}
        return None

    # ------------------------------------------------------------------
    # Reads / pinning / GC
    # ------------------------------------------------------------------

    def get_asset(self, project_id: str, asset_id: str) -> dict | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM ghost_assets WHERE id = ? AND project_id = ?",
                (asset_id, project_id),
            ).fetchone()
        if row is None:
            return None
        return self._row_to_dict(row)

    def asset_path(self, asset_id: str) -> Path:
        """Resolve an asset by opaque ID through the managed root only."""
        if not isinstance(asset_id, str) or ASSET_ID_RE.fullmatch(asset_id) is None:
            raise NotFoundError("preview asset not found", code="S_ASSET_NOT_FOUND")
        with self._connect() as conn:
            row = conn.execute(
                "SELECT relative_path, expires_at, pinned FROM ghost_assets WHERE id = ?",
                (asset_id,),
            ).fetchone()
        if row is None:
            raise NotFoundError("preview asset not found", code="S_ASSET_NOT_FOUND")
        if not row["pinned"] and row["expires_at"] < self._clock():
            raise GhostAssetPreparationError("S_ASSET_EXPIRED", "preview asset has expired")
        from .media import validate_managed_path
        try:
            return validate_managed_path(self.asset_root() / row["relative_path"], self.asset_root())
        except UserError:
            raise GhostAssetPreparationError("S_ASSET_UNAVAILABLE", "preview asset is unavailable")

    def verify_and_pin(
        self,
        project_id: str,
        proposal_id: str,
        claimed_asset: dict,
        conn: sqlite3.Connection | None = None,
    ) -> dict:
        """Verify a commit's accepted asset and pin it atomically.

        The claimed asset must match the server's prepared record for this
        proposal (ID + content hash). Returns the verified server record.
        Raises stable errors otherwise; never pins a forged or stale asset.
        Uses the caller's active transaction connection when provided so the
        pin joins the same SQLite transaction as the ledger append.
        """
        target_conn = conn if conn is not None else self._connect()
        try:
            row = target_conn.execute(
                "SELECT * FROM ghost_assets WHERE project_id = ? AND proposal_id = ?",
                (project_id, proposal_id),
            ).fetchone()
            if row is None:
                raise GhostAssetPreparationError(
                    "S_ASSET_NOT_AVAILABLE",
                    "the referenced proposal has no prepared server-managed asset",
                )
            if row["id"] != claimed_asset.get("id"):
                raise GhostAssetPreparationError(
                    "S_ASSET_MISMATCH", "accepted asset does not match the prepared asset"
                )
            if row["content_sha256"] != claimed_asset.get("contentHash"):
                raise GhostAssetPreparationError(
                    "S_ASSET_MISMATCH", "accepted asset content hash does not match"
                )
            if not row["pinned"] and row["expires_at"] < self._clock():
                raise GhostAssetPreparationError("S_ASSET_EXPIRED", "preview asset has expired")
            # Decode-validate the bytes before pinning.
            from .media import validate_managed_path
            path = validate_managed_path(
                self.asset_root() / row["relative_path"], self.asset_root()
            )
            if not path.is_file():
                raise GhostAssetPreparationError("S_ASSET_UNAVAILABLE", "asset file is missing")
            self._probe_audio(path)
            actual_hash = self._hash_file(path)
            if actual_hash != row["content_sha256"]:
                raise GhostAssetPreparationError(
                    "S_ASSET_MISMATCH", "asset bytes no longer match the recorded hash"
                )
            target_conn.execute(
                "UPDATE ghost_assets SET pinned = 1 WHERE id = ?",
                (row["id"],),
            )
            return self._row_to_dict(row)
        finally:
            if conn is None:
                target_conn.close()

    def cleanup_expired(self, now: float | None = None) -> int:
        """Explicit GC: remove only expired, unpinned assets. Returns count."""
        now = now if now is not None else self._clock()
        removed = 0
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, relative_path FROM ghost_assets"
                " WHERE pinned = 0 AND expires_at < ?",
                (now,),
            ).fetchall()
            for row in rows:
                path = self.asset_root() / row["relative_path"]
                try:
                    from .media import validate_managed_path
                    validated = validate_managed_path(path, self.asset_root())
                    validated.unlink(missing_ok=True)
                except UserError:
                    # A corrupt row pointing outside the root is deleted from
                    # the registry but never followed on disk.
                    pass
                conn.execute("DELETE FROM ghost_assets WHERE id = ?", (row["id"],))
                removed += 1
        return removed

    def delete_for_proposal(self, project_id: str, proposal_id: str) -> None:
        """Remove the asset for a proposal (rejected/expired path)."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT id, relative_path, pinned FROM ghost_assets"
                " WHERE project_id = ? AND proposal_id = ?",
                (project_id, proposal_id),
            ).fetchone()
            if row is None:
                return
            if row["pinned"]:
                return  # accepted assets are pinned and never removed here
            path = self.asset_root() / row["relative_path"]
            try:
                from .media import validate_managed_path
                validated = validate_managed_path(path, self.asset_root())
                validated.unlink(missing_ok=True)
            except UserError:
                pass
            conn.execute("DELETE FROM ghost_assets WHERE id = ?", (row["id"],))

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "projectId": row["project_id"],
            "proposalId": row["proposal_id"],
            "trackId": row["track_id"],
            "contentHash": row["content_sha256"],
            "transformSpec": json.loads(row["transform_spec_json"]),
            "sampleRate": row["sample_rate"],
            "channels": row["channels"],
            "durationSeconds": row["duration_seconds"],
            "fileSizeBytes": row["file_size_bytes"],
            "pinned": bool(row["pinned"]),
            "createdAt": row["created_at"],
            "expiresAt": row["expires_at"],
        }

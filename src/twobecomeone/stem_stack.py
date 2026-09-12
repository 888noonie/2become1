"""Phase 14C: one prepared stem-stack composite asset.

Resolves crate components on the server, crops/loops them to a shared bar
span, mixes one stereo 44.1 kHz WAV, and registers it under a managed root.
Never trusts client paths. Does not write into the footer singleton player.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from .assembler import render_aligned
from .common import UserError
from .media import validate_managed_path
from .stem_crate import LOOP_BARS, ROLES

STACK_SAMPLE_RATE = 44100
STACK_CHANNELS = 2
STACK_ID_RE = re.compile(r"\Ass-[0-9a-f]{32}\Z")
MIN_TEMPO_RATIO = 0.25
MAX_TEMPO_RATIO = 4.0
MAX_SEMITONE = 12
BEATS_PER_BAR = 4


class StemStackError(UserError):
    status = 422

    def __init__(self, code: str, message: str, *, detail: str | None = None):
        super().__init__(message, detail=detail, code=code)


def db_to_linear(gain_db: float) -> float:
    return 10.0 ** (gain_db / 20.0)


def stack_destination_grid(dest_bpm: float, dest_bars: int, component_ids: list[str]) -> dict:
    identity = {
        "kind": "stem_stack",
        "bpm": dest_bpm,
        "intervalSeconds": 60.0 / dest_bpm,
        "originSeconds": 0.0,
        "destinationBars": dest_bars,
        "components": component_ids,
    }
    encoded = json.dumps(identity, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return {
        "revision": f"grid-v1:{hashlib.sha256(encoded.encode('utf-8')).hexdigest()}",
        "intervalSeconds": identity["intervalSeconds"],
        "originSeconds": 0.0,
        "beatsPerBar": BEATS_PER_BAR,
    }


class StemStackStore:
    def __init__(self, connect: Callable[[], sqlite3.Connection], data_dir: Path, *, clock=time.time):
        self._connect = connect
        self.data_dir = Path(data_dir)
        self.asset_dir = self.data_dir / "stem_stack_assets"
        self.asset_dir.mkdir(parents=True, exist_ok=True)
        self._clock = clock

    def prepare(
        self,
        project: dict,
        action: dict,
        *,
        get_crate_item: Callable[[str], dict],
        resolve_stem_path: Callable[[str, str], Path],
        ffmpeg_version: str,
    ) -> dict:
        payload = action["payload"]
        components = payload["components"]
        dest_bars = int(payload["destinationBars"])
        if dest_bars not in LOOP_BARS:
            raise StemStackError("V_INVALID_DESTINATION_BARS", "destinationBars must be 1, 2, 4, or 8")
        work = self.asset_dir / f".tmp-{uuid.uuid4().hex}"
        work.mkdir(parents=True, exist_ok=True)
        try:
            resolved = []
            roles_seen: set[str] = set()
            ids_seen: set[str] = set()
            dest_bpm = None
            for component in components:
                item = get_crate_item(component["crateItemId"])
                expected = component["expected"]
                if item.get("media_status") not in (None, "available"):
                    raise StemStackError("S_STEM_UNAVAILABLE", "crate stem media is unavailable or stale")
                if item["content_sha256"] != expected["contentSha256"]:
                    raise StemStackError("S_STALE_CRATE", "crate source hash does not match expected")
                if item["grid_revision"] != expected["gridRevision"]:
                    raise StemStackError("S_STALE_CRATE", "crate grid revision does not match expected")
                if item["stem_name"] != expected["stemName"] or item["stem_set_id"] != expected["stemSetId"]:
                    raise StemStackError("S_STALE_CRATE", "crate stem identity does not match expected")
                if int(item["loop_bars"]) != int(component["loopBars"]):
                    raise StemStackError("S_STALE_CRATE", "crate loop bars do not match expected")
                role = component["role"]
                if role not in ROLES:
                    raise StemStackError("V_INVALID_ROLE", f"unknown stack role {role}")
                if item["stem_name"] in ("center", "sides") and role != "other":
                    raise StemStackError(
                        "V_INVALID_ROLE",
                        "ffmpeg center/sides can only occupy the other role",
                    )
                if role in roles_seen:
                    raise StemStackError("V_DUPLICATE_ROLE", f"duplicate stack role {role}")
                if item["id"] in ids_seen:
                    raise StemStackError("V_DUPLICATE_COMPONENT", "duplicate crate item in stack")
                roles_seen.add(role)
                ids_seen.add(item["id"])
                bpm = float(item["effective_bpm"])
                if dest_bpm is None or role == "beat":
                    dest_bpm = bpm
                path = resolve_stem_path(item["stem_set_id"], item["stem_name"])
                resolved.append((component, item, path, bpm))

            dest_beats = dest_bars * BEATS_PER_BAR
            dest_seconds = dest_beats * 60.0 / dest_bpm
            rendered: list[Path] = []
            manifest_components = []
            for index, (component, item, path, bpm) in enumerate(resolved):
                transform = component.get("transform") or {}
                tempo_ratio = float(transform.get("tempoRatio", 1))
                shift = int(transform.get("semitoneShift", 0))
                if not (MIN_TEMPO_RATIO <= tempo_ratio <= MAX_TEMPO_RATIO):
                    raise StemStackError("V_INVALID_SHIFT", "tempoRatio is out of bounds")
                if abs(shift) > MAX_SEMITONE:
                    raise StemStackError("V_INVALID_SHIFT", "semitoneShift is out of bounds")
                start_beat = float(item["region_start_beat"])
                end_beat = float(item["region_end_beat"])
                start_sec = start_beat * 60.0 / bpm
                region_sec = (end_beat - start_beat) * 60.0 / bpm
                if region_sec <= 0:
                    raise StemStackError("S_STACK_PREPARE_FAILED", "crate region has no duration")
                looped = work / f"comp-{index}-loop.wav"
                self._loop_region(path, looped, start_sec, region_sec, dest_seconds)
                aligned = work / f"comp-{index}.wav"
                render_aligned(
                    str(looped), aligned, tempo_ratio, shift,
                    sr=STACK_SAMPLE_RATE, start=0.0, duration=dest_seconds,
                )
                gain_lin = db_to_linear(float(component["gainDb"]))
                if abs(gain_lin - 1.0) > 1e-9:
                    gained = work / f"comp-{index}-g.wav"
                    self._run_ffmpeg([
                        "ffmpeg", "-y", "-v", "error", "-i", str(aligned),
                        "-af", f"volume={gain_lin:.6f}",
                        "-ar", str(STACK_SAMPLE_RATE), "-ac", str(STACK_CHANNELS),
                        str(gained),
                    ])
                    aligned = gained
                rendered.append(aligned)
                manifest_components.append({
                    "crateItemId": item["id"],
                    "role": component["role"],
                    "stemName": item["stem_name"],
                    "stemSetId": item["stem_set_id"],
                    "method": item["method"],
                    "modelName": item.get("model_name"),
                    "sourceHash": self._hash_file(path),
                    "contentSha256": item["content_sha256"],
                    "gridRevision": item["grid_revision"],
                    "loopBars": component["loopBars"],
                    "regionStartBeat": start_beat,
                    "regionEndBeat": end_beat,
                    "gainDb": component["gainDb"],
                    "tempoRatio": tempo_ratio,
                    "semitoneShift": shift,
                    "provenance": item.get("provenance"),
                })

            dest_grid = stack_destination_grid(dest_bpm, dest_bars, [item["id"] for _, item, _, _ in resolved])
            asset_id = f"ss-{uuid.uuid4().hex}"
            final_path = self.asset_dir / f"{asset_id}.wav"
            tmp_mix = work / "mix.wav"
            self._mix(rendered, tmp_mix)
            peak = self._peak(tmp_mix)
            tmp_mix.replace(final_path)
            content_hash = self._hash_file(final_path)
            decoded = self._probe(final_path)
            transform_spec = {
                "kind": "stem_stack",
                "destinationBars": dest_bars,
                "destinationBpm": dest_bpm,
                "targetBpm": dest_bpm,
                "destinationGrid": dest_grid,
                "destinationGridRevision": dest_grid["revision"],
                "semanticRegion": {
                    "id": f"stack-{dest_bars}",
                    "startBeat": 0.0,
                    "endBeat": float(dest_beats),
                },
                "sampleRate": STACK_SAMPLE_RATE,
                "channels": STACK_CHANNELS,
                "peak": peak,
                "clipping": peak >= 0.99,
                "toolVersion": ffmpeg_version,
                "components": manifest_components,
            }
            now = self._clock()
            size = final_path.stat().st_size
            return {
                "kind": "stem_stack",
                "asset": {
                    "id": asset_id,
                    "contentHash": content_hash,
                    "transformSpec": transform_spec,
                    "audioUrl": f"/api/stem-stack-assets/{asset_id}/audio",
                    "expiresAt": now + 6 * 3600,
                },
                "_record": {
                    "id": asset_id,
                    "project_id": project["id"],
                    "proposal_id": action["id"],
                    "content_sha256": content_hash,
                    "relative_path": final_path.name,
                    "manifest_json": json.dumps(transform_spec, sort_keys=True, separators=(",", ":")),
                    "sample_rate": decoded["sample_rate"],
                    "channels": decoded["channels"],
                    "duration_seconds": decoded["duration"],
                    "file_size_bytes": size,
                    "created_at": now,
                },
            }
        except Exception:
            for leftover in self.asset_dir.glob("ss-*.wav"):
                # Only unpublished temps live in work/; never delete registered files here.
                pass
            raise
        finally:
            if work.exists():
                for child in work.glob("*"):
                    child.unlink(missing_ok=True)
                work.rmdir()

    def register_prepared(self, preparation: dict, conn: sqlite3.Connection) -> None:
        record = preparation.get("_record") or {}
        asset_id = record.get("id")
        if not isinstance(asset_id, str) or STACK_ID_RE.fullmatch(asset_id) is None:
            raise StemStackError("S_STACK_PREPARE_FAILED", "invalid stack asset identity")
        conn.execute(
            "INSERT INTO stem_stack_assets ("
            " id, project_id, proposal_id, content_sha256, relative_path,"
            " manifest_json, sample_rate, channels, duration_seconds,"
            " file_size_bytes, pinned, created_at"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
            (
                record["id"], record["project_id"], record["proposal_id"],
                record["content_sha256"], record["relative_path"],
                record["manifest_json"], record["sample_rate"], record["channels"],
                record["duration_seconds"], record["file_size_bytes"], record["created_at"],
            ),
        )

    def discard_prepared(self, preparation: dict) -> None:
        asset_id = (preparation.get("_record") or {}).get("id")
        if isinstance(asset_id, str) and STACK_ID_RE.fullmatch(asset_id):
            (self.asset_dir / f"{asset_id}.wav").unlink(missing_ok=True)

    def verify_and_pin(self, project_id: str, proposal_id: str, claimed: dict, conn=None) -> dict:
        closer = False
        if conn is None:
            conn = self._connect()
            closer = True
        try:
            row = conn.execute(
                "SELECT * FROM stem_stack_assets WHERE project_id = ? AND proposal_id = ?",
                (project_id, proposal_id),
            ).fetchone()
            if row is None:
                raise StemStackError("S_ASSET_NOT_AVAILABLE", "no prepared stack asset for this proposal")
            if claimed.get("id") != row["id"] or claimed.get("contentHash") != row["content_sha256"]:
                raise StemStackError("S_ASSET_MISMATCH", "accepted stack asset does not match the prepared file")
            path = self._managed_file(row["relative_path"], row["id"])
            actual = self._hash_file(path)
            if actual != row["content_sha256"]:
                raise StemStackError("S_ASSET_MISMATCH", "stack asset bytes no longer match the recorded hash")
            conn.execute("UPDATE stem_stack_assets SET pinned = 1 WHERE id = ?", (row["id"],))
            return {
                "id": row["id"],
                "contentHash": row["content_sha256"],
                "transformSpec": json.loads(row["manifest_json"]),
            }
        finally:
            if closer:
                conn.close()

    def verify_committed_asset(self, project_id: str, asset_id: str, content_hash: str) -> Path:
        if not isinstance(asset_id, str) or STACK_ID_RE.fullmatch(asset_id) is None:
            raise StemStackError("S_ASSET_NOT_AVAILABLE", "committed stack identity is invalid")
        with self._connect() as conn:
            row = conn.execute(
                "SELECT relative_path, pinned, content_sha256 FROM stem_stack_assets"
                " WHERE id = ? AND project_id = ?",
                (asset_id, project_id),
            ).fetchone()
        if row is None or not row["pinned"]:
            raise StemStackError("S_ASSET_NOT_AVAILABLE", "committed stack asset is missing or unpinned")
        if row["content_sha256"] != content_hash:
            raise StemStackError("S_ASSET_MISMATCH", "committed stack content hash does not match")
        path = self._managed_file(row["relative_path"], asset_id)
        if self._hash_file(path) != content_hash:
            raise StemStackError("S_ASSET_MISMATCH", "committed stack bytes no longer match the recorded hash")
        return path

    def audio_path(self, asset_id: str) -> Path:
        if not isinstance(asset_id, str) or STACK_ID_RE.fullmatch(asset_id) is None:
            raise StemStackError("S_ASSET_NOT_AVAILABLE", "unknown stack asset")
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM stem_stack_assets WHERE id = ?", (asset_id,)).fetchone()
        if row is None:
            raise StemStackError("S_ASSET_NOT_AVAILABLE", "unknown stack asset")
        return self._managed_file(row["relative_path"], asset_id)

    def _managed_file(self, relative_path: str, asset_id: str) -> Path:
        if Path(relative_path).name != f"{asset_id}.wav":
            raise StemStackError("S_ASSET_NOT_AVAILABLE", "stack asset file is missing")
        try:
            path = validate_managed_path(self.asset_dir / relative_path, self.asset_dir)
        except UserError as exc:
            raise StemStackError("S_ASSET_NOT_AVAILABLE", "stack asset path is outside the managed root") from exc
        if not path.is_file():
            raise StemStackError("S_ASSET_NOT_AVAILABLE", "stack asset file is missing")
        return path

    def _loop_region(self, source: Path, dest: Path, start: float, region: float, dest_seconds: float) -> None:
        extract = dest.with_name(dest.stem + "-src.wav")
        self._run_ffmpeg([
            "ffmpeg", "-y", "-v", "error",
            "-ss", f"{start:.6f}", "-t", f"{region:.6f}",
            "-i", str(source),
            "-ar", str(STACK_SAMPLE_RATE), "-ac", str(STACK_CHANNELS),
            str(extract),
        ])
        repeats = max(1, math.ceil(dest_seconds / region + 1e-9))
        list_path = dest.with_suffix(".txt")
        list_path.write_text("".join(f"file '{extract}'\n" for _ in range(repeats)))
        self._run_ffmpeg([
            "ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0",
            "-i", str(list_path),
            "-t", f"{dest_seconds:.6f}",
            "-ar", str(STACK_SAMPLE_RATE), "-ac", str(STACK_CHANNELS),
            str(dest),
        ])

    def _mix(self, inputs: list[Path], dest: Path) -> None:
        if len(inputs) == 1:
            dest.write_bytes(inputs[0].read_bytes())
            return
        cmd = ["ffmpeg", "-y", "-v", "error"]
        for path in inputs:
            cmd.extend(["-i", str(path)])
        cmd.extend([
            "-filter_complex", f"amix=inputs={len(inputs)}:duration=longest:normalize=0",
            "-ar", str(STACK_SAMPLE_RATE), "-ac", str(STACK_CHANNELS), str(dest),
        ])
        self._run_ffmpeg(cmd)

    def _peak(self, path: Path) -> float:
        proc = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", str(path), "-af", "volumedetect", "-f", "null", "-"],
            capture_output=True, text=True,
        )
        peak = 0.0
        for line in (proc.stderr or "").splitlines():
            if "max_volume:" in line:
                try:
                    db = float(line.split("max_volume:")[1].strip().split()[0])
                    if math.isfinite(db):
                        peak = max(peak, 10.0 ** (db / 20.0))
                except (ValueError, IndexError):
                    continue
        return peak

    def _probe(self, path: Path) -> dict:
        proc = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "stream=sample_rate,channels:format=duration",
                "-of", "json", str(path),
            ],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            raise StemStackError("S_STACK_PREPARE_FAILED", "stack mix failed decode validation")
        data = json.loads(proc.stdout)
        stream = data["streams"][0]
        return {
            "sample_rate": int(stream["sample_rate"]),
            "channels": int(stream["channels"]),
            "duration": float(data["format"]["duration"]),
        }

    @staticmethod
    def _hash_file(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return f"sha256:{digest.hexdigest()}"

    @staticmethod
    def _run_ffmpeg(cmd: list[str]) -> None:
        proc = subprocess.run(cmd, capture_output=True)
        if proc.returncode != 0:
            detail = proc.stderr.decode("utf-8", "replace")[:400]
            raise StemStackError("S_STACK_PREPARE_FAILED", "ffmpeg could not prepare the stem stack", detail=detail)

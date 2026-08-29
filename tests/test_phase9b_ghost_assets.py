"""Phase 9B: managed Ghost asset preparation, serving, pinning, GC.

Uses real ffmpeg against synthetic WAVs inside ``tmp_path`` — never the
persistent data root.
"""

import asyncio
import io
import json
import struct
import time
import wave
from pathlib import Path

import pytest

from twobecomeone import actions as action_contract
from twobecomeone.common import ConflictError
from twobecomeone.ghost_assets import GhostAssetPreparationError, GhostAssetStore
from twobecomeone.studio import StudioService


def synth_wav(path: Path, *, seconds: float = 4.0, sr: int = 22050, freq: float = 220.0) -> Path:
    frames = bytearray()
    for index in range(int(sr * seconds)):
        t = index / sr
        value = int(0.4 * 20000 * ((1 if (t * freq) % 1 < 0.5 else -1)))
        frames += struct.pack("<hh", value, value)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(sr)
        output.writeframes(bytes(frames))
    return path


def make_service(tmp_path: Path) -> StudioService:
    return StudioService(tmp_path / "data")


def ingest(service: StudioService, wav: Path) -> dict:
    with wav.open("rb") as handle:
        return service.ingest(handle, wav.name)


def make_vocals_stem(service: StudioService, track_id: str, wav: Path) -> None:
    """Register a completed Demucs-style stem set with a real vocals file."""
    import hashlib

    track_sha256 = service._track_content_hash(track_id)
    stem_dir = service.stem_dir / f"set-{track_sha256[:12]}"
    stem_dir.mkdir(parents=True, exist_ok=True)
    stem_file = stem_dir / "vocals.wav"
    if not stem_file.exists():
        # 32s leaves room for any detected BPM: a 0-8 beat region spans under
        # 16s even at 30 BPM, so Phase 10A media-bounds validation (A6) holds.
        synth_wav(stem_file, seconds=32.0)
    rel = f"stems/set-{track_sha256[:12]}/vocals.wav"
    with service._connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO stem_sets ("
            " id, track_id, track_sha256, method, model_name, device, status, paths_json, created_at"
            ") VALUES (?, ?, ?, 'demucs', 'htdemucs', 'cpu', 'complete', ?, ?)",
            (f"set-{track_sha256[:12]}", track_id, track_sha256, json.dumps({"vocals": rel}), time.time()),
        )


@pytest.fixture
def prepared_project(tmp_path):
    """A service + project with an anchor and lead track and real vocals stems."""
    service = make_service(tmp_path)
    try:
        anchor_wav = synth_wav(tmp_path / "anchor.wav", freq=220.0, seconds=32.0)
        lead_wav = synth_wav(tmp_path / "lead.wav", freq=330.0, seconds=32.0)
        anchor = service.ingest(anchor_wav.open("rb"), "anchor.wav")
        lead = service.ingest(lead_wav.open("rb"), "lead.wav")
        # Register completed Demucs-style vocals stem sets BEFORE assigning
        # variants, so project validation finds them available.
        make_vocals_stem(service, anchor["id"], anchor_wav)
        make_vocals_stem(service, lead["id"], lead_wav)
        project = service.create_project("Ghost mix")
        service.update_project(
            project["id"],
            anchor_track_id=anchor["id"],
            lead_track_id=lead["id"],
            anchor_variant="vocals",
            lead_variant="vocals",
        )
        yield service, project["id"], anchor, lead
    finally:
        service.close()


def preview_action(action_id="a-1", key="k-1", **region_overrides):
    region = {"id": "verse_1", "startBeat": 0, "endBeat": 8, "gridRevision": "grid-1"}
    region.update(region_overrides)
    return {
        "id": action_id,
        "schemaVersion": 1,
        "type": "preview_layer",
        "actor": {"type": "human", "id": "richard"},
        "requestedAt": "2026-08-28T00:00:00Z",
        "idempotencyKey": key,
        "payload": {
            "source": {"deck": "A", "stem": "vocal", "region": region},
            "destination": {"deck": "B"},
            "timing": {"launch": "next_phrase", "quantize": True},
            "gainDb": -3,
        },
    }


class TestAssetPreparation:
    def test_preview_prepares_real_asset_and_descriptor(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        result = service.record_project_action(project_id, preview_action())
        assert result["outcome"]["result"] == "proposal_created"
        asset = result["outcome"]["asset"]
        assert asset["id"].startswith("ga-")
        assert asset["contentHash"].startswith("sha256:")
        assert asset["audioUrl"] == f"/api/ghost-assets/{asset['id']}/audio"
        spec = asset["transformSpec"]
        assert spec["stem"] == "vocals"
        assert spec["separationMethod"] == "demucs"
        assert spec["model"] == "htdemucs"
        assert len(spec["sourceTrackContentHash"]) == 64
        assert spec["sourceGridRevision"].startswith("grid-v1:")
        assert spec["destinationGridRevision"].startswith("grid-v1:")
        assert spec["sourceOffsetSeconds"] == pytest.approx(
            spec["sourceGrid"]["originSeconds"]
        )
        assert spec["sourceBpm"] > 0 and spec["targetBpm"] > 0
        assert spec["tempoRatio"] == pytest.approx(spec["targetBpm"] / spec["sourceBpm"])
        assert spec["semanticRegion"]["startBeat"] == 0
        assert spec["semanticRegion"]["endBeat"] == 8
        assert "/" not in str(spec["sourceOffsetSeconds"])
        # No absolute paths anywhere in the descriptor.
        assert str(service.data_dir) not in json.dumps(asset)

        # The asset row exists and the file is on disk under ghost_assets/.
        stored = service._ghost_assets.get_asset(project_id, asset["id"])
        assert stored is not None
        assert stored["pinned"] is False
        # Resolve through the guarded route instead.
        path = service.ghost_asset_audio_path(asset["id"])
        assert path.is_file()
        assert path.parent == service._ghost_assets.asset_root()

        # The file decodes and has a plausible stretched duration. The exact
        # detected BPM of the synthetic track is noisy, so assert the duration
        # is positive, finite, and within a generous relative band of the
        # server-computed expectation (codec/sample tolerance).
        expected = (8 - 0) * 60.0 / spec["sourceBpm"] / spec["tempoRatio"]
        assert stored["durationSeconds"] > 0
        assert abs(stored["durationSeconds"] - expected) / max(expected, 1e-9) < 0.5

        # Proposal + asset are durably linked.
        state = service.project_action_state(project_id)
        assert state["last_sequence"] == 1
        assert state["proposals"]["byId"]["a-1"]["lifecycle"] == "ready"

    def test_stem_must_be_exactly_vocal(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        action = preview_action()
        action["payload"]["source"]["stem"] = "center"
        with pytest.raises(GhostAssetPreparationError) as excinfo:
            service.record_project_action(project_id, action)
        assert excinfo.value.code == "S_STEM_NOT_VOCAL"
        # Zero ledger mutation.
        assert service.project_actions(project_id)["total"] == 0

    def test_missing_vocals_stem_fails(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        # Remove the stem set rows to simulate missing separation.
        with service._connect() as conn:
            conn.execute("DELETE FROM stem_sets")
        with pytest.raises(GhostAssetPreparationError) as excinfo:
            service.record_project_action(project_id, preview_action())
        assert excinfo.value.code == "S_STEM_UNAVAILABLE"

    def test_deck_without_track_fails(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        # Clear the anchor track AND its variant so project validation passes.
        service.update_project(project_id, anchor_track_id=None, anchor_variant="full")
        with pytest.raises(GhostAssetPreparationError) as excinfo:
            service.record_project_action(project_id, preview_action())
        assert excinfo.value.code == "S_DECK_NOT_TRACK"

    def test_missing_bpm_fails(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        # Simulate missing analysis by zeroing the effective BPM (NOT NULL
        # column, but `_v1_track_bpm` requires bpm > 0).
        import sqlite3
        conn = sqlite3.connect(service.db_path)
        with conn:
            conn.execute("UPDATE tracks SET bpm = 0, bpm_override = NULL WHERE id = ?", (anchor["id"],))
        conn.close()
        with pytest.raises(GhostAssetPreparationError) as excinfo:
            service.record_project_action(project_id, preview_action())
        assert excinfo.value.code == "S_GRID_MISSING"

    def test_missing_server_grid_origin_fails(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        with service._connect() as conn:
            conn.execute(
                "UPDATE tracks SET first_beat = NULL, first_beat_override = NULL WHERE id = ?",
                (anchor["id"],),
            )
        with pytest.raises(GhostAssetPreparationError) as excinfo:
            service.record_project_action(project_id, preview_action())
        assert excinfo.value.code == "S_GRID_MISSING"

    def test_reversed_region_fails(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        # The strict contract validator rejects reversed bounds before the
        # asset preparer runs.
        with pytest.raises(action_contract.ActionValidationError) as excinfo:
            service.record_project_action(project_id, preview_action(startBeat=32, endBeat=16))
        assert excinfo.value.node_code == "V_REGION_INVALID_BOUNDS"

    def test_no_demucs_run_on_request_path(self, prepared_project):
        # The separation path is never invoked: the test above (missing stem)
        # failed with an availability code rather than starting a job. Here we
        # additionally assert no new job rows appear after any preview attempt.
        service, project_id, anchor, lead = prepared_project
        with service._connect() as conn:
            conn.execute("DELETE FROM stem_sets")
        try:
            service.record_project_action(project_id, preview_action())
        except GhostAssetPreparationError:
            pass
        with service._connect() as conn:
            jobs = conn.execute("SELECT COUNT(*) FROM jobs WHERE kind = 'separate'").fetchone()[0]
        assert jobs == 0


class TestAssetServing:
    @pytest.mark.parametrize("asset_id", ["../../etc/passwd", "ga-../escape", "ga-not-hex", "", "GA-" + "a" * 32])
    def test_malformed_asset_id_rejected_before_lookup(self, prepared_project, asset_id):
        service, project_id, anchor, lead = prepared_project
        from twobecomeone.common import NotFoundError
        with pytest.raises(NotFoundError) as excinfo:
            service.ghost_asset_audio_path(asset_id)
        assert excinfo.value.code == "S_ASSET_NOT_FOUND"

    def test_serve_by_opaque_id(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        result = service.record_project_action(project_id, preview_action())
        asset_id = result["outcome"]["asset"]["id"]
        path = service.ghost_asset_audio_path(asset_id)
        assert path.is_file()
        assert service._ghost_assets.asset_root() in path.parents or path.parent == service._ghost_assets.asset_root()

    def test_unknown_asset_404(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        from twobecomeone.common import NotFoundError
        with pytest.raises(NotFoundError):
            service.ghost_asset_audio_path("ga-does-not-exist")

    def test_expired_asset_not_served(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        result = service.record_project_action(project_id, preview_action())
        asset_id = result["outcome"]["asset"]["id"]
        # Force expiry by rewriting the row.
        with service._connect() as conn:
            conn.execute(
                "UPDATE ghost_assets SET expires_at = ? WHERE id = ?",
                (time.time() - 10, asset_id),
            )
        with pytest.raises(GhostAssetPreparationError) as excinfo:
            service.ghost_asset_audio_path(asset_id)
        assert excinfo.value.code == "S_ASSET_EXPIRED"

    def test_registry_row_pointing_outside_root_never_served(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        result = service.record_project_action(project_id, preview_action())
        asset_id = result["outcome"]["asset"]["id"]
        # Corrupt the row to point at a file outside the managed root.
        with service._connect() as conn:
            conn.execute(
                "UPDATE ghost_assets SET relative_path = ? WHERE id = ?",
                ("../tracks/" + anchor["id"] + ".mp3", asset_id),
            )
        with pytest.raises(GhostAssetPreparationError) as excinfo:
            service.ghost_asset_audio_path(asset_id)
        assert excinfo.value.code == "S_ASSET_UNAVAILABLE"


class TestCommitPinning:
    def _auditioning_commit(self, service, project_id, asset):
        # Drive the lifecycle to auditioning via direct projection mutation
        # would break durability guarantees; instead the runtime/test seam in
        # this tri-phase advances lifecycle through the ledger. Use the
        # documented test seam: a scheduled + auditioning fact is not a public
        # Action type, so the service exposes the internal transition helper.
        store = service._actions
        with store._connect() as conn:
            row = conn.execute(
                "SELECT proposals_json FROM action_projection WHERE project_id = ?",
                (project_id,),
            ).fetchone()
            proposals = json.loads(row["proposals_json"])
            proposals["byId"]["a-1"]["lifecycle"] = "auditioning"
            conn.execute(
                "UPDATE action_projection SET proposals_json = ? WHERE project_id = ?",
                (json.dumps(proposals), project_id),
            )
        commit = {
            "id": "c-1",
            "schemaVersion": 1,
            "type": "commit_layer",
            "actor": {"type": "human", "id": "richard"},
            "requestedAt": "t",
            "idempotencyKey": "ck",
            "payload": {
                "proposalId": "a-1",
                "acceptedAt": "2026-08-28T00:00:05Z",
                "acceptedAsset": {
                    "id": asset["id"],
                    "contentHash": asset["contentHash"],
                    "transformSpec": asset["transformSpec"],
                },
            },
        }
        return service.record_project_action(project_id, commit)

    def test_commit_verifies_and_pins(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        result = service.record_project_action(project_id, preview_action())
        asset = result["outcome"]["asset"]
        commit = self._auditioning_commit(service, project_id, asset)
        assert commit["outcome"]["result"] == "proposal_committed"
        stored = service._ghost_assets.get_asset(project_id, asset["id"])
        assert stored["pinned"] is True

        state = service.project_action_state(project_id)
        assert state["proposals"]["byId"]["a-1"]["lifecycle"] == "accepted"
        assert len(state["session"]["committedLayers"]) == 1
        layer = state["session"]["committedLayers"][0]
        assert layer["asset"]["id"] == asset["id"]
        assert layer["asset"]["pinned"] is True
        assert layer["sourceRegionRef"]["id"] == "verse_1"

    def test_commit_with_forged_asset_fails(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        result = service.record_project_action(project_id, preview_action())
        asset = result["outcome"]["asset"]
        self._auditioning_commit_setup_only(service, project_id)
        commit = {
            "id": "c-2",
            "schemaVersion": 1,
            "type": "commit_layer",
            "actor": {"type": "human", "id": "richard"},
            "requestedAt": "t",
            "idempotencyKey": "ck2",
            "payload": {
                "proposalId": "a-1",
                "acceptedAt": "t2",
                "acceptedAsset": {
                    "id": "ga-forged",
                    "contentHash": "sha256:forged",
                    "transformSpec": {},
                },
            },
        }
        with pytest.raises(GhostAssetPreparationError) as excinfo:
            service.record_project_action(project_id, commit)
        assert excinfo.value.code == "S_ASSET_MISMATCH"
        # Proposal still auditioning; no committed layer.
        state = service.project_action_state(project_id)
        assert state["proposals"]["byId"]["a-1"]["lifecycle"] == "auditioning"
        assert state["session"]["committedLayers"] == []

    def _auditioning_commit_setup_only(self, service, project_id):
        store = service._actions
        with store._connect() as conn:
            row = conn.execute(
                "SELECT proposals_json FROM action_projection WHERE project_id = ?",
                (project_id,),
            ).fetchone()
            proposals = json.loads(row["proposals_json"])
            proposals["byId"]["a-1"]["lifecycle"] = "auditioning"
            conn.execute(
                "UPDATE action_projection SET proposals_json = ? WHERE project_id = ?",
                (json.dumps(proposals), project_id),
            )

    def test_commit_retry_returns_original_result(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        result = service.record_project_action(project_id, preview_action())
        asset = result["outcome"]["asset"]
        commit = {
            "id": "c-1",
            "schemaVersion": 1,
            "type": "commit_layer",
            "actor": {"type": "human", "id": "richard"},
            "requestedAt": "t",
            "idempotencyKey": "ck",
            "payload": {
                "proposalId": "a-1",
                "acceptedAt": "t2",
                "acceptedAsset": {
                    "id": asset["id"],
                    "contentHash": asset["contentHash"],
                    "transformSpec": asset["transformSpec"],
                },
            },
        }
        self._auditioning_commit_setup_only(service, project_id)
        first = service.record_project_action(project_id, commit)
        retry = service.record_project_action(project_id, commit)
        assert retry["idempotentReplay"] is True
        assert retry["outcome"] == first["outcome"]
        assert service.project_actions(project_id)["total"] == 2

    def test_pinned_asset_survives_gc(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        result = service.record_project_action(project_id, preview_action())
        asset = result["outcome"]["asset"]
        self._auditioning_commit_setup_only(service, project_id)
        commit = {
            "id": "c-1",
            "schemaVersion": 1,
            "type": "commit_layer",
            "actor": {"type": "human", "id": "richard"},
            "requestedAt": "t",
            "idempotencyKey": "ck",
            "payload": {
                "proposalId": "a-1",
                "acceptedAt": "t2",
                "acceptedAsset": {
                    "id": asset["id"],
                    "contentHash": asset["contentHash"],
                    "transformSpec": asset["transformSpec"],
                },
            },
        }
        service.record_project_action(project_id, commit)
        # Expire everything, then GC: pinned must survive.
        with service._connect() as conn:
            conn.execute("UPDATE ghost_assets SET expires_at = 1")
        removed = service.cleanup_ghost_assets()
        assert removed == 0
        path = service.ghost_asset_audio_path(asset["id"])
        assert path.is_file()


class TestGarbageCollection:
    def test_expired_unpinned_removed(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        result = service.record_project_action(project_id, preview_action())
        asset_id = result["outcome"]["asset"]["id"]
        path = service.ghost_asset_audio_path(asset_id)
        assert path.is_file()
        with service._connect() as conn:
            conn.execute("UPDATE ghost_assets SET expires_at = ? WHERE id = ?", (time.time() - 1, asset_id))
        removed = service.cleanup_ghost_assets()
        assert removed == 1
        assert not path.exists()
        from twobecomeone.common import NotFoundError
        with pytest.raises(NotFoundError):
            service.ghost_asset_audio_path(asset_id)

    def test_unexpired_unpinned_kept(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        service.record_project_action(project_id, preview_action())
        assert service.cleanup_ghost_assets() == 0


class TestAssetIsolation:
    def test_two_proposals_get_distinct_assets(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        r1 = service.record_project_action(project_id, preview_action(action_id="a-1", key="k-1"))
        r2 = service.record_project_action(
            project_id,
            preview_action(action_id="a-2", key="k-2", startBeat=0, endBeat=4),
        )
        id1 = r1["outcome"]["asset"]["id"]
        id2 = r2["outcome"]["asset"]["id"]
        assert id1 != id2
        p1 = service.ghost_asset_audio_path(id1)
        p2 = service.ghost_asset_audio_path(id2)
        assert p1 != p2

    def test_hash_matches_bytes(self, prepared_project):
        import hashlib
        service, project_id, anchor, lead = prepared_project
        result = service.record_project_action(project_id, preview_action())
        asset = result["outcome"]["asset"]
        path = service.ghost_asset_audio_path(asset["id"])
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        assert asset["contentHash"] == f"sha256:{digest}"

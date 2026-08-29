"""Phase 11A/11C: human commit (launch receipt) and append-only revert."""

import json
import struct
import time
import wave
from pathlib import Path

import pytest

from twobecomeone import actions as action_contract
from twobecomeone.common import ConflictError, NotFoundError
from twobecomeone.ghost_assets import GhostAssetPreparationError
from twobecomeone.studio import StudioService


def synth_wav(path: Path, *, seconds: float = 32.0, sr: int = 22050, freq: float = 220.0) -> Path:
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


def make_vocals_stem(service: StudioService, track_id: str, wav: Path) -> None:
    import hashlib

    track_sha256 = service._track_content_hash(track_id)
    stem_dir = service.stem_dir / f"set-{track_sha256[:12]}"
    stem_dir.mkdir(parents=True, exist_ok=True)
    stem_file = stem_dir / "vocals.wav"
    if not stem_file.exists():
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
    service = StudioService(tmp_path / "data")
    try:
        anchor_wav = synth_wav(tmp_path / "anchor.wav", freq=220.0, seconds=32.0)
        lead_wav = synth_wav(tmp_path / "lead.wav", freq=330.0, seconds=32.0)
        anchor = service.ingest(anchor_wav.open("rb"), "anchor.wav")
        lead = service.ingest(lead_wav.open("rb"), "lead.wav")
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


def commit_action(asset, action_id="c-1", key="ck", proposal_id="a-1"):
    return {
        "id": action_id,
        "schemaVersion": 1,
        "type": "commit_layer",
        "actor": {"type": "human", "id": "richard"},
        "requestedAt": "t",
        "idempotencyKey": key,
        "payload": {
            "proposalId": proposal_id,
            "acceptedAt": "2026-08-28T00:00:05Z",
            "acceptedAsset": {
                "id": asset["id"],
                "contentHash": asset["contentHash"],
                "transformSpec": asset["transformSpec"],
            },
        },
    }


def revert_action(commit_action_id, action_id="r-1", key="rk"):
    return {
        "id": action_id,
        "schemaVersion": 1,
        "type": "revert_commit",
        "actor": {"type": "human", "id": "richard"},
        "requestedAt": "t",
        "idempotencyKey": key,
        "payload": {
            "commitActionId": commit_action_id,
            "revertedAt": "2026-08-28T00:01:00Z",
        },
    }


def drive_to_auditioning(service, project_id, asset, proposal_id="a-1", launch_beat=32.0):
    service.record_proposal_lifecycle(
        project_id, proposal_id,
        {"to": "scheduled", "actor": {"type": "human", "id": "richard"}, "at": "t"},
    )
    service.record_proposal_lifecycle(
        project_id, proposal_id,
        {
            "to": "auditioning",
            "actor": {"type": "human", "id": "richard"},
            "at": "t",
            "fact": {
                "assetId": asset["id"],
                "contentHash": asset["contentHash"],
                "gridRevision": asset["transformSpec"]["destinationGridRevision"],
                "launchBeat": launch_beat,
            },
        },
    )


class TestCommitLaunchReceipt:
    def test_legacy_projection_adds_empty_reverted_layers(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        service.record_project_action(project_id, preview_action())
        with service._connect() as conn:
            row = conn.execute(
                "SELECT session_json FROM action_projection WHERE project_id = ?", (project_id,),
            ).fetchone()
            session = json.loads(row["session_json"])
            session.pop("revertedLayers", None)
            conn.execute(
                "UPDATE action_projection SET session_json = ? WHERE project_id = ?",
                (json.dumps(session), project_id),
            )
        assert service.project_action_state(project_id)["session"]["revertedLayers"] == []

    def test_commit_requires_auditioning_fact(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        result = service.record_project_action(project_id, preview_action())
        asset = result["outcome"]["asset"]
        # No auditioning fact recorded -> commit must fail (Amendment 6).
        with pytest.raises(ConflictError) as excinfo:
            service.record_project_action(project_id, commit_action(asset))
        assert excinfo.value.code == "L_NOT_AUDITIONING"

    def test_commit_requires_complete_launch_identity(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        result = service.record_project_action(project_id, preview_action())
        asset = result["outcome"]["asset"]
        service.record_proposal_lifecycle(
            project_id, "a-1",
            {"to": "scheduled", "actor": {"type": "human", "id": "richard"}, "at": "t"},
        )
        service.record_proposal_lifecycle(
            project_id, "a-1",
            {
                "to": "auditioning", "actor": {"type": "human", "id": "richard"},
                "at": "t", "fact": {"launchBeat": 32.0},
            },
        )
        with pytest.raises(ConflictError) as excinfo:
            service.record_project_action(project_id, commit_action(asset))
        assert excinfo.value.code == "S_ASSET_MISMATCH"

    def test_commit_retains_launch_receipt(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        result = service.record_project_action(project_id, preview_action())
        asset = result["outcome"]["asset"]
        drive_to_auditioning(service, project_id, asset, launch_beat=32.0)
        commit = service.record_project_action(project_id, commit_action(asset))
        assert commit["outcome"]["result"] == "proposal_committed"
        state = service.project_action_state(project_id)
        layer = state["session"]["committedLayers"][0]
        assert layer["launchReceipt"]["launchBeat"] == 32.0
        assert layer["launchReceipt"]["assetId"] == asset["id"]
        assert layer["launchReceipt"]["contentHash"] == asset["contentHash"]
        # launchAudioTime is NOT render authority and must be absent.
        assert "launchAudioTime" not in layer["launchReceipt"]

    def test_commit_receipt_survives_rebuild(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        result = service.record_project_action(project_id, preview_action())
        asset = result["outcome"]["asset"]
        drive_to_auditioning(service, project_id, asset, launch_beat=32.0)
        service.record_project_action(project_id, commit_action(asset))
        rebuilt = service._actions.rebuild_projection(project_id)
        layer = rebuilt["session"]["committedLayers"][0]
        assert layer["launchReceipt"]["launchBeat"] == 32.0

    def test_commit_idempotent_no_duplicate_layer(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        result = service.record_project_action(project_id, preview_action())
        asset = result["outcome"]["asset"]
        drive_to_auditioning(service, project_id, asset)
        commit = commit_action(asset)
        first = service.record_project_action(project_id, commit)
        retry = service.record_project_action(project_id, commit)
        assert retry["idempotentReplay"] is True
        state = service.project_action_state(project_id)
        assert len(state["session"]["committedLayers"]) == 1
        assert len(state["session"]["acceptedActionIds"]) == 1


class TestRevertCommit:
    def _committed(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        result = service.record_project_action(project_id, preview_action())
        asset = result["outcome"]["asset"]
        drive_to_auditioning(service, project_id, asset)
        service.record_project_action(project_id, commit_action(asset))
        return service, project_id, asset

    def test_revert_moves_layer_and_retains_provenance(self, prepared_project):
        service, project_id, asset = self._committed(prepared_project)
        result = service.record_project_action(project_id, revert_action("c-1"))
        assert result["outcome"]["result"] == "commit_reverted"
        state = service.project_action_state(project_id)
        assert state["session"]["committedLayers"] == []
        assert len(state["session"]["revertedLayers"]) == 1
        reverted = state["session"]["revertedLayers"][0]
        assert reverted["actionId"] == "c-1"
        assert reverted["revertedBy"] == "r-1"
        # Full provenance retained (asset identity + launch receipt).
        assert reverted["acceptedAsset"]["id"] == asset["id"]
        assert reverted["launchReceipt"]["launchBeat"] == 32.0
        # Proposal stays terminal accepted with committedActionId intact.
        proposal = state["proposals"]["byId"]["a-1"]
        assert proposal["lifecycle"] == "accepted"
        assert proposal["committedActionId"] == "c-1"

    def test_revert_is_append_only(self, prepared_project):
        service, project_id, asset = self._committed(prepared_project)
        service.record_project_action(project_id, revert_action("c-1"))
        # The commit row and pinned asset are untouched.
        actions = service.project_actions(project_id)
        types = [a["type"] for a in actions["items"]]
        assert types.count("commit_layer") == 1
        assert types.count("revert_commit") == 1
        stored = service._ghost_assets.get_asset(project_id, asset["id"])
        assert stored["pinned"] is True

    def test_revert_replay_is_noop(self, prepared_project):
        service, project_id, asset = self._committed(prepared_project)
        first = service.record_project_action(project_id, revert_action("c-1"))
        assert first["outcome"]["result"] == "commit_reverted"
        # Exact replay (same envelope) is idempotent.
        retry = service.record_project_action(project_id, revert_action("c-1"))
        assert retry["idempotentReplay"] is True
        # A DIFFERENT revert of the same commit is rejected with zero mutation.
        with pytest.raises(ConflictError) as excinfo:
            service.record_project_action(
                project_id, revert_action("c-1", action_id="r-2", key="rk2")
            )
        assert excinfo.value.code == "L_ALREADY_REVERTED"
        state = service.project_action_state(project_id)
        assert len(state["session"]["revertedLayers"]) == 1
        actions = service.project_actions(project_id)
        assert [a["type"] for a in actions["items"]].count("revert_commit") == 1

    def test_revert_unknown_commit_404(self, prepared_project):
        service, project_id, asset = self._committed(prepared_project)
        with pytest.raises(NotFoundError) as excinfo:
            service.record_project_action(project_id, revert_action("nope"))
        assert excinfo.value.code == "L_UNKNOWN_COMMIT"

    def test_producer_cannot_revert(self, prepared_project):
        service, project_id, asset = self._committed(prepared_project)
        action = revert_action("c-1")
        action["actor"] = {"type": "producer", "id": "auto"}
        with pytest.raises(ConflictError) as excinfo:
            service.record_project_action(project_id, action)
        assert excinfo.value.code == "P_ACTOR_NOT_ALLOWED"

    def test_revert_survives_rebuild(self, prepared_project):
        service, project_id, asset = self._committed(prepared_project)
        service.record_project_action(project_id, revert_action("c-1"))
        rebuilt = service._actions.rebuild_projection(project_id)
        assert rebuilt["session"]["committedLayers"] == []
        assert len(rebuilt["session"]["revertedLayers"]) == 1


class TestRevertValidation:
    def test_revert_payload_validation(self):
        # Missing commitActionId.
        with pytest.raises(action_contract.ActionValidationError) as excinfo:
            action_contract.validate_action({
                "id": "r", "schemaVersion": 1, "type": "revert_commit",
                "actor": {"type": "human", "id": "x"}, "requestedAt": "t",
                "idempotencyKey": "k", "payload": {"revertedAt": "t2"},
            })
        assert excinfo.value.node_code == "V_MISSING_COMMIT_ACTION_ID"
        # Unknown key.
        with pytest.raises(action_contract.ActionValidationError) as excinfo:
            action_contract.validate_action({
                "id": "r", "schemaVersion": 1, "type": "revert_commit",
                "actor": {"type": "human", "id": "x"}, "requestedAt": "t",
                "idempotencyKey": "k",
                "payload": {"commitActionId": "c", "revertedAt": "t2", "extra": 1},
            })
        assert excinfo.value.node_code == "V_UNEXPECTED_PAYLOAD_KEY"

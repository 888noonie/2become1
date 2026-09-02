"""Phase 12A.0: single committed-layer live-action gate (L_LAYER_LIMIT).

The live committed-layer engine is designed for exactly one layer under the
fixed musical policy. The backend must reject a second *live* commit while a
committed layer exists, with a stable conflict code. Append-only history is
never rewritten: a revert frees the slot, an idempotent retry of the SAME
commit envelope is still its durable success, and a rebuild replay of a legacy
multi-layer ledger stays tolerated.
"""

import struct
import time
import wave
from pathlib import Path

import pytest

from twobecomeone.common import ConflictError
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
    import json

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


def preview_action(action_id="a-1", key="k-1"):
    return {
        "id": action_id,
        "schemaVersion": 1,
        "type": "preview_layer",
        "actor": {"type": "human", "id": "richard"},
        "requestedAt": "2026-08-28T00:00:00Z",
        "idempotencyKey": key,
        "payload": {
            "source": {"deck": "A", "stem": "vocal", "region": {"id": "verse_1", "startBeat": 0, "endBeat": 8, "gridRevision": "grid-1"}},
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
        "payload": {"commitActionId": commit_action_id, "revertedAt": "2026-08-28T00:01:00Z"},
    }


def audition(service, project_id, action_id, key, launch_beat=32.0):
    """Author a preview (which prepares the server asset), record scheduled
    + auditioning facts, and return the prepared asset."""
    result = service.record_project_action(project_id, preview_action(action_id, key))
    asset = result["outcome"]["asset"]
    proposal_id = result["outcome"]["proposal"]["id"]
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
    return asset, proposal_id


def test_second_live_commit_is_rejected_with_layer_limit(prepared_project):
    service, project_id, anchor, lead = prepared_project
    asset_one, proposal_one = audition(service, project_id, "a-live", "k-live")
    commit_one = service.record_project_action(
        project_id, commit_action(asset_one, action_id="c-1", key="ck-1", proposal_id=proposal_one),
    )
    assert commit_one["outcome"]["result"] == "proposal_committed"
    assert len(service.project_action_state(project_id)["session"]["committedLayers"]) == 1

    asset_two, proposal_two = audition(service, project_id, "a-live-2", "k-live-2", launch_beat=64.0)
    with pytest.raises(ConflictError) as excinfo:
        service.record_project_action(
            project_id,
            commit_action(asset_two, action_id="c-2", key="ck-2", proposal_id=proposal_two),
        )
    assert excinfo.value.code == "L_LAYER_LIMIT"
    # The failed commit must not leave a second committed layer behind.
    assert len(service.project_action_state(project_id)["session"]["committedLayers"]) == 1


def test_revert_then_recommit_is_allowed(prepared_project):
    service, project_id, anchor, lead = prepared_project
    asset_one, proposal_one = audition(service, project_id, "a-live", "k-live")
    service.record_project_action(
        project_id, commit_action(asset_one, action_id="c-1", key="ck-1", proposal_id=proposal_one),
    )
    service.record_project_action(project_id, revert_action("c-1", action_id="r-1", key="rk-1"))
    assert len(service.project_action_state(project_id)["session"]["committedLayers"]) == 0

    asset_two, proposal_two = audition(service, project_id, "a-live-2", "k-live-2", launch_beat=64.0)
    commit_two = service.record_project_action(
        project_id,
        commit_action(asset_two, action_id="c-2", key="ck-2", proposal_id=proposal_two),
    )
    assert commit_two["outcome"]["result"] == "proposal_committed"
    assert len(service.project_action_state(project_id)["session"]["committedLayers"]) == 1


def test_idempotent_retry_of_same_commit_envelope_is_still_success(prepared_project):
    service, project_id, anchor, lead = prepared_project
    asset_one, proposal_one = audition(service, project_id, "a-live", "k-live")
    action = commit_action(asset_one, action_id="c-1", key="ck-1", proposal_id=proposal_one)
    result_one = service.record_project_action(project_id, action)
    assert result_one["outcome"]["result"] == "proposal_committed"
    # Same id/idempotencyKey/payload: the idempotency replay path must return
    # the original durable outcome, NOT an L_LAYER_LIMIT failure.
    result_two = service.record_project_action(project_id, action)
    assert result_two["idempotentReplay"] is True
    assert len(service.project_action_state(project_id)["session"]["committedLayers"]) == 1


def test_rebuild_projection_tolerates_legacy_multi_layer_ledger(prepared_project):
    """Rebuild replay must tolerate a historical multi-layer ledger.

    The cap is a live-action gate on the commit path, not a projection rule:
    rebuilding a ledger that contains legacy committed layers (however many)
    must not fail and must not rewrite history.
    """
    service, project_id, anchor, lead = prepared_project
    asset_one, proposal_one = audition(service, project_id, "a-live", "k-live")
    service.record_project_action(
        project_id, commit_action(asset_one, action_id="c-1", key="ck-1", proposal_id=proposal_one),
    )
    asset_two, proposal_two = audition(service, project_id, "a-live-2", "k-live-2", launch_beat=64.0)
    # A second live commit is now impossible by the gate under test, so a
    # legacy two-layer ledger can only exist pre-gate. Craft it the way the
    # pre-gate code would have left it: two commit facts in the ledger.
    import json as json_mod
    with service._connect() as conn:
        row = conn.execute(
            "SELECT outcome_json, recorded_at FROM actions WHERE id = 'c-1'",
        ).fetchone()
        legacy_outcome = row["outcome_json"]
        legacy_recorded = row["recorded_at"]
        max_row = conn.execute(
            "SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM actions WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        legacy_sequence = max_row["max_seq"]
    # payload_json holds ONLY the payload (see _stored_action: json.loads(row["payload_json"]) -> payload)
    with service._connect() as conn:
        conn.execute(
            "INSERT INTO actions ("
            " sequence, id, project_id, schema_version, type, actor_type,"
            " actor_id, requested_at, idempotency_key, payload_json,"
            " outcome_json, recorded_at"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                legacy_sequence + 1,
                "c-legacy", project_id, 1, "commit_layer", "human", "richard",
                "t-legacy", "ck-legacy",
                json_mod.dumps({
                    "proposalId": proposal_two,
                    "acceptedAt": "2026-08-28T00:00:05Z",
                    "acceptedAsset": {
                        "id": asset_two["id"],
                        "contentHash": asset_two["contentHash"],
                        "transformSpec": asset_two["transformSpec"],
                    },
                }),
                legacy_outcome,
                legacy_recorded + 1,
            ),
        )
    rebuilt = service._actions.rebuild_projection(project_id)
    committed = rebuilt["session"]["committedLayers"]
    # History is never rewritten: both legacy layers remain in the rebuild.
    assert len(committed) == 2
    assert {layer["actionId"] for layer in committed} == {"c-1", "c-legacy"}
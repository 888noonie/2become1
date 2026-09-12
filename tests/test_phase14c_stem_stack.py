"""Phase 14C: preview/commit one prepared stem stack."""

from __future__ import annotations

import json
import math
import struct
import wave
from pathlib import Path

import pytest

from twobecomeone.actions import validate_action
from twobecomeone.common import ConflictError, UserError
from twobecomeone.migrations import latest_version
from twobecomeone.stem_stack import STACK_SAMPLE_RATE, StemStackError
from twobecomeone.studio import StudioService
from test_phase11a_commit import drive_to_auditioning, make_vocals_stem, revert_action, synth_wav
from test_phase14b1_stem_crate import create_crate_item, make_ffmpeg_stems


def stack_component(item, role, **overrides):
    payload = {
        "crateItemId": item["id"],
        "expected": {
            "contentSha256": item["content_sha256"],
            "gridRevision": item["grid_revision"],
            "stemName": item["stem_name"],
            "stemSetId": item["stem_set_id"],
        },
        "role": role,
        "loopBars": item["loop_bars"],
        "gainDb": 0,
    }
    payload.update(overrides)
    return payload


def preview_stack(components, action_id="s-1", key="sk-1", destination_bars=2):
    return {
        "id": action_id,
        "schemaVersion": 1,
        "type": "preview_stem_stack",
        "actor": {"type": "human", "id": "richard"},
        "requestedAt": "2026-09-12T00:00:00Z",
        "idempotencyKey": key,
        "payload": {
            "components": components,
            "destinationBars": destination_bars,
            "timing": {"launch": "next_phrase", "quantize": True},
        },
    }


def commit_stack(asset, action_id="cs-1", key="csk", proposal_id="s-1"):
    return {
        "id": action_id,
        "schemaVersion": 1,
        "type": "commit_stem_stack",
        "actor": {"type": "human", "id": "richard"},
        "requestedAt": "t",
        "idempotencyKey": key,
        "payload": {
            "proposalId": proposal_id,
            "acceptedAt": "2026-09-12T00:00:05Z",
            "acceptedAsset": {
                "id": asset["id"],
                "contentHash": asset["contentHash"],
                "transformSpec": asset["transformSpec"],
            },
        },
    }


def click_wav(path: Path, *, seconds=8.0, sr=22050, period=0.5) -> Path:
    frames = bytearray()
    for index in range(int(sr * seconds)):
        t = index / sr
        click = 0.9 if (t % period) < 0.01 else 0.0
        value = int(click * 20000)
        frames += struct.pack("<hh", value, value)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(sr)
        output.writeframes(bytes(frames))
    return path


@pytest.fixture
def stack_service(tmp_path):
    service = StudioService(tmp_path / "data")
    try:
        voice_wav = synth_wav(tmp_path / "voice.wav", freq=880.0, seconds=16.0)
        other_wav = click_wav(tmp_path / "other.wav", seconds=16.0)
        voice_track = service.ingest(voice_wav.open("rb"), "voice.wav")
        other_track = service.ingest(other_wav.open("rb"), "other.wav")
        make_vocals_stem(service, voice_track["id"], voice_wav)
        other_set = make_ffmpeg_stems(service, other_track["id"], other_wav)
        voice_set = f"set-{service._track_content_hash(voice_track['id'])[:12]}"
        voice_item = create_crate_item(
            service, track_id=voice_track["id"], stem_set_id=voice_set,
            stem_name="vocals", role="voice", loop_bars=2,
            region_start_beat=0.0, region_end_beat=8.0,
        )
        other_item = create_crate_item(
            service, track_id=other_track["id"], stem_set_id=other_set,
            stem_name="center", role="other", loop_bars=2,
            region_start_beat=0.0, region_end_beat=8.0,
        )
        project = service.create_project("Stack mix")
        yield service, project["id"], voice_item, other_item
    finally:
        service.close()


def test_migration_12_creates_stem_stack_assets(tmp_path):
    service = StudioService(tmp_path / "data")
    try:
        with service._connect() as conn:
            tables = {
                row[0] for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
        assert "stem_stack_assets" in tables
        assert latest_version() == 12
    finally:
        service.close()


def test_contract_rejects_empty_and_five_components():
    empty = preview_stack([])
    with pytest.raises(UserError) as exc:
        validate_action(empty)
    assert exc.value.code == "V_INVALID_COMPONENT_COUNT"
    extra = preview_stack([
        stack_component({"id": str(i), "content_sha256": "h", "grid_revision": "g",
                         "stem_name": "vocals", "stem_set_id": "s", "loop_bars": 2}, "voice")
        for i in range(5)
    ])
    # Duplicate roles also fire first; force unique roles then overflow count.
    roles = ["beat", "bass", "other", "voice", "voice"]
    extra["payload"]["components"] = [
        stack_component(
            {"id": f"c{i}", "content_sha256": "h", "grid_revision": "g",
             "stem_name": "vocals", "stem_set_id": "s", "loop_bars": 2},
            roles[i],
        )
        for i in range(5)
    ]
    with pytest.raises(UserError) as exc:
        validate_action(extra)
    assert exc.value.code in ("V_INVALID_COMPONENT_COUNT", "V_DUPLICATE_ROLE")


def test_contract_rejects_duplicate_role_and_bool_gain():
    item = {"id": "a", "content_sha256": "h", "grid_revision": "g",
            "stem_name": "vocals", "stem_set_id": "s", "loop_bars": 2}
    action = preview_stack([
        stack_component(item, "voice"),
        stack_component({**item, "id": "b"}, "voice"),
    ])
    with pytest.raises(UserError) as exc:
        validate_action(action)
    assert exc.value.code == "V_DUPLICATE_ROLE"
    bad = preview_stack([stack_component(item, "voice", gainDb=True)])
    with pytest.raises(UserError) as exc:
        validate_action(bad)
    assert exc.value.code == "V_INVALID_GAIN"


def test_prepare_mixes_stereo_44100_and_keeps_component_onsets(stack_service):
    service, project_id, voice_item, other_item = stack_service
    result = service.record_project_action(project_id, preview_stack([
        stack_component(voice_item, "voice"),
        stack_component(other_item, "other"),
    ]))
    asset = result["outcome"]["asset"]
    assert asset["id"].startswith("ss-")
    assert asset["contentHash"].startswith("sha256:")
    assert asset["transformSpec"]["kind"] == "stem_stack"
    assert asset["transformSpec"]["sampleRate"] == STACK_SAMPLE_RATE
    assert asset["transformSpec"]["channels"] == 2
    assert len(asset["transformSpec"]["components"]) == 2
    path = service.stem_stack_audio_path(asset["id"])
    with wave.open(str(path), "rb") as handle:
        assert handle.getnchannels() == 2
        assert handle.getframerate() == STACK_SAMPLE_RATE
        frames = handle.readframes(handle.getnframes())
    samples = struct.unpack("<" + "h" * (len(frames) // 2), frames)
    peak = max(abs(sample) for sample in samples)
    assert peak > 1000
    dest_bpm = float(voice_item["effective_bpm"])
    dest_seconds = 8 * 60.0 / dest_bpm
    duration = asset["transformSpec"]["semanticRegion"]["endBeat"] * 60.0 / dest_bpm
    assert math.isclose(duration, dest_seconds, rel_tol=0.05)


def test_stale_crate_hash_is_fail_closed(stack_service):
    service, project_id, voice_item, other_item = stack_service
    component = stack_component(voice_item, "voice")
    component["expected"]["contentSha256"] = "sha256:" + "0" * 64
    with pytest.raises(StemStackError) as exc:
        service.record_project_action(project_id, preview_stack([component]))
    assert exc.value.code == "S_STALE_CRATE"


def test_ffmpeg_center_cannot_occupy_voice(stack_service):
    service, project_id, _voice_item, other_item = stack_service
    with pytest.raises(StemStackError) as exc:
        service.record_project_action(project_id, preview_stack([
            stack_component(other_item, "voice"),
        ]))
    assert exc.value.code == "V_INVALID_ROLE"


def test_commit_undo_and_second_layer_limit(stack_service):
    service, project_id, voice_item, other_item = stack_service
    preview = service.record_project_action(project_id, preview_stack([
        stack_component(voice_item, "voice"),
        stack_component(other_item, "other"),
    ]))
    asset = preview["outcome"]["asset"]
    with pytest.raises(ConflictError) as exc:
        service.record_project_action(project_id, commit_stack(asset))
    assert exc.value.code == "L_NOT_AUDITIONING"
    drive_to_auditioning(service, project_id, asset, proposal_id="s-1", launch_beat=8.0)
    commit = service.record_project_action(project_id, commit_stack(asset))
    assert commit["outcome"]["result"] == "proposal_committed"
    state = service.project_action_state(project_id)
    layer = state["session"]["committedLayers"][0]
    assert layer["kind"] == "stem_stack"
    assert layer["actionType"] == "commit_stem_stack"
    preview2 = service.record_project_action(project_id, preview_stack(
        [stack_component(voice_item, "voice")],
        action_id="s-2", key="sk-2",
    ))
    asset2 = preview2["outcome"]["asset"]
    drive_to_auditioning(service, project_id, asset2, proposal_id="s-2", launch_beat=8.0)
    with pytest.raises(ConflictError) as exc:
        service.record_project_action(project_id, commit_stack(asset2, action_id="cs-2", key="csk2", proposal_id="s-2"))
    assert exc.value.code == "L_LAYER_LIMIT"
    service.record_project_action(project_id, revert_action(commit["outcome"].get("committedActionId") or layer["actionId"]))
    state = service.project_action_state(project_id)
    assert state["session"]["committedLayers"] == []
    assert state["session"]["revertedLayers"][0]["kind"] == "stem_stack"


def test_producer_cannot_preview_or_commit_stack(stack_service):
    service, project_id, voice_item, _other = stack_service
    action = preview_stack([stack_component(voice_item, "voice")])
    action["actor"] = {"type": "producer", "id": "bot"}
    with pytest.raises(ConflictError) as exc:
        service.record_project_action(project_id, action)
    assert exc.value.code == "P_PRODUCER_PREVIEW_DENIED"


def test_prepared_file_is_cleaned_when_append_fails(stack_service, monkeypatch):
    service, project_id, voice_item, other_item = stack_service
    original = service._stem_stack.register_prepared

    def boom(preparation, conn):
        raise RuntimeError("registry boom")

    monkeypatch.setattr(service._stem_stack, "register_prepared", boom)
    with pytest.raises(RuntimeError):
        service.record_project_action(project_id, preview_stack([
            stack_component(voice_item, "voice"),
            stack_component(other_item, "other"),
        ]))
    leftover = list((service.data_dir / "stem_stack_assets").glob("ss-*.wav"))
    assert leftover == []
    monkeypatch.setattr(service._stem_stack, "register_prepared", original)

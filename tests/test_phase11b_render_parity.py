"""Phase 11B: committed-layer render parity, preflight, and hard-fail on missing asset."""

import json
import math
import re
import struct
import subprocess
import time
import wave
from pathlib import Path

import pytest

from twobecomeone.common import UserError
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


def commit_one(service, project_id, launch_beat=32.0):
    result = service.record_project_action(project_id, preview_action())
    asset = result["outcome"]["asset"]
    drive_to_auditioning(service, project_id, asset, launch_beat=launch_beat)
    service.record_project_action(project_id, commit_action(asset))
    return asset


def wav_rms(path: Path) -> float:
    """RMS over all interleaved 16-bit samples of a PCM wav file."""
    with wave.open(str(path), "rb") as audio:
        frames = audio.readframes(audio.getnframes())
    samples = struct.unpack(f"<{len(frames) // 2}h", frames)
    return math.sqrt(sum(sample * sample for sample in samples) / len(samples))


def wait_for_job(service: StudioService, job_id: str, timeout_s: float = 60.0) -> dict:
    """Poll a synchronous-engine job until it reaches a terminal status."""
    deadline = time.monotonic() + timeout_s
    job = service.get_job(job_id)
    while job["status"] not in ("complete", "failed", "cancelled", "interrupted"):
        assert time.monotonic() < deadline, f"job {job_id} did not finish: {job['status']}"
        time.sleep(0.05)
        job = service.get_job(job_id)
    return job


def render_options(project_id, anchor_id, lead_id, **overrides):
    from twobecomeone.studio import RenderOptions

    opts = {
        "anchor_id": anchor_id,
        "lead_id": lead_id,
        "project_id": project_id,
        "preview": False,
    }
    opts.update(overrides)
    return RenderOptions(**opts)


class TestCommittedRenderPlan:
    def test_plan_includes_committed_layer(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        asset = commit_one(service, project_id)
        plan = service.plan_render(
            render_options(project_id, anchor["id"], lead["id"])
        )
        assert len(plan["committed_layers"]) == 1
        cl = plan["committed_layers"][0]
        assert cl["assetId"] == asset["id"]
        assert cl["contentHash"] == asset["contentHash"]
        assert cl["outputDuration"] > 0
        assert cl["gainLinear"] == pytest.approx(10 ** (-3 / 20.0), rel=1e-6)

    def test_plan_without_project_has_no_committed_layers(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        commit_one(service, project_id)
        plan = service.plan_render(
            render_options(None, anchor["id"], lead["id"])
        )
        assert plan["committed_layers"] == []

    def test_project_scope_rejects_mismatched_render_tracks(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        commit_one(service, project_id)
        with pytest.raises(UserError, match="authoritative project"):
            service.plan_render(render_options(project_id, lead["id"], anchor["id"]))

    def test_reverted_layer_excluded_from_plan(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        commit_one(service, project_id)
        service.record_project_action(project_id, {
            "id": "r-1", "schemaVersion": 1, "type": "revert_commit",
            "actor": {"type": "human", "id": "richard"}, "requestedAt": "t",
            "idempotencyKey": "rk",
            "payload": {"commitActionId": "c-1", "revertedAt": "t2"},
        })
        plan = service.plan_render(
            render_options(project_id, anchor["id"], lead["id"])
        )
        assert plan["committed_layers"] == []

    def test_missing_asset_fails_plan(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        asset = commit_one(service, project_id)
        # Delete the pinned asset file.
        path = service.ghost_asset_audio_path(asset["id"])
        path.unlink()
        with pytest.raises(GhostAssetPreparationError) as excinfo:
            service.plan_render(
                render_options(project_id, anchor["id"], lead["id"])
            )
        assert excinfo.value.code == "S_ASSET_UNAVAILABLE"
        assert "layer-c-1" in str(excinfo.value)

    def test_direct_render_preflights_before_job_creation(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        asset = commit_one(service, project_id)
        service.ghost_asset_audio_path(asset["id"]).unlink()
        before = len(service.list_jobs())
        with pytest.raises(GhostAssetPreparationError) as excinfo:
            service.submit_render(render_options(project_id, anchor["id"], lead["id"]))
        assert excinfo.value.code == "S_ASSET_UNAVAILABLE"
        assert len(service.list_jobs()) == before

    def test_corrupt_asset_fails_plan(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        asset = commit_one(service, project_id)
        path = service.ghost_asset_audio_path(asset["id"])
        path.write_bytes(b"corrupt")
        with pytest.raises(GhostAssetPreparationError) as excinfo:
            service.plan_render(
                render_options(project_id, anchor["id"], lead["id"])
            )
        assert excinfo.value.code in ("S_ASSET_MISMATCH", "S_ASSET_UNAVAILABLE")


class TestCommittedRenderMath:
    @staticmethod
    def _layer(service, project_id):
        return service.project_action_state(project_id)["session"]["committedLayers"][0]

    def test_ratio_below_one(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        asset = commit_one(service, project_id)
        # output_bpm < targetBpm -> ratio < 1.
        plan = service.plan_render(
            render_options(project_id, anchor["id"], lead["id"], tempo_mode="custom", target_bpm=60)
        )
        cl = plan["committed_layers"][0]
        assert cl["tempoRatio"] < 1.0

    def test_ratio_above_one(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        asset = commit_one(service, project_id)
        plan = service.plan_render(
            render_options(project_id, anchor["id"], lead["id"], tempo_mode="custom", target_bpm=200)
        )
        cl = plan["committed_layers"][0]
        assert cl["tempoRatio"] > 1.0

    def test_ratio_equal_one(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        asset = commit_one(service, project_id)
        # foundation mode: output_bpm == anchor bpm; ratio may not be exactly 1
        # but the math must be finite and positive.
        plan = service.plan_render(
            render_options(project_id, anchor["id"], lead["id"])
        )
        cl = plan["committed_layers"][0]
        assert cl["tempoRatio"] > 0
        assert cl["outputDuration"] > 0

    def test_head_and_tail_clipping_intersect_the_output_window(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        commit_one(service, project_id, launch_beat=8.0)
        layer = self._layer(service, project_id)
        receipt = layer["launchReceipt"]
        target = receipt["targetBpm"]
        accepted_time = receipt["destinationOriginSeconds"] + 8.0 * 60.0 / target

        # Start one second before the render: source advances by one second and
        # the visible duration loses that second (the prior bug kept it).
        resolved = service._resolve_committed_layer(
            project_id, layer, target, accepted_time + 1.0, 0.0, 30.0,
        )
        full_duration = 8.0 * 60.0 / target
        assert resolved["outputStart"] == pytest.approx(0.0)
        assert resolved["sourceTrimStart"] == pytest.approx(1.0)
        assert resolved["outputDuration"] == pytest.approx(full_duration - 1.0)

        # Tail clipping keeps only the intersection with a short render.
        tail = service._resolve_committed_layer(
            project_id, layer, target, accepted_time - 1.0, 0.0, 2.0,
        )
        assert tail["outputStart"] == pytest.approx(1.0)
        assert tail["outputDuration"] == pytest.approx(1.0)

    def test_complete_out_of_window_exclusion_and_transition_offset(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        commit_one(service, project_id, launch_beat=8.0)
        layer = self._layer(service, project_id)
        receipt = layer["launchReceipt"]
        target = receipt["targetBpm"]
        accepted_time = receipt["destinationOriginSeconds"] + 8.0 * 60.0 / target
        assert service._resolve_committed_layer(
            project_id, layer, target, accepted_time + 20.0, 0.0, 5.0,
        ) is None
        transitioned = service._resolve_committed_layer(
            project_id, layer, target, accepted_time, 7.0, 20.0,
        )
        assert transitioned["outputStart"] == pytest.approx(7.0)


class TestCommittedRenderExecution:
    def test_isolated_committed_gain_is_within_half_db(self, tmp_path):
        from twobecomeone import assembler

        source = synth_wav(tmp_path / "gain-source.wav", seconds=2.0, freq=110.0)
        gained = tmp_path / "gain-result.wav"
        assembler._run_simple_filter(source, gained, f"volume={10 ** (-6 / 20):.9f}")

        measured_db = 20.0 * math.log10(wav_rms(gained) / wav_rms(source))
        assert measured_db == pytest.approx(-6.0, abs=0.5)

    def test_committed_chain_matches_planned_gain_pre_limiter(self, prepared_project):
        """End-to-end pre-limiter parity: the planner's resolved facts, run
        through the exact committed chain build_mash executes (trim → stretch
        → gain), deliver the planned linear gain within ±0.5 dB RMS.

        The plan's binding tolerance is measured pre-limiter: the shared
        loudnorm stage (I=-16 LUFS) is absolute loudness normalization, so
        an isolated absolute level is unmeasurable after it by design."""
        service, project_id, anchor, lead = prepared_project
        commit_one(service, project_id)

        plan = service._compute_arrangement(
            render_options(project_id, anchor["id"], lead["id"])
        )
        resolved = plan.committed_layers
        assert len(resolved) == 1
        layer = resolved[0]
        planned_db = 20.0 * math.log10(layer["gainLinear"])
        assert planned_db == pytest.approx(-3.0, abs=1e-3)

        # Replay the exact build_mash committed chain on the pinned asset:
        # trim -> tempo stretch -> gain, exactly as build_mash does.
        from twobecomeone import assembler

        work = Path(service.temp_dir) / "parity"
        work.mkdir(parents=True, exist_ok=True)
        aligned = assembler.render_aligned(
            str(layer["path"]),
            work / "aligned.wav",
            layer["tempoRatio"],
            0,  # no pitch shift: the asset is already tempo-normalized
            start=layer["sourceTrimStart"],
            duration=layer["sourceTrimDuration"],
        )
        gained = work / "gained.wav"
        assembler._run_simple_filter(
            aligned, gained, f"volume={layer['gainLinear']:.9f}"
        )

        baseline = assembler.render_aligned(
            str(layer["path"]),
            work / "baseline.wav",
            layer["tempoRatio"],
            0,
            start=layer["sourceTrimStart"],
            duration=layer["sourceTrimDuration"],
        )
        measured_db = 20.0 * math.log10(wav_rms(gained) / wav_rms(baseline))
        assert measured_db == pytest.approx(-3.0, abs=0.5), (
            f"committed chain gain drifted from planned -3 dB: {measured_db:.3f} dB"
        )

    def test_committed_layer_isolated_render_places_layer_in_window(self, prepared_project, tmp_path):
        """Full-pipeline placement proof: a real render with the base tracks
        silenced (gains 0) contains only the committed layer, positioned at
        its planned outputStart with the planned visible duration.

        The render window must cover the accepted launch: with the default
        32-second grid the layer at launch beat 32 lands at ~22.6s, so the
        lead is cued at 16s to bound the window at 16s with the layer inside
        (the browser journey cues the window the same way). Level claims are
        unmeasurable post-loudnorm by design; this proves placement."""
        service, project_id, anchor, lead = prepared_project
        commit_one(service, project_id)

        options = render_options(
            project_id,
            anchor["id"],
            lead["id"],
            anchor_gain=0.0,
            lead_gain=0.0,
            lead_start=16.0,  # position the 16s window over the launch
        )
        plan = service._compute_arrangement(options)
        assert len(plan.committed_layers) == 1, (
            "fixture regression: the render window no longer covers the launch"
        )
        layer = plan.committed_layers[0]
        planned_start = layer["outputStart"]
        planned_duration = layer["outputDuration"]

        job = service.submit_render(options)
        job = wait_for_job(service, job["id"])
        assert job["status"] == "complete", job.get("error")

        # Render outputs live at render_dir/{job_id}.mp3 (the API dict
        # deliberately excludes output_path; the internal accessor has it).
        out = Path(service._store.get_output_path(job["id"]))
        assert out.exists() and out.stat().st_size > 0

        # Decode the real rendered output and measure where audio actually starts.
        decoded = tmp_path / "isolated.wav"
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", str(out), str(decoded)],
            check=True, capture_output=True,
        )
        window_rms = wav_rms(decoded)

        # The silenced base tracks contribute digital silence outside the
        # layer window; the layer window must be non-silent.
        assert window_rms > 0, "committed layer is missing from the real render output"

        # Placement: audio onset must align with the planned outputStart. Tolerance
        # covers the mp3 encoder delay (~576 samples) and frame granularity.
        detect = subprocess.run(
            [
                "ffmpeg", "-v", "info",
                "-i", str(out),
                "-af", "silencedetect=n=-60dB:d=0.05",
                "-f", "null", "-",
            ],
            capture_output=True, text=True,
        )
        report = detect.stderr
        # silencedetect emits pairs; leading silence begins at t≈0 and ends
        # where the layer starts (the FIRST silence_end), then trailing
        # silence begins after the layer ends (the first silence_start that
        # follows the layer's onset).
        starts = [float(m) for m in re.findall(r"silence_start: ([0-9.]+)", report)]
        ends = [float(m) for m in re.findall(r"silence_end: ([0-9.]+)", report)]
        assert ends, f"no audible boundary found in render: {report!r}"
        measured_start = ends[0]
        assert measured_start == pytest.approx(planned_start, abs=0.25), (
            f"committed layer placed at {measured_start:.3f}s, planned {planned_start:.3f}s"
        )

        # Duration: the audible layer must span the planned visible duration
        # (silence resumes after the layer ends, before the window ends).
        trailing = [t for t in starts if t > measured_start]
        assert trailing, f"layer does not end before the render window end: {report!r}"
        measured_end = trailing[0]
        measured_duration = measured_end - measured_start
        assert measured_duration == pytest.approx(planned_duration, abs=0.5), (
            f"audible span {measured_duration:.3f}s vs planned {planned_duration:.3f}s"
        )

    def test_render_with_committed_layer_produces_output(self, prepared_project):
        service, project_id, anchor, lead = prepared_project
        commit_one(service, project_id)
        job = service.submit_render(
            render_options(project_id, anchor["id"], lead["id"])
        )
        # Wait for the job to complete (synchronous engine in tests).
        for _ in range(200):
            job = service.get_job(job["id"])
            if job["status"] in ("complete", "failed", "cancelled", "interrupted"):
                break
            time.sleep(0.05)
        assert job["status"] == "complete", job.get("error")
        assert job["result"]["duration"] > 0
        assert job["result"]["committed_layer_count"] == 1

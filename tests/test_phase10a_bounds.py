"""Phase 10A: region span bounds and media-duration validation (A6).

Uses real ffmpeg against synthetic WAVs inside tmp_path; fixture stems here
are 32s like the Phase 9B prepared_project so detected-BPM noise cannot push
a 1-64 beat region past the media edge.
"""

import json
import struct
import time
import wave
from pathlib import Path

import pytest

from twobecomeone.common import ConflictError, NotFoundError
from twobecomeone.ghost_assets import (
    GHOST_SAMPLE_RATE,
    MAX_GHOST_REGION_BEATS,
    MEDIA_EDGE_TOLERANCE_SECONDS,
    MIN_GHOST_REGION_BEATS,
    GhostAssetPreparationError,
)
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


def make_vocals_stem(service: StudioService, track_id: str, wav: Path) -> None:
    track_sha256 = service._track_content_hash(track_id)
    stem_dir = service.stem_dir / f"set-{track_sha256[:12]}"
    stem_dir.mkdir(parents=True, exist_ok=True)
    stem_file = stem_dir / "vocals.wav"
    if not stem_file.exists():
        synth_wav(stem_file)
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
        anchor_wav = synth_wav(tmp_path / "anchor.wav", freq=220.0)
        lead_wav = synth_wav(tmp_path / "lead.wav", freq=330.0)
        anchor = service.ingest(anchor_wav.open("rb"), "anchor.wav")
        lead = service.ingest(lead_wav.open("rb"), "lead.wav")
        make_vocals_stem(service, anchor["id"], anchor_wav)
        make_vocals_stem(service, lead["id"], lead_wav)
        project = service.create_project("Bounds mix")
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


class TestRegionSpanBounds:
    def test_one_beat_boundary_passes(self, prepared_project):
        service, project_id, _, _ = prepared_project
        result = service.record_project_action(
            project_id, preview_action("edge-1", "edge-1", startBeat=0, endBeat=1)
        )
        assert result["outcome"]["result"] == "proposal_created"

    def test_sixty_four_beat_boundary_passes(self, prepared_project):
        """64-beat span (16 bars at 4/4) is allowed and inside 32s media."""
        service, project_id, _, _ = prepared_project
        bpm = service._v1_track_bpm(prepared_project[2]["id"])
        # 64 beats at this BPM must stay inside the 32s stem, else the
        # media-bounds check below (not the span bound) fires first.
        if 64 * 60.0 / bpm > 32.0:
            pytest.skip(f"detected BPM {bpm} makes 64 beats exceed fixture duration")
        result = service.record_project_action(
            project_id, preview_action("edge-64", "edge-64", startBeat=0, endBeat=64)
        )
        assert result["outcome"]["result"] == "proposal_created"

    def test_span_above_64_rejected(self, prepared_project):
        service, project_id, _, _ = prepared_project
        with pytest.raises(GhostAssetPreparationError) as e:
            service.record_project_action(
                project_id, preview_action("bad-span", "bad-span", startBeat=0, endBeat=64.5)
            )
        assert e.value.code == "S_REGION_OUT_OF_RANGE"

    def test_span_below_one_rejected(self, prepared_project):
        service, project_id, _, _ = prepared_project
        with pytest.raises(GhostAssetPreparationError) as e:
            service.record_project_action(
                project_id, preview_action("bad-span", "bad-span", startBeat=10, endBeat=10.5)
            )
        assert e.value.code == "S_REGION_OUT_OF_RANGE"

    def test_before_origin_start_rejected(self, prepared_project):
        """A6 before-origin vector: a negative startBeat is rejected by the
        frozen Action contract (V_REGION_INVALID_BOUNDS) before any
        preparation runs; the region never reaches a deck."""
        service, project_id, _, _ = prepared_project
        from twobecomeone import actions as action_contract
        from twobecomeone.common import UserError

        with pytest.raises(UserError) as e:
            service.record_project_action(
                project_id, preview_action("neg", "neg", startBeat=-4, endBeat=4)
            )
        # The frozen Action contract owns the negative-startBeat rule.
        assert "REGION" in str(e.value.code)
        # zero ledger mutation
        assert service.project_actions(project_id)["total"] == 0

    def test_exact_end_accepted(self, prepared_project):
        """A6 exact-end vector: a region ending precisely at the media end
        (within the documented tolerance) is accepted."""
        service, project_id, anchor, _ = prepared_project
        track = service.get_track(anchor["id"])
        grid = track["beat_grid"]
        bpm = service._v1_track_bpm(anchor["id"])
        origin = grid["first_beat"]
        stem_path = service._v1_vocals_stem_path(project_id, anchor["id"])
        duration = _ffprobe_duration(stem_path)
        beats_available = (duration - origin) * bpm / 60.0
        # Last beat index whose end still fits within tolerance.
        end_beat = origin + float(int(beats_available))
        if end_beat <= origin + MIN_GHOST_REGION_BEATS:
            pytest.skip("fixture too short for an exact-end region")
        result = service.record_project_action(
            project_id,
            preview_action("exact-end", "exact-end", startBeat=end_beat - 8, endBeat=end_beat),
        )
        assert result["outcome"]["result"] == "proposal_created"

    def test_past_end_rejected(self, prepared_project):
        """A6 past-end vector: a region extending beyond media is rejected
        before ffmpeg runs."""
        service, project_id, anchor, _ = prepared_project
        track = service.get_track(anchor["id"])
        grid = track["beat_grid"]
        bpm = service._v1_track_bpm(anchor["id"])
        origin = grid["first_beat"]
        stem_path = service._v1_vocals_stem_path(project_id, anchor["id"])
        duration = _ffprobe_duration(stem_path)
        beats_available = (duration - origin) * bpm / 60.0
        # A region that starts inside but ends clearly past the media edge.
        # Keep the span within [1, 64] so the SPAN bound is not what fires.
        start = float(int(max(origin + MIN_GHOST_REGION_BEATS, beats_available - 4)))
        if start < origin + 1:
            pytest.skip("fixture geometry leaves no past-end vector")
        with pytest.raises(GhostAssetPreparationError) as e:
            service.record_project_action(
                project_id,
                preview_action("past-end", "past-end", startBeat=start, endBeat=start + 64),
            )
        assert e.value.code == "S_REGION_BEYOND_MEDIA"

    def test_no_ffmpeg_when_out_of_bounds(self, prepared_project, monkeypatch):
        """Span-out-of-bounds regions never reach ffmpeg."""
        service, project_id, _, _ = prepared_project
        calls = []
        from twobecomeone import ghost_assets as ga_module

        original = ga_module.GhostAssetStore._run_ffmpeg_subprocess

        def spy(cmd):
            calls.append(cmd)
            return original(cmd)

        monkeypatch.setattr(
            ga_module.GhostAssetStore, "_run_ffmpeg_subprocess", staticmethod(spy)
        )
        with pytest.raises(GhostAssetPreparationError):
            service.record_project_action(
                project_id, preview_action("no-ff", "no-ff", startBeat=0, endBeat=64.5)
            )
        assert calls == []


def _ffprobe_duration(path) -> float:
    import subprocess as sp

    probe = sp.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
        capture_output=True, text=True,
    )
    return float(json.loads(probe.stdout)["format"]["duration"])
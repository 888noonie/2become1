"""Phase 14B.2: crate loop-region math and compatibility (no derivative files)."""

from __future__ import annotations

import math

import pytest

from twobecomeone.common import UserError
from twobecomeone.stem_crate_truth import (
    BEATS_PER_BAR,
    GRID_MISSING,
    compatibility,
    derive_bar_region,
    downbeat_beat,
    evaluate_loop_truth,
    grid_facts_from_track,
    require_grid_facts,
    snap_to_bar_beat,
)
from twobecomeone.studio import StudioService

from test_phase11a_commit import make_vocals_stem, synth_wav
from test_phase14b1_stem_crate import create_crate_item


def _facts(
    *,
    bpm=120.0,
    first_beat=0.1,
    downbeat_beats=2.0,
    revision="grid-v1:test",
    confidence=0.9,
    beat_confidence=0.8,
    overrides=False,
):
    interval = 60.0 / bpm
    return require_grid_facts(
        bpm=bpm,
        first_beat=first_beat,
        suggested_downbeat=first_beat + downbeat_beats * interval,
        interval=interval,
        grid_revision=revision,
        analysis_confidence=confidence,
        beat_confidence=beat_confidence,
        overrides_active=overrides,
    )


class TestRequireGridFacts:
    def test_missing_bpm_fails_closed(self):
        with pytest.raises(UserError) as exc:
            require_grid_facts(
                bpm=None,
                first_beat=0.0,
                suggested_downbeat=0.0,
                grid_revision="grid-v1:x",
            )
        assert exc.value.code == GRID_MISSING

    def test_non_finite_downbeat_fails_closed(self):
        with pytest.raises(UserError) as exc:
            require_grid_facts(
                bpm=120,
                first_beat=0.0,
                suggested_downbeat=float("nan"),
                grid_revision="grid-v1:x",
            )
        assert exc.value.code == GRID_MISSING

    def test_blank_revision_fails_closed(self):
        with pytest.raises(UserError) as exc:
            require_grid_facts(
                bpm=100,
                first_beat=0.0,
                suggested_downbeat=0.0,
                grid_revision="  ",
            )
        assert exc.value.code == GRID_MISSING

    def test_surfaces_low_confidence_and_overrides(self):
        facts = require_grid_facts(
            bpm=90,
            first_beat=0.2,
            suggested_downbeat=0.2,
            grid_revision="grid-v1:low",
            analysis_confidence=0.2,
            beat_confidence=0.9,
            overrides_active=True,
        )
        assert facts["low_confidence"] is True
        assert facts["analysis_confidence"] == 0.2
        assert facts["overrides_active"] is True


class TestBarRegionDerivation:
    def test_duration_is_loop_bars_times_four_beats(self):
        facts = _facts()
        for bars in (1, 2, 4, 8):
            region = derive_bar_region(facts, bars, start_beat=downbeat_beat(facts))
            assert region["loop_beats"] == bars * BEATS_PER_BAR
            assert math.isclose(
                region["region_end_beat"] - region["region_start_beat"],
                bars * BEATS_PER_BAR,
            )

    def test_start_snaps_to_downbeat_lattice_from_first_principles(self):
        bpm = 128.0
        first_beat = 0.25
        interval = 60.0 / bpm
        downbeat_beats = 1.0
        facts = require_grid_facts(
            bpm=bpm,
            first_beat=first_beat,
            suggested_downbeat=first_beat + downbeat_beats * interval,
            interval=interval,
            grid_revision="grid-v1:128",
        )
        lattice = downbeat_beats
        raw_start = 0.0
        relative = raw_start - lattice
        k = math.floor(relative / BEATS_PER_BAR + 0.5)
        expected_start = lattice + k * BEATS_PER_BAR
        while expected_start < 0:
            k += 1
            expected_start = lattice + k * BEATS_PER_BAR

        region = derive_bar_region(facts, 4, start_beat=raw_start)
        assert region["region_start_beat"] == expected_start
        assert region["region_end_beat"] == expected_start + 16
        assert region["grid_revision"] == "grid-v1:128"

    def test_unsupported_loop_length_rejected(self):
        with pytest.raises(UserError):
            derive_bar_region(_facts(), 3, start_beat=0.0)

    def test_snap_helper_never_goes_negative(self):
        assert snap_to_bar_beat(0.0, 2.0) >= 0
        assert snap_to_bar_beat(0.0, 2.0) == 2.0


class TestLoopTruthInvalidation:
    def test_grid_revision_change_is_stale_not_rewritten(self):
        stored_start, stored_end, bars = 2.0, 18.0, 4
        current = _facts(revision="grid-v1:new")
        truth = evaluate_loop_truth(
            stored_revision="grid-v1:old",
            stored_start=stored_start,
            stored_end=stored_end,
            stored_bars=bars,
            current_facts=current,
        )
        assert truth["grid_status"] == "stale_revision"
        assert truth["region_aligned"] is False
        assert stored_start == 2.0 and stored_end == 18.0

    def test_missing_live_grid_fails_closed(self):
        truth = evaluate_loop_truth(
            stored_revision="grid-v1:old",
            stored_start=0.0,
            stored_end=16.0,
            stored_bars=4,
            current_facts=None,
            current_error=GRID_MISSING,
        )
        assert truth["grid_status"] == "missing"
        assert truth["region_aligned"] is False


class TestCompatibility:
    def _item(self, bpm, tonic, mode, provenance="source_track_inherited"):
        return {
            "effective_bpm": bpm,
            "effective_tonic": tonic,
            "effective_mode": mode,
            "provenance": provenance,
        }

    def test_same_key_same_tempo_is_compatible(self):
        result = compatibility(
            self._item(120, "C", "major"),
            self._item(120, "C", "major"),
        )
        assert result["verdict"] == "compatible"
        assert result["harmonic"] == "compatible"
        assert result["semitone_shift"] == 0
        assert result["bpm_delta"] == 0
        assert result["bpm_ratio"] == 1.0
        assert "source_inherited" in result["reasons"]
        assert result["explanation"] == "120→120 BPM; 0 st; source inherited"

    def test_unknown_key_is_never_compatible(self):
        result = compatibility(
            self._item(120, None, None),
            self._item(120, "C", "major"),
        )
        assert result["verdict"] == "unknown"
        assert result["harmonic"] == "unknown"
        assert result["relationship"] == "unknown"
        assert "unknown_key" in result["reasons"]
        assert result["explanation"].startswith("120→120 BPM; key unknown")

    def test_bpm_and_semitone_transform(self):
        result = compatibility(
            self._item(120, "C", "major"),
            self._item(124, "D", "major"),
        )
        assert result["verdict"] == "transform_needed"
        assert result["bpm_delta"] == 4.0
        assert result["bpm_ratio"] == pytest.approx(124 / 120)
        assert result["semitone_shift"] == 2
        assert "bpm_delta" in result["reasons"]
        assert "semitone_shift" in result["reasons"]
        assert result["explanation"] == "120→124 BPM; +2 st; source inherited"

    def test_relative_major_minor_is_not_compatible(self):
        result = compatibility(
            self._item(120, "A", "minor"),
            self._item(120, "C", "major"),
        )
        assert result["verdict"] == "transform_needed"
        assert result["semitone_shift"] == 0
        assert result["relationship"] == "relative"
        assert result["harmonic"] != "compatible"

    def test_grid_facts_from_track_round_trip(self):
        track = {
            "bpm": 100,
            "key": {"tonic": "F", "mode": "minor", "confidence": 0.4},
            "beat_grid": {
                "interval": 0.6,
                "first_beat": 0.0,
                "suggested_downbeat": 0.0,
                "confidence": 0.7,
            },
            "overrides_active": True,
        }
        facts = grid_facts_from_track(track, "grid-v1:track")
        assert facts["low_confidence"] is True
        assert facts["overrides_active"] is True
        assert facts["bpm"] == 100


@pytest.fixture
def crate_service(tmp_path):
    service = StudioService(tmp_path / "data")
    try:
        wav = synth_wav(tmp_path / "track.wav", seconds=32.0)
        track = service.ingest(wav.open("rb"), "track.wav")
        make_vocals_stem(service, track["id"], wav)
        stem_set_id = f"set-{service._track_content_hash(track['id'])[:12]}"
        yield service, track, stem_set_id
    finally:
        service.close()


class TestStemCrateServiceTruth:
    def test_omitted_end_derives_from_grid_not_naive_four_four_only(self, crate_service):
        service, track, stem_set_id = crate_service
        item = service.create_stem_crate_item(
            track_id=track["id"],
            stem_set_id=stem_set_id,
            stem_name="vocals",
            role="voice",
            loop_bars=2,
            region_start_beat=0.0,
        )
        facts = grid_facts_from_track(
            {**track, "overrides_active": False},
            item["grid_revision"],
        )
        expected = derive_bar_region(facts, 2, start_beat=0.0)
        assert item["region_start_beat"] == expected["region_start_beat"]
        assert item["region_end_beat"] == expected["region_end_beat"]
        assert item["loop_truth"]["grid_status"] == "ok"
        assert item["provenance"] == "source_track_inherited"
        assert item["source_track_name"]

    def test_bpm_override_invalidates_stored_revision(self, crate_service):
        service, track, stem_set_id = crate_service
        item = create_crate_item(service, track_id=track["id"], stem_set_id=stem_set_id)
        stored_start = item["region_start_beat"]
        stored_end = item["region_end_beat"]
        service.update_track(track["id"], bpm=item["effective_bpm"] + 8)
        refreshed = service.get_stem_crate_item(item["id"])
        assert refreshed["loop_truth"]["grid_status"] == "stale_revision"
        assert refreshed["region_start_beat"] == stored_start
        assert refreshed["region_end_beat"] == stored_end

    def test_missing_grid_on_create_fails_closed(self, crate_service):
        service, track, stem_set_id = crate_service
        with service._connect() as conn:
            conn.execute(
                "UPDATE tracks SET first_beat = NULL, suggested_downbeat = NULL,"
                " first_beat_override = NULL, downbeat_override = NULL WHERE id = ?",
                (track["id"],),
            )
        with pytest.raises(UserError) as exc:
            service.create_stem_crate_item(
                track_id=track["id"],
                stem_set_id=stem_set_id,
                stem_name="vocals",
                role="voice",
            )
        assert exc.value.code == GRID_MISSING

    def test_compatibility_endpoint_payload(self, crate_service):
        service, track, stem_set_id = crate_service
        voice = create_crate_item(
            service, track_id=track["id"], stem_set_id=stem_set_id, role="voice"
        )
        beat = create_crate_item(
            service,
            track_id=track["id"],
            stem_set_id=stem_set_id,
            role="beat",
            region_start_beat=16.0,
            region_end_beat=32.0,
        )
        result = service.stem_crate_compatibility(voice["id"], beat["id"])
        assert result["verdict"] in {"compatible", "transform_needed", "unknown"}
        assert result["source_id"] == voice["id"]
        assert result["against_id"] == beat["id"]
        listed = service.list_stem_crate_items(against_id=beat["id"])
        assert all("compatibility" in row for row in listed["items"])


@pytest.fixture
def anyio_backend():
    return "asyncio"


class TestStemCrateTruthHTTP:
    @pytest.mark.anyio
    async def test_compatibility_query(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        service = app.state.studio
        try:
            wav = synth_wav(tmp_path / "t.wav", seconds=16.0)
            track = service.ingest(wav.open("rb"), "t.wav")
            make_vocals_stem(service, track["id"], wav)
            stem_set_id = f"set-{service._track_content_hash(track['id'])[:12]}"
            async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
                a = (
                    await client.post(
                        "/api/stem-crate",
                        json={
                            "track_id": track["id"],
                            "stem_set_id": stem_set_id,
                            "stem_name": "vocals",
                            "role": "voice",
                            "region_start_beat": 0,
                            "region_end_beat": 16,
                        },
                    )
                ).json()
                b = (
                    await client.post(
                        "/api/stem-crate",
                        json={
                            "track_id": track["id"],
                            "stem_set_id": stem_set_id,
                            "stem_name": "vocals",
                            "role": "beat",
                            "region_start_beat": 16,
                            "region_end_beat": 32,
                        },
                    )
                ).json()
                compared = (
                    await client.get(
                        "/api/stem-crate/compatibility",
                        params={"source": a["id"], "against": b["id"]},
                    )
                ).json()
                assert compared["source_id"] == a["id"]
                assert compared["against_id"] == b["id"]
                assert compared["verdict"] == "compatible"
                assert compared["harmonic"] == "compatible"
                assert "unknown_key" not in compared["reasons"]
                listing = (
                    await client.get("/api/stem-crate", params={"against": b["id"]})
                ).json()
                assert listing["items"][0]["loop_truth"]["grid_status"] in {
                    "ok",
                    "stale_revision",
                    "missing",
                }
                assert "compatibility" in listing["items"][0]
        finally:
            app.state.studio.close()

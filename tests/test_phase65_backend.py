"""Phase 6.5 backend contracts and planner tests (Task 1).

Covers:
- project settings validator: defaults, ranges, enums, nested EQ, unknown keys,
  non-finite values, booleans-as-numbers, malformed objects, and contradictory
  custom-tempo settings;
- tempo-target planning vectors (Foundation, Lead, custom) across slower and
  faster sources;
- overlay and transition duration/availability vectors including hard cut,
  insufficient Foundation overlap, requested-duration cap, and severe-stretch
  warnings;
- old V0.3 payload compatibility (no new fields → Foundation mode, Lead ratio
  unchanged, same duration);
- RenderBody defaults and normalized result/plan metadata.
"""

from __future__ import annotations

import pytest

from twobecomeone import assembler, projects
from twobecomeone.common import UserError


# ---------------------------------------------------------------------------
# Project settings validator
# ---------------------------------------------------------------------------


class TestMixerSettingsValidation:
    def test_missing_fields_preserve_v03_behavior(self):
        """An empty settings blob must stay valid (V0.3 defaults)."""
        out = projects.validate_settings({})
        assert out == {}

    def test_accepts_all_new_valid_settings(self):
        settings = {
            "tempo_mode": "custom",
            "target_bpm": 128.0,
            "arrangement_mode": "transition",
            "transition_start": 4.0,
            "crossfade_duration": 3.5,
            "crossfade_curve": "linear",
            "anchor_pan": -0.5,
            "lead_pan": 0.25,
            "anchor_eq": {"low": 2.0, "mid": -1.5, "high": 0.0},
            "lead_eq": {"low": 0.0, "mid": 3.0, "high": -4.0},
        }
        out = projects.validate_settings(settings)
        assert out["tempo_mode"] == "custom"
        assert out["target_bpm"] == 128.0
        assert out["arrangement_mode"] == "transition"
        assert out["crossfade_curve"] == "linear"
        assert out["anchor_eq"] == {"low": 2.0, "mid": -1.5, "high": 0.0}

    def test_defaults_are_implicit(self):
        """Unset new settings are not persisted; defaults are V0.3 behavior."""
        out = projects.validate_settings({})
        assert "tempo_mode" not in out
        assert "arrangement_mode" not in out
        assert "crossfade_curve" not in out

    @pytest.mark.parametrize("bad", ["custom", "bpm", "", 123, None, True])
    def test_rejects_invalid_tempo_mode(self, bad):
        with pytest.raises(UserError):
            projects.validate_settings({"tempo_mode": bad})

    def test_custom_tempo_requires_target_bpm(self):
        with pytest.raises(UserError):
            projects.validate_settings({"tempo_mode": "custom", "target_bpm": None})
        with pytest.raises(UserError):
            projects.validate_settings({"tempo_mode": "custom"})

    def test_non_custom_persists_null_target(self):
        assert projects.validate_settings({
            "tempo_mode": "foundation", "target_bpm": None,
        }) == {"tempo_mode": "foundation", "target_bpm": None}

    def test_target_bpm_with_non_custom_mode_is_contradictory(self):
        for mode in ("foundation", "lead"):
            with pytest.raises(UserError):
                projects.validate_settings({"tempo_mode": mode, "target_bpm": 120.0})

    @pytest.mark.parametrize("bad", [0, -5, float("nan"), float("inf"), "120", True])
    def test_rejects_invalid_target_bpm(self, bad):
        with pytest.raises(UserError):
            projects.validate_settings({"tempo_mode": "custom", "target_bpm": bad})

    @pytest.mark.parametrize("bad", ["crossfade", "eq", "", 0, True])
    def test_rejects_invalid_arrangement_mode(self, bad):
        with pytest.raises(UserError):
            projects.validate_settings({"arrangement_mode": bad})

    def test_crossfade_duration_range(self):
        assert projects.validate_settings({"crossfade_duration": 0.0})["crossfade_duration"] == 0.0
        assert projects.validate_settings({"crossfade_duration": 30.0})["crossfade_duration"] == 30.0
        for bad in (-0.1, 30.1, float("inf"), float("nan"), "3", True):
            with pytest.raises(UserError):
                projects.validate_settings({"crossfade_duration": bad})

    @pytest.mark.parametrize("bad", ["equal-power", "none", "", 1, True])
    def test_rejects_invalid_crossfade_curve(self, bad):
        with pytest.raises(UserError):
            projects.validate_settings({"crossfade_curve": bad})

    @pytest.mark.parametrize("bad", [-1.1, 1.1, float("nan"), float("inf"), "0.5", True])
    def test_rejects_invalid_pan(self, bad):
        with pytest.raises(UserError):
            projects.validate_settings({"anchor_pan": bad})
        with pytest.raises(UserError):
            projects.validate_settings({"lead_pan": bad})

    def test_accepts_pan_bounds(self):
        assert projects.validate_settings({"anchor_pan": -1.0})["anchor_pan"] == -1.0
        assert projects.validate_settings({"lead_pan": 1.0})["lead_pan"] == 1.0

    @pytest.mark.parametrize("eq", [
        {"low": 0.0},                          # missing mid/high
        {"low": 0.0, "mid": 0.0, "high": 0.0, "bass": 0.0},  # unknown nested key
        {"low": 0.0, "mid": 0.0, "high": True}, # boolean as number
        {"low": 0.0, "mid": 0.0, "high": "3"},  # string as number
        {"low": 0.0, "mid": 0.0, "high": float("nan")},
        {"low": -13.0, "mid": 0.0, "high": 0.0},# out of range
        {"low": 0.0, "mid": 0.0, "high": 12.1}, # out of range
        [],                                     # not an object
        "eq",                                   # not an object
        None,
    ])
    def test_rejects_malformed_eq(self, eq):
        with pytest.raises(UserError):
            projects.validate_settings({"anchor_eq": eq})
        with pytest.raises(UserError):
            projects.validate_settings({"lead_eq": eq})

    def test_accepts_valid_eq_bounds(self):
        out = projects.validate_settings(
            {"anchor_eq": {"low": -12.0, "mid": 0.0, "high": 12.0}}
        )
        assert out["anchor_eq"]["low"] == -12.0
        assert out["anchor_eq"]["high"] == 12.0

    def test_rejects_unknown_settings_key(self):
        with pytest.raises(UserError):
            projects.validate_settings({"some_new_unknown_key": 1})


# ---------------------------------------------------------------------------
# Tempo target planning vectors
# ---------------------------------------------------------------------------


class TestTempoTargetPlanning:
    def _service(self, tmp_path):
        from twobecomeone.studio import StudioService
        return StudioService(tmp_path / "data")

    def _tracks(self, service, tmp_path):
        """Ingest two synthetic tracks with different BPMs."""
        import asyncio
        from test_phase3_http import synth_track
        anchor = None
        lead = None
        for name, bpm, root in (("a.wav", 100.0, 261.63), ("l.wav", 120.0, 220.0)):
            p = synth_track(tmp_path / name, bpm=bpm, root=root, duration=8.0)
            track = service.ingest_path(p)
            if name == "a.wav":
                anchor = track
            else:
                lead = track
        return anchor, lead

    def test_foundation_mode_defaults(self, tmp_path):
        from twobecomeone.studio import RenderOptions
        service = self._service(tmp_path)
        try:
            anchor, lead = self._tracks(service, tmp_path)
            plan = service.plan_render(RenderOptions(anchor_id=anchor["id"], lead_id=lead["id"]))
            # Output BPM is the Foundation BPM; the Foundation ratio is 1.0.
            assert plan["tempo_mode"] == "foundation"
            assert plan["output_bpm"] == pytest.approx(anchor["bpm"])
            assert plan["anchor_tempo_ratio"] == pytest.approx(1.0, abs=1e-4)
            assert plan["lead_tempo_ratio"] == pytest.approx(anchor["bpm"] / lead["bpm"], abs=1e-4)
            # Backward-compatible aliases.
            assert plan["tempo_ratio"] == plan["lead_tempo_ratio"]
            assert plan["bpm_change_percent"] == plan["lead_bpm_change_percent"]
            assert plan["anchor_bpm_change_percent"] == pytest.approx(0.0, abs=1e-2)
        finally:
            service.close()

    def test_lead_mode(self, tmp_path):
        from twobecomeone.studio import RenderOptions
        service = self._service(tmp_path)
        try:
            anchor, lead = self._tracks(service, tmp_path)
            plan = service.plan_render(RenderOptions(
                anchor_id=anchor["id"], lead_id=lead["id"], tempo_mode="lead",
            ))
            assert plan["tempo_mode"] == "lead"
            assert plan["output_bpm"] == pytest.approx(lead["bpm"])
            assert plan["lead_tempo_ratio"] == pytest.approx(1.0, abs=1e-4)
            assert plan["anchor_tempo_ratio"] == pytest.approx(lead["bpm"] / anchor["bpm"], abs=1e-4)
        finally:
            service.close()

    def test_custom_mode(self, tmp_path):
        from twobecomeone.studio import RenderOptions
        service = self._service(tmp_path)
        try:
            anchor, lead = self._tracks(service, tmp_path)
            plan = service.plan_render(RenderOptions(
                anchor_id=anchor["id"], lead_id=lead["id"],
                tempo_mode="custom", target_bpm=140.0,
            ))
            assert plan["tempo_mode"] == "custom"
            assert plan["output_bpm"] == pytest.approx(140.0)
            assert plan["anchor_tempo_ratio"] == pytest.approx(140.0 / anchor["bpm"], abs=1e-4)
            assert plan["lead_tempo_ratio"] == pytest.approx(140.0 / lead["bpm"], abs=1e-4)
        finally:
            service.close()

    def test_custom_mode_rejects_invalid_target(self, tmp_path):
        from twobecomeone.studio import RenderOptions
        service = self._service(tmp_path)
        try:
            anchor, lead = self._tracks(service, tmp_path)
            with pytest.raises(UserError):
                service.plan_render(RenderOptions(
                    anchor_id=anchor["id"], lead_id=lead["id"],
                    tempo_mode="custom", target_bpm=None,
                ))
        finally:
            service.close()

    def test_effective_bpm_and_pitch_independent(self, tmp_path):
        from twobecomeone.studio import RenderOptions
        service = self._service(tmp_path)
        try:
            anchor, lead = self._tracks(service, tmp_path)
            plan = service.plan_render(RenderOptions(
                anchor_id=anchor["id"], lead_id=lead["id"], tempo_mode="custom",
                target_bpm=100.0, pitch_mode="preserve",
            ))
            assert plan["semitone_shift"] == 0
            assert plan["pitch_mode"] == "preserve"
            assert plan["output_bpm"] == pytest.approx(100.0)
        finally:
            service.close()


# ---------------------------------------------------------------------------
# Overlay / transition duration & availability vectors
# ---------------------------------------------------------------------------


class TestArrangementPlanning:
    def _service(self, tmp_path):
        from twobecomeone.studio import StudioService
        return StudioService(tmp_path / "data")

    def _tracks(self, service, tmp_path, duration=8.0):
        from test_phase3_http import synth_track
        anchor = lead = None
        for name, bpm, root in (("a.wav", 100.0, 261.63), ("l.wav", 100.0, 220.0)):
            p = synth_track(tmp_path / name, bpm=bpm, root=root, duration=duration)
            track = service.ingest_path(p)
            if name == "a.wav":
                anchor = track
            else:
                lead = track
        return anchor, lead

    def test_overlay_both_start_at_zero(self, tmp_path):
        from twobecomeone.studio import RenderOptions
        service = self._service(tmp_path)
        try:
            anchor, lead = self._tracks(service, tmp_path)
            plan = service.plan_render(RenderOptions(anchor_id=anchor["id"], lead_id=lead["id"]))
            assert plan["arrangement_mode"] == "overlay"
            assert plan["sources"]["anchor"]["output_start"] == 0.0
            assert plan["sources"]["lead"]["output_start"] == 0.0
            # Auto duration = shorter aligned overlap (Foundation mode => ratio 1.0).
            assert plan["duration"]["output"] == pytest.approx(anchor["duration"], abs=1e-3)
        finally:
            service.close()

    def test_transition_lead_starts_at_transition_start(self, tmp_path):
        from twobecomeone.studio import RenderOptions
        service = self._service(tmp_path)
        try:
            anchor, lead = self._tracks(service, tmp_path)
            plan = service.plan_render(RenderOptions(
                anchor_id=anchor["id"], lead_id=lead["id"],
                arrangement_mode="transition", transition_start=2.0,
                crossfade_duration=1.0,
            ))
            assert plan["arrangement_mode"] == "transition"
            assert plan["transition"]["start"] == 2.0
            assert plan["sources"]["anchor"]["output_start"] == 0.0
            assert plan["sources"]["lead"]["output_start"] == 2.0
            # Foundation only needs to cover the crossfade. The Lead then runs
            # for its complete aligned availability: 2 + 8 = 10 seconds.
            assert plan["duration"]["output"] == pytest.approx(
                2.0 + lead["duration"], abs=1e-3,
            )
            assert plan["sources"]["anchor"]["output_end"] == pytest.approx(3.0)
            assert plan["sources"]["lead"]["output_end"] == pytest.approx(10.0, abs=1e-3)
        finally:
            service.close()

    def test_transition_hard_cut_zero_crossfade(self, tmp_path):
        from twobecomeone.studio import RenderOptions
        service = self._service(tmp_path)
        try:
            anchor, lead = self._tracks(service, tmp_path)
            plan = service.plan_render(RenderOptions(
                anchor_id=anchor["id"], lead_id=lead["id"],
                arrangement_mode="transition", transition_start=3.0,
                crossfade_duration=0.0,
            ))
            assert plan["transition"]["crossfade_duration"] == 0.0
            assert plan["duration"]["output"] == pytest.approx(
                3.0 + lead["duration"], abs=1e-3,
            )
            assert plan["sources"]["anchor"]["source_consumed"] == pytest.approx(3.0)
            assert any("hard cut" in w.lower() for w in plan["warnings"])
        finally:
            service.close()

    def test_transition_insufficient_foundation_overlap_is_rejected(self, tmp_path):
        from twobecomeone.studio import RenderOptions
        service = self._service(tmp_path)
        try:
            # 8s track; transition_start 6 + crossfade 3 = 9 > 8 available => impossible.
            anchor, lead = self._tracks(service, tmp_path, duration=8.0)
            with pytest.raises(UserError):
                service.plan_render(RenderOptions(
                    anchor_id=anchor["id"], lead_id=lead["id"],
                    arrangement_mode="transition", transition_start=6.0,
                    crossfade_duration=3.0,
                ))
        finally:
            service.close()

    def test_transition_requested_duration_capped(self, tmp_path):
        from twobecomeone.studio import RenderOptions
        service = self._service(tmp_path)
        try:
            anchor, lead = self._tracks(service, tmp_path, duration=8.0)
            plan = service.plan_render(RenderOptions(
                anchor_id=anchor["id"], lead_id=lead["id"],
                arrangement_mode="transition", transition_start=2.0,
                crossfade_duration=1.0, duration=30.0,
            ))
            # Lead available out = 8s (ratio 1.0) => transition ceiling 2+8=10.
            assert plan["duration"]["requested"] == 30.0
            assert plan["duration"]["output"] == pytest.approx(10.0, abs=1e-3)
            assert any("cap" in w.lower() or "shorter" in w.lower() or "exceeds" in w.lower() for w in plan["warnings"])
        finally:
            service.close()

    def test_severe_stretch_warning(self, tmp_path):
        from twobecomeone.studio import RenderOptions
        service = self._service(tmp_path)
        try:
            anchor, lead = self._tracks(service, tmp_path)
            # Force the lead well below the foundation so its stretch is ~2:1.
            service.update_track(lead["id"], bpm=50.0)
            plan = service.plan_render(RenderOptions(anchor_id=anchor["id"], lead_id=lead["id"]))
            # The detected lead BPM is ~49.7, so the ratio is ~2.01, not exactly 2.
            assert plan["lead_tempo_ratio"] > 1.99
            joined = " ".join(plan["warnings"])
            assert "lead" in joined.lower() and ("2:1" in joined or "heavily" in joined.lower())
        finally:
            service.close()

    def test_transition_settings_do_not_leak_into_overlay(self, tmp_path):
        from twobecomeone.studio import RenderOptions
        service = self._service(tmp_path)
        try:
            anchor, lead = self._tracks(service, tmp_path)
            plan = service.plan_render(RenderOptions(
                anchor_id=anchor["id"], lead_id=lead["id"],
                arrangement_mode="overlay", transition_start=3.0,
                crossfade_duration=2.0,
            ))
            # Overlay ignores transition timing: both start at 0 and the full
            # overlap is used, not transition_start + lead availability.
            assert plan["sources"]["anchor"]["output_start"] == 0.0
            assert plan["sources"]["lead"]["output_start"] == 0.0
            assert plan["duration"]["output"] == pytest.approx(anchor["duration"], abs=1e-3)
        finally:
            service.close()

    def test_transition_rejects_lead_cue_beyond_source(self, tmp_path):
        from twobecomeone.studio import RenderOptions
        service = self._service(tmp_path)
        try:
            anchor, lead = self._tracks(service, tmp_path)
            with pytest.raises(UserError, match="Lead cue"):
                service.plan_render(RenderOptions(
                    anchor_id=anchor["id"], lead_id=lead["id"],
                    arrangement_mode="transition", transition_start=20.0,
                    lead_start=lead["duration"] + 1.0,
                ))
        finally:
            service.close()


# ---------------------------------------------------------------------------
# API contract: defaults, compatibility, normalized metadata
# ---------------------------------------------------------------------------


class TestRenderBodyCompatibility:
    @pytest.mark.anyio
    async def test_old_payload_produces_v03_defaults(self, tmp_path):
        """A V0.3 payload with no new fields must behave exactly like before."""
        pytest.importorskip("fastapi")
        import httpx
        from test_phase3_http import synth_track
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
                a = lead = None
                for name, bpm in (("a.wav", 100.0), ("l.wav", 120.0)):
                    p = synth_track(tmp_path / name, bpm=bpm, root=261.63, duration=8.0)
                    with p.open("rb") as f:
                        r = await c.post("/api/tracks", files={"file": (name, f, "audio/wav")})
                    assert r.status_code == 201
                    if name == "a.wav":
                        a = r.json()
                    else:
                        lead = r.json()

                old_payload = {
                    "anchor_id": a["id"], "lead_id": lead["id"],
                    "anchor_start": 0.0, "lead_start": 0.0,
                    "duration": None, "anchor_gain": 0.8, "lead_gain": 0.8,
                    "use_vocals": False, "stem_method": "auto", "preview": False,
                    "anchor_variant": "full", "lead_variant": "full",
                    "pitch_mode": "match",
                }
                resp = await c.post("/api/renders/plan", json=old_payload)
                assert resp.status_code == 200, resp.text
                plan = resp.json()
                # Defaults: Foundation output BPM, overlay arrangement, old lead
                # ratio, Foundation ratio 1.0, old duration semantics.
                assert plan["tempo_mode"] == "foundation"
                assert plan["output_bpm"] == pytest.approx(a["bpm"])
                assert plan["anchor_tempo_ratio"] == pytest.approx(1.0, abs=1e-4)
                assert plan["lead_tempo_ratio"] == pytest.approx(a["bpm"] / lead["bpm"], abs=1e-4)
                assert plan["tempo_ratio"] == plan["lead_tempo_ratio"]
                assert plan["arrangement_mode"] == "overlay"
                assert plan["channel"]["anchor"]["gain"] == 0.8
                assert plan["channel"]["anchor"]["pan"] == 0.0
                assert plan["channel"]["anchor"]["eq"] == {"low": 0.0, "mid": 0.0, "high": 0.0}
                assert plan["duration"]["output"] == pytest.approx(
                    min(a["duration"], (lead["duration"]) / plan["lead_tempo_ratio"]), abs=1e-3
                )
        finally:
            app.state.studio.close()

    @pytest.mark.anyio
    async def test_render_body_accepts_new_mixer_fields(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from test_phase3_http import synth_track
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
                a = lead = None
                for name, bpm in (("a.wav", 100.0), ("l.wav", 120.0)):
                    p = synth_track(tmp_path / name, bpm=bpm, root=261.63, duration=8.0)
                    with p.open("rb") as f:
                        r = await c.post("/api/tracks", files={"file": (name, f, "audio/wav")})
                    if name == "a.wav":
                        a = r.json()
                    else:
                        lead = r.json()

                body = {
                    "anchor_id": a["id"], "lead_id": lead["id"],
                    "tempo_mode": "custom", "target_bpm": 140.0,
                    "arrangement_mode": "transition", "transition_start": 2.0,
                    "crossfade_duration": 1.0, "crossfade_curve": "linear",
                    "anchor_pan": -0.5, "lead_pan": 0.25,
                    "anchor_eq": {"low": 2.0, "mid": 0.0, "high": -1.0},
                    "lead_eq": {"low": 0.0, "mid": 1.0, "high": 0.0},
                }
                resp = await c.post("/api/renders/plan", json=body)
                assert resp.status_code == 200, resp.text
                plan = resp.json()
                assert plan["output_bpm"] == pytest.approx(140.0)
                assert plan["arrangement_mode"] == "transition"
                assert plan["channel"]["anchor"]["pan"] == -0.5
                assert plan["channel"]["lead"]["pan"] == 0.25
                assert plan["channel"]["anchor"]["eq"]["low"] == 2.0
                assert plan["channel"]["lead"]["eq"]["mid"] == 1.0

                # Invalid EQ must be rejected (422 via body validation).
                bad = {**body, "anchor_eq": {"low": 99.0, "mid": 0.0, "high": 0.0}}
                bad_resp = await c.post("/api/renders/plan", json=bad)
                assert bad_resp.status_code in (400, 422)
                assert "error" in bad_resp.json()

                # Numeric mixer fields and nested EQ are strict at the HTTP
                # boundary: no bool/string coercion or unknown keys.
                for bad_patch in (
                    {"anchor_pan": True},
                    {"transition_start": "2"},
                    {"anchor_eq": {"low": 0, "mid": 0, "high": 0, "x": 1}},
                    {"lead_eq": {"low": False, "mid": 0, "high": 0}},
                ):
                    bad_resp = await c.post(
                        "/api/renders/plan", json={**body, **bad_patch},
                    )
                    assert bad_resp.status_code == 422, bad_resp.text

                contradictory = await c.post(
                    "/api/renders/plan",
                    json={**body, "tempo_mode": "foundation", "target_bpm": 140},
                )
                assert contradictory.status_code == 422
        finally:
            app.state.studio.close()

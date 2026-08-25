"""Phase 5 backend contract tests (Task 1).

Covers:
- structured stem variants on GET /api/tracks/{id}/stems with restart-safe
  server-authored audio URLs (top-level ``stems`` alias preserved);
- optional download disposition on GET /api/stems/{id}/audio;
- atomic project validation of track/variant combinations;
- the read-only render-plan endpoint sharing the renderer's planning logic;
- common error envelope and no-absolute-path leakage.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path

import pytest

from test_phase3_http import synth_track


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _import_track(client, tmp_path: Path, name: str, bpm: float, root: float, duration: float = 4.0):
    p = synth_track(tmp_path / name, bpm=bpm, root=root, duration=duration)
    with p.open("rb") as f:
        resp = await client.post("/api/tracks", files={"file": (name, f, "audio/wav")})
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _wait_job(client, job_id: str, timeout: float = 60.0) -> dict:
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        job = (await client.get(f"/api/jobs/{job_id}")).json()
        if job["status"] in {"complete", "failed", "cancelled", "interrupted"}:
            return job
        await asyncio.sleep(0.05)
    raise TimeoutError(f"job {job_id} did not finish")


class TestStructuredStems:
    @pytest.mark.anyio
    async def test_stems_includes_structured_variants(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://studio.test") as c:
                t = await _import_track(c, tmp_path, "t.wav", 100, 261.63)

                # Before any separation, only full is offered.
                data = (await c.get(f"/api/tracks/{t['id']}/stems")).json()
                assert data["stems"] == ["full"]
                assert [v["name"] for v in data["variants"]] == ["full"]
                assert data["variants"][0]["audio_url"] == f"/api/tracks/{t['id']}/audio"
                assert data["variants"][0]["stem_set_id"] is None

                job = (await c.post(
                    f"/api/tracks/{t['id']}/separations", json={"method": "ffmpeg"}
                )).json()
                job = await _wait_job(c, job["id"])
                assert job["status"] == "complete", job.get("error")

                data = (await c.get(f"/api/tracks/{t['id']}/stems")).json()
                # Compatibility alias preserved.
                assert sorted(data["stems"]) == ["center", "full", "sides"]
                by_name = {v["name"]: v for v in data["variants"]}
                for name in ("center", "sides"):
                    v = by_name[name]
                    assert v["stem_set_id"]
                    assert v["method"] == "ffmpeg"
                    assert v["model_name"]
                    assert v["device"]
                    assert v["audio_url"].startswith(f"/api/stems/{v['stem_set_id']}/audio?name={name}")
                # No absolute paths leak.
                import json as _json
                assert str(tmp_path) not in _json.dumps(data)

                # Structured advertising is honest: no invented demucs stems.
                assert "vocals" not in by_name
        finally:
            app.state.studio.close()

    @pytest.mark.anyio
    async def test_stem_variants_playable_after_restart(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        data_dir = tmp_path / "data"
        app = create_app(data_dir)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://studio.test") as c:
            t = await _import_track(c, tmp_path, "t.wav", 100, 261.63)
            track_id = t["id"]
            job = (await c.post(
                f"/api/tracks/{track_id}/separations", json={"method": "ffmpeg"}
            )).json()
            job = await _wait_job(c, job["id"])
            assert job["status"] == "complete", job.get("error")
        app.state.studio.close()

        # Fresh service over the same data dir (simulates a server restart).
        app2 = create_app(data_dir)
        transport2 = httpx.ASGITransport(app=app2)
        try:
            async with httpx.AsyncClient(transport=transport2, base_url="http://studio.test") as c:
                data = (await c.get(f"/api/tracks/{track_id}/stems")).json()
                by_name = {v["name"]: v for v in data["variants"]}
                assert "center" in by_name
                # The authored audio URL must resolve without any remembered
                # in-process job result.
                audio = await c.get(by_name["center"]["audio_url"])
                assert audio.status_code == 200
                assert len(audio.content) > 0
        finally:
            app2.state.studio.close()


class TestStemDownloadDisposition:
    @pytest.mark.anyio
    async def test_download_disposition_and_strict_lookup(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://studio.test") as c:
                t = await _import_track(c, tmp_path, "t.wav", 100, 261.63)
                job = (await c.post(
                    f"/api/tracks/{t['id']}/separations", json={"method": "ffmpeg"}
                )).json()
                job = await _wait_job(c, job["id"])
                stem_set_id = job["result"]["stem_set_id"]

                inline = await c.get(f"/api/stems/{stem_set_id}/audio", params={"name": "center"})
                assert inline.status_code == 200
                assert "attachment" not in (inline.headers.get("content-disposition") or "")

                download = await c.get(
                    f"/api/stems/{stem_set_id}/audio",
                    params={"name": "center", "download": "true"},
                )
                assert download.status_code == 200
                assert "attachment" in (download.headers.get("content-disposition") or "")

                # Strict set/name lookup: bad set, bad name, path-as-name all 4xx.
                assert (await c.get("/api/stems/nope/audio", params={"name": "center"})).status_code in (400, 404)
                assert (await c.get(f"/api/stems/{stem_set_id}/audio", params={"name": "vocals"})).status_code in (400, 404)
                resp = await c.get(f"/api/stems/{stem_set_id}/audio", params={"name": "../t.wav"})
                assert resp.status_code in (400, 404, 422)
                assert "error" in resp.json()
        finally:
            app.state.studio.close()


class TestProjectVariantValidation:
    @pytest.mark.anyio
    async def test_atomic_track_variant_validation(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://studio.test") as c:
                a = await _import_track(c, tmp_path, "a.wav", 100, 261.63)
                l = await _import_track(c, tmp_path, "l.wav", 120, 220.0)
                proj = (await c.post("/api/projects", json={"name": "Mix"})).json()

                # Assigning a track and an unavailable variant together in one
                # PATCH must be rejected with no partial write.
                resp = await c.patch(f"/api/projects/{proj['id']}", json={
                    "lead_track_id": l["id"],
                    "lead_variant": "vocals",
                })
                assert resp.status_code in (400, 409, 422)
                assert "error" in resp.json()
                current = (await c.get(f"/api/projects/{proj['id']}")).json()
                assert current["lead_track_id"] is None
                assert current["lead_variant"] is None

                # full is always valid, and multi-field assign works.
                resp = await c.patch(f"/api/projects/{proj['id']}", json={
                    "anchor_track_id": a["id"],
                    "anchor_variant": "full",
                    "lead_track_id": l["id"],
                    "lead_variant": "full",
                })
                assert resp.status_code == 200, resp.text

                # Variant from a different track is not accepted.
                job = (await c.post(
                    f"/api/tracks/{a['id']}/separations", json={"method": "ffmpeg"}
                )).json()
                job = await _wait_job(c, job["id"])
                assert job["status"] == "complete", job.get("error")

                resp = await c.patch(f"/api/projects/{proj['id']}", json={
                    "lead_variant": "center",  # exists on a, not on l
                })
                assert resp.status_code in (400, 409, 422)
                current = (await c.get(f"/api/projects/{proj['id']}")).json()
                assert current["lead_variant"] == "full"

                # Swapping tracks while a stem variant is selected is rejected
                # atomically when the new track lacks that stem.
                resp = await c.patch(f"/api/projects/{proj['id']}", json={
                    "lead_track_id": a["id"],
                    "lead_variant": "center",
                })
                assert resp.status_code == 200, resp.text
        finally:
            app.state.studio.close()


class TestRenderPlan:
    @pytest.mark.anyio
    async def test_plan_matches_renderer_and_creates_nothing(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app
        from twobecomeone import assembler

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://studio.test") as c:
                a = await _import_track(c, tmp_path, "a.wav", 100, 261.63)  # C major
                l = await _import_track(c, tmp_path, "l.wav", 120, 220.0)

                jobs_before = (await c.get("/api/jobs")).json()["jobs"]
                renders_before = list((tmp_path / "data" / "renders").glob("*"))

                resp = await c.post("/api/renders/plan", json={
                    "anchor_id": a["id"], "lead_id": l["id"], "duration": 10.0,
                })
                assert resp.status_code == 200, resp.text
                plan = resp.json()

                # Exact parity with the renderer's math.
                ratio = a["bpm"] / l["bpm"]
                assert plan["tempo_ratio"] == pytest.approx(ratio, abs=1e-4)
                assert plan["bpm_change_percent"] == pytest.approx((ratio - 1.0) * 100.0, abs=1e-2)
                expected_shift = assembler.semitones_to_match(
                    f"{a['key']['tonic']} {a['key']['mode']}",
                    f"{l['key']['tonic']} {l['key']['mode']}",
                )
                assert plan["semitone_shift"] == expected_shift
                assert plan["effective_bpm"] == {"anchor": a["bpm"], "lead": l["bpm"]}
                assert plan["effective_keys"]["anchor"]["tonic"] == a["key"]["tonic"]
                assert plan["effective_keys"]["lead"]["mode"] == l["key"]["mode"]
                assert plan["anchor_variant"] == "full"
                assert plan["lead_variant"] == "full"
                assert plan["pitch_mode"] == "match"
                assert plan["duration"]["requested"] == 10.0
                assert plan["duration"]["available"] is not None
                # Overlong requests are capped to the available overlap so the
                # plan reports exactly what the renderer will produce.
                assert plan["duration"]["output"] == pytest.approx(plan["duration"]["available"], abs=1e-3)
                assert plan["duration"]["output"] < 10.0
                assert isinstance(plan["warnings"], list)
                import json as _json
                assert str(tmp_path) not in _json.dumps(plan)

                # Read-only: no job, no output.
                assert (await c.get("/api/jobs")).json()["jobs"] == jobs_before
                assert list((tmp_path / "data" / "renders").glob("*")) == renders_before
        finally:
            app.state.studio.close()

    @pytest.mark.anyio
    async def test_plan_caps_overlong_request_to_available(self, tmp_path):
        """Audit regression: an overlong request must report the capped output.

        The read-only plan previously returned ``output == requested`` (e.g.
        30.0) even when only ~7.7s of overlap existed, while the renderer
        silently stopped at the shorter source's EOF. The plan must match.
        """
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://studio.test") as c:
                a = await _import_track(c, tmp_path, "a.wav", 100, 261.63, duration=8.0)
                l = await _import_track(c, tmp_path, "l.wav", 100, 261.63, duration=8.0)

                resp = await c.post("/api/renders/plan", json={
                    "anchor_id": a["id"], "lead_id": l["id"], "duration": 30.0,
                })
                assert resp.status_code == 200, resp.text
                plan = resp.json()
                assert plan["duration"]["requested"] == 30.0
                assert plan["duration"]["available"] < 30.0
                assert plan["duration"]["output"] == pytest.approx(plan["duration"]["available"], abs=1e-3)
                # Backward-compatible alias agrees.
                assert plan["output_duration"] == pytest.approx(plan["duration"]["output"], abs=1e-3)
                assert any("exceeds the available overlap" in w for w in plan["warnings"])
        finally:
            app.state.studio.close()

    @pytest.mark.anyio
    async def test_plan_preserve_pitch_and_warnings(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://studio.test") as c:
                a = await _import_track(c, tmp_path, "a.wav", 120, 261.63)
                l = await _import_track(c, tmp_path, "l.wav", 60, 220.0)

                resp = await c.post("/api/renders/plan", json={
                    "anchor_id": a["id"], "lead_id": l["id"],
                    "pitch_mode": "preserve",
                })
                assert resp.status_code == 200, resp.text
                plan = resp.json()
                assert plan["semitone_shift"] == 0
                assert plan["pitch_mode"] == "preserve"
                assert plan["tempo_ratio"] == pytest.approx(a["bpm"] / l["bpm"], abs=1e-4)
                joined = " ".join(plan["warnings"])
                assert "2:1" in joined or "double" in joined.lower() or "ratio" in joined.lower()
                assert plan["duration"]["requested"] is None
                assert plan["duration"]["available"] > 0
                assert plan["duration"]["output"] <= plan["duration"]["available"]
        finally:
            app.state.studio.close()

    @pytest.mark.anyio
    async def test_plan_stem_variants_and_unavailable(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://studio.test") as c:
                a = await _import_track(c, tmp_path, "a.wav", 100, 261.63)
                l = await _import_track(c, tmp_path, "l.wav", 100, 261.63)

                # Unavailable stem variant -> error envelope, no partial state.
                resp = await c.post("/api/renders/plan", json={
                    "anchor_id": a["id"], "lead_id": l["id"], "lead_variant": "vocals",
                })
                assert resp.status_code in (400, 409, 422)
                assert "error" in resp.json()

                job = (await c.post(
                    f"/api/tracks/{l['id']}/separations", json={"method": "ffmpeg"}
                )).json()
                job = await _wait_job(c, job["id"])
                assert job["status"] == "complete", job.get("error")

                resp = await c.post("/api/renders/plan", json={
                    "anchor_id": a["id"], "lead_id": l["id"], "lead_variant": "center",
                })
                assert resp.status_code == 200, resp.text
                plan = resp.json()
                assert plan["lead_variant"] == "center"
                # The truthful selected source is described without paths.
                assert plan["selected_sources"]["lead"]["variant"] == "center"
                assert plan["selected_sources"]["lead"]["method"] == "ffmpeg"
                assert plan["selected_sources"]["anchor"]["method"] is None
        finally:
            app.state.studio.close()

    @pytest.mark.anyio
    async def test_plan_validation_and_missing_tracks(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://studio.test") as c:
                a = await _import_track(c, tmp_path, "a.wav", 100, 261.63)
                assert (await c.post("/api/renders/plan", json={
                    "anchor_id": a["id"], "lead_id": "nope",
                })).status_code in (400, 404, 422)
                # Invalid body -> standard 422 envelope.
                resp = await c.post("/api/renders/plan", json={"anchor_id": a["id"]})
                assert resp.status_code == 422
                assert resp.json()["error"]["code"] == "validation_error"
        finally:
            app.state.studio.close()

    @pytest.mark.anyio
    async def test_plan_effective_overrides(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://studio.test") as c:
                a = await _import_track(c, tmp_path, "a.wav", 100, 261.63)
                l = await _import_track(c, tmp_path, "l.wav", 120, 220.0)

                # Override the anchor's effective BPM; the plan must use it.
                resp = await c.patch(f"/api/tracks/{a['id']}", json={"bpm": 150.0})
                assert resp.status_code == 200

                plan = (await c.post("/api/renders/plan", json={
                    "anchor_id": a["id"], "lead_id": l["id"],
                })).json()
                assert plan["tempo_ratio"] == pytest.approx(150 / l["bpm"], abs=1e-4)
                assert plan["effective_bpm"]["anchor"] == 150.0
                assert plan["effective_bpm"]["lead"] == l["bpm"]
        finally:
            app.state.studio.close()

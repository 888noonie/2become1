"""Phase 3 HTTP tests: error envelope, library/projects/stems endpoints, variants."""

import math
import struct
import wave
from pathlib import Path

import pytest


def synth_track(path: Path, *, bpm: float, root: float, duration: float = 4.0) -> Path:
    sr = 22050
    beat = 60.0 / bpm
    samples = bytearray()
    for index in range(int(sr * duration)):
        t = index / sr
        chord = (
            math.sin(2 * math.pi * root * t)
            + 0.7 * math.sin(2 * math.pi * root * 1.25 * t)
            + 0.6 * math.sin(2 * math.pi * root * 1.5 * t)
        ) / 3
        click = 0.45 * math.sin(2 * math.pi * 90 * t) if (t % beat) < 0.04 else 0
        value = int(max(-1, min(1, chord + click)) * 22000)
        samples += struct.pack("<hh", value, value)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(sr)
        output.writeframes(samples)
    return path


@pytest.fixture
def anyio_backend():
    return "asyncio"


class TestErrorEnvelope:
    @pytest.mark.anyio
    async def test_404_envelope(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
                resp = await c.get("/api/tracks/nope")
                assert resp.status_code == 404
                body = resp.json()
                assert body["error"]["code"] == "not_found"
                assert "message" in body["error"]
                assert "detail" in body["error"]
        finally:
            app.state.studio.close()

    @pytest.mark.anyio
    async def test_422_validation_envelope(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
                # Invalid sort -> 422 (RequestValidationError) via Literal.
                resp = await c.get("/api/tracks", params={"sort": "bogus"})
                assert resp.status_code == 422
                assert resp.json()["error"]["code"] == "validation_error"
        finally:
            app.state.studio.close()


class TestLibraryHTTP:
    @pytest.mark.anyio
    async def test_library_crud_flow(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
                p = synth_track(tmp_path / "t.wav", bpm=100, root=261.63)
                with p.open("rb") as f:
                    resp = await c.post("/api/tracks", files={"file": ("t.wav", f, "audio/wav")})
                assert resp.status_code == 201
                track = resp.json()
                tid = track["id"]

                # List with pagination shape.
                listing = (await c.get("/api/tracks")).json()
                assert "items" in listing and "total" in listing
                assert listing["total"] == 1

                # PATCH display name + override.
                patched = (await c.patch(f"/api/tracks/{tid}", json={"display_name": "Renamed", "bpm": 128.0})).json()
                assert patched["name"] == "Renamed"
                assert patched["bpm"] == 128.0
                assert patched["detected"]["bpm"] != 128.0

                # Artwork endpoint returns a placeholder (no artwork).
                art = await c.get(f"/api/tracks/{tid}/artwork")
                assert art.status_code == 200

                # Trash + restore.
                trashed = (await c.delete(f"/api/tracks/{tid}")).json()
                assert trashed["deleted_at"] is not None
                restored = (await c.post(f"/api/tracks/{tid}/restore")).json()
                assert restored["deleted_at"] is None
        finally:
            app.state.studio.close()


class TestProjectsHTTP:
    @pytest.mark.anyio
    async def test_project_crud_flow(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
                a = synth_track(tmp_path / "a.wav", bpm=100, root=261.63)
                l = synth_track(tmp_path / "l.wav", bpm=120, root=220.0)
                with a.open("rb") as f:
                    at = (await c.post("/api/tracks", files={"file": ("a.wav", f, "audio/wav")})).json()
                with l.open("rb") as f:
                    lt = (await c.post("/api/tracks", files={"file": ("l.wav", f, "audio/wav")})).json()

                proj = (await c.post("/api/projects", json={"name": "Test"})).json()
                assert proj["name"] == "Test"
                pid = proj["id"]

                updated = (await c.patch(f"/api/projects/{pid}", json={
                    "anchor_track_id": at["id"], "lead_track_id": lt["id"],
                    "settings": {"duration": 20.0, "snap": True, "pitch_mode": "match"},
                })).json()
                assert updated["anchor_track_id"] == at["id"]

                got = (await c.get(f"/api/projects/{pid}")).json()
                assert got["settings"]["duration"] == 20.0

                # Delete -> 204.
                resp = await c.delete(f"/api/projects/{pid}")
                assert resp.status_code == 204
                # Now 404.
                resp = await c.get(f"/api/projects/{pid}")
                assert resp.status_code == 404
        finally:
            app.state.studio.close()


class TestStemsHTTP:
    @pytest.mark.anyio
    async def test_separation_and_stem_audio(self, tmp_path):
        pytest.importorskip("fastapi")
        import asyncio
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
                p = synth_track(tmp_path / "t.wav", bpm=100, root=261.63)
                with p.open("rb") as f:
                    t = (await c.post("/api/tracks", files={"file": ("t.wav", f, "audio/wav")})).json()

                resp = await c.post(f"/api/tracks/{t['id']}/separations", json={"method": "ffmpeg"})
                assert resp.status_code == 202
                job = resp.json()
                deadline = 60
                import time
                start = time.monotonic()
                while time.monotonic() - start < deadline:
                    j = (await c.get(f"/api/jobs/{job['id']}")).json()
                    if j["status"] in {"complete", "failed"}:
                        break
                    await asyncio.sleep(0.05)
                assert j["status"] == "complete", j.get("error")
                stem_set_id = j["result"]["stem_set_id"]

                stems = (await c.get(f"/api/tracks/{t['id']}/stems")).json()
                assert "center" in stems["stems"]
                assert "vocals" not in stems["stems"]

                audio = await c.get(f"/api/stems/{stem_set_id}/audio", params={"name": "center"})
                assert audio.status_code == 200
        finally:
            app.state.studio.close()


class TestRenderVariantsHTTP:
    @pytest.mark.anyio
    async def test_legacy_use_vocals_and_explicit_variant(self, tmp_path):
        pytest.importorskip("fastapi")
        import asyncio
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
                a = synth_track(tmp_path / "a.wav", bpm=100, root=261.63)
                l = synth_track(tmp_path / "l.wav", bpm=120, root=220.0)
                with a.open("rb") as f:
                    at = (await c.post("/api/tracks", files={"file": ("a.wav", f, "audio/wav")})).json()
                with l.open("rb") as f:
                    lt = (await c.post("/api/tracks", files={"file": ("l.wav", f, "audio/wav")})).json()

                # Legacy use_vocals: false -> full lead (works without separation).
                resp = await c.post("/api/jobs", json={
                    "anchor_id": at["id"], "lead_id": lt["id"],
                    "duration": 2.0, "preview": True, "use_vocals": False,
                })
                assert resp.status_code == 202
                job = resp.json()
                import time
                start = time.monotonic()
                while time.monotonic() - start < 60:
                    j = (await c.get(f"/api/jobs/{job['id']}")).json()
                    if j["status"] in {"complete", "failed"}:
                        break
                    await asyncio.sleep(0.05)
                assert j["status"] == "complete", j.get("error")
                assert j["result"]["lead_variant"] == "full"

                # Explicit unavailable variant -> failed with conflict.
                resp2 = await c.post("/api/jobs", json={
                    "anchor_id": at["id"], "lead_id": lt["id"],
                    "duration": 2.0, "preview": True, "lead_variant": "vocals",
                })
                job2 = resp2.json()
                start = time.monotonic()
                while time.monotonic() - start < 60:
                    j2 = (await c.get(f"/api/jobs/{job2['id']}")).json()
                    if j2["status"] in {"complete", "failed"}:
                        break
                    await asyncio.sleep(0.05)
                assert j2["status"] == "failed"
                assert "not available" in j2["error"]
        finally:
            app.state.studio.close()

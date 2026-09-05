"""Phase 4.0 backend support tests: jobs pagination/filters, library source
filter, and health details."""

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


class TestHealth:
    def test_health_reports_facts(self, tmp_path):
        from twobecomeone.studio import StudioService

        service = StudioService(tmp_path / "data")
        try:
            health = service.health()
            assert health["status"] == "ready"
            assert health["version"]
            assert "ffmpeg" in health
            assert "yt_dlp" in health
            assert health["preferred_device"] in {"cuda", "cpu"}
            assert "demucs_available" in health
            assert "queue" in health
            assert health["queue"]["active"] == 0
            assert "storage" in health
            assert health["storage"]["data_dir"] == str(service.data_dir)
        finally:
            service.close()

    @pytest.mark.anyio
    async def test_health_http_includes_network_exposure(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
                resp = await c.get("/api/health")
                assert resp.status_code == 200
                body = resp.json()
                assert "network_exposure" in body
                assert body["network_exposure"]["authenticated"] is False
                assert "warning" in body["network_exposure"]
        finally:
            app.state.studio.close()


class TestLibrarySourceFilter:
    def test_source_filter(self, tmp_path):
        from twobecomeone.studio import StudioService

        service = StudioService(tmp_path / "data")
        try:
            a = synth_track(tmp_path / "a.wav", bpm=100, root=261.63)
            b = synth_track(tmp_path / "b.wav", bpm=120, root=220.0)
            with a.open("rb") as f:
                service.ingest(f, "a.wav", source_kind="upload")
            with b.open("rb") as f:
                service.ingest(f, "b.wav", source_kind="youtube", source_ref="https://youtu.be/x")
            uploads = service.list_tracks_page(source="upload")
            assert uploads["total"] == 1
            assert uploads["items"][0]["source"]["kind"] == "upload"
            yt = service.list_tracks_page(source="youtube")
            assert yt["total"] == 1
            assert yt["items"][0]["source"]["kind"] == "youtube"
        finally:
            service.close()

    def test_source_filter_rejects_unknown(self, tmp_path):
        from twobecomeone.studio import StudioService
        from twobecomeone.common import UserError

        service = StudioService(tmp_path / "data")
        try:
            with pytest.raises(UserError, match="unknown source"):
                service.list_tracks_page(source="bogus")
        finally:
            service.close()


class TestJobsPagination:
    def test_list_jobs_page_and_filters(self, tmp_path):
        from twobecomeone.studio import StudioService

        service = StudioService(tmp_path / "data")
        try:
            # No jobs yet.
            page = service.list_jobs_page()
            assert page["total"] == 0
            assert page["items"] == []
            # job_counts reflects zero.
            assert service.job_counts()["active"] == 0
        finally:
            service.close()

    @pytest.mark.anyio
    async def test_jobs_http_alias_preserved(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
                # No filters -> V0.2 alias shape.
                resp = await c.get("/api/jobs")
                assert resp.status_code == 200
                assert "jobs" in resp.json()
                # With a filter -> paginated shape.
                resp2 = await c.get("/api/jobs", params={"status": "complete"})
                assert resp2.status_code == 200
                body = resp2.json()
                assert "items" in body and "total" in body
        finally:
            app.state.studio.close()

    @pytest.mark.anyio
    async def test_jobs_http_rejects_unknown_status(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
                resp = await c.get("/api/jobs", params={"status": "bogus"})
                assert resp.status_code == 422
                assert resp.json()["error"]["code"] == "validation_error"
        finally:
            app.state.studio.close()

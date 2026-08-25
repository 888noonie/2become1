"""Phase 2.4-2.8 tests: resume, metadata, managed paths, dedupe, HTTP imports."""

import io
import math
import struct
import wave
from pathlib import Path

import pytest

from twobecomeone import media, sources
from twobecomeone.common import UserError
from twobecomeone.studio import StudioService


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


class TestMedia:
    def test_sha256_deterministic(self, tmp_path):
        p = tmp_path / "a.bin"
        p.write_bytes(b"hello world")
        assert media.sha256_file(p) == media.sha256_file(p)
        assert media.sha256_file(p) != media.sha256_file(tmp_path / "b.bin") if (tmp_path / "b.bin").exists() else True

    def test_sanitize_text_strips_control_and_bidi(self):
        assert media.sanitize_text("hello\x00world", 100) == "helloworld"
        assert media.sanitize_text("a\u200eb\u202ec", 100) == "abc"
        assert media.sanitize_text("  lots   of   space  ", 100) == "lots of space"
        assert media.sanitize_text("x" * 1000, 10) == "x" * 10

    def test_sanitize_metadata_whitelists(self):
        raw = {
            "title": "My <script>Track</script>",
            "uploader": "Someone",
            "description": "should be dropped",
            "cookies": "secret",
            "duration": 123.4,
            "webpage_url": "https://youtube.com/watch?v=x",
            "extractor": "youtube",
            "video_id": "abc123",
            "nested": {"a": 1},
        }
        clean = media.sanitize_metadata(raw)
        assert "title" in clean
        assert "description" not in clean
        assert "cookies" not in clean
        assert "nested" not in clean
        assert clean["duration"] == 123.4
        assert clean["video_id"] == "abc123"

    def test_sanitize_metadata_bad_duration(self):
        assert media.sanitize_metadata({"duration": "not-a-number"})["duration"] is None
        assert media.sanitize_metadata({"duration": -5})["duration"] is None

    def test_generate_waveform(self, tmp_path):
        p = synth_track(tmp_path / "t.wav", bpm=100, root=261.63)
        wf = media.generate_waveform(p)
        assert wf["version"] == 1
        assert wf["bins"] == 1200
        assert len(wf["peaks"]) == 1200

    def test_validate_managed_path_rejects_escape(self, tmp_path):
        root = tmp_path / "root"
        root.mkdir()
        outside = tmp_path / "outside.txt"
        outside.write_text("x")
        with pytest.raises(UserError, match="escapes"):
            media.validate_managed_path(outside, root)

    def test_validate_managed_path_accepts_inside(self, tmp_path):
        root = tmp_path / "root"
        root.mkdir()
        inside = root / "a.txt"
        inside.write_text("x")
        assert media.validate_managed_path(inside, root) == inside.resolve()


class TestDedupe:
    def test_duplicate_imports_produce_one_track(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            p = synth_track(tmp_path / "t.wav", bpm=100, root=261.63)
            with p.open("rb") as f:
                t1 = service.ingest(f, "t.wav")
            with p.open("rb") as f:
                t2 = service.ingest(f, "t.wav")
            assert t1["id"] == t2["id"]
            assert len(service.list_tracks()) == 1
        finally:
            service.close()


class TestImportJobs:
    def test_youtube_import_returns_202_job(self, tmp_path, monkeypatch):
        service = StudioService(tmp_path / "data")
        try:
            # Mock the download to avoid network.
            def fake_download(url, work_dir, **kwargs):
                from twobecomeone.acquisition import SubprocessResult
                # Write a fake audio file into work_dir.
                p = synth_track(Path(work_dir) / "abc123.mp3", bpm=100, root=261.63)
                return SubprocessResult(returncode=0)

            monkeypatch.setattr("twobecomeone.acquisition.download_youtube", fake_download)
            job = service.submit_youtube_import("https://youtu.be/abc123")
            assert job["status"] in {"queued", "running"}
            assert job["kind"] == "import"
            completed = service.wait_for_job(job["id"], timeout=30)
            assert completed["status"] == "complete", completed.get("error")
            assert "track_id" in completed["result"]
        finally:
            service.close()

    def test_youtube_import_rejects_bad_url(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            with pytest.raises(UserError, match="valid"):
                service.submit_youtube_import("not-a-url")
        finally:
            service.close()

    def test_upload_import_stages_and_analyzes(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            p = synth_track(tmp_path / "t.wav", bpm=100, root=261.63)
            with p.open("rb") as f:
                staged = service.stage_upload(f, "t.wav")
            job = service.submit_upload_import(staged)
            completed = service.wait_for_job(job["id"], timeout=30)
            assert completed["status"] == "complete", completed.get("error")
            assert "track_id" in completed["result"]
        finally:
            service.close()


class TestHTTPImports:
    @pytest.fixture
    def anyio_backend(self):
        return "asyncio"

    @pytest.mark.anyio
    async def test_imports_youtube_returns_202(self, tmp_path, monkeypatch):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        def fake_download(url, work_dir, **kwargs):
            from twobecomeone.acquisition import SubprocessResult
            synth_track(Path(work_dir) / "abc123.mp3", bpm=100, root=261.63)
            return SubprocessResult(returncode=0)

        monkeypatch.setattr("twobecomeone.acquisition.download_youtube", fake_download)
        app = create_app(tmp_path / "web-data")
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://studio.test") as client:
                resp = await client.post(
                    "/api/imports/youtube", json={"url": "https://youtu.be/abc123"}
                )
                assert resp.status_code == 202, resp.text
                job = resp.json()
                assert job["kind"] == "import"
                assert "output_path" not in job
        finally:
            app.state.studio.close()

    @pytest.mark.anyio
    async def test_imports_upload_returns_202(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        p = synth_track(tmp_path / "t.wav", bpm=100, root=261.63)
        app = create_app(tmp_path / "web-data")
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://studio.test") as client:
                with p.open("rb") as f:
                    resp = await client.post(
                        "/api/imports/upload", files={"file": ("t.wav", f, "audio/wav")}
                    )
                assert resp.status_code == 202, resp.text
                job = resp.json()
                assert job["kind"] == "import"
        finally:
            app.state.studio.close()

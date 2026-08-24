import asyncio
import io
import math
import struct
import time
import wave
from pathlib import Path

import pytest

from twobecomeone import beatgrid
from twobecomeone.studio import RenderOptions, StudioService


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
def studio_tracks(tmp_path):
    return (
        synth_track(tmp_path / "anchor.wav", bpm=100, root=261.63),
        synth_track(tmp_path / "lead.wav", bpm=140, root=220.0),
    )


def ingest_path(service: StudioService, path: Path) -> dict:
    with path.open("rb") as source:
        return service.ingest(source, path.name)


def test_studio_ingest_persists_safe_track(tmp_path, studio_tracks):
    service = StudioService(tmp_path / "data")
    try:
        track = ingest_path(service, studio_tracks[0])
        assert track["name"] == "anchor.wav"
        assert track["bpm"] > 0
        assert track["audio_url"].endswith("/audio")
        assert track["beat_grid"]["interval"] > 0
        assert track["beat_grid"]["suggested_downbeat"] >= 0
        assert service.track_path(track["id"]).parent == service.track_dir
        assert service.list_tracks()[0]["id"] == track["id"]
    finally:
        service.close()


def test_beat_grid_returns_honest_suggestion(studio_tracks):
    grid = beatgrid.detect(studio_tracks[0], bpm=100.0)
    assert grid.beat_interval == pytest.approx(0.6, abs=0.01)
    assert grid.first_beat >= 0
    assert grid.suggested_downbeat >= grid.first_beat
    assert 0 <= grid.confidence <= 1


def test_studio_rejects_unsupported_upload(tmp_path):
    service = StudioService(tmp_path / "data")
    try:
        with pytest.raises(Exception, match="unsupported audio type"):
            service.ingest(io.BytesIO(b"not audio"), "track.exe")
    finally:
        service.close()


def test_studio_render_job_completes(tmp_path, studio_tracks):
    service = StudioService(tmp_path / "data")
    try:
        anchor = ingest_path(service, studio_tracks[0])
        lead = ingest_path(service, studio_tracks[1])
        job = service.submit_render(RenderOptions(
            anchor_id=anchor["id"], lead_id=lead["id"], duration=2.0, preview=True,
        ))
        completed = service.wait_for_job(job["id"], timeout=30)
        assert completed["status"] == "complete", completed["error"]
        assert completed["result"]["duration"] == pytest.approx(2.0, abs=0.15)
        assert service.job_output_path(job["id"]).is_file()
    finally:
        service.close()


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_web_vertical_slice(tmp_path, studio_tracks):
    pytest.importorskip("fastapi")
    import httpx2
    from twobecomeone.webapp import create_app

    app = create_app(tmp_path / "web-data")
    transport = httpx2.ASGITransport(app=app)
    try:
        async with httpx2.AsyncClient(transport=transport, base_url="http://studio.test") as client:
            assert (await client.get("/")).status_code == 200
            health = (await client.get("/api/health")).json()
            assert health["status"] == "ready"

            uploaded = []
            for path in studio_tracks:
                with path.open("rb") as source:
                    response = await client.post(
                        "/api/tracks", files={"file": (path.name, source, "audio/wav")},
                    )
                assert response.status_code == 201, response.text
                uploaded.append(response.json())
                assert uploaded[-1]["beat_grid"]["interval"] > 0

            response = await client.post("/api/jobs", json={
                "anchor_id": uploaded[0]["id"],
                "lead_id": uploaded[1]["id"],
                "duration": 2.0,
                "preview": True,
            })
            assert response.status_code == 202, response.text
            job_id = response.json()["id"]
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                job = (await client.get(f"/api/jobs/{job_id}")).json()
                if job["status"] in {"complete", "failed"}:
                    break
                await asyncio.sleep(0.05)
            assert job["status"] == "complete", job.get("error")
            audio = await client.get(f"/api/jobs/{job_id}/audio")
            assert audio.status_code == 200
            assert audio.headers["content-type"].startswith("audio/mpeg")
    finally:
        app.state.studio.close()

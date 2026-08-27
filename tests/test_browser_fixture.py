"""Focused tests for the Phase 7A browser-test fixture helpers.

Covers every helper in ``tests/browser/fixture_server.py`` so the browser
harness rests on tested ground: the deterministic YouTube stub, the synthetic
track generator, the network patch, and the seeded fixture app.
"""

from __future__ import annotations

import pytest

from twobecomeone import acquisition, sources
from twobecomeone.studio import StudioService

from browser import fixture_server

_REAL_DOWNLOAD_YOUTUBE = acquisition.download_youtube


@pytest.fixture(autouse=True)
def _restore_download_boundary(monkeypatch):
    """Keep the fixture's module-level network stub inside each test."""
    monkeypatch.setattr(acquisition, "download_youtube", _REAL_DOWNLOAD_YOUTUBE)
    yield


def test_synth_track_is_decodable_and_deterministic(tmp_path):
    a = fixture_server.synth_track(tmp_path / "a.wav", bpm=100.0, root=261.63)
    b = fixture_server.synth_track(tmp_path / "b.wav", bpm=100.0, root=261.63)
    assert a.is_file()
    assert a.read_bytes() == b.read_bytes()


def test_fake_download_writes_artifact_and_thumbnail(tmp_path):
    work = tmp_path / "work"
    result = fixture_server._fake_download_youtube(
        "https://youtu.be/dQw4w9WgXcQ", work,
    )
    assert result.returncode == 0
    assert (work / "dQw4w9WgXcQ.wav").is_file()
    assert (work / "dQw4w9WgXcQ.png").is_file()


def test_fake_download_emits_progress(tmp_path):
    seen = []
    fixture_server._fake_download_youtube(
        "https://youtu.be/dQw4w9WgXcQ", tmp_path / "work",
        on_progress=seen.append,
    )
    assert [p["percent"] for p in seen] == [40.0, 100.0]


def test_patch_for_tests_is_idempotent():
    original = acquisition.download_youtube
    fixture_server.patch_for_tests()
    first = acquisition.download_youtube
    fixture_server.patch_for_tests()
    assert acquisition.download_youtube is first
    assert acquisition.download_youtube is not original


def test_seed_library_ingests_two_tracks(tmp_path):
    service = StudioService(tmp_path / "data")
    try:
        anchor, lead = fixture_server.seed_library(service, tmp_path)
        assert anchor["id"] != lead["id"]
        assert anchor["bpm"] > 0 and lead["bpm"] > 0
        assert len(service.list_tracks()) == 2
    finally:
        service.close()


def test_seed_failed_render_is_retryable_history(tmp_path):
    service = StudioService(tmp_path / "data")
    try:
        anchor, lead = fixture_server.seed_library(service, tmp_path)
        job_id = fixture_server.seed_failed_render(service, anchor, lead)
        job = service.get_job(job_id)
        assert job["status"] == "failed"
        assert job["recovery"]["can_retry"] is True
        assert job["request"]["anchor_id"] == anchor["id"]
        assert job["request"]["lead_id"] == lead["id"]
    finally:
        service.close()


def test_create_fixture_app_seeds_and_stubs(tmp_path):
    app = fixture_server.create_fixture_app(tmp_path / "data", seed=True)
    try:
        service = app.state.studio
        assert len(service.list_tracks()) == 2
        # The network boundary is stubbed on the module the import job uses.
        assert acquisition.download_youtube is fixture_server._fake_download_youtube
    finally:
        app.state.studio.close()


def test_create_fixture_app_no_seed_is_empty(tmp_path):
    app = fixture_server.create_fixture_app(tmp_path / "data", seed=False)
    try:
        assert app.state.studio.list_tracks() == []
    finally:
        app.state.studio.close()


def test_fixture_app_reports_loopback_binding(tmp_path):
    app = fixture_server.create_fixture_app(tmp_path / "data", seed=False)
    try:
        assert app.state.bind_host == "127.0.0.1"
    finally:
        app.state.studio.close()


def test_youtube_import_job_completes_with_stub(tmp_path):
    """The real import job path runs end to end with only the download stubbed."""
    fixture_server.patch_for_tests()
    service = StudioService(tmp_path / "data")
    try:
        job = service.submit_youtube_import("https://youtu.be/dQw4w9WgXcQ")
        completed = service.wait_for_job(job["id"], timeout=30)
        assert completed["status"] == "complete", completed.get("error")
        track = service.get_track(completed["result"]["track_id"])
        assert track["source"]["kind"] == "youtube"
        assert track["artwork_url"].endswith("/artwork")
    finally:
        service.close()

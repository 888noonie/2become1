"""Focused tests for the Phase 9C ghost browser fixture helpers.

Covers the seed logic in ``tests/browser/ghost_fixture_server.py`` so the
browser harness rests on tested ground: the synthetic track generator, the
vocals-stem registration, and the seeded project.
"""

from __future__ import annotations

import json

import pytest

from twobecomeone.studio import StudioService

from browser import ghost_fixture_server


def test_synth_track_is_decodable_and_deterministic(tmp_path):
    a = ghost_fixture_server.synth_track(tmp_path / "a.wav", bpm=120.0, root=261.63)
    b = ghost_fixture_server.synth_track(tmp_path / "b.wav", bpm=120.0, root=261.63)
    assert a.is_file()
    assert a.read_bytes() == b.read_bytes()


def test_make_vocals_stem_registers_completed_set(tmp_path):
    service = StudioService(tmp_path / "data")
    try:
        wav = ghost_fixture_server.synth_track(tmp_path / "t.wav", bpm=120.0, root=261.63)
        track = service.ingest(wav.open("rb"), "t.wav")
        ghost_fixture_server.make_vocals_stem(service, track["id"])
        assert service._variant_available(service._track_content_hash(track["id"]), "vocals") is True
    finally:
        service.close()


def test_seed_creates_project_with_tracks_and_stems(tmp_path):
    data_dir = tmp_path / "data"
    result = ghost_fixture_server.seed(data_dir)
    assert "project_id" in result
    assert "anchor_id" in result
    assert "lead_id" in result

    service = StudioService(data_dir)
    try:
        project = service.get_project(result["project_id"])
        assert project["anchor_track_id"] == result["anchor_id"]
        assert project["lead_track_id"] == result["lead_id"]
        assert project["anchor_variant"] == "vocals"
        assert project["lead_variant"] == "vocals"
        # Both tracks have a playable vocals stem.
        for track_id in (result["anchor_id"], result["lead_id"]):
            assert service._variant_available(service._track_content_hash(track_id), "vocals") is True
    finally:
        service.close()
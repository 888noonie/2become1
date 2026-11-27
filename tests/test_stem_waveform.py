"""Stem-Focus waveform (OPERATION STUDIO SURGEON, Act I).

The Focus panel draws a stem from real peaks of the stored stem file. The
route reads that file and never writes it; the payload is cached and is
recomputed when the file changes.
"""

from __future__ import annotations

import pytest

from twobecomeone.common import UserError
from twobecomeone.studio import StudioService

from test_stem_names import _file_hashes, _ingest, _quad, _set_dir, _stage_all, _wav


@pytest.fixture
def imported(tmp_path):
    service = StudioService(tmp_path / "data")
    try:
        track = _ingest(service, _wav(tmp_path / "mix.wav", freq=200.0))
        result = service.import_stem_set(track["id"], _stage_all(service, _quad(tmp_path / "stems")))
        yield service, track, result
    finally:
        service.close()


def test_peaks_come_from_the_stem_file_and_leave_it_unchanged(imported):
    service, _track, result = imported
    set_id = result["stem_set_id"]
    before = _file_hashes(_set_dir(service, set_id))
    payload = service.stem_waveform(set_id, "bass")
    assert payload["version"] == 1 and payload["bins"] == 1200 and len(payload["peaks"]) == 1200
    assert payload["role"] == "bass" and payload["stem_set_id"] == set_id
    assert payload["duration_sec"] == pytest.approx(1.0, abs=0.01)
    # Real peaks of that file (the same generator as a track waveform), not
    # a flat or decorative shape.
    from twobecomeone import media
    assert payload["peaks"] == media.generate_waveform(service.stem_audio_path(set_id, "bass"))["peaks"]
    assert max(hi for _lo, hi in payload["peaks"]) > 0.1
    assert _file_hashes(_set_dir(service, set_id)) == before


def test_the_cache_is_reused_and_recomputed_when_the_file_changes(imported, monkeypatch):
    service, _track, result = imported
    set_id = result["stem_set_id"]
    first = service.stem_waveform(set_id, "vocals")
    calls = []
    import twobecomeone.media as media
    real = media.generate_waveform
    monkeypatch.setattr(media, "generate_waveform", lambda path, *a, **k: calls.append(path) or real(path, *a, **k))
    assert service.stem_waveform(set_id, "vocals") == first
    assert calls == []
    # Replace the stem file (a test-only change) and the peaks follow it.
    path = service.stem_audio_path(set_id, "vocals")
    _wav(path, freq=440.0, duration=2.0)
    again = service.stem_waveform(set_id, "vocals")
    assert len(calls) == 1
    assert again["duration_sec"] == pytest.approx(2.0, abs=0.01)


def test_unknown_roles_and_sets_are_refused(imported):
    service, _track, result = imported
    with pytest.raises(UserError):
        service.stem_waveform(result["stem_set_id"], "../vocals")
    with pytest.raises(UserError):
        service.stem_waveform("missing-set", "vocals")


def test_http_route_serves_the_payload(tmp_path):
    from fastapi.testclient import TestClient
    from twobecomeone.webapp import create_app

    app = create_app(tmp_path / "data")
    service = app.state.studio
    with TestClient(app, base_url="http://localhost") as client:
        track = _ingest(service, _wav(tmp_path / "mix.wav", freq=200.0))
        result = service.import_stem_set(track["id"], _stage_all(service, _quad(tmp_path / "stems")))
        set_id = result["stem_set_id"]
        response = client.get(f"/api/stems/{set_id}/waveform", params={"name": "drums"})
        assert response.status_code == 200, response.text
        assert response.json()["role"] == "drums" and len(response.json()["peaks"]) == 1200
        assert client.get(f"/api/stems/{set_id}/waveform", params={"name": "nope"}).status_code >= 400


def test_parallel_cache_writers_use_distinct_temporary_files(imported, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from pathlib import Path
    from threading import Barrier

    service, _track, result = imported
    ready = Barrier(2)
    replace = Path.replace

    def simultaneous_replace(path, target):
        if target.name.endswith(".bass.json"):
            ready.wait(timeout=10)
        return replace(path, target)

    monkeypatch.setattr(Path, "replace", simultaneous_replace)
    with ThreadPoolExecutor(max_workers=2) as pool:
        reads = [pool.submit(service.stem_waveform, result["stem_set_id"], "bass") for _ in range(2)]
        assert reads[0].result() == reads[1].result()


def test_waveform_recovers_from_non_object_cache(imported):
    service, _track, result = imported
    set_id = result["stem_set_id"]
    first = service.stem_waveform(set_id, "bass")
    cache = service.waveform_dir / "stems" / f"{set_id}.bass.json"
    cache.write_text("[]", encoding="utf-8")
    assert service.stem_waveform(set_id, "bass") == first


def test_corrupt_waveform_media_error_hides_filesystem_path(imported):
    service, _track, result = imported
    set_id = result["stem_set_id"]
    source = service.stem_audio_path(set_id, "bass")
    source.write_bytes(b"not audio")
    with pytest.raises(UserError) as error:
        service.stem_waveform(set_id, "bass")
    assert str(source) not in str(error.value)

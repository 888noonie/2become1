"""Saved Studio arrangements (OPERATION FULL HOUSE): save, list, reopen, guards."""
from __future__ import annotations

from fastapi.testclient import TestClient

from twobecomeone.webapp import create_app


def _project(reference: str = "/api/stems/abc123/audio?name=vocals&start=30&duration=60") -> dict:
    return {
        "schemaVersion": 1,
        "transport": {"masterBpm": 96.8, "timeSignature": [4, 4], "sampleRate": 48000,
                      "playheadBeat": 0, "isPlaying": False, "loopRange": [8, 16]},
        "assets": {"asset-1": {"id": "asset-1", "name": "A Vocals", "durationSec": 60.0,
                               "nativeBpm": 96.8, "detectedKey": None, "bufferReference": reference}},
        "tracks": [],
        "clips": [{"id": "clip-1", "trackIndex": 0, "assetId": "asset-1"}],
        "master": {"volumeDb": -1.5},
    }


def _client(tmp_path):
    return TestClient(create_app(tmp_path), base_url="http://127.0.0.1")


def test_save_list_and_reopen_round_trip(tmp_path):
    client = _client(tmp_path)
    project = _project()
    saved = client.put("/api/arrangements/full-house-demo", json={"name": "Full House demo", "project": project})
    assert saved.status_code == 200, saved.text
    assert saved.json()["name"] == "Full House demo"
    listed = client.get("/api/arrangements").json()["items"]
    assert [(i["id"], i["clipCount"]) for i in listed] == [("full-house-demo", 1)]
    reopened = client.get("/api/arrangements/full-house-demo").json()
    assert reopened["project"] == project
    # Saving again replaces the document atomically, no stray temp files.
    project["master"]["volumeDb"] = -3
    client.put("/api/arrangements/full-house-demo", json={"name": "Full House demo", "project": project})
    assert client.get("/api/arrangements/full-house-demo").json()["project"]["master"]["volumeDb"] == -3
    assert sorted(p.name for p in (tmp_path / "arrangements").iterdir()) == ["full-house-demo.json"]


def test_identifier_and_reference_guards(tmp_path):
    client = _client(tmp_path)
    for bad in ("../escape", "UPPER", "a" * 70, "dot.json"):
        response = client.put(f"/api/arrangements/{bad}", json={"project": _project()})
        assert response.status_code in (404, 422), (bad, response.status_code)
    for reference in ("/etc/passwd", "http://example.com/a.wav", "/api/stems/x/audio?name=../../x",
                      "file:///home/a.wav", "/api/jobs/1/audio"):
        response = client.put("/api/arrangements/ok", json={"project": _project(reference)})
        assert response.status_code == 422, reference
        assert response.json()["error"]["code"] == "ARRANGEMENT_REFERENCE_INVALID"
    assert not (tmp_path / "arrangements" / "ok.json").exists()


def test_schema_and_missing_documents(tmp_path):
    client = _client(tmp_path)
    future = _project()
    future["schemaVersion"] = 2
    response = client.put("/api/arrangements/future", json={"project": future})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "ARRANGEMENT_SCHEMA_UNSUPPORTED"
    missing = client.get("/api/arrangements/nothing-here")
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "ARRANGEMENT_NOT_FOUND"


def test_size_limit(tmp_path):
    client = _client(tmp_path)
    project = _project()
    project["assets"]["asset-1"]["name"] = "x" * (1024 * 1024)
    response = client.put("/api/arrangements/big", json={"project": project})
    assert response.status_code == 413

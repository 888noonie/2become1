"""Read-only Crate catalogue projection (OPERATION RECORD CRATE, Act II-B).

The Crate reuses the existing Library search/pagination, re-validates stem
files on every request, reports separation jobs as facts rather than
readiness, and returns no audio, path, raw metadata blob or credential.

These tests own the backend contract only. The frontend is implemented
independently.
"""

from __future__ import annotations

import json
import math
import re
import struct
import uuid
import wave
from pathlib import Path

import pytest

from twobecomeone import media
from twobecomeone.studio import StudioService

QUAD = ("vocals", "drums", "bass", "other")
ITEM_KEYS = {
    "track_id", "name", "artwork_url", "duration", "bpm", "key", "source",
    "stems", "separation", "content_sha256", "duplicates", "actions",
}
STEM_KEYS = {
    "status", "available", "quad", "roles", "method", "model_name",
    "stem_set_id",
}
SEPARATION_KEYS = {"status", "job_id", "active", "error"}
DUPLICATE_KEYS = {"exact_content", "same_source", "possible_versions"}


def synth_track(path: Path, *, bpm: float = 100.0, root: float = 261.63,
                duration: float = 4.0) -> Path:
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


def _service(tmp_path: Path) -> StudioService:
    return StudioService(tmp_path / "data")


def _ingest(service: StudioService, path: Path, *, source_kind: str = "local",
            source_ref: str | None = None, metadata: dict | None = None) -> dict:
    with path.open("rb") as handle:
        return service.ingest(
            handle, path.name, source_kind=source_kind,
            source_ref=source_ref, metadata=metadata,
        )


def _write_stem(path: Path) -> Path:
    """A small but valid WAV file; readiness checks file resolution."""
    frames = 2205
    data = bytearray()
    for index in range(frames):
        value = int(0.1 * 32767 * math.sin(2 * math.pi * 440 * index / 22050))
        data += struct.pack("<hh", value, value)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(22050)
        output.writeframes(data)
    return path


def _add_stem_set(service: StudioService, track: dict, method: str, names,
                  *, model_name: str | None = None) -> str:
    """Insert a completed stem set the projection must validate on read."""
    stem_set_id = uuid.uuid4().hex
    base = service.stem_dir / stem_set_id
    base.mkdir(parents=True, exist_ok=True)
    paths = {}
    for name in names:
        _write_stem(base / f"{name}.wav")
        paths[name] = f"stems/{stem_set_id}/{name}.wav"
    model = {
        "demucs": "htdemucs@4.1.0",
        "ffmpeg": "center-side-v1",
        "imported": "owner-supplied",
    }.get(method, method)
    device = {"demucs": "cuda", "ffmpeg": "cpu", "imported": "user"}.get(method)
    with service._connect() as conn:
        conn.execute(
            "INSERT INTO stem_sets (id, track_id, method, model, device, status,"
            " paths_json, track_sha256, model_name, provenance_json, created_at)"
            " VALUES (?, ?, ?, ?, ?, 'complete', ?, ?, ?, NULL, ?)",
            (
                stem_set_id, track["id"], method, model, device,
                json.dumps(paths), service._track_content_hash(track["id"]),
                model_name or model, 1_700_000_000.0,
            ),
        )
    return stem_set_id


def _add_job(service: StudioService, track_id: str, status: str, *,
             error: str | None = None, created_at: float = 1_700_000_000.0) -> str:
    job_id = uuid.uuid4().hex
    with service._connect() as conn:
        conn.execute(
            "INSERT INTO jobs (id, kind, status, stage, progress, message,"
            " request_json, error, created_at, updated_at)"
            " VALUES (?, 'separate', ?, 'separating', 0, '', ?, ?, ?, ?)",
            (
                job_id, status,
                json.dumps({"track_id": track_id, "method": "demucs"}),
                error, created_at, created_at,
            ),
        )
    return job_id


@pytest.fixture
def service(tmp_path):
    instance = _service(tmp_path)
    try:
        yield instance
    finally:
        instance.close()


@pytest.fixture
def anyio_backend():
    return "asyncio"


class TestLibraryParity:
    def test_search_filter_sort_and_pagination_match(self, service):
        tracks = []
        for name, bpm in (("alpha", 96.0), ("beta", 120.0), ("gamma", 84.0)):
            path = synth_track(service.temp_dir / f"{name}.wav", bpm=bpm)
            track = _ingest(service, path)
            service.update_track(track["id"], display_name=name.title())
            tracks.append(track)
        yt = _ingest(
            service, synth_track(service.temp_dir / "delta.wav", bpm=110.0),
            source_kind="youtube",
            source_ref="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            metadata={"id": "dQw4w9WgXcQ", "title": "Delta", "uploader": "Uploader"},
        )
        service.update_track(yt["id"], display_name="Delta")

        cases = [
            {"limit": 1, "offset": 0},
            {"limit": 1, "offset": 2},
            {"limit": 10, "query": "alph"},
            {"limit": 10, "query": "a", "sort": "name"},
            {"limit": 10, "source": "youtube"},
        ]
        for kwargs in cases:
            library = service.list_tracks_page(**kwargs)
            crate = service.list_crate_page(**kwargs)
            assert crate["total"] == library["total"], kwargs
            assert crate["limit"] == library["limit"], kwargs
            assert crate["offset"] == library["offset"], kwargs
            assert [item["track_id"] for item in crate["items"]] == [
                item["id"] for item in library["items"]
            ], kwargs

        service.trash_track(tracks[0]["id"])
        for status in ("active", "trash", "all"):
            library = service.list_tracks_page(status=status, limit=10)
            crate = service.list_crate_page(status=status, limit=10)
            assert [item["track_id"] for item in crate["items"]] == [
                item["id"] for item in library["items"]
            ], status


class TestItemContract:
    def test_item_schema_and_safe_projection(self, service, tmp_path):
        track = _ingest(
            service,
            synth_track(service.temp_dir / "hold.wav", bpm=96.0),
            source_kind="youtube",
            source_ref="https://www.youtube.com/watch?v=YN1CWXq0UZo",
            metadata={
                "id": "YN1CWXq0UZo",
                "title": "Hold this feeling",
                "uploader": "TheSpiceArmy",
                "channel": "TheSpiceArmy",
                "description": "must not survive",
                "cookies": "must not survive",
                "webpage_url": "https://www.youtube.com/watch?v=YN1CWXq0UZo",
                "thumbnail": "https://i.ytimg.com/vi/YN1CWXq0UZo/hqdefault.jpg",
            },
        )
        item = service.list_crate_page(limit=1)["items"][0]

        assert set(item) == ITEM_KEYS
        assert set(item["stems"]) == STEM_KEYS
        assert set(item["separation"]) == SEPARATION_KEYS
        assert set(item["duplicates"]) == DUPLICATE_KEYS
        assert item["track_id"] == track["id"]
        assert item["name"] == "hold.wav"
        assert item["artwork_url"] == f"/api/tracks/{track['id']}/artwork"
        assert item["duration"] == pytest.approx(track["duration"])
        assert item["bpm"] == pytest.approx(track["bpm"])
        assert set(item["key"]) == {"tonic", "mode", "confidence"}
        assert item["source"] == {
            "kind": "youtube",
            "external_id": "youtube:YN1CWXq0UZo",
            "video_id": "YN1CWXq0UZo",
        }
        assert re.fullmatch(r"[0-9a-f]{64}", item["content_sha256"])
        assert item["stems"] == {
            "status": "none", "available": False, "quad": False, "roles": [],
            "method": None, "model_name": None, "stem_set_id": None,
        }
        assert item["separation"] == {
            "status": "none", "job_id": None, "active": False, "error": None,
        }
        assert item["duplicates"] == {
            "exact_content": [], "same_source": [], "possible_versions": [],
        }
        assert "separate" in item["actions"]
        assert "choose_A" not in item["actions"]

        blob = json.dumps(item)
        assert "metadata_json" not in blob
        assert "must not survive" not in blob
        assert "cookies" not in blob
        assert str(tmp_path) not in blob
        assert "studio.sqlite3" not in blob

    def test_legacy_row_without_metadata_video_id_uses_source_ref(self, service):
        track = _ingest(
            service,
            synth_track(service.temp_dir / "legacy.wav", bpm=100.0),
            source_kind="youtube",
            source_ref="https://youtu.be/Ozd2ja7mAgM",
            metadata={"title": "Legacy row", "uploader": "Someone"},
        )
        item = service.list_crate_page(limit=1)["items"][0]
        assert item["track_id"] == track["id"]
        assert item["source"]["video_id"] == "Ozd2ja7mAgM"
        assert item["source"]["external_id"] == "youtube:Ozd2ja7mAgM"


class TestStemReadiness:
    def test_quad_center_sides_partial_missing_and_none(self, service):
        quad = _ingest(service, synth_track(service.temp_dir / "quad.wav", bpm=96.0))
        center = _ingest(service, synth_track(service.temp_dir / "center.wav", bpm=100.0))
        partial = _ingest(service, synth_track(service.temp_dir / "partial.wav", bpm=104.0))
        missing = _ingest(service, synth_track(service.temp_dir / "missing.wav", bpm=108.0))
        none = _ingest(service, synth_track(service.temp_dir / "none.wav", bpm=112.0))

        quad_set = _add_stem_set(service, quad, "demucs", QUAD)
        _add_stem_set(service, center, "ffmpeg", ("center", "sides"))
        _add_stem_set(service, partial, "demucs", ("vocals", "drums"))
        missing_set = _add_stem_set(service, missing, "demucs", QUAD)
        (service.stem_dir / missing_set / "bass.wav").unlink()

        page = service.list_crate_page(limit=10)
        items = {item["track_id"]: item for item in page["items"]}

        assert items[quad["id"]]["stems"] == {
            "status": "quad", "available": True, "quad": True,
            "roles": ["vocals", "drums", "bass", "other"],
            "method": "demucs", "model_name": "htdemucs@4.1.0",
            "stem_set_id": quad_set,
        }
        assert "separate" not in items[quad["id"]]["actions"]
        assert "add_arrangement" in items[quad["id"]]["actions"]

        assert items[center["id"]]["stems"]["status"] == "center_sides"
        assert items[center["id"]]["stems"]["quad"] is False
        assert items[center["id"]]["stems"]["roles"] == ["center", "sides"]
        assert items[center["id"]]["stems"]["method"] == "ffmpeg"
        assert "separate" in items[center["id"]]["actions"]
        assert "add_arrangement" not in items[center["id"]]["actions"]

        assert items[partial["id"]]["stems"]["status"] == "partial"
        assert items[partial["id"]]["stems"]["roles"] == ["vocals", "drums"]
        assert items[partial["id"]]["stems"]["quad"] is False
        assert "separate" in items[partial["id"]]["actions"]

        # A complete set with one file removed is not a quad.
        assert items[missing["id"]]["stems"]["status"] == "partial"
        assert items[missing["id"]]["stems"]["quad"] is False
        assert items[missing["id"]]["stems"]["roles"] == ["vocals", "drums", "other"]
        assert "separate" in items[missing["id"]]["actions"]
        assert "add_arrangement" not in items[missing["id"]]["actions"]

        assert items[none["id"]]["stems"]["status"] == "none"
        assert items[none["id"]]["stems"]["available"] is False
        assert items[none["id"]]["stems"]["roles"] == []
        assert "choose_A" not in items[none["id"]]["actions"]
        assert "separate" in items[none["id"]]["actions"]

        # The projection agrees with the existing validated stem listing.
        for track in (quad, center, partial, missing, none):
            listing = service.list_stems(track["id"])
            listed = {
                variant["name"] for variant in listing["variants"]
                if variant["name"] != "full"
            }
            assert set(items[track["id"]]["stems"]["roles"]) == listed

    def test_pending_and_failed_jobs_are_status_not_readiness(self, service):
        pending = _ingest(service, synth_track(service.temp_dir / "pending.wav", bpm=120.0))
        failed = _ingest(service, synth_track(service.temp_dir / "failed.wav", bpm=124.0))
        complete = _ingest(service, synth_track(service.temp_dir / "complete.wav", bpm=128.0))
        pending_job = _add_job(service, pending["id"], "queued")
        failed_job = _add_job(
            service, failed["id"], "failed",
            error=f"demucs failed reading {service.data_dir}/stems/x.wav: boom",
        )
        complete_job = _add_job(service, complete["id"], "complete")

        items = {
            item["track_id"]: item
            for item in service.list_crate_page(limit=10)["items"]
        }

        assert items[pending["id"]]["separation"] == {
            "status": "queued", "job_id": pending_job, "active": True, "error": None,
        }
        assert items[pending["id"]]["stems"]["status"] == "none"
        assert "separate" not in items[pending["id"]]["actions"]

        failed_item = items[failed["id"]]
        assert failed_item["separation"]["status"] == "failed"
        assert failed_item["separation"]["job_id"] == failed_job
        assert failed_item["separation"]["active"] is False
        assert "boom" in failed_item["separation"]["error"]
        assert str(service.data_dir) not in failed_item["separation"]["error"]
        assert "managed data" in failed_item["separation"]["error"]
        assert failed_item["stems"]["status"] == "none"
        assert "separate" in failed_item["actions"]

        # A completed job with no validated files is not readiness.
        assert items[complete["id"]]["separation"] == {
            "status": "complete", "job_id": complete_job, "active": False, "error": None,
        }
        assert items[complete["id"]]["stems"]["status"] == "none"
        assert "separate" in items[complete["id"]]["actions"]


class TestDuplicates:
    def test_exact_source_and_possible_versions_are_distinct(self, service):
        same_a = _ingest(
            service, synth_track(service.temp_dir / "same-a.wav", bpm=96.0),
            source_kind="youtube",
            source_ref="https://www.youtube.com/watch?v=AAAAAAAAAAA",
            metadata={"id": "AAAAAAAAAAA", "title": "Alpha One", "uploader": "Artist One"},
        )
        same_b = _ingest(
            service, synth_track(service.temp_dir / "same-b.wav", bpm=97.0),
            source_kind="youtube",
            source_ref="https://youtu.be/AAAAAAAAAAA",
            metadata={"id": "AAAAAAAAAAA", "title": "Alpha Two", "uploader": "Artist Two"},
        )
        possible_c = _ingest(
            service, synth_track(service.temp_dir / "possible-c.wav", bpm=98.0),
            source_kind="youtube",
            source_ref="https://www.youtube.com/watch?v=BBBBBBBBBBB",
            metadata={"id": "BBBBBBBBBBB", "title": "Same Song", "uploader": "Same Artist"},
        )
        possible_d = _ingest(
            service, synth_track(service.temp_dir / "possible-d.wav", bpm=99.0),
            source_kind="youtube",
            source_ref="https://www.youtube.com/watch?v=CCCCCCCCCCC",
            metadata={"id": "CCCCCCCCCCC", "title": "Same Song", "uploader": "Same Artist"},
        )
        service.update_track(possible_c["id"], display_name="Same Song")
        service.update_track(possible_d["id"], display_name="Same Song")

        items = {
            item["track_id"]: item
            for item in service.list_crate_page(limit=10)["items"]
        }

        for track in (same_a, same_b, possible_c, possible_d):
            assert items[track["id"]]["duplicates"]["exact_content"] == []

        assert items[same_a["id"]]["duplicates"]["same_source"] == [same_b["id"]]
        assert items[same_b["id"]]["duplicates"]["same_source"] == [same_a["id"]]
        assert items[same_a["id"]]["duplicates"]["possible_versions"] == []
        assert items[same_b["id"]]["duplicates"]["possible_versions"] == []

        assert items[possible_c["id"]]["duplicates"]["same_source"] == []
        assert items[possible_d["id"]]["duplicates"]["same_source"] == []
        assert items[possible_c["id"]]["duplicates"]["possible_versions"] == [{
            "track_id": possible_d["id"], "name": "Same Song",
            "reason": "same_title_and_artist",
        }]
        assert items[possible_d["id"]]["duplicates"]["possible_versions"] == [{
            "track_id": possible_c["id"], "name": "Same Song",
            "reason": "same_title_and_artist",
        }]
        assert items[same_a["id"]]["content_sha256"] != items[same_b["id"]]["content_sha256"]


class TestBoundsAndRoute:
    def test_query_count_and_response_size_are_bounded(self, service):
        for index in range(12):
            _ingest(
                service,
                synth_track(service.temp_dir / f"bounded-{index}.wav", bpm=90.0 + index),
            )
        counts = {"select": 0}
        original = service._connect

        def counting_connect():
            conn = original()

            def trace(sql):
                if sql.lstrip().upper().startswith("SELECT"):
                    counts["select"] += 1

            conn.set_trace_callback(trace)
            return conn

        service._connect = counting_connect
        try:
            counts["select"] = 0
            one = service.list_crate_page(limit=1)
            one_count = counts["select"]
            counts["select"] = 0
            many = service.list_crate_page(limit=12)
            many_count = counts["select"]
        finally:
            service._connect = original

        assert len(one["items"]) == 1
        assert len(many["items"]) == 12
        assert one_count == many_count
        assert many_count <= 7, f"{many_count} SELECTs for a 12-item page"
        size = len(json.dumps(many).encode("utf-8"))
        assert size < 100_000, f"{size} bytes for a 12-item page"

    @pytest.mark.anyio
    async def test_http_route_envelope(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "route-data")
        transport = httpx.ASGITransport(app=app)
        try:
            studio = app.state.studio
            track = _ingest(
                studio,
                synth_track(studio.temp_dir / "route.wav", bpm=101.0),
            )
            studio.update_track(track["id"], display_name="Route Alpha")
            async with httpx.AsyncClient(
                transport=transport, base_url="http://localhost"
            ) as client:
                response = await client.get(
                    "/api/crate", params={"limit": 1, "q": "route alph"}
                )
            assert response.status_code == 200
            body = response.json()
            assert set(body) == {"items", "total", "limit", "offset"}
            assert body["total"] == 1
            assert set(body["items"][0]) == ITEM_KEYS
            assert body["items"][0]["track_id"] == track["id"]
        finally:
            app.state.studio.close()


class TestYoutubeIdNormalisation:
    def test_yt_dlp_id_becomes_video_id(self):
        clean = media.sanitize_metadata({"id": "dQw4w9WgXcQ", "title": "x"})
        assert clean["video_id"] == "dQw4w9WgXcQ"
        assert "id" not in clean

    def test_invalid_id_is_dropped_and_explicit_video_id_wins(self):
        assert "video_id" not in media.sanitize_metadata({"id": "not-an-id"})
        explicit = media.sanitize_metadata(
            {"video_id": "AAAAAAAAAAA", "id": "dQw4w9WgXcQ"}
        )
        assert explicit["video_id"] == "AAAAAAAAAAA"

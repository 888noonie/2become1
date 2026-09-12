"""Phase 14B.1: stem crate persistence (migration, service CRUD, HTTP contract)."""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

import pytest

from twobecomeone import migrations
from twobecomeone.common import ConflictError, NotFoundError, UserError
from twobecomeone.migrations import latest_version, run_migrations
from twobecomeone.studio import StudioService
from test_phase11a_commit import make_vocals_stem, synth_wav
from test_phase3_http import synth_track


FIXTURES = Path(__file__).parent / "fixtures"
V02_SCHEMA = FIXTURES / "v0.2_schema.sql"


def make_ffmpeg_stems(service: StudioService, track_id: str, wav: Path) -> str:
    track_sha256 = service._track_content_hash(track_id)
    stem_dir = service.stem_dir / f"ff-{track_sha256[:12]}"
    stem_dir.mkdir(parents=True, exist_ok=True)
    paths: dict[str, str] = {}
    for name in ("center", "sides"):
        dest = stem_dir / f"{name}.wav"
        if not dest.exists():
            synth_wav(dest, seconds=8.0)
        paths[name] = f"stems/ff-{track_sha256[:12]}/{name}.wav"
    stem_set_id = f"ff-{track_sha256[:12]}"
    with service._connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO stem_sets ("
            " id, track_id, track_sha256, method, model_name, device, status, paths_json, created_at"
            ") VALUES (?, ?, ?, 'ffmpeg', 'center-side-v1', 'cpu', 'complete', ?, ?)",
            (stem_set_id, track_id, track_sha256, json.dumps(paths), time.time()),
        )
    return stem_set_id


def create_crate_item(
    service: StudioService,
    *,
    track_id: str,
    stem_set_id: str,
    stem_name: str = "vocals",
    role: str = "voice",
    **overrides,
):
    payload = {
        "track_id": track_id,
        "stem_set_id": stem_set_id,
        "stem_name": stem_name,
        "role": role,
        "loop_bars": 4,
        "region_start_beat": 0.0,
        "region_end_beat": 16.0,
    }
    payload.update(overrides)
    return service.create_stem_crate_item(**payload)


@pytest.fixture
def crate_service(tmp_path):
    service = StudioService(tmp_path / "data")
    try:
        wav = synth_wav(tmp_path / "track.wav", seconds=32.0)
        track = service.ingest(wav.open("rb"), "track.wav")
        make_vocals_stem(service, track["id"], wav)
        stem_set_id = f"set-{service._track_content_hash(track['id'])[:12]}"
        yield service, track, stem_set_id
    finally:
        service.close()


class TestMigration11StemCrate:
    def test_migration_11_table_indexes_and_latest_version(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            with service._connect() as conn:
                tables = {
                    r[0]
                    for r in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    ).fetchall()
                }
                assert "stem_crate_items" in tables
                idx = {
                    r[1]
                    for r in conn.execute("PRAGMA index_list(stem_crate_items)").fetchall()
                }
                assert "idx_stem_crate_items_created" in idx
                assert "idx_stem_crate_items_role" in idx
                assert "idx_stem_crate_items_source_region" in idx
                assert latest_version() == 12
        finally:
            service.close()

    def test_migration_11_upgrade_idempotent_and_rollback_safe(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.executescript(V02_SCHEMA.read_text())
        applied = run_migrations(conn)
        assert 11 in applied
        assert run_migrations(conn) == []

        original = migrations.MIGRATIONS
        conn2 = sqlite3.connect(":memory:")
        conn2.row_factory = sqlite3.Row
        conn2.executescript(V02_SCHEMA.read_text())
        migrations.MIGRATIONS = [m for m in original if m[0] <= 10]
        run_migrations(conn2)
        migrations.MIGRATIONS = [
            (
                11,
                "broken stem crate",
                ["CREATE TABLE stem_crate_items_broken (id TEXT PRIMARY KEY)", "NOT VALID SQL"],
            )
        ]
        try:
            with pytest.raises(sqlite3.OperationalError):
                run_migrations(conn2)
        finally:
            migrations.MIGRATIONS = original
        tables = {
            r[0]
            for r in conn2.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        }
        assert "stem_crate_items_broken" not in tables
        assert migrations.applied_versions(conn2) == set(range(11))


class TestStemCrateService:
    def test_create_list_get_update_delete(self, crate_service):
        service, track, stem_set_id = crate_service
        created = create_crate_item(
            service,
            track_id=track["id"],
            stem_set_id=stem_set_id,
            label="Lead vocal",
            gain_db=-3.0,
        )
        assert created["schema_version"] == 1
        assert created["track_id"] == track["id"]
        assert created["content_sha256"] == track.get("content_sha256") or service._track_content_hash(track["id"])
        assert created["stem_name"] == "vocals"
        assert created["method"] == "demucs"
        assert created["role"] == "voice"
        assert created["provenance"] == "source_track_inherited"
        assert created["media_status"] == "available"
        assert created["audio_url"].startswith("/api/stems/")
        assert "path" not in json.dumps(created)

        listing = service.list_stem_crate_items(limit=10, offset=0, query="Lead")
        assert listing["total"] == 1
        assert listing["items"][0]["id"] == created["id"]

        by_role = service.list_stem_crate_items(role="voice")
        assert by_role["total"] == 1
        assert service.list_stem_crate_items(role="beat")["total"] == 0

        updated = service.update_stem_crate_item(
            created["id"],
            label="Renamed",
            role="other",
            loop_bars=2,
            region_start_beat=4.0,
            region_end_beat=12.0,
            gain_db=0.0,
        )
        assert updated["label"] == "Renamed"
        assert updated["role"] == "other"
        assert updated["loop_bars"] == 2

        service.delete_stem_crate_item(created["id"])
        with pytest.raises(NotFoundError):
            service.get_stem_crate_item(created["id"])

    def test_duplicate_source_region_rejected(self, crate_service):
        service, track, stem_set_id = crate_service
        create_crate_item(service, track_id=track["id"], stem_set_id=stem_set_id)
        with pytest.raises(ConflictError):
            create_crate_item(service, track_id=track["id"], stem_set_id=stem_set_id)

    def test_stale_content_hash_surfaces_honestly(self, crate_service):
        service, track, stem_set_id = crate_service
        item = create_crate_item(service, track_id=track["id"], stem_set_id=stem_set_id)
        with service._connect() as conn:
            conn.execute(
                "UPDATE tracks SET content_sha256 = ? WHERE id = ?",
                ("deadbeef" * 8, track["id"]),
            )
        stale = service.get_stem_crate_item(item["id"])
        assert stale["media_status"] == "stale_hash"
        assert stale["audio_url"] is None

    def test_missing_media_surfaces_unavailable(self, crate_service, tmp_path):
        service, track, stem_set_id = crate_service
        item = create_crate_item(service, track_id=track["id"], stem_set_id=stem_set_id)
        stem_file = service.stem_dir / f"set-{service._track_content_hash(track['id'])[:12]}" / "vocals.wav"
        stem_file.unlink()
        unavailable = service.get_stem_crate_item(item["id"])
        assert unavailable["media_status"] == "unavailable"
        assert unavailable["audio_url"] is None

    def test_ffmpeg_center_sides_truthful(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            wav = synth_wav(tmp_path / "track.wav", seconds=16.0)
            track = service.ingest(wav.open("rb"), "track.wav")
            stem_set_id = make_ffmpeg_stems(service, track["id"], wav)
            item = create_crate_item(
                service,
                track_id=track["id"],
                stem_set_id=stem_set_id,
                stem_name="center",
                role="voice",
            )
            assert item["stem_name"] == "center"
            assert item["method"] == "ffmpeg"
            assert "vocals" not in item["stem_name"]
        finally:
            service.close()

    def test_persists_across_restart(self, crate_service, tmp_path):
        service, track, stem_set_id = crate_service
        item = create_crate_item(service, track_id=track["id"], stem_set_id=stem_set_id)
        service.close()

        reopened = StudioService(tmp_path / "data")
        try:
            got = reopened.get_stem_crate_item(item["id"])
            assert got["track_id"] == track["id"]
            assert got["media_status"] == "available"
        finally:
            reopened.close()

    def test_rejects_unknown_stem_set_and_mismatched_track(self, crate_service, tmp_path):
        service, track, stem_set_id = crate_service
        with pytest.raises(UserError, match="unknown stem set"):
            create_crate_item(service, track_id=track["id"], stem_set_id="missing")
        with pytest.raises(UserError, match="stem set does not belong"):
            wav2 = synth_wav(tmp_path / "other.wav", seconds=16.0)
            other = service.ingest(wav2.open("rb"), "other.wav")
            create_crate_item(
                service,
                track_id=other["id"],
                stem_set_id=stem_set_id,
            )

    def test_delete_does_not_remove_stems_or_track(self, crate_service):
        service, track, stem_set_id = crate_service
        item = create_crate_item(service, track_id=track["id"], stem_set_id=stem_set_id)
        service.delete_stem_crate_item(item["id"])
        assert service.get_track(track["id"])["id"] == track["id"]
        stems = service.list_stems(track["id"])
        assert "vocals" in stems["stems"]


@pytest.fixture
def anyio_backend():
    return "asyncio"


class TestStemCrateHTTP:
    @pytest.mark.anyio
    async def test_stem_crate_crud_flow(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        service = app.state.studio
        try:
            wav = synth_wav(tmp_path / "t.wav", seconds=16.0)
            track = service.ingest(wav.open("rb"), "t.wav")
            make_vocals_stem(service, track["id"], wav)
            stem_set_id = f"set-{service._track_content_hash(track['id'])[:12]}"

            async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
                created = (
                    await c.post(
                        "/api/stem-crate",
                        json={
                            "track_id": track["id"],
                            "stem_set_id": stem_set_id,
                            "stem_name": "vocals",
                            "role": "voice",
                            "loop_bars": 4,
                            "region_start_beat": 0,
                            "region_end_beat": 16,
                            "label": "HTTP crate",
                        },
                    )
                ).json()
                assert created["media_status"] == "available"
                item_id = created["id"]

                listing = (await c.get("/api/stem-crate", params={"q": "HTTP"})).json()
                assert listing["total"] == 1
                assert listing["items"][0]["method"] == "demucs"

                patched = (
                    await c.patch(
                        f"/api/stem-crate/{item_id}",
                        json={"label": "Updated", "loop_bars": 2},
                    )
                ).json()
                assert patched["label"] == "Updated"
                assert patched["loop_bars"] == 2

                resp = await c.delete(f"/api/stem-crate/{item_id}")
                assert resp.status_code == 204
                missing = await c.get("/api/stem-crate", params={"q": "Updated"})
                assert missing.json()["total"] == 0
        finally:
            app.state.studio.close()

    @pytest.mark.anyio
    async def test_hostile_json_shapes(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        service = app.state.studio
        try:
            wav = synth_wav(tmp_path / "t.wav", seconds=8.0)
            track = service.ingest(wav.open("rb"), "t.wav")
            make_vocals_stem(service, track["id"], wav)
            stem_set_id = f"set-{service._track_content_hash(track['id'])[:12]}"

            async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
                unknown = await c.post(
                    "/api/stem-crate",
                    json={
                        "track_id": track["id"],
                        "stem_set_id": stem_set_id,
                        "stem_name": "vocals",
                        "role": "voice",
                        "extra": "nope",
                    },
                )
                assert unknown.status_code == 422
                assert unknown.json()["error"]["code"] == "validation_error"

                bad_loop = await c.post(
                    "/api/stem-crate",
                    json={
                        "track_id": track["id"],
                        "stem_set_id": stem_set_id,
                        "stem_name": "vocals",
                        "role": "voice",
                        "loop_bars": 3,
                    },
                )
                assert bad_loop.status_code == 422

                bool_gain = await c.patch(
                    f"/api/stem-crate/{'x' * 32}",
                    json={"gain_db": True},
                )
                assert bool_gain.status_code in {400, 404, 422}
        finally:
            app.state.studio.close()

    @pytest.mark.anyio
    async def test_ffmpeg_center_not_relabeled(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        service = app.state.studio
        try:
            wav = synth_wav(tmp_path / "t.wav", seconds=8.0)
            track = service.ingest(wav.open("rb"), "t.wav")
            stem_set_id = make_ffmpeg_stems(service, track["id"], wav)

            async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
                created = (
                    await c.post(
                        "/api/stem-crate",
                        json={
                            "track_id": track["id"],
                            "stem_set_id": stem_set_id,
                            "stem_name": "center",
                            "role": "voice",
                        },
                    )
                ).json()
                assert created["stem_name"] == "center"
                assert created["method"] == "ffmpeg"
                assert "vocals" not in created["stem_name"]
        finally:
            app.state.studio.close()

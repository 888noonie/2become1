"""Stem display names (OPERATION THE STEM WORKSHOP, Act I).

A separated stem keeps its original track, role token, stem set and source
attribution. The owner's label is additive: it lives beside the role in
``names_json``, and no path, filename, media byte or provenance entry moves.
"""

from __future__ import annotations

import hashlib
import json
import math
import sqlite3
import struct
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

import pytest

from twobecomeone.common import UserError
from twobecomeone.studio import StudioService, clean_stem_display_name

ROLE_FREQ = {"vocals": 440.0, "drums": 220.0, "bass": 110.0, "other": 330.0}
ROLES = ("vocals", "drums", "bass", "other")


def _wav(
    path: Path,
    *,
    freq: float,
    duration: float = 1.0,
    rate: int = 44100,
    channels: int = 2,
) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = int(round(duration * rate))
    data = bytearray()
    for index in range(frames):
        value = int(0.2 * 32767 * math.sin(2 * math.pi * freq * index / rate))
        data += struct.pack("<h", value) * channels
    with wave.open(str(path), "wb") as out:
        out.setnchannels(channels)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(data)
    return path


def _quad(directory: Path) -> dict[str, Path]:
    return {
        role: _wav(directory / f"{role}.wav", freq=freq)
        for role, freq in ROLE_FREQ.items()
    }


def _ingest(service: StudioService, path: Path) -> dict:
    with path.open("rb") as handle:
        return service.ingest(handle, path.name, source_kind="local")


def _stage_all(service: StudioService, files: dict[str, Path]) -> list[dict]:
    entries = []
    for role in ROLES:
        with files[role].open("rb") as handle:
            key = service.stage_upload(handle, files[role].name)
        entries.append({
            "role": role,
            "staging_key": key,
            "original_name": files[role].name,
        })
    return entries


@pytest.fixture
def imported(tmp_path):
    """A real imported quad attached to a real Library track."""
    service = StudioService(tmp_path / "data")
    try:
        track = _ingest(service, _wav(tmp_path / "mix.wav", freq=200.0))
        track = service.update_track(track["id"], display_name="Paper Lanterns")
        result = service.import_stem_set(
            track["id"], _stage_all(service, _quad(tmp_path / "stems"))
        )
        yield service, track, result
    finally:
        service.close()


def _set_dir(service: StudioService, stem_set_id: str) -> Path:
    return service.stem_dir / stem_set_id


def _file_hashes(directory: Path) -> dict[str, str]:
    return {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(directory.iterdir())
    }


class TestNameIdentity:
    def test_a_label_attaches_to_the_set_and_role_and_leaves_the_media_alone(self, imported):
        service, track, result = imported
        set_id = result["stem_set_id"]
        directory = _set_dir(service, set_id)
        before_hashes = _file_hashes(directory)
        before_paths = json.loads(
            service._stem_set_row(set_id)["paths_json"]
        )
        before_audio = service.stem_audio_path(set_id, "vocals").read_bytes()

        info = service.set_stem_names(
            set_id, {"vocals": "Lead Vocal", "drums": "Kit"}
        )

        assert info["stem_set_id"] == set_id
        assert info["track_id"] == track["id"]
        assert info["track_name"] == "Paper Lanterns"
        assert info["source_kind"] == "local"
        assert isinstance(info["bpm"], float)
        assert info["bpm_source"] == "measured"
        assert info["method"] == "imported"
        assert info["model_name"].startswith("sha256:")
        assert [stem["name"] for stem in info["stems"]] == list(ROLES)
        by_role = {stem["name"]: stem for stem in info["stems"]}
        assert by_role["vocals"]["display_name"] == "Lead Vocal"
        assert by_role["vocals"]["custom_name"] is True
        assert by_role["drums"]["display_name"] == "Kit"
        assert by_role["bass"]["display_name"] == "bass"
        assert by_role["bass"]["custom_name"] is False

        # The role is still the audio key, and no media changed.
        assert by_role["vocals"]["audio_url"] == (
            f"/api/stems/{set_id}/audio?name=vocals"
        )
        assert _file_hashes(directory) == before_hashes
        assert json.loads(service._stem_set_row(set_id)["paths_json"]) == before_paths
        assert service.stem_audio_path(set_id, "vocals").read_bytes() == before_audio
        assert sorted(path.name for path in directory.iterdir()) == [
            "bass.wav", "drums.wav", "other.wav", "vocals.wav",
        ]

        # The listing carries the label beside the unchanged role.
        listing = service.list_stems(track["id"])
        variants = {v["name"]: v for v in listing["variants"]}
        assert variants["vocals"]["display_name"] == "Lead Vocal"
        assert variants["vocals"]["custom_name"] is True
        assert variants["drums"]["display_name"] == "Kit"
        assert variants["bass"]["display_name"] == "bass"
        assert variants["bass"]["custom_name"] is False
        assert variants["full"]["display_name"] == "full"
        assert variants["full"]["custom_name"] is False

        row = service._stem_set_row(set_id)
        assert json.loads(row["names_json"]) == {
            "vocals": "Lead Vocal", "drums": "Kit",
        }

    def test_the_info_card_keeps_measured_and_entered_tempo_distinct(self, imported):
        service, track, result = imported
        set_id = result["stem_set_id"]
        assert service.stem_set_info(set_id)["bpm_source"] == "measured"

        service.update_track(track["id"], bpm=128.0)
        entered = service.stem_set_info(set_id)
        assert entered["bpm"] == 128.0
        assert entered["bpm_source"] == "entered"

        service.update_track(track["id"], bpm=None)
        assert service.stem_set_info(set_id)["bpm_source"] == "measured"

    def test_a_later_name_does_not_replace_an_earlier_one(self, imported):
        service, _track, result = imported
        set_id = result["stem_set_id"]
        service.set_stem_names(set_id, {"vocals": "Lead Vocal", "bass": "Low End"})
        info = service.set_stem_names(set_id, {"drums": "Kit"})
        assert {s["name"]: s["display_name"] for s in info["stems"]} == {
            "vocals": "Lead Vocal",
            "drums": "Kit",
            "bass": "Low End",
            "other": "other",
        }

    def test_concurrent_writers_preserve_independent_roles(self, imported):
        service, _track, result = imported
        set_id = result["stem_set_id"]
        start = Barrier(2)

        def rename(role, label):
            start.wait(timeout=5)
            service.set_stem_names(set_id, {role: label})

        with ThreadPoolExecutor(max_workers=2) as workers:
            vocals = workers.submit(rename, "vocals", "Lead")
            drums = workers.submit(rename, "drums", "Kit")
            vocals.result(timeout=10)
            drums.result(timeout=10)
        assert json.loads(service._stem_set_row(set_id)["names_json"]) == {
            "vocals": "Lead", "drums": "Kit",
        }

    def test_repair_retains_name_but_changed_import_has_its_own_identity(self, imported, tmp_path):
        service, track, result = imported
        set_id = result["stem_set_id"]
        service.set_stem_names(set_id, {"vocals": "Lead"})
        original = service._stem_set_row(set_id)
        files = {role: tmp_path / "stems" / f"{role}.wav" for role in ROLES}
        _set_dir(service, set_id).joinpath("vocals.wav").unlink()
        repaired = service.import_stem_set(track["id"], _stage_all(service, files))
        assert repaired["repaired"] is True
        assert repaired["stem_set_id"] == set_id
        assert dict(service._stem_set_row(set_id)) == dict(original)
        assert service.stem_audio_path(set_id, "vocals").read_bytes() == files["vocals"].read_bytes()

        files["vocals"] = _wav(tmp_path / "replacement.wav", freq=550.0)
        replacement = service.import_stem_set(track["id"], _stage_all(service, files))
        assert replacement["stem_set_id"] != set_id
        assert service.stem_set_info(replacement["stem_set_id"])["stems"][0]["custom_name"] is False
        assert service.stem_set_info(set_id)["stems"][0]["display_name"] == "Lead"

    def test_clearing_a_name_returns_the_role_token(self, imported):
        service, _track, result = imported
        set_id = result["stem_set_id"]
        service.set_stem_names(set_id, {"vocals": "Lead Vocal"})
        info = service.set_stem_names(set_id, {"vocals": None})
        by_role = {stem["name"]: stem for stem in info["stems"]}
        assert by_role["vocals"]["display_name"] == "vocals"
        assert by_role["vocals"]["custom_name"] is False
        assert by_role["vocals"]["name"] == "vocals"
        assert json.loads(service._stem_set_row(set_id)["names_json"] or "{}") == {}

    def test_names_survive_reopening_the_same_data_directory(self, tmp_path):
        data = tmp_path / "data"
        service = StudioService(data)
        try:
            track = _ingest(service, _wav(tmp_path / "mix.wav", freq=200.0))
            result = service.import_stem_set(
                track["id"], _stage_all(service, _quad(tmp_path / "stems"))
            )
            set_id = result["stem_set_id"]
            service.set_stem_names(set_id, {"other": "Texture"})
        finally:
            service.close()

        reopened = StudioService(data)
        try:
            info = reopened.stem_set_info(set_id)
            by_role = {stem["name"]: stem for stem in info["stems"]}
            assert by_role["other"]["display_name"] == "Texture"
            assert by_role["vocals"]["display_name"] == "vocals"
            assert set(reopened.list_stems(track["id"])["stems"]) == {"full", *ROLES}
        finally:
            reopened.close()


class TestNameValidation:
    def test_an_absent_role_is_rejected_without_a_partial_write(self, imported):
        service, _track, result = imported
        set_id = result["stem_set_id"]
        with pytest.raises(UserError, match="cowbell"):
            service.set_stem_names(
                set_id, {"vocals": "Lead Vocal", "cowbell": "More cowbell"}
            )
        assert service._stem_set_row(set_id)["names_json"] is None
        assert {
            stem["name"]: stem["display_name"]
            for stem in service.stem_set_info(set_id)["stems"]
        } == {role: role for role in ROLES}

    def test_a_role_the_set_does_not_contain_is_rejected(self, imported):
        service, _track, result = imported
        set_id = result["stem_set_id"]
        with pytest.raises(UserError, match="not found"):
            service.set_stem_names(set_id, {"center": "Middle"})
        assert service._stem_set_row(set_id)["names_json"] is None

    def test_blank_overlong_and_non_string_names_are_rejected(self, imported):
        service, _track, result = imported
        set_id = result["stem_set_id"]
        for value, match in (
            ("   \n\t", "empty"),
            ("é" * 201, "200"),
            (12, "empty"),
        ):
            with pytest.raises(UserError, match=match):
                service.set_stem_names(set_id, {"vocals": value})
        assert service._stem_set_row(set_id)["names_json"] is None

    def test_an_empty_patch_is_rejected(self, imported):
        service, _track, result = imported
        with pytest.raises(UserError, match="at least one"):
            service.set_stem_names(result["stem_set_id"], {})

    def test_an_unknown_set_matches_the_existing_stem_route_refusal(self, imported):
        service, _track, _result = imported
        with pytest.raises(UserError, match="unknown stem set"):
            service.set_stem_names("missing-set", {"vocals": "Lead Vocal"})
        with pytest.raises(UserError, match="unknown stem set"):
            service.stem_set_info("missing-set")

    def test_the_name_cleaner_rejects_rather_than_slices(self):
        assert clean_stem_display_name("  Café — 夜  ") == "Café — 夜"
        with pytest.raises(UserError):
            clean_stem_display_name("x" * 201)


class TestMigration:
    def test_an_existing_database_upgrades_without_touching_its_sets(
        self, tmp_path, monkeypatch
    ):
        from twobecomeone import migrations

        original = migrations.MIGRATIONS
        monkeypatch.setattr(
            migrations, "MIGRATIONS", [m for m in original if m[0] <= 13]
        )
        data = tmp_path / "data"
        service = StudioService(data)
        try:
            track = _ingest(service, _wav(tmp_path / "mix.wav", freq=200.0))
            result = service.import_stem_set(
                track["id"], _stage_all(service, _quad(tmp_path / "stems"))
            )
            set_id = result["stem_set_id"]
            before = service._stem_set_row(set_id)
            assert "names_json" not in before.keys()
            before_paths = before["paths_json"]
            before_created = before["created_at"]
        finally:
            service.close()

        monkeypatch.setattr(migrations, "MIGRATIONS", original)
        upgraded = StudioService(data)
        try:
            row = upgraded._stem_set_row(set_id)
            assert "names_json" in row.keys()
            assert row["names_json"] is None
            assert row["paths_json"] == before_paths
            assert row["created_at"] == before_created
            assert {
                stem["name"]: stem["display_name"]
                for stem in upgraded.stem_set_info(set_id)["stems"]
            } == {role: role for role in ROLES}
            upgraded.set_stem_names(set_id, {"vocals": "Lead Vocal"})
            assert upgraded.stem_set_info(set_id)["stems"][0]["display_name"] == (
                "Lead Vocal"
            )
        finally:
            upgraded.close()


class TestCorruptOrOldRows:
    def test_a_missing_or_corrupt_names_blob_falls_back_to_the_role(self, imported):
        service, _track, result = imported
        set_id = result["stem_set_id"]
        service.set_stem_names(set_id, {"vocals": "Lead Vocal"})
        with sqlite3.connect(service.data_dir / "studio.sqlite3") as conn:
            conn.execute(
                "UPDATE stem_sets SET names_json = ? WHERE id = ?",
                ("{not json", set_id),
            )
        info = service.stem_set_info(set_id)
        by_role = {stem["name"]: stem for stem in info["stems"]}
        assert by_role["vocals"]["display_name"] == "vocals"
        assert by_role["vocals"]["custom_name"] is False
        # A new valid write repairs the labels that remain readable.
        repaired = service.set_stem_names(set_id, {"bass": "Low End"})
        by_role = {stem["name"]: stem for stem in repaired["stems"]}
        assert by_role["bass"]["display_name"] == "Low End"
        assert by_role["vocals"]["display_name"] == "vocals"

    def test_a_names_blob_for_a_role_without_media_is_not_advertised(self, imported):
        service, _track, result = imported
        set_id = result["stem_set_id"]
        service.set_stem_names(set_id, {"vocals": "Lead Vocal"})
        _set_dir(service, set_id).joinpath("vocals.wav").unlink()
        info = service.stem_set_info(set_id)
        assert [stem["name"] for stem in info["stems"]] == [
            "drums", "bass", "other",
        ]


    @pytest.mark.parametrize("bad_paths", ["{not json", "[]"])
    def test_corrupt_paths_are_unavailable_and_do_not_allow_renames(self, imported, bad_paths):
        service, track, result = imported
        set_id = result["stem_set_id"]
        service.set_stem_names(set_id, {"vocals": "Lead"})
        with service._connect() as conn:
            conn.execute("UPDATE stem_sets SET paths_json = ? WHERE id = ?", (bad_paths, set_id))
        assert service.stem_set_info(set_id)["stems"] == []
        assert service.list_stems(track["id"])["stems"] == ["full"]
        with pytest.raises(UserError, match="not found"):
            service.stem_audio_path(set_id, "vocals")
        with pytest.raises(UserError, match="not found"):
            service.set_stem_names(set_id, {"vocals": "Replacement"})
        assert json.loads(service._stem_set_row(set_id)["names_json"]) == {"vocals": "Lead"}

    def test_rename_rejects_missing_media_without_applying_other_changes(self, imported):
        service, _track, result = imported
        set_id = result["stem_set_id"]
        service.set_stem_names(set_id, {"vocals": "Lead"})
        _set_dir(service, set_id).joinpath("vocals.wav").unlink()
        with pytest.raises(UserError, match="unavailable"):
            service.set_stem_names(set_id, {"drums": "Kit", "vocals": "Replacement"})
        assert json.loads(service._stem_set_row(set_id)["names_json"]) == {"vocals": "Lead"}
        service.set_stem_names(set_id, {"vocals": None})
        assert service._stem_set_row(set_id)["names_json"] is None


class TestHttpNames:
    @pytest.mark.anyio
    async def test_patch_and_read_one_stem_set(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        data = tmp_path / "data"
        service = StudioService(data)
        try:
            track = _ingest(service, _wav(tmp_path / "mix.wav", freq=200.0))
            track = service.update_track(track["id"], display_name="Paper Lanterns")
            result = service.import_stem_set(
                track["id"], _stage_all(service, _quad(tmp_path / "stems"))
            )
            set_id = result["stem_set_id"]
        finally:
            service.close()

        app = create_app(data)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
            patched = await client.patch(
                f"/api/stem-sets/{set_id}/names",
                json={"names": {"vocals": "Lead Vocal", "drums": None}},
            )
            assert patched.status_code == 200, patched.text
            body = patched.json()
            assert body["track_id"] == track["id"]
            assert body["track_name"] == "Paper Lanterns"
            assert body["source_kind"] == "local"
            by_role = {stem["name"]: stem for stem in body["stems"]}
            assert by_role["vocals"]["display_name"] == "Lead Vocal"
            assert by_role["drums"]["display_name"] == "drums"

            fetched = await client.get(f"/api/stem-sets/{set_id}")
            assert fetched.status_code == 200, fetched.text
            assert fetched.json()["stems"] == body["stems"]

            listing = await client.get(f"/api/tracks/{track['id']}/stems")
            assert listing.status_code == 200, listing.text
            variants = {v["name"]: v for v in listing.json()["variants"]}
            assert variants["vocals"]["display_name"] == "Lead Vocal"
            assert variants["vocals"]["name"] == "vocals"
            assert variants["vocals"]["audio_url"].endswith("?name=vocals")
            audio = await client.get(variants["vocals"]["audio_url"])
            assert audio.status_code == 200
            assert audio.headers["content-type"].startswith("audio/")

    @pytest.mark.anyio
    async def test_http_refusals_are_typed_and_leave_the_set_unnamed(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        data = tmp_path / "data"
        service = StudioService(data)
        try:
            track = _ingest(service, _wav(tmp_path / "mix.wav", freq=200.0))
            result = service.import_stem_set(
                track["id"], _stage_all(service, _quad(tmp_path / "stems"))
            )
            set_id = result["stem_set_id"]
        finally:
            service.close()

        app = create_app(data)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
            unknown_set = await client.patch(
                "/api/stem-sets/missing-set/names", json={"names": {"vocals": "Lead"}}
            )
            assert unknown_set.status_code == 400
            assert unknown_set.json()["error"]["code"] == "bad_request"

            unknown_role = await client.patch(
                f"/api/stem-sets/{set_id}/names", json={"names": {"cowbell": "More"}}
            )
            assert unknown_role.status_code == 400
            assert "cowbell" in unknown_role.json()["error"]["message"]

            blank = await client.patch(
                f"/api/stem-sets/{set_id}/names", json={"names": {"vocals": "  "}}
            )
            assert blank.status_code == 400

            extra = await client.patch(
                f"/api/stem-sets/{set_id}/names",
                json={"names": {"vocals": "Lead"}, "paths": {"vocals": "/tmp/x.wav"}},
            )
            assert extra.status_code == 422

            read_back = await client.get(f"/api/stem-sets/{set_id}")
            assert {
                stem["name"]: stem["display_name"]
                for stem in read_back.json()["stems"]
            } == {role: role for role in ROLES}

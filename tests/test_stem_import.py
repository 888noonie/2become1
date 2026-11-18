"""Owner-supplied stem import (OPERATION STEM PASSPORT).

Covers the service contract and the HTTP routes: four explicit roles, WAV only,
decode validation, one sample rate and channel count, a measured duration
tolerance, atomic publication, honest `imported` provenance, no separation job,
no orphaned staging files, and compatibility with the existing stem listing.
"""

from __future__ import annotations

import io
import math
import struct
import wave
from pathlib import Path

import pytest


def stem_wav(
    path: Path,
    *,
    freq: float,
    duration: float = 6.0,
    rate: int = 44100,
    channels: int = 2,
    amplitude: float = 0.2,
) -> Path:
    """One aligned component: a plain tone is enough to prove import plumbing."""
    frames = int(round(duration * rate))
    data = bytearray()
    for index in range(frames):
        value = int(amplitude * 32767 * math.sin(2 * math.pi * freq * index / rate))
        packed = struct.pack("<h", value)
        data += packed * channels
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(channels)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(data)
    return path


ROLE_FREQ = {"vocals": 440.0, "drums": 220.0, "bass": 110.0, "other": 330.0}


def make_stems(directory: Path, **overrides) -> dict[str, Path]:
    files = {}
    for role, freq in ROLE_FREQ.items():
        options = overrides.get(role, {})
        files[role] = stem_wav(directory / f"{role}.wav", freq=options.pop("freq", freq), **options)
    return files


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _service(tmp_path: Path):
    from twobecomeone.studio import StudioService

    data = tmp_path / "data"
    return StudioService(data)


def _ingest(service, path: Path):
    with path.open("rb") as handle:
        return service.ingest(handle, path.name, source_kind="local")


def _stage_all(service, files: dict[str, Path], names: dict[str, str] | None = None) -> list[dict]:
    entries = []
    for role in ("vocals", "drums", "bass", "other"):
        with files[role].open("rb") as handle:
            key = service.stage_upload(handle, (names or {}).get(role, files[role].name))
        entries.append({
            "role": role,
            "staging_key": key,
            "original_name": (names or {}).get(role, files[role].name),
        })
    return entries


class TestServiceImport:
    def test_four_aligned_stems_attach_with_imported_provenance(self, tmp_path):
        service = _service(tmp_path)
        try:
            track = _ingest(service, stem_wav(tmp_path / "mix.wav", freq=200.0))
            files = make_stems(tmp_path / "stems")
            result = service.import_stem_set(track["id"], _stage_all(service, files))

            assert result["method"] == "imported"
            assert result["roles"] == ["vocals", "drums", "bass", "other"]
            assert result["cached"] is False
            assert len(result["set_hash"]) == 64

            listing = service.list_stems(track["id"])
            imported = [v for v in listing["variants"] if v.get("method") == "imported"]
            assert {v["name"] for v in imported} == {"vocals", "drums", "bass", "other"}
            for variant in imported:
                assert variant["model_name"].startswith("sha256:")
                assert variant["device"] == "user"
                assert variant["set_hash"] == result["set_hash"]
                assert variant["original_name"].endswith(".wav")
                assert len(variant["source_sha256"]) == 64
                assert variant["provenance"][variant["name"]]["sha256"] == variant["source_sha256"]
                assert variant["audio_url"].startswith("/api/stems/")

            # Media is published under the existing stems/<set>/<role>.wav layout.
            set_dir = service.stem_dir / result["stem_set_id"]
            assert sorted(p.name for p in set_dir.iterdir()) == [
                "bass.wav", "drums.wav", "other.wav", "vocals.wav",
            ]
            # Staged inputs are consumed.
            assert not list(service.incoming_dir.iterdir())

            # No separation job was created by the import.
            jobs = service.list_jobs()
            assert (jobs.get("items", []) if isinstance(jobs, dict) else jobs) == []
        finally:
            service.close()

    def test_existing_demucs_set_is_untouched(self, tmp_path):
        import sqlite3

        service = _service(tmp_path)
        try:
            track = _ingest(service, stem_wav(tmp_path / "mix.wav", freq=200.0))
            stem_set = service.stem_dir / "demucs-set"
            stem_set.mkdir(parents=True)
            for role in ("vocals", "drums", "bass", "other"):
                stem_wav(stem_set / f"{role}.wav", freq=ROLE_FREQ[role])
            with sqlite3.connect(service.data_dir / "studio.sqlite3") as conn:
                conn.execute(
                    "INSERT INTO stem_sets (id, track_id, method, model, device, status,"
                    " paths_json, track_sha256, model_name, created_at)"
                    " VALUES ('demucs-set', ?, 'demucs', 'htdemucs@4.1.0', 'cuda', 'complete', ?, ?, 'htdemucs@4.1.0', 1.0)",
                    (
                        track["id"],
                        __import__("json").dumps({
                            role: f"stems/demucs-set/{role}.wav"
                            for role in ("vocals", "drums", "bass", "other")
                        }),
                        service._track_content_hash(track["id"]),
                    ),
                )
            before = {p: p.stat().st_size for p in stem_set.iterdir()}

            result = service.import_stem_set(
                track["id"], _stage_all(service, make_stems(tmp_path / "mine"))
            )
            assert result["method"] == "imported"
            assert {p: p.stat().st_size for p in stem_set.iterdir()} == before
            # The desk shows one set per lane and prefers the owner's set; the
            # separation output is still present and untouched.
            methods = {v["method"] for v in service.list_stems(track["id"])["variants"] if v.get("method")}
            assert methods == {"imported"}
            assert stem_set.exists() and len(list(stem_set.iterdir())) == 4
        finally:
            service.close()

    def test_same_four_files_are_a_cache_hit(self, tmp_path):
        service = _service(tmp_path)
        try:
            track = _ingest(service, stem_wav(tmp_path / "mix.wav", freq=200.0))
            files = make_stems(tmp_path / "stems")
            first = service.import_stem_set(track["id"], _stage_all(service, files))
            second = service.import_stem_set(track["id"], _stage_all(service, files))
            assert second["cached"] is True
            assert second["stem_set_id"] == first["stem_set_id"]
            assert len([p for p in service.stem_dir.iterdir() if p.is_dir()]) == 1
        finally:
            service.close()

    @pytest.mark.parametrize("roles", [
        ["vocals", "drums", "bass"],                       # missing other
        ["vocals", "drums", "bass", "other", "other"],     # five entries
        ["vocals", "vocals", "bass", "other"],             # duplicate role
        ["center", "drums", "bass", "other"],              # not a stem role
    ])
    def test_role_sets_are_refused(self, tmp_path, roles):
        from twobecomeone.studio import UserError

        service = _service(tmp_path)
        try:
            track = _ingest(service, stem_wav(tmp_path / "mix.wav", freq=200.0))
            files = make_stems(tmp_path / "stems")
            entries = []
            for index, role in enumerate(roles):
                source = files[role] if role in files else files["other"]
                with source.open("rb") as handle:
                    key = service.stage_upload(handle, source.name)
                entries.append({"role": role, "staging_key": key, "original_name": source.name})
            with pytest.raises(UserError):
                service.import_stem_set(track["id"], entries)
            assert service.list_stems(track["id"])["variants"] == [service.list_stems(track["id"])["variants"][0]]
            assert not [p for p in service.stem_dir.iterdir() if p.is_dir()]
        finally:
            service.close()

    def test_duration_mismatch_fails_with_measured_numbers(self, tmp_path):
        from twobecomeone.studio import UserError

        service = _service(tmp_path)
        try:
            track = _ingest(service, stem_wav(tmp_path / "mix.wav", freq=200.0))
            files = make_stems(tmp_path / "stems", other={"duration": 6.25})
            with pytest.raises(UserError) as excinfo:
                service.import_stem_set(track["id"], _stage_all(service, files))
            message = str(excinfo.value)
            assert "timeline" in message
            assert "0.250s" in message or "0.25" in message
            assert not [p for p in service.stem_dir.iterdir() if p.is_dir()]
        finally:
            service.close()

    def test_sample_rate_and_channel_mismatches_are_refused(self, tmp_path):
        from twobecomeone.studio import UserError

        service = _service(tmp_path)
        try:
            track = _ingest(service, stem_wav(tmp_path / "mix.wav", freq=200.0))
            with pytest.raises(UserError) as rate:
                service.import_stem_set(
                    track["id"],
                    _stage_all(service, make_stems(tmp_path / "r", bass={"rate": 48000})),
                )
            assert "different sample rates" in str(rate.value)

            with pytest.raises(UserError) as channels:
                service.import_stem_set(
                    track["id"],
                    _stage_all(service, make_stems(tmp_path / "c", drums={"channels": 1})),
                )
            assert "different channel counts" in str(channels.value)
        finally:
            service.close()

    def test_non_wav_and_undecodable_files_are_refused(self, tmp_path):
        from twobecomeone.studio import UserError

        service = _service(tmp_path)
        try:
            track = _ingest(service, stem_wav(tmp_path / "mix.wav", freq=200.0))
            files = make_stems(tmp_path / "stems")
            with files["vocals"].open("rb") as handle:
                mp3_key = service.stage_upload(handle, "vocals.mp3")
            entries = _stage_all(service, files)
            entries[0] = {"role": "vocals", "staging_key": mp3_key, "original_name": "vocals.mp3"}
            with pytest.raises(UserError) as wrong_type:
                service.import_stem_set(track["id"], entries)
            assert "WAV" in str(wrong_type.value)

            broken = tmp_path / "broken.wav"
            broken.write_bytes(b"not audio at all")
            with broken.open("rb") as handle:
                broken_key = service.stage_upload(handle, "broken.wav")
            entries = _stage_all(service, make_stems(tmp_path / "again"))
            entries[1] = {"role": "drums", "staging_key": broken_key, "original_name": "broken.wav"}
            with pytest.raises(UserError):
                service.import_stem_set(track["id"], entries)
        finally:
            service.close()

    def test_staging_keys_cannot_escape_incoming(self, tmp_path):
        from twobecomeone.studio import UserError

        service = _service(tmp_path)
        try:
            track = _ingest(service, stem_wav(tmp_path / "mix.wav", freq=200.0))
            entries = _stage_all(service, make_stems(tmp_path / "stems"))
            entries[0]["staging_key"] = "../../etc/passwd"
            with pytest.raises(UserError):
                service.import_stem_set(track["id"], entries)
        finally:
            service.close()

    def test_failed_import_leaves_nothing_ready_and_retry_works(self, tmp_path):
        from twobecomeone.studio import UserError

        service = _service(tmp_path)
        try:
            track = _ingest(service, stem_wav(tmp_path / "mix.wav", freq=200.0))
            bad = make_stems(tmp_path / "bad", vocals={"duration": 5.5})
            with pytest.raises(UserError):
                service.import_stem_set(track["id"], _stage_all(service, bad))
            assert [v["name"] for v in service.list_stems(track["id"])["variants"]] == ["full"]
            assert not [p for p in service.stem_dir.iterdir() if p.is_dir()]

            good = service.import_stem_set(track["id"], _stage_all(service, make_stems(tmp_path / "good")))
            assert good["method"] == "imported"
            assert len([v for v in service.list_stems(track["id"])["variants"] if v["name"] != "full"]) == 4
        finally:
            service.close()


class TestHttpImport:
    @pytest.mark.anyio
    async def test_stage_then_commit_and_list(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
            mix = stem_wav(tmp_path / "mix.wav", freq=200.0)
            with mix.open("rb") as handle:
                track = (await client.post(
                    "/api/tracks", files={"file": ("mix.wav", handle, "audio/wav")}
                )).json()

            files = make_stems(tmp_path / "stems")
            entries = []
            for role in ("vocals", "drums", "bass", "other"):
                with files[role].open("rb") as handle:
                    staged = await client.post(
                        "/api/stems/stage",
                        files={"file": (files[role].name, handle, "audio/wav")},
                    )
                assert staged.status_code == 201, staged.text
                entries.append({
                    "role": role,
                    "staging_key": staged.json()["staging_key"],
                    "original_name": files[role].name,
                })

            committed = await client.post(
                f"/api/tracks/{track['id']}/stem-import", json={"files": entries}
            )
            assert committed.status_code == 201, committed.text
            body = committed.json()
            assert body["method"] == "imported"

            listing = (await client.get(f"/api/tracks/{track['id']}/stems")).json()
            imported = [v for v in listing["variants"] if v.get("method") == "imported"]
            assert {v["name"] for v in imported} == {"vocals", "drums", "bass", "other"}
            audio = await client.get(imported[0]["audio_url"])
            assert audio.status_code == 200
            assert audio.headers["content-type"].startswith("audio/")

            jobs = (await client.get("/api/jobs")).json()
            assert jobs.get("items", []) == []

    @pytest.mark.anyio
    async def test_http_refusal_removes_staged_inputs(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
            mix = stem_wav(tmp_path / "mix.wav", freq=200.0)
            with mix.open("rb") as handle:
                track = (await client.post(
                    "/api/tracks", files={"file": ("mix.wav", handle, "audio/wav")}
                )).json()
            files = make_stems(tmp_path / "stems", other={"duration": 7.0})
            entries = []
            for role in ("vocals", "drums", "bass", "other"):
                with files[role].open("rb") as handle:
                    staged = await client.post(
                        "/api/stems/stage",
                        files={"file": (files[role].name, handle, "audio/wav")},
                    )
                entries.append({
                    "role": role,
                    "staging_key": staged.json()["staging_key"],
                    "original_name": files[role].name,
                })

            refused = await client.post(
                f"/api/tracks/{track['id']}/stem-import", json={"files": entries}
            )
            assert refused.status_code == 400
            listing = (await client.get(f"/api/tracks/{track['id']}/stems")).json()
            assert [v["name"] for v in listing["variants"]] == ["full"]
            incoming = tmp_path / "data" / "incoming"
            assert not list(incoming.iterdir()) if incoming.exists() else True

class TestHardening:
    def test_the_same_staged_file_cannot_fill_two_roles(self, tmp_path):
        from twobecomeone.studio import UserError

        service = _service(tmp_path)
        try:
            track = _ingest(service, stem_wav(tmp_path / "mix.wav", freq=200.0))
            files = make_stems(tmp_path / "stems")
            entries = _stage_all(service, files)
            entries[1]["staging_key"] = entries[0]["staging_key"]
            with pytest.raises(UserError) as excinfo:
                service.import_stem_set(track["id"], entries)
            assert "more than one role" in str(excinfo.value)
            assert not [p for p in service.stem_dir.iterdir() if p.is_dir()]
        finally:
            service.close()

    def test_a_non_wav_container_is_refused_even_with_a_wav_name(self, tmp_path):
        from twobecomeone.studio import UserError

        service = _service(tmp_path)
        try:
            track = _ingest(service, stem_wav(tmp_path / "mix.wav", freq=200.0))
            files = make_stems(tmp_path / "stems")
            # Real FLAC bytes renamed to .wav: decodable audio, wrong container.
            import subprocess
            flac_real = tmp_path / "vocals.flac"
            subprocess.run([
                "ffmpeg", "-v", "error", "-y", "-i", str(files["vocals"]),
                "-c:a", "flac", str(flac_real),
            ], check=True)
            flac_named_wav = tmp_path / "vocals-wrong.wav"
            flac_real.replace(flac_named_wav)
            with flac_named_wav.open("rb") as handle:
                key = service.stage_upload(handle, "vocals.wav")
            entries = _stage_all(service, make_stems(tmp_path / "again"))
            entries[0] = {"role": "vocals", "staging_key": key, "original_name": "vocals.wav"}
            with pytest.raises(UserError) as excinfo:
                service.import_stem_set(track["id"], entries)
            assert "WAV container" in str(excinfo.value)
        finally:
            service.close()

    def test_a_partial_newer_set_never_mixes_with_a_complete_one(self, tmp_path):
        import json
        import sqlite3
        import time

        service = _service(tmp_path)
        try:
            track = _ingest(service, stem_wav(tmp_path / "mix.wav", freq=200.0))
            track_sha = service._track_content_hash(track["id"])

            def publish(set_id, roles, method, created):
                folder = service.stem_dir / set_id
                folder.mkdir(parents=True)
                paths = {}
                for role in roles:
                    stem_wav(folder / f"{role}.wav", freq=ROLE_FREQ[role])
                    paths[role] = f"stems/{set_id}/{role}.wav"
                with sqlite3.connect(service.data_dir / "studio.sqlite3") as conn:
                    conn.execute(
                        "INSERT INTO stem_sets (id, track_id, method, model, device, status,"
                        " paths_json, track_sha256, model_name, created_at)"
                        " VALUES (?, ?, ?, 'x', 'cpu', 'complete', ?, ?, ?, ?)",
                        (set_id, track["id"], method, json.dumps(paths), track_sha, "x", created),
                    )

            # Older, complete Demucs set.
            publish("demucs-old", ("vocals", "drums", "bass", "other"), "demucs", time.time() - 100)
            # Newer imported set missing one file.
            broken = service.stem_dir / "imported-partial"
            broken.mkdir()
            paths = {}
            for role in ("vocals", "drums", "bass"):
                stem_wav(broken / f"{role}.wav", freq=ROLE_FREQ[role])
                paths[role] = f"stems/imported-partial/{role}.wav"
            with sqlite3.connect(service.data_dir / "studio.sqlite3") as conn:
                conn.execute(
                    "INSERT INTO stem_sets (id, track_id, method, model, device, status,"
                    " paths_json, track_sha256, model_name, created_at)"
                    " VALUES ('imported-partial', ?, 'imported', 'x', 'user', 'complete', ?, ?, 'sha256:x', ?)",
                    (track["id"], json.dumps(paths), track_sha, time.time()),
                )

            listing = service.list_stems(track["id"])
            lane_sets = {v["stem_set_id"] for v in listing["variants"] if v["name"] != "full"}
            assert lane_sets == {"demucs-old"}, "a group must come from one set only"
            assert len([v for v in listing["variants"] if v["name"] != "full"]) == 4
        finally:
            service.close()

    def test_a_database_failure_removes_the_published_directory(self, tmp_path, monkeypatch):
        import sqlite3 as sqlite_module
        from twobecomeone.studio import UserError  # noqa: F401  (documents the contract)

        service = _service(tmp_path)
        try:
            track = _ingest(service, stem_wav(tmp_path / "mix.wav", freq=200.0))
            entries = _stage_all(service, make_stems(tmp_path / "stems"))
            real_connect = service._connect
            state = {"publishedDir": None, "inserted": False}

            class InsertFails:
                def __init__(self, conn):
                    self._conn = conn

                def __enter__(self):
                    return self

                def __exit__(self, *exc):
                    return self._conn.__exit__(*exc)

                def execute(self, sql, *args, **kwargs):
                    if "INSERT INTO stem_sets" in sql:
                        # Record what is on disk at the moment the row would land.
                        state["publishedDir"] = [
                            p.name for p in service.stem_dir.iterdir() if p.is_dir()
                        ]
                        state["inserted"] = True
                        raise sqlite_module.OperationalError("disk I/O error")
                    return self._conn.execute(sql, *args, **kwargs)

            monkeypatch.setattr(service, "_connect", lambda: InsertFails(real_connect()))
            with pytest.raises(sqlite_module.OperationalError):
                service.import_stem_set(track["id"], entries)
            monkeypatch.setattr(service, "_connect", real_connect)

            assert state["inserted"] is True, "the failure happens after publication"
            assert state["publishedDir"], "a set directory existed when the INSERT failed"
            assert not [p for p in service.stem_dir.iterdir() if p.is_dir()], "it was removed"
            assert [v["name"] for v in service.list_stems(track["id"])["variants"]] == ["full"]
        finally:
            service.close()

    def test_discard_removes_only_managed_staging_keys(self, tmp_path):
        service = _service(tmp_path)
        try:
            track = _ingest(service, stem_wav(tmp_path / "mix.wav", freq=200.0))
            files = make_stems(tmp_path / "stems")
            entries = _stage_all(service, files)
            keys = [entry["staging_key"] for entry in entries[:2]]
            assert service.discard_staged_stems(keys) == 2
            assert service.discard_staged_stems(["../../etc/passwd"]) == 0
            assert sorted(p.name for p in service.incoming_dir.iterdir()) == sorted(
                [entries[2]["staging_key"], entries[3]["staging_key"]]
            )
        finally:
            service.close()

class TestNonQuadVariants:
    def test_center_and_sides_stay_visible_beside_a_complete_quad(self, tmp_path):
        import json
        import sqlite3
        import time

        service = _service(tmp_path)
        try:
            track = _ingest(service, stem_wav(tmp_path / "mix.wav", freq=200.0))
            track_sha = service._track_content_hash(track["id"])

            def publish(set_id, roles, method, created):
                folder = service.stem_dir / set_id
                folder.mkdir(parents=True)
                paths = {}
                for role in roles:
                    stem_wav(folder / f"{role}.wav", freq=ROLE_FREQ.get(role, 300.0))
                    paths[role] = f"stems/{set_id}/{role}.wav"
                with sqlite3.connect(service.data_dir / "studio.sqlite3") as conn:
                    conn.execute(
                        "INSERT INTO stem_sets (id, track_id, method, model, device, status,"
                        " paths_json, track_sha256, model_name, created_at)"
                        " VALUES (?, ?, ?, 'x', 'cpu', 'complete', ?, ?, ?, ?)",
                        (set_id, track["id"], method, json.dumps(paths), track_sha, "x", created),
                    )

            publish("quad", ("vocals", "drums", "bass", "other"), "demucs", time.time() - 100)
            publish("split", ("center", "sides"), "ffmpeg", time.time())

            names = {v["name"] for v in service.list_stems(track["id"])["variants"]}
            assert {"vocals", "drums", "bass", "other"} <= names
            assert {"center", "sides"} <= names, "center/sides must stay available"
            quad_sets = {
                v["stem_set_id"] for v in service.list_stems(track["id"])["variants"]
                if v["name"] in {"vocals", "drums", "bass", "other"}
            }
            assert quad_sets == {"quad"}, "the quad still comes from one set"
        finally:
            service.close()


class TestHttpStagingGuards:
    @pytest.mark.anyio
    async def test_staging_refuses_a_non_wav_suffix(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
            wav = stem_wav(tmp_path / "vocals.wav", freq=440.0)
            with wav.open("rb") as handle:
                refused = await client.post(
                    "/api/stems/stage", files={"file": ("vocals.flac", handle, "audio/flac")}
                )
            assert refused.status_code == 400
            assert "WAV" in refused.text

class TestSetIntegrity:
    def test_two_partial_sets_never_form_a_mixed_quad(self, tmp_path):
        import json
        import sqlite3
        import time

        service = _service(tmp_path)
        try:
            track = _ingest(service, stem_wav(tmp_path / "mix.wav", freq=200.0))
            track_sha = service._track_content_hash(track["id"])

            def publish(set_id, roles, method, created):
                folder = service.stem_dir / set_id
                folder.mkdir(parents=True)
                paths = {}
                for role in roles:
                    stem_wav(folder / f"{role}.wav", freq=ROLE_FREQ[role])
                    paths[role] = f"stems/{set_id}/{role}.wav"
                with sqlite3.connect(service.data_dir / "studio.sqlite3") as conn:
                    conn.execute(
                        "INSERT INTO stem_sets (id, track_id, method, model, device, status,"
                        " paths_json, track_sha256, model_name, created_at)"
                        " VALUES (?, ?, ?, 'x', 'cpu', 'complete', ?, ?, ?, ?)",
                        (set_id, track["id"], method, json.dumps(paths), track_sha, set_id, created),
                    )

            publish("imported-three", ("vocals", "drums", "bass"), "imported", time.time())
            publish("demucs-other", ("other",), "demucs", time.time() - 10)

            listing = service.list_stems(track["id"])
            quad = [v for v in listing["variants"] if v["name"] in {"vocals", "drums", "bass", "other"}]
            assert {v["stem_set_id"] for v in quad} == {"imported-three"}
            assert [v["name"] for v in quad] == ["bass", "drums", "vocals"], "no fourth lane is invented"
        finally:
            service.close()

    def test_reimport_repairs_a_row_whose_media_went_missing(self, tmp_path):
        service = _service(tmp_path)
        try:
            track = _ingest(service, stem_wav(tmp_path / "mix.wav", freq=200.0))
            files = make_stems(tmp_path / "stems")
            first = service.import_stem_set(track["id"], _stage_all(service, files))
            # Delete one published lane, as a disk problem would.
            (service.stem_dir / first["stem_set_id"] / "other.wav").unlink()

            second = service.import_stem_set(track["id"], _stage_all(service, files))
            assert second["cached"] is False, "a broken row is repaired, not reused"
            assert (service.stem_dir / second["stem_set_id"] / "other.wav").is_file()
            imported = [
                v for v in service.list_stems(track["id"])["variants"] if v.get("method") == "imported"
            ]
            assert len(imported) == 4
        finally:
            service.close()

    def test_a_lane_that_only_fits_at_the_file_rate_is_refused(self, tmp_path):
        import math as maths
        import struct
        import wave
        from twobecomeone.studio import UserError

        # 115 s stereo at 44.1 kHz: 40.6 MB decoded at 44.1 kHz (under the old
        # check) but 44.2 MB at the 48 kHz playback context (over the ceiling).
        def long_silence(path: Path, seconds: float = 115.0) -> Path:
            frames = int(round(seconds * 44100))
            path.parent.mkdir(parents=True, exist_ok=True)
            with wave.open(str(path), "wb") as out:
                out.setnchannels(2)
                out.setsampwidth(2)
                out.setframerate(44100)
                block = b"\x00\x00\x00\x00" * 4096
                remaining = frames
                while remaining > 0:
                    chunk = min(4096, remaining)
                    out.writeframes(block[: chunk * 4])
                    remaining -= chunk
            return path

        service = _service(tmp_path)
        try:
            track = _ingest(service, stem_wav(tmp_path / "mix.wav", freq=200.0))
            files = {role: long_silence(tmp_path / "long" / f"{role}.wav") for role in ROLE_FREQ}
            with pytest.raises(UserError) as excinfo:
                service.import_stem_set(track["id"], _stage_all(service, files))
            assert "decodes to" in str(excinfo.value)
            assert not [p for p in service.stem_dir.iterdir() if p.is_dir()]
        finally:
            service.close()

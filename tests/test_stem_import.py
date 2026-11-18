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

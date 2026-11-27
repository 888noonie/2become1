"""The Stem-Focus audio truth contract (OPERATION STUDIO SURGEON, Act II).

These tests pin the audio surface a focused stem preview depends on. They are
verification, not a redesign: no route, table, column or media copy is added.

The claims:

* a stem's identity is ``(stem_set_id, role)`` and its preview URL does not
  change when the owner renames it;
* the full route serves the stored bytes and honours HTTP Range, so an
  ``<audio>`` element can seek;
* the section route cuts at a sample index, keeps the file's rate, channels and
  sample width, and is byte-aligned with the source at both ends;
* a malformed set id, an unknown role, ``full``, a traversal name, a deleted
  file, a symlink out of the managed root and a tampered database path all
  refuse — none can expose an unmanaged file;
* the identity card states the source tempo and whether it was entered, and
  never returns media paths, hashes or peaks;
* the existing waveform route is the recording's mix, not a stem.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import sqlite3
import struct
import subprocess
import wave
from pathlib import Path

import numpy as np
import pytest

import httpx

from twobecomeone.common import UserError
from twobecomeone.studio import StudioService
from twobecomeone.webapp import create_app

ROLES = ("vocals", "drums", "bass", "other")
ROLE_FREQ = {"vocals": 440.0, "drums": 220.0, "bass": 110.0, "other": 330.0}
RATE = 44100
SECONDS = 6

CARD_KEYS = {
    "stem_set_id", "track_id", "track_name", "source_kind", "bpm", "bpm_source",
    "method", "model_name", "device", "status", "created_at", "stems",
}
CARD_STEM_KEYS = {"name", "display_name", "custom_name", "audio_url"}


# --------------------------------------------------------------------------
# Fixtures and helpers
# --------------------------------------------------------------------------

def _tone(path: Path, *, freq: float, seconds: float = SECONDS, rate: int = RATE,
          channels: int = 2) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = bytearray()
    for index in range(int(round(seconds * rate))):
        value = int(0.2 * 32767 * math.sin(2 * math.pi * freq * index / rate))
        data += struct.pack("<h", value) * channels
    with wave.open(str(path), "wb") as output:
        output.setnchannels(channels)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(data)
    return path


def _reencode(source: Path, target: Path, codec: str) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-i", str(source),
         "-c:a", codec, str(target)],
        check=True, capture_output=True,
    )
    return target


def _no_separation(monkeypatch) -> None:
    monkeypatch.setattr("twobecomeone.separator.demucs_available", lambda: False)
    monkeypatch.setattr(StudioService, "_queue_auto_separation", lambda self, track_id: None)


def _stage(service: StudioService, path: Path, role: str) -> dict:
    with path.open("rb") as handle:
        key = service.stage_upload(handle, f"{role}.wav")
    return {"role": role, "staging_key": key, "original_name": f"{role}.wav"}


def _library(service: StudioService, root: Path, *, seconds: float = SECONDS) -> tuple[dict, str]:
    mix = _tone(root / "mixes" / "Lantern Carrier.wav", freq=196.0, seconds=seconds)
    with mix.open("rb") as handle:
        track = service.ingest(handle, mix.name, source_kind="local")
    track = service.update_track(track["id"], display_name="Lantern Carrier")
    files = {
        role: _tone(root / "stems" / role / f"{role}.wav", freq=ROLE_FREQ[role], seconds=seconds)
        for role in ROLES
    }
    imported = service.import_stem_set(
        track["id"], [_stage(service, files[role], role) for role in ROLES],
    )
    return track, imported["stem_set_id"]


def _wav_chunks(raw: bytes) -> dict[bytes, bytes]:
    """Return the raw chunk bodies of a RIFF/WAVE payload."""
    chunks: dict[bytes, bytes] = {}
    offset = 12
    while offset + 8 <= len(raw):
        chunk_id = raw[offset:offset + 4]
        size = int.from_bytes(raw[offset + 4:offset + 8], "little")
        chunks.setdefault(chunk_id, raw[offset + 8:offset + 8 + size])
        offset += 8 + size + (size & 1)
    return chunks


def _decode_f32(path: Path) -> np.ndarray:
    """Decode to interleaved float32 so any sample width compares honestly."""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=channels", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    )
    channels = int(json.loads(probe.stdout)["streams"][0]["channels"])
    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-i", str(path),
         "-map", "0:a:0", "-f", "f32le", "-acodec", "pcm_f32le", "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(raw, dtype="<f4").reshape(-1, channels)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def service(tmp_path, monkeypatch):
    _no_separation(monkeypatch)
    instance = StudioService(tmp_path / "data")
    try:
        yield instance
    finally:
        instance.close()


@pytest.fixture
def library(service, tmp_path):
    track, stem_set = _library(service, tmp_path)
    return service, tmp_path, track, stem_set


# --------------------------------------------------------------------------
# Identity: (stem_set_id, role) is stable; a rename is presentation only
# --------------------------------------------------------------------------

class TestIdentity:
    def test_a_rename_changes_only_the_label(self, library):
        service, _root, _track, stem_set = library
        before = service.stem_set_info(stem_set)
        vocals_before = next(s for s in before["stems"] if s["name"] == "vocals")
        digest_before = hashlib.sha256(
            service.stem_audio_path(stem_set, "vocals").read_bytes()
        ).hexdigest()

        service.set_stem_names(stem_set, {"vocals": "Lantern Lead"})
        after = service.stem_set_info(stem_set)
        vocals_after = next(s for s in after["stems"] if s["name"] == "vocals")

        assert vocals_after["name"] == "vocals"          # the role is the key
        assert vocals_after["audio_url"] == vocals_before["audio_url"]
        assert vocals_after["display_name"] == "Lantern Lead"
        assert vocals_after["custom_name"] is True
        assert after["track_id"] == before["track_id"]
        assert after["method"] == "imported"
        assert hashlib.sha256(
            service.stem_audio_path(stem_set, "vocals").read_bytes()
        ).hexdigest() == digest_before

    def test_the_preview_url_is_exactly_the_set_and_role(self, library):
        service, _root, _track, stem_set = library
        for stem in service.stem_set_info(stem_set)["stems"]:
            assert stem["audio_url"] == (
                f"/api/stems/{stem_set}/audio?name={stem['name']}"
            )

    def test_the_identity_card_states_the_tempo_and_its_source(self, service, tmp_path):
        track, stem_set = _library(service, tmp_path)
        measured = service.stem_set_info(stem_set)
        assert measured["bpm"] == pytest.approx(track["bpm"])
        assert measured["bpm_source"] == "measured"

        service.update_track(track["id"], bpm=123.0)
        entered = service.stem_set_info(stem_set)
        assert entered["bpm"] == pytest.approx(123.0)
        assert entered["bpm_source"] == "entered"

    def test_the_card_is_a_fixed_shape_without_media_paths_or_peaks(self, library):
        service, root, _track, stem_set = library
        card = service.stem_set_info(stem_set)

        assert set(card) == CARD_KEYS
        assert card["stems"]
        for stem in card["stems"]:
            assert set(stem) == CARD_STEM_KEYS
        blob = json.dumps(card)
        assert str(root) not in blob
        for forbidden in ("paths_json", "names_json", "provenance_json",
                          "content_sha256", "peaks", ".wav\""):
            assert forbidden not in blob


# --------------------------------------------------------------------------
# The full route: stored bytes, and Range for seeking
# --------------------------------------------------------------------------

class TestFullRoute:
    def test_serves_the_stored_bytes_and_honours_range(self, tmp_path, monkeypatch):
        pytest.importorskip("fastapi")
        _no_separation(monkeypatch)
        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        try:
            studio = app.state.studio
            _track, stem_set = _library(studio, tmp_path)
            stored = studio.stem_audio_path(stem_set, "vocals").read_bytes()

            async def run():
                async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
                    url = f"/api/stems/{stem_set}/audio"
                    full = await c.get(url, params={"name": "vocals"})
                    name = {"name": "vocals"}
                    head = await c.get(url, params=name, headers={"Range": "bytes=0-99"})
                    suffix = await c.get(url, params=name, headers={"Range": "bytes=-64"})
                    late = await c.get(url, params=name, headers={"Range": "bytes=999999999-"})
                    attachment = await c.get(url, params={"name": "vocals", "download": True})
                    return full, head, suffix, late, attachment

            full, head, suffix, late, attachment = asyncio_run(run())
            assert full.status_code == 200
            assert full.content == stored
            assert full.headers["accept-ranges"] == "bytes"

            assert head.status_code == 206
            assert head.content == stored[:100]
            assert head.headers["content-range"] == f"bytes 0-99/{len(stored)}"

            assert suffix.status_code == 206
            assert suffix.content == stored[-64:]

            assert late.status_code == 416

            assert attachment.status_code == 200
            assert attachment.headers["content-disposition"].startswith("attachment")
        finally:
            app.state.studio.close()


# --------------------------------------------------------------------------
# The section route: a sampled window, not a re-encode of something else
# --------------------------------------------------------------------------

class TestSectionRoute:
    def test_a_fractional_start_is_sample_exact_at_both_ends(self, library):
        service, _root, _track, stem_set = library
        source_bytes = service.stem_audio_path(stem_set, "vocals").read_bytes()
        with wave.open(io.BytesIO(source_bytes), "rb") as src:
            rate = src.getframerate()
            channels = src.getnchannels()
            width = src.getsampwidth()
            source = src.readframes(src.getnframes())

        start_seconds = 1.25
        start_sample = int(round(start_seconds * rate))
        raw = service.stem_audio_window(
            stem_set, "vocals", start=start_seconds, duration=30,
        )

        with wave.open(io.BytesIO(raw), "rb") as cut:
            assert cut.getframerate() == rate
            assert cut.getnchannels() == channels
            assert cut.getsampwidth() == width
            frames = cut.readframes(cut.getnframes())
            count = cut.getnframes()

        # The section is the remainder of a six second stem, from the sample.
        total_frames = len(source) // (channels * width)
        assert count == total_frames - start_sample
        assert frames == source[start_sample * channels * width:]

        # Real RIFF sizes, not a pipe placeholder, and a correct data length.
        assert struct.unpack("<I", raw[4:8])[0] == len(raw) - 8
        data = _wav_chunks(raw)[b"data"]
        assert len(data) == count * channels * width

    def test_the_last_sample_is_one_frame_and_the_end_is_refused(self, library):
        service, _root, _track, stem_set = library
        stored = service.stem_audio_path(stem_set, "vocals").read_bytes()
        with wave.open(io.BytesIO(stored), "rb") as src:
            rate = src.getframerate()
            total = src.getnframes()

        last = service.stem_audio_window(
            stem_set, "vocals", start=(total - 1) / rate, duration=30,
        )
        with wave.open(io.BytesIO(last), "rb") as cut:
            assert cut.getnframes() == 1

        with pytest.raises(UserError, match="past the end"):
            service.stem_audio_window(stem_set, "vocals", start=total / rate, duration=30)

    @pytest.mark.parametrize("duration", [29, 31, 45, 120])
    def test_only_the_three_section_lengths_are_served(self, library, duration):
        service, _root, _track, stem_set = library
        with pytest.raises(UserError, match="30, 60, or 90"):
            service.stem_audio_window(stem_set, "vocals", start=0, duration=duration)

    def test_out_of_range_starts_are_refused(self, library):
        service, _root, _track, stem_set = library
        for start, message in ((-1.0, "between 0 and 3600"), (3601.0, "between 0 and 3600")):
            with pytest.raises(UserError, match=message):
                service.stem_audio_window(stem_set, "vocals", start=start, duration=30)
        with pytest.raises(UserError, match="finite number of seconds"):
            service.stem_audio_window(stem_set, "vocals", start=True, duration=30)

    def test_a_cut_copies_nothing_and_leaves_the_stem_byte_identical(self, library):
        service, root, _track, stem_set = library
        stems_root = root / "data" / "stems"
        path = service.stem_audio_path(stem_set, "bass")

        def snapshot():
            return {
                str(item.relative_to(stems_root)): hashlib.sha256(item.read_bytes()).hexdigest()
                for item in sorted(stems_root.rglob("*")) if item.is_file()
            }

        before = snapshot()
        service.stem_audio_window(stem_set, "bass", start=0, duration=30)

        assert snapshot() == before
        assert hashlib.sha256(path.read_bytes()).hexdigest() == before[
            str(path.relative_to(stems_root))
        ]

    def test_wide_pcm_and_float_keep_their_samples(self, tmp_path, monkeypatch):
        _no_separation(monkeypatch)
        service = StudioService(tmp_path / "data")
        try:
            for codec, expect_format in (("pcm_s24le", 1), ("pcm_f32le", 3)):
                mix = _tone(tmp_path / f"mix-{codec}.wav", freq=196.0)
                hi = _reencode(mix, tmp_path / f"hi-{codec}.wav", codec)
                with hi.open("rb") as handle:
                    track = service.ingest(handle, hi.name, source_kind="local")
                entries = []
                wide_vocals = None
                for role in ROLES:
                    base = _tone(tmp_path / f"{codec}-{role}.wav", freq=ROLE_FREQ[role])
                    wide = _reencode(base, tmp_path / f"wide-{codec}-{role}.wav", codec)
                    if role == "vocals":
                        wide_vocals = wide
                    entries.append(_stage(service, wide, role))
                stem_set = service.import_stem_set(track["id"], entries)["stem_set_id"]

                raw = service.stem_audio_window(
                    stem_set, "vocals", start=0.5, duration=30,
                )
                fmt = _wav_chunks(raw)[b"fmt "]
                tag = struct.unpack("<H", fmt[:2])[0]
                bits = struct.unpack("<H", fmt[14:16])[0]
                expected_bits = 24 if codec == "pcm_s24le" else 32
                assert bits == expected_bits
                # Extensible WAVs carry the real format in the subformat GUID.
                if tag == 0xFFFE:
                    assert struct.unpack("<H", fmt[24:26])[0] == expect_format
                else:
                    assert tag == expect_format

                written = tmp_path / f"cut-{codec}.wav"
                written.write_bytes(raw)
                source_cut = tmp_path / f"source-cut-{codec}.wav"
                subprocess.run(
                    ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-v", "error",
                     "-i", str(wide_vocals), "-af",
                     "atrim=start_sample=22050,asetpts=PTS-STARTPTS",
                     "-c:a", codec, str(source_cut)],
                    check=True, capture_output=True,
                )
                assert np.array_equal(_decode_f32(written), _decode_f32(source_cut))
        finally:
            service.close()


# --------------------------------------------------------------------------
# Refusals: no unmanaged content can be reached or advertised
# --------------------------------------------------------------------------

class TestRefusals:
    def test_unknown_set_unknown_role_full_and_traversal_refuse(self, library):
        service, _root, _track, stem_set = library
        with pytest.raises(UserError, match="unknown stem set"):
            service.stem_audio_path("no-such-set", "vocals")
        for name, message in (
            ("guitar", "not found"),
            ("full", "not found"),
            ("../vocals", "not found"),
            ("../../tracks/x", "not found"),
            ("", "not found"),
        ):
            with pytest.raises(UserError, match=message):
                service.stem_audio_path(stem_set, name)

    def test_a_deleted_file_is_refused_and_no_longer_advertised(self, library):
        service, _root, track, stem_set = library
        service.stem_audio_path(stem_set, "drums").unlink()

        with pytest.raises(UserError, match="unavailable or corrupt"):
            service.stem_audio_path(stem_set, "drums")
        with pytest.raises(UserError, match="unavailable or corrupt"):
            service.stem_audio_window(stem_set, "drums", start=0, duration=30)

        card_roles = [s["name"] for s in service.stem_set_info(stem_set)["stems"]]
        listing = service.list_stems(track["id"])
        assert "drums" not in card_roles
        assert "drums" not in listing["stems"]
        # The recording's own mix is still a different asset and still listed.
        assert "full" in listing["stems"]

    def test_a_symlink_out_of_the_stem_root_is_refused(self, library):
        service, _root, _track, stem_set = library
        target = service.stem_audio_path(stem_set, "vocals")
        target.unlink()
        target.symlink_to("/etc/hostname")
        with pytest.raises(UserError, match="unavailable or corrupt"):
            service.stem_audio_path(stem_set, "vocals")

    def test_a_tampered_database_path_cannot_reach_outside_the_root(self, library):
        service, root, track, stem_set = library
        outside = root / "outside-secret.wav"
        outside.write_bytes(b"RIFF0000WAVEsecret")
        database = root / "data" / "studio.sqlite3"
        with sqlite3.connect(database) as conn:
            original = json.loads(
                conn.execute(
                    "SELECT paths_json FROM stem_sets WHERE id = ?", (stem_set,)
                ).fetchone()[0]
            )

        mutations = {
            "absolute": str(outside),
            "traversal": "stems/../../outside-secret.wav",
            "tracks dir": "tracks/x.wav",
            # Both of these are real files *inside* the managed stem root, so
            # only the role/filename equality stops them being served as
            # "vocals". A preview URL must never play the wrong lane.
            "another role's file": f"stems/{stem_set}/drums.wav",
            "a different file name": f"stems/{stem_set}/vocals-copy.wav",
        }
        (root / "data" / "stems" / stem_set / "vocals-copy.wav").write_bytes(
            service.stem_audio_path(stem_set, "vocals").read_bytes()
        )
        for label, rel in mutations.items():
            with sqlite3.connect(database) as conn:
                conn.execute(
                    "UPDATE stem_sets SET paths_json = ? WHERE id = ?",
                    (json.dumps({**original, "vocals": rel}), stem_set),
                )
            with pytest.raises(UserError, match="unavailable or corrupt"):
                service.stem_audio_path(stem_set, "vocals")
            assert "vocals" not in [
                s["name"] for s in service.stem_set_info(stem_set)["stems"]
            ], label
            assert "vocals" not in service.list_stems(track["id"])["stems"], label

        with sqlite3.connect(database) as conn:
            conn.execute(
                "UPDATE stem_sets SET paths_json = ? WHERE id = ?",
                (json.dumps(original), stem_set),
            )
        assert service.stem_audio_path(stem_set, "vocals").is_file()

    def test_malformed_paths_json_reports_no_stems(self, library):
        service, root, track, stem_set = library
        with sqlite3.connect(root / "data" / "studio.sqlite3") as conn:
            conn.execute(
                "UPDATE stem_sets SET paths_json = 'not json' WHERE id = ?", (stem_set,),
            )
        with pytest.raises(UserError, match="not found"):
            service.stem_audio_path(stem_set, "vocals")
        assert service.stem_set_info(stem_set)["stems"] == []
        assert service.list_stems(track["id"])["stems"] == ["full"]


# --------------------------------------------------------------------------
# Waveform/peaks: the mix has them; a stem does not
# --------------------------------------------------------------------------

class TestWaveformTruth:
    def test_the_waveform_route_is_the_mix_and_a_stem_card_has_no_peaks(
        self, tmp_path, monkeypatch,
    ):
        pytest.importorskip("fastapi")
        _no_separation(monkeypatch)
        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        try:
            studio = app.state.studio
            track, stem_set = _library(studio, tmp_path)

            async def run():
                async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
                    waveform = await c.get(f"/api/tracks/{track['id']}/waveform")
                    card = await c.get(f"/api/stem-sets/{stem_set}")
                    stems = await c.get(f"/api/tracks/{track['id']}/stems")
                    return waveform, card, stems

            waveform, card, stems = asyncio_run(run())
            assert waveform.status_code == 200
            payload = waveform.json()
            assert payload["version"] == 1
            assert payload["bins"] == 1200
            assert len(payload["peaks"]) == 1200

            assert "peaks" not in json.dumps(card.json())
            variants = stems.json()["variants"]
            assert all("peaks" not in json.dumps(variant) for variant in variants)
        finally:
            app.state.studio.close()


# --------------------------------------------------------------------------
# HTTP behaviour matches the service, and the reason is in the envelope
# --------------------------------------------------------------------------

class TestHttpContract:
    def test_the_routes_report_the_same_refusals(self, tmp_path, monkeypatch):
        pytest.importorskip("fastapi")
        _no_separation(monkeypatch)
        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        try:
            studio = app.state.studio
            _track, stem_set = _library(studio, tmp_path)

            async def run():
                async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
                    url = f"/api/stems/{stem_set}/audio"
                    cases = {}
                    cases["unknown role"] = await c.get(url, params={"name": "guitar"})
                    cases["full"] = await c.get(url, params={"name": "full"})
                    cases["traversal"] = await c.get(url, params={"name": "../../tracks/x"})
                    cases["unknown set"] = await c.get(
                        "/api/stems/nope/audio", params={"name": "vocals"},
                    )
                    cases["start only"] = await c.get(url, params={"name": "vocals", "start": 1})
                    cases["odd length"] = await c.get(
                        url, params={"name": "vocals", "start": 0, "duration": 45},
                    )
                    cases["past end"] = await c.get(
                        url, params={"name": "vocals", "start": 3600, "duration": 30},
                    )
                    cases["missing name"] = await c.get(url)
                    return cases

            cases = asyncio_run(run())
            for label, response in cases.items():
                if label == "missing name":
                    assert response.status_code == 422, label
                    assert response.json()["error"]["code"] == "validation_error"
                    continue
                assert response.status_code == 400, label
                body = response.json()["error"]
                assert body["code"] == "bad_request", label
                assert body["message"], label
                assert "error" in response.json(), label
        finally:
            app.state.studio.close()

    def test_the_ok_section_is_a_wav_with_a_real_length(self, tmp_path, monkeypatch):
        pytest.importorskip("fastapi")
        _no_separation(monkeypatch)
        app = create_app(tmp_path / "data")
        transport = httpx.ASGITransport(app=app)
        try:
            studio = app.state.studio
            _track, stem_set = _library(studio, tmp_path)

            async def run():
                async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
                    return await c.get(
                        f"/api/stems/{stem_set}/audio",
                        params={"name": "other", "start": 0, "duration": 30},
                    )

            response = asyncio_run(run())
            assert response.status_code == 200
            assert response.headers["content-type"] == "audio/wav"
            assert len(response.content) == int(response.headers["content-length"])
            assert response.content[:4] == b"RIFF"
            assert response.content[8:12] == b"WAVE"
            assert struct.unpack("<I", response.content[4:8])[0] == len(response.content) - 8
        finally:
            app.state.studio.close()


def asyncio_run(coro):
    """Run one coroutine without importing the asyncio test plugin twice."""
    import asyncio
    return asyncio.run(coro)

"""Track labels and full-quality sections (OPERATION THE NAME IS BOND)."""

from __future__ import annotations

import io
import json
import math
import resource
import sqlite3
import struct
import tracemalloc
import wave
from pathlib import Path

import pytest

from twobecomeone.common import UserError
from twobecomeone.studio import StudioService, _wav_has_pcm

REPORTED_STEM_BYTES = 68_327_416
ROLES = ("vocals", "drums", "bass", "other")


def _silence(path: Path, seconds: int, rate: int = 44100, channels: int = 2) -> Path:
    frame = b"\x00\x00" * channels
    block = frame * rate
    with wave.open(str(path), "wb") as output:
        output.setnchannels(channels)
        output.setsampwidth(2)
        output.setframerate(rate)
        for _ in range(seconds):
            output.writeframes(block)
    return path


def _pattern(path: Path, seconds: int = 40, rate: int = 44100) -> Path:
    block = bytearray()
    for index in range(rate):
        left = (index % 2000) - 1000
        right = 1000 - (index % 2000)
        block += struct.pack("<hh", left, right)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(rate)
        for _ in range(seconds):
            output.writeframes(block)
    return path


def _tone(path: Path, *, root: float, duration: float = 2.0) -> Path:
    rate = 22050
    frames = bytearray()
    total = int(rate * duration)
    for index in range(total):
        sample = int(max(-1.0, min(1.0, math.sin(2 * math.pi * root * index / rate))) * 16000)
        frames += struct.pack("<hh", sample, sample)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(frames)
    return path


def _row(service: StudioService, track_id: str) -> sqlite3.Row:
    conn = sqlite3.connect(service.db_path)
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
    finally:
        conn.close()


def _stage(service: StudioService, path: Path, role: str) -> dict:
    with path.open("rb") as handle:
        key = service.stage_upload(handle, f"{role}.wav")
    return {"role": role, "staging_key": key, "original_name": f"{role}.wav"}


def _frames(raw: bytes) -> tuple[int, int, bytes]:
    with wave.open(io.BytesIO(raw), "rb") as handle:
        return handle.getframerate(), handle.getnchannels(), handle.readframes(handle.getnframes())


def _no_demucs(monkeypatch) -> None:
    monkeypatch.setattr("twobecomeone.separator.demucs_available", lambda: False)


class TestTrackNames:
    def test_import_name_survives_separation_and_a_later_title(self, tmp_path, monkeypatch):
        _no_demucs(monkeypatch)
        service = StudioService(tmp_path / "data")
        try:
            def fake_download(url, work_dir, **kwargs):
                from twobecomeone.acquisition import SubprocessResult

                work = Path(work_dir)
                _tone(work / "dQw4w9WgXcQ.mp3", root=220.0)
                (work / "dQw4w9WgXcQ.info.json").write_text(json.dumps({
                    "id": "dQw4w9WgXcQ",
                    "title": "Video title should not win",
                    "webpage_url": "https://evil.example/watch",
                }), encoding="utf-8")
                return SubprocessResult(returncode=0)

            monkeypatch.setattr("twobecomeone.acquisition.download_youtube", fake_download)
            job = service.submit_youtube_import(
                "https://youtu.be/dQw4w9WgXcQ",
                display_name="Café — 夜 <script>",
            )
            completed = service.wait_for_job(job["id"], timeout=60)
            assert completed["status"] == "complete", completed.get("error")
            track_id = completed["result"]["track_id"]
            for other in service.list_jobs(limit=10):
                if other["id"] != job["id"]:
                    service.wait_for_job(other["id"], timeout=60)

            track = service.get_track(track_id)
            stored = _row(service, track_id)
            assert track["name"] == "Café — 夜 <script>"
            assert stored["original_name"] == "dQw4w9WgXcQ.mp3"
            assert stored["source_ref"] == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
            assert stored["source_kind"] == "youtube"
            digest = stored["content_sha256"]
            path = stored["path"]

            renamed = service.update_track(track_id, display_name="Cafe\u0301 — night")
            assert renamed["name"] == "Café — night"
            again = service._apply_import_display_name(
                renamed,
                {"display_name": "A later title"},
                {"title": "Overwrite me"},
            )
            assert again["name"] == "Café — night"
            after = _row(service, track_id)
            assert after["content_sha256"] == digest
            assert after["path"] == path
            assert after["source_ref"] == stored["source_ref"]
            assert after["id"] == track_id
        finally:
            service.close()

    def test_blank_and_overlong_names_are_rejected_before_download(self, tmp_path, monkeypatch):
        service = StudioService(tmp_path / "data")
        try:
            def explode(*_args, **_kwargs):
                raise AssertionError("download started")

            monkeypatch.setattr("twobecomeone.acquisition.download_youtube", explode)
            with pytest.raises(UserError, match="empty"):
                service.submit_youtube_import(
                    "https://youtu.be/dQw4w9WgXcQ", display_name="   \n\t",
                )
            with pytest.raises(UserError, match="200"):
                service.submit_youtube_import(
                    "https://youtu.be/dQw4w9WgXcQ", display_name="é" * 201,
                )
        finally:
            service.close()

    def test_video_title_is_the_default_and_duplicate_labels_are_allowed(self, tmp_path, monkeypatch):
        _no_demucs(monkeypatch)
        service = StudioService(tmp_path / "data")
        try:
            def fake_download(url, work_dir, **kwargs):
                from twobecomeone.acquisition import SubprocessResult

                work = Path(work_dir)
                _tone(work / "dQw4w9WgXcQ.mp3", root=330.0)
                (work / "dQw4w9WgXcQ.info.json").write_text(
                    json.dumps({"id": "dQw4w9WgXcQ", "title": "Café — 夜"}),
                    encoding="utf-8",
                )
                return SubprocessResult(returncode=0)

            monkeypatch.setattr("twobecomeone.acquisition.download_youtube", fake_download)
            job = service.submit_youtube_import("https://youtu.be/dQw4w9WgXcQ")
            completed = service.wait_for_job(job["id"], timeout=60)
            assert completed["status"] == "complete", completed.get("error")
            named = service.get_track(completed["result"]["track_id"])
            assert named["name"] == "Café — 夜"

            first = _tone(tmp_path / "one.wav", root=196.0)
            second = _tone(tmp_path / "two.wav", root=392.0)
            with first.open("rb") as handle:
                left = service.ingest(handle, "one.wav")
            with second.open("rb") as handle:
                right = service.ingest(handle, "two.wav")
            service.update_track(left["id"], display_name="Same")
            service.update_track(right["id"], display_name="Same")
            assert service.get_track(left["id"])["name"] == "Same"
            assert service.get_track(right["id"])["name"] == "Same"
            assert left["id"] != right["id"]
        finally:
            service.close()

    def test_a_rename_during_import_completion_keeps_the_saved_name(self, tmp_path, monkeypatch):
        _no_demucs(monkeypatch)
        monkeypatch.setattr(
            StudioService, "_queue_auto_separation", lambda self, track_id: None,
        )
        service = StudioService(tmp_path / "data")
        try:
            tone = _tone(tmp_path / "take.wav", root=220.0)
            with tone.open("rb") as handle:
                track = service.ingest(handle, "take.wav")
            before = _row(service, track["id"])
            assert before["display_name"] is None
            digest = before["content_sha256"]
            path = before["path"]
            original = service._set_display_name_if_unset

            def rename_in_the_gap(track_id, cleaned):
                service.update_track(track_id, display_name="Owner")
                return original(track_id, cleaned)

            service._set_display_name_if_unset = rename_in_the_gap
            finished = service._apply_import_display_name(
                track, {"display_name": "Import"}, {"title": "Video title"},
            )
            assert finished["name"] == "Owner"
            service._set_display_name_if_unset = original
            again = service._apply_import_display_name(
                finished, {"display_name": "Import"}, {"title": "Video title"},
            )
            assert again["name"] == "Owner"
            after = _row(service, track["id"])
            assert after["display_name"] == "Owner"
            assert after["original_name"] == "take.wav"
            assert after["content_sha256"] == digest
            assert after["path"] == path
            assert after["id"] == track["id"]
        finally:
            service.close()


class TestStemSections:
    def test_limits_move_together_for_the_reported_stem(self):
        ordinary = 40 * 1024 * 1024
        assert REPORTED_STEM_BYTES > ordinary
        assert REPORTED_STEM_BYTES * 4 > 160 * 1024 * 1024
        assert REPORTED_STEM_BYTES * 8 > 320 * 1024 * 1024
        assert REPORTED_STEM_BYTES < 128 * 1024 * 1024
        assert REPORTED_STEM_BYTES * 4 < 512 * 1024 * 1024
        assert REPORTED_STEM_BYTES * 8 < 1024 * 1024 * 1024

    def test_window_keeps_rate_channels_and_samples(self, tmp_path, monkeypatch):
        _no_demucs(monkeypatch)
        monkeypatch.setattr(
            StudioService, "_queue_auto_separation", lambda self, track_id: None,
        )
        service = StudioService(tmp_path / "data")
        try:
            carrier = _tone(tmp_path / "carrier.wav", root=220.0)
            with carrier.open("rb") as handle:
                track = service.ingest(handle, "carrier.wav")
            pattern = _pattern(tmp_path / "pattern.wav", seconds=40)
            imported = service.import_stem_set(track["id"], [
                _stage(service, pattern, role) for role in ROLES
            ])
            before = pattern.read_bytes()
            windows = [
                service.stem_audio_window(
                    imported["stem_set_id"], role, start=5, duration=30,
                )
                for role in ROLES
            ]
            assert windows[0] == windows[1] == windows[2] == windows[3]
            assert pattern.read_bytes() == before
            rate, channels, frames = _frames(windows[0])
            assert rate == 44100
            assert channels == 2
            with wave.open(str(pattern), "rb") as source:
                source_frames = source.readframes(source.getnframes())
            start = 5 * 44100 * 4
            assert frames == source_frames[start:start + len(frames)]
            assert len(frames) == 30 * 44100 * 4
        finally:
            service.close()

    def test_long_recording_is_windowed_under_the_default_ceiling(self, tmp_path, monkeypatch):
        _no_demucs(monkeypatch)
        monkeypatch.setattr(
            StudioService, "_queue_auto_separation", lambda self, track_id: None,
        )
        service = StudioService(tmp_path / "data")
        try:
            carrier = _tone(tmp_path / "carrier.wav", root=220.0)
            with carrier.open("rb") as handle:
                track = service.ingest(handle, "carrier.wav")
            long = _silence(tmp_path / "long.wav", seconds=178)
            full_decoded = 178 * 48000 * 2 * 4
            assert full_decoded > 40 * 1024 * 1024
            assert full_decoded >= REPORTED_STEM_BYTES
            imported = service.import_stem_set(track["id"], [
                _stage(service, long, role) for role in ROLES
            ])
            digest = long.read_bytes()[:64]
            tracemalloc.start()
            before = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
            window = service.stem_audio_window(
                imported["stem_set_id"], "vocals", start=0, duration=90,
            )
            _current, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            after = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
            rate, channels, frames = _frames(window)
            assert rate == 44100
            assert channels == 2
            assert len(frames) == 90 * 44100 * 4
            decoded_at_context = 90 * 48000 * 2 * 4
            assert decoded_at_context < 40 * 1024 * 1024
            assert len(window) < 40 * 1024 * 1024
            assert peak < 80 * 1024 * 1024
            assert long.read_bytes()[:64] == digest
            # The cut is a 16-bit slice, not an eight-lane float allocation.
            assert after - before < 200_000
        finally:
            service.close()

    def test_invalid_and_too_wide_sections_fail_cleanly(self, tmp_path, monkeypatch):
        _no_demucs(monkeypatch)
        monkeypatch.setattr(
            StudioService, "_queue_auto_separation", lambda self, track_id: None,
        )
        service = StudioService(tmp_path / "data")
        try:
            carrier = _tone(tmp_path / "carrier.wav", root=220.0)
            with carrier.open("rb") as handle:
                track = service.ingest(handle, "carrier.wav")
            wide = _silence(tmp_path / "wide.wav", seconds=30, rate=96000)
            short = _silence(tmp_path / "short.wav", seconds=2)
            high = service.import_stem_set(track["id"], [
                _stage(service, wide, role) for role in ROLES
            ])
            with pytest.raises(UserError, match="30, 60, or 90"):
                service.stem_audio_window(high["stem_set_id"], "vocals", start=0, duration=45)
            with pytest.raises(UserError, match="between 0 and 3600"):
                service.stem_audio_window(high["stem_set_id"], "vocals", start=-1, duration=30)
            with pytest.raises(UserError, match="decodes to"):
                service.stem_audio_window(high["stem_set_id"], "vocals", start=0, duration=60)
            fitted = service.stem_audio_window(
                high["stem_set_id"], "vocals", start=0, duration=30,
            )
            rate, channels, frames = _frames(fitted)
            assert rate == 96000
            assert channels == 2
            assert len(frames) == 30 * 96000 * 4
            brief = service.import_stem_set(track["id"], [
                _stage(service, short, role) for role in ROLES
            ])
            with pytest.raises(UserError, match="past the end") as caught:
                service.stem_audio_window(brief["stem_set_id"], "drums", start=1000, duration=30)
            assert str(tmp_path) not in str(caught.value)
        finally:
            service.close()

    def test_seek_lands_on_the_sample_and_wider_pcm_is_kept(self, tmp_path):
        service = StudioService.__new__(StudioService)
        narrow = tmp_path / "two.wav"
        with wave.open(str(narrow), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(48000)
            handle.writeframes(struct.pack("<hh", 0, 1))
        original = narrow.read_bytes()
        service.stem_audio_path = lambda *_args, **_kwargs: narrow
        window = service.stem_audio_window("set", "vocals", start=1 / 48000, duration=30)
        assert narrow.read_bytes() == original
        assert len(window) < 4096
        with wave.open(io.BytesIO(window), "rb") as handle:
            assert handle.getframerate() == 48000
            assert handle.getnchannels() == 1
            assert handle.getsampwidth() == 2
            assert handle.readframes(1) == struct.pack("<h", 1)
        with pytest.raises(UserError, match="past the end"):
            service.stem_audio_window("set", "vocals", start=0.001, duration=30)

        one = tmp_path / "one.wav"
        with wave.open(str(one), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(48000)
            handle.writeframes(struct.pack("<h", 1))
        service.stem_audio_path = lambda *_args, **_kwargs: one
        kept_one = service.stem_audio_window("set", "vocals", start=0, duration=30)
        with wave.open(io.BytesIO(kept_one), "rb") as handle:
            assert handle.readframes(1) == struct.pack("<h", 1)
        with pytest.raises(UserError, match="past the end") as caught:
            service.stem_audio_window("set", "vocals", start=0.0000209, duration=30)
        assert str(tmp_path) not in str(caught.value)

        one24 = tmp_path / "one24.wav"
        with wave.open(str(one24), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(3)
            handle.setframerate(48000)
            handle.writeframes(b"\x01\x00\x00")
        service.stem_audio_path = lambda *_args, **_kwargs: one24
        kept24 = service.stem_audio_window("set", "vocals", start=0, duration=30)
        assert kept24[:4] == b"RIFF"
        assert b"\x01\x00\x00" in kept24
        assert len(kept24) < 4096
        assert _wav_has_pcm(kept24) is True

        floated = tmp_path / "one-float.wav"
        sample = struct.pack("<f", 0.5)
        fmt = struct.pack("<HHIIHH", 3, 1, 48000, 192000, 4, 32)
        chunks = b"fmt " + struct.pack("<I", 16) + fmt + b"data" + struct.pack("<I", len(sample)) + sample
        floated.write_bytes(b"RIFF" + struct.pack("<I", 4 + len(chunks)) + b"WAVE" + chunks)
        service.stem_audio_path = lambda *_args, **_kwargs: floated
        kept_float = service.stem_audio_window("set", "vocals", start=0, duration=30)
        assert sample in kept_float
        assert len(kept_float) < 4096
        assert _wav_has_pcm(kept_float) is True
        assert _wav_has_pcm(b"RIFF" + struct.pack("<I", 12) + b"WAVEdata" + struct.pack("<I", 0)) is False

        wide = tmp_path / "wide24.wav"
        with wave.open(str(wide), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(3)
            handle.setframerate(44100)
            handle.writeframes(b"\x01\x00\x00" * 44100)
        wide_bytes = wide.read_bytes()
        service.stem_audio_path = lambda *_args, **_kwargs: wide
        kept = service.stem_audio_window("set", "vocals", start=0, duration=30)
        assert wide.read_bytes() == wide_bytes
        with wave.open(io.BytesIO(kept), "rb") as handle:
            assert handle.getframerate() == 44100
            assert handle.getnchannels() == 1
            assert handle.getsampwidth() == 3
            assert handle.readframes(1) == b"\x01\x00\x00"

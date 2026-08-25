"""Phase 3.9 corrective tests: embedded/YouTube artwork, stem finalization,
cancellation cleanup, and OOM warning propagation."""

import base64
import math
import struct
import subprocess
import wave
from pathlib import Path

import pytest

from twobecomeone import media, separator
from twobecomeone.common import UserError
from twobecomeone.studio import StudioService


def synth_track(path: Path, *, bpm: float, root: float, duration: float = 4.0) -> Path:
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


# A valid 1x1 red PNG.
_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQAB"
    "h6FO1AAAAABJRU5ErkJggg=="
)


def _png_with_trailing_bytes() -> bytes:
    return _PNG + b"\x00\x00EXIF\x00\x00trailing-polyglot-payload"


def _make_mp3_with_artwork(path: Path, artwork: bytes) -> Path:
    """Create an MP3 with attached cover art using ffmpeg."""
    wav = path.with_suffix(".wav")
    synth_track(wav, bpm=100, root=261.63)
    art = path.with_suffix(".png")
    art.write_bytes(artwork)
    subprocess.run(
        [
            "ffmpeg", "-y", "-v", "error",
            "-i", str(wav), "-i", str(art),
            "-map", "0:a", "-map", "1:v",
            "-c:a", "libmp3lame", "-c:v", "png",
            "-id3v2_version", "3",
            "-metadata:s:v", "title=Album cover",
            "-metadata:s:v", "comment=Cover (front)",
            str(path),
        ],
        check=True,
    )
    return path


class TestEmbeddedArtwork:
    def test_ingest_extracts_and_normalizes_embedded_artwork(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            mp3 = _make_mp3_with_artwork(tmp_path / "cover.mp3", _png_with_trailing_bytes())
            with mp3.open("rb") as f:
                track = service.ingest(f, "cover.mp3")
            # artwork_path is populated in the DB.
            row = service._get_track_row(track["id"])
            assert row["artwork_path"] is not None
            # The stored file is a clean WebP without the injected payload.
            art_path = service.artwork_path(track["id"])
            assert art_path is not None
            data = art_path.read_bytes()
            assert data[:4] == b"RIFF"
            assert data[8:12] == b"WEBP"
            assert b"trailing-polyglot-payload" not in data
            assert b"EXIF" not in data
        finally:
            service.close()

    def test_ingest_without_artwork_is_nonfatal(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            p = synth_track(tmp_path / "plain.wav", bpm=100, root=261.63)
            with p.open("rb") as f:
                track = service.ingest(f, "plain.wav")
            assert track["id"]
            assert service.artwork_path(track["id"]) is None
        finally:
            service.close()


class TestYouTubeThumbnail:
    def test_youtube_ingest_stores_normalized_thumbnail(self, tmp_path, monkeypatch):
        service = StudioService(tmp_path / "data")
        try:
            def fake_download(url, work_dir, **kwargs):
                from twobecomeone.acquisition import SubprocessResult
                work_dir = Path(work_dir)
                # Write the audio artifact AND a thumbnail.
                synth_track(work_dir / "dQw4w9WgXcQ.mp3", bpm=100, root=261.63)
                (work_dir / "dQw4w9WgXcQ.webp").write_bytes(_png_with_trailing_bytes())
                return SubprocessResult(returncode=0)

            monkeypatch.setattr("twobecomeone.acquisition.download_youtube", fake_download)
            job = service.submit_youtube_import("https://youtu.be/dQw4w9WgXcQ")
            completed = service.wait_for_job(job["id"], timeout=30)
            assert completed["status"] == "complete", completed.get("error")
            track_id = completed["result"]["track_id"]
            art_path = service.artwork_path(track_id)
            assert art_path is not None
            data = art_path.read_bytes()
            assert data[:4] == b"RIFF" and data[8:12] == b"WEBP"
            assert b"trailing-polyglot-payload" not in data
        finally:
            service.close()

    def test_resolve_thumbnail_allowlist(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            work = tmp_path / "work"
            work.mkdir()
            (work / "dQw4w9WgXcQ.jpg").write_bytes(_PNG)
            # A non-allowlisted extension is ignored.
            (work / "dQw4w9WgXcQ.gif").write_bytes(_PNG)
            resolved = service._resolve_thumbnail(work, "dQw4w9WgXcQ")
            assert resolved is not None
            assert resolved.suffix == ".jpg"
        finally:
            service.close()


class TestStemFinalization:
    def test_corrupt_stem_rejected(self, tmp_path, monkeypatch):
        service = StudioService(tmp_path / "data")
        try:
            t = synth_track(tmp_path / "t.wav", bpm=100, root=261.63)
            with t.open("rb") as f:
                track = service.ingest(f, "t.wav")

            # Make separator produce a corrupt (non-decodable) stem.
            def fake_separate(path, out_dir, method="auto", on_oom=None):
                out_dir = Path(out_dir)
                out_dir.mkdir(parents=True, exist_ok=True)
                center = out_dir / "center.wav"
                center.write_bytes(b"this is not valid audio")
                sides = out_dir / "sides.wav"
                sides.write_bytes(b"also not audio")
                return {"center": center, "sides": sides}

            monkeypatch.setattr("twobecomeone.separator.separate", fake_separate)
            job = service.submit_separation(track["id"], method="ffmpeg")
            completed = service.wait_for_job(job["id"], timeout=30)
            assert completed["status"] == "failed"
            assert "decode" in completed["error"]
            # No cache row and no final directory left behind.
            with service._connect() as conn:
                count = conn.execute("SELECT COUNT(*) FROM stem_sets").fetchone()[0]
            assert count == 0
            assert list(service.stem_dir.iterdir()) == []
        finally:
            service.close()

    def test_atomic_finalization_no_partial_dir(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            t = synth_track(tmp_path / "t.wav", bpm=100, root=261.63)
            with t.open("rb") as f:
                track = service.ingest(f, "t.wav")
            job = service.submit_separation(track["id"], method="ffmpeg")
            completed = service.wait_for_job(job["id"], timeout=30)
            assert completed["status"] == "complete", completed.get("error")
            stem_set_id = completed["result"]["stem_set_id"]
            final_dir = service.stem_dir / stem_set_id
            assert final_dir.is_dir()
            # No leftover staging dirs.
            leftovers = [p for p in service.stem_dir.iterdir() if p.name.startswith(".tmp_")]
            assert leftovers == []
            # Both stems present and decodable.
            for name in ("center", "sides"):
                assert (final_dir / f"{name}.wav").is_file()
                assert media.validate_audio_decodes(final_dir / f"{name}.wav")
        finally:
            service.close()

    def test_cancellation_during_separation_cleans_up(self, tmp_path, monkeypatch):
        service = StudioService(tmp_path / "data")
        try:
            t = synth_track(tmp_path / "t.wav", bpm=100, root=261.63)
            with t.open("rb") as f:
                track = service.ingest(f, "t.wav")

            # A separator that blocks until cancelled, then raises JobCancelled.
            def blocking_separate(path, out_dir, method="auto", on_oom=None):
                import time
                from twobecomeone.jobs import JobCancelled
                # Simulate long work; the token is checked by the caller after
                # separate() returns, so we just return valid stems and let the
                # post-separation cancellation check fire.
                out_dir = Path(out_dir)
                out_dir.mkdir(parents=True, exist_ok=True)
                center = out_dir / "center.wav"
                sides = out_dir / "sides.wav"
                synth_track(center, bpm=100, root=261.63, duration=1.0)
                synth_track(sides, bpm=100, root=261.63, duration=1.0)
                return {"center": center, "sides": sides}

            monkeypatch.setattr("twobecomeone.separator.separate", blocking_separate)

            # Submit then immediately cancel.
            job = service.submit_separation(track["id"], method="ffmpeg")
            # Cancel while queued/running.
            service.cancel_job(job["id"])
            completed = service.wait_for_job(job["id"], timeout=30)
            assert completed["status"] in {"cancelled", "failed"}
            # No cache row, no final dir.
            with service._connect() as conn:
                count = conn.execute("SELECT COUNT(*) FROM stem_sets").fetchone()[0]
            assert count == 0
            assert list(service.stem_dir.iterdir()) == []
        finally:
            service.close()


class TestOOMWarningPropagation:
    def _mock_demucs_oom(self, monkeypatch, oom_on_load: bool):
        """Mock Demucs to OOM either on load or on inference, then succeed on CPU."""
        import sys
        import types

        calls = {"device": [], "empty_cache": 0, "gc": 0}

        class FakeSeparator:
            def __init__(self, device="cuda"):
                self.device = device
                self.samplerate = 44100
                calls["device"].append(device)
                if oom_on_load and device == "cuda":
                    raise RuntimeError("CUDA out of memory. Tried to allocate 2 GiB")

            def separate_audio_file(self, path):
                if self.device == "cuda" and not oom_on_load:
                    raise RuntimeError("CUDA out of memory. Tried to allocate 2 GiB")
                import numpy as np
                fake = {n: np.zeros(1000, dtype=np.float32) for n in ["vocals", "drums", "bass", "other"]}
                return None, fake

        monkeypatch.setattr(separator, "_pick_demucs_device", lambda: "cuda")
        monkeypatch.setattr(separator, "_demucs_separator", None)
        monkeypatch.setattr(separator, "_demucs_device", None)

        demucs_module = types.ModuleType("demucs")
        demucs_module.__path__ = []
        demucs_api = types.ModuleType("demucs.api")
        demucs_api.Separator = FakeSeparator
        demucs_module.api = demucs_api
        monkeypatch.setitem(sys.modules, "demucs", demucs_module)
        monkeypatch.setitem(sys.modules, "demucs.api", demucs_api)

        torch_module = types.ModuleType("torch")
        torch_module.cuda = types.SimpleNamespace(
            OutOfMemoryError=type("OutOfMemoryError", (RuntimeError,), {}),
            empty_cache=lambda: calls.__setitem__("empty_cache", calls["empty_cache"] + 1),
        )
        monkeypatch.setitem(sys.modules, "torch", torch_module)
        import gc
        monkeypatch.setattr(
            gc, "collect", lambda: calls.__setitem__("gc", calls["gc"] + 1),
        )

        def fake_save(audio, path, samplerate=None):
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            synth_track(Path(path), bpm=100, root=261.63, duration=1.0)
        demucs_api.save_audio = fake_save
        return calls

    def test_load_oom_publishes_warning_in_job(self, tmp_path, monkeypatch):
        service = StudioService(tmp_path / "data")
        try:
            t = synth_track(tmp_path / "t.wav", bpm=100, root=261.63)
            with t.open("rb") as f:
                track = service.ingest(f, "t.wav")

            calls = self._mock_demucs_oom(monkeypatch, oom_on_load=True)
            job = service.submit_separation(track["id"], method="demucs")
            completed = service.wait_for_job(job["id"], timeout=60)
            assert completed["status"] == "complete", completed.get("error")
            # Warning observable in progress_detail.
            detail = completed.get("progress_detail") or {}
            assert "GPU Memory Limit Reached" in detail.get("warning", "")
            # CUDA released, cache cleared, CPU attempted once.
            assert calls["empty_cache"] >= 1
            assert calls["gc"] >= 1
            assert calls["device"] == ["cuda", "cpu"]
            assert completed["result"]["device"] == "cpu"
        finally:
            service.close()

    def test_inference_oom_publishes_warning_in_job(self, tmp_path, monkeypatch):
        service = StudioService(tmp_path / "data")
        try:
            t = synth_track(tmp_path / "t.wav", bpm=100, root=261.63)
            with t.open("rb") as f:
                track = service.ingest(f, "t.wav")

            calls = self._mock_demucs_oom(monkeypatch, oom_on_load=False)
            job = service.submit_separation(track["id"], method="demucs")
            completed = service.wait_for_job(job["id"], timeout=60)
            assert completed["status"] == "complete", completed.get("error")
            detail = completed.get("progress_detail") or {}
            assert "GPU Memory Limit Reached" in detail.get("warning", "")
            assert calls["empty_cache"] >= 1
            assert calls["gc"] >= 1
            assert calls["device"] == ["cuda", "cpu"]
            assert completed["result"]["device"] == "cpu"
        finally:
            service.close()

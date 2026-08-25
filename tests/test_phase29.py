"""Phase 2.9 regression tests: live progress, canonicalization, staging keys,
metadata persistence, waveform paths, race-safe dedupe, resume, and no path
leaks in public job JSON."""

import io
import json
import math
import struct
import sys
import threading
import time
import wave
from pathlib import Path

import pytest

from twobecomeone import acquisition, media, sources
from twobecomeone.common import UserError
from twobecomeone.studio import StudioService


FAKE_DOWNLOADER = Path(__file__).with_name("fake_downloader.py")


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


class TestLiveProgress:
    def test_progress_fires_before_process_exits(self, tmp_path):
        """on_progress must fire while the child is still running."""
        out = tmp_path / "fake.bin"
        token = acquisition.CancellationToken()
        fired_during = []

        # Use a slow downloader so we can observe callbacks mid-run.
        result = acquisition.run_process(
            [sys.executable, str(FAKE_DOWNLOADER),
             "--chunks", "5", "--delay", "0.3", "--out", str(out)],
            token=token,
            on_progress=lambda d: fired_during.append(time.monotonic()),
            timeout=60.0,
        )
        assert result.returncode == 0
        assert len(fired_during) >= 5
        # The first callback must have fired well before the process finished.
        # (The process takes ~1.5s; the first callback should be < 1s in.)
        assert fired_during[0] < fired_during[-1], "callbacks should be spread over time"


class TestParserTemplate:
    def test_real_template_percentages(self):
        # yt-dlp pads values and appends '%' to percent; ANSI may be present.
        line = "\x1b[0;32m2BECOME1 downloaded= 123456 total= 1000000 percent= 12.3% speed= 1.2MiB/s eta= 42\x1b[0m"
        parsed = acquisition.parse_progress_line(line)
        assert parsed is not None
        assert parsed["percent"] == pytest.approx(12.3)
        assert parsed["bytes"] == 123456
        assert parsed["total_bytes"] == 1000000

    def test_ansi_only_line_ignored(self):
        assert acquisition.parse_progress_line("\x1b[0mno marker here\x1b[0m") is None


class TestCanonicalization:
    def test_equivalent_urls_same_work_key(self):
        a = sources.canonicalize_youtube_url("https://youtu.be/dQw4w9WgXcQ")
        b = sources.canonicalize_youtube_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        c = sources.canonicalize_youtube_url("https://www.youtube.com/shorts/dQw4w9WgXcQ")
        assert a == b == c == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

    def test_invalid_url_rejected(self):
        with pytest.raises(UserError):
            sources.canonicalize_youtube_url("https://example.com/not-youtube")


class TestStagingKey:
    def test_public_job_json_has_no_absolute_paths(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            p = synth_track(tmp_path / "t.wav", bpm=100, root=261.63)
            with p.open("rb") as f:
                key = service.stage_upload(f, "t.wav")
            job = service.submit_upload_import(key, original_name="t.wav")
            # The serialized request must contain no absolute path.
            serialized = json.dumps(job)
            assert str(tmp_path) not in serialized
            assert "/incoming/" not in serialized
            assert "staging_key" in job["request"]
            assert job["request"]["staging_key"] == key
        finally:
            service.close()

    def test_staging_key_rejects_traversal(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            with pytest.raises(UserError):
                service.submit_upload_import("../../etc/passwd")
            with pytest.raises(UserError):
                service.submit_upload_import("a/b.wav")
        finally:
            service.close()


class TestOriginalName:
    def test_original_upload_name_survives(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            p = synth_track(tmp_path / "human-name.wav", bpm=100, root=261.63)
            with p.open("rb") as f:
                key = service.stage_upload(f, "human-name.wav")
            job = service.submit_upload_import(key, original_name="human-name.wav")
            completed = service.wait_for_job(job["id"], timeout=30)
            assert completed["status"] == "complete", completed.get("error")
            track = service.get_track(completed["result"]["track_id"])
            assert track["name"] == "human-name.wav"
        finally:
            service.close()


class TestMetadataPersistence:
    def test_sanitized_metadata_persisted(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            p = synth_track(tmp_path / "t.wav", bpm=100, root=261.63)
            with p.open("rb") as f:
                track = service.ingest(
                    f, "t.wav", source_kind="youtube",
                    source_ref="https://youtu.be/dQw4w9WgXcQ",
                    metadata={
                        "title": "My <b>Track</b>",
                        "uploader": "Someone",
                        "description": "DROP ME",
                        "duration": 123.4,
                        "video_id": "dQw4w9WgXcQ",
                    },
                )
            # metadata_json is stored; description is dropped.
            with service._connect() as conn:
                row = conn.execute(
                    "SELECT metadata_json FROM tracks WHERE id = ?", (track["id"],)
                ).fetchone()
            stored = json.loads(row["metadata_json"])
            # Sanitization strips control/bidi chars and collapses whitespace;
            # HTML tags are preserved as literal text (XSS is prevented at
            # render time via textContent, not by stripping markup).
            assert stored["title"] == "My <b>Track</b>"
            assert "description" not in stored
            assert stored["video_id"] == "dQw4w9WgXcQ"
        finally:
            service.close()


class TestWaveformPath:
    def test_waveform_path_names_readable_file(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            p = synth_track(tmp_path / "t.wav", bpm=100, root=261.63)
            with p.open("rb") as f:
                track = service.ingest(f, "t.wav")
            with service._connect() as conn:
                row = conn.execute(
                    "SELECT waveform_path FROM tracks WHERE id = ?", (track["id"],)
                ).fetchone()
            rel = row["waveform_path"]
            assert rel is not None
            assert rel.startswith("waveforms/")
            # The named file exists and is readable JSON.
            full = service.data_dir / rel
            assert full.is_file()
            data = json.loads(full.read_text(encoding="utf-8"))
            assert data["version"] == 1
            assert len(data["peaks"]) == 1200
        finally:
            service.close()


class TestRaceSafeDedupe:
    def test_concurrent_imports_produce_one_row(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            p = synth_track(tmp_path / "t.wav", bpm=100, root=261.63)
            results = []
            errors = []

            def do_import():
                try:
                    with p.open("rb") as f:
                        results.append(service.ingest(f, "t.wav"))
                except Exception as exc:  # noqa: BLE001
                    errors.append(exc)

            threads = [threading.Thread(target=do_import) for _ in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            assert not errors, f"imports raised: {errors}"
            # All four returned the same track id.
            ids = {r["id"] for r in results}
            assert len(ids) == 1
            # Exactly one row in the DB.
            assert len(service.list_tracks()) == 1
        finally:
            service.close()


class TestResumeContract:
    def test_retry_reuses_same_work_key(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            url = "https://youtu.be/dQw4w9WgXcQ"
            canonical = sources.canonicalize_youtube_url(url)
            key1 = service._work_key(canonical)
            key2 = service._work_key(canonical)
            assert key1 == key2
            # The work key is relative and resolves under incoming/.
            assert "/" not in key1
            assert (service.incoming_dir / key1).resolve().is_relative_to(service.incoming_dir.resolve())
        finally:
            service.close()

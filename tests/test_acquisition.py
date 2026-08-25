"""Phase 2 acquisition tests.

The deadlock test (test_subprocess_does_not_deadlock_on_stderr_flood) is the
mandatory gate: it must pass before the real yt-dlp integration is trusted.
It runs a fake downloader that floods stderr beyond pipe capacity while
emitting stdout progress markers, and asserts the executor drains both pipes
concurrently to completion.
"""

import sys
import time
from pathlib import Path

import pytest

from twobecomeone import acquisition
from twobecomeone.jobs import CancellationToken


FAKE_DOWNLOADER = Path(__file__).with_name("fake_downloader.py")


def _run_fake(args: list[str], timeout: float = 30.0) -> acquisition.SubprocessResult:
    token = CancellationToken()
    progress: list[dict] = []

    def on_progress(detail: dict) -> None:
        progress.append(detail)

    result = acquisition.run_process(
        [sys.executable, str(FAKE_DOWNLOADER), *args],
        token=token,
        on_progress=on_progress,
        timeout=timeout,
    )
    return result, progress


class TestDeadlock:
    def test_subprocess_does_not_deadlock_on_stderr_flood(self, tmp_path):
        """A subprocess flooding stderr must not deadlock the executor."""
        out = tmp_path / "fake_download.bin"
        result, progress = _run_fake(
            ["--stderr-mb", "8", "--chunks", "10", "--out", str(out)],
            timeout=60.0,
        )
        assert result.returncode == 0, f"subprocess failed: {result.stderr_tail[:500]}"
        # Progress markers were parsed from stdout despite the stderr flood.
        assert len(progress) >= 10, f"expected >=10 progress events, got {len(progress)}"
        # The payload was fully written.
        assert out.exists()
        assert out.stat().st_size == 1000

    def test_progress_parser_ignores_garbage(self):
        """Only marker-prefixed lines are parsed; garbage is ignored."""
        parsed = acquisition.parse_progress_line(
            "2BECOME1 downloaded=500 total=1000 percent=50.0 speed=100 eta=5"
        )
        assert parsed is not None
        assert parsed["percent"] == 50.0
        assert parsed["bytes"] == 500
        assert parsed["total_bytes"] == 1000

        assert acquisition.parse_progress_line("random garbage line") is None
        assert acquisition.parse_progress_line("") is None
        assert acquisition.parse_progress_line("2BECOME1") is not None  # empty fields ok

    def test_progress_parser_clamps_and_rejects(self):
        # Percent clamped to 0-100.
        p = acquisition.parse_progress_line("2BECOME1 percent=150")
        assert p["percent"] == 100.0
        p = acquisition.parse_progress_line("2BECOME1 percent=-5")
        assert p["percent"] == 0.0
        # Non-finite / negative values rejected (become None).
        p = acquisition.parse_progress_line("2BECOME1 percent=nan")
        assert p["percent"] is None
        p = acquisition.parse_progress_line("2BECOME1 speed=-1")
        assert p["speed"] is None
        # Unknown totals accepted.
        p = acquisition.parse_progress_line("2BECOME1 total=NA")
        assert p["total_bytes"] is None

    def test_progress_parser_handles_malformed(self):
        # Truncated line, embedded delimiters, oversized numbers, invalid UTF-8.
        assert acquisition.parse_progress_line("2BECOME1 downloaded=1 total=") is not None
        assert acquisition.parse_progress_line("2BECOME1 percent=50=50=50") is not None
        assert acquisition.parse_progress_line("2BECOME1 percent=99999999999999999999") is not None
        # Invalid UTF-8 bytes are replaced, never raise.
        assert acquisition.parse_progress_line(b"2BECOME1 percent=50 \xff\xfe".decode("utf-8", "replace")) is not None

    def test_progress_callback_failure_does_not_stop_pipe_drain(self, tmp_path):
        """A UI/DB progress callback failure cannot deadlock the downloader."""
        out = tmp_path / "callback-failure.bin"

        def fail_progress(_detail):
            raise RuntimeError("observer failed")

        result = acquisition.run_process(
            [sys.executable, str(FAKE_DOWNLOADER),
             "--stderr-mb", "8", "--chunks", "10", "--out", str(out)],
            token=CancellationToken(),
            on_progress=fail_progress,
            timeout=60.0,
        )
        assert result.returncode == 0
        assert out.stat().st_size == 1000


class TestYouTubeDownload:
    def test_real_entrypoint_builds_controlled_resumable_command(self, tmp_path, monkeypatch):
        """Exercise download_youtube itself so missing runtime imports are caught."""
        captured = {}

        def fake_run(argv, **kwargs):
            captured["argv"] = argv
            captured["kwargs"] = kwargs
            return acquisition.SubprocessResult(returncode=0)

        monkeypatch.setattr(acquisition, "run_process", fake_run)
        work_dir = tmp_path / "incoming" / "stable-key"
        token = CancellationToken()

        result = acquisition.download_youtube(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            work_dir,
            token=token,
        )

        assert result.returncode == 0
        assert work_dir.is_dir()
        assert captured["kwargs"]["cwd"] == str(work_dir.resolve())
        argv = captured["argv"]
        output = argv[argv.index("-o") + 1]
        assert output == str(work_dir.resolve() / "%(id)s.%(ext)s")
        assert "--continue" in argv
        assert "--no-playlist" in argv
        assert argv[argv.index("--max-filesize") + 1] == str(acquisition.MAX_DOWNLOAD_BYTES)

    def test_output_template_cannot_escape_work_directory(self, tmp_path):
        with pytest.raises(ValueError, match="controlled ID template"):
            acquisition.yt_dlp_argv(
                "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                str(tmp_path / "work"),
                str(tmp_path / "outside.mp3"),
            )

    def test_work_directory_symlink_is_rejected(self, tmp_path):
        target = tmp_path / "target"
        target.mkdir()
        link = tmp_path / "work"
        link.symlink_to(target, target_is_directory=True)
        with pytest.raises(ValueError, match="must not be a symlink"):
            acquisition.download_youtube(
                "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                link,
                token=CancellationToken(),
            )


class TestCancellation:
    def test_cancellation_terminates_child(self, tmp_path):
        """Cancelling a long-running child terminates it and returns promptly."""
        out = tmp_path / "fake_download.bin"
        token = CancellationToken()

        # Start a slow downloader, cancel it mid-flight.
        import threading

        result_holder = {}

        def run():
            result_holder["result"] = acquisition.run_process(
                [sys.executable, str(FAKE_DOWNLOADER),
                 "--chunks", "100", "--delay", "0.2", "--out", str(out)],
                token=token,
                on_progress=lambda d: None,
                timeout=60.0,
            )

        t = threading.Thread(target=run)
        t.start()
        time.sleep(0.5)
        token.cancel()
        t.join(timeout=15.0)
        assert not t.is_alive(), "cancellation did not terminate the child"
        result = result_holder["result"]
        assert result.returncode != 0 or result.cancelled


class TestResume:
    def test_resume_continues_from_partial_bytes(self, tmp_path):
        """A second run with the same work dir continues from existing bytes."""
        out = tmp_path / "resumable.bin"
        token = CancellationToken()

        # First run: interrupt it part-way by cancelling.
        import threading

        first_result = {}

        def first():
            first_result["r"] = acquisition.run_process(
                [sys.executable, str(Path(__file__).with_name("fake_resumable.py")),
                 "--out", str(out), "--total", "1000", "--chunks", "10",
                 "--delay", "0.3"],
                token=token,
                on_progress=lambda d: None,
                timeout=60.0,
            )

        t = threading.Thread(target=first)
        t.start()
        time.sleep(0.8)  # let it write a couple chunks
        token.cancel()
        t.join(timeout=15.0)

        part = Path(str(out) + ".part")
        assert part.exists(), "partial .part file should remain after cancellation"
        partial_size = part.stat().st_size
        assert 0 < partial_size < 1000, f"expected partial bytes, got {partial_size}"

        # Second run: fresh token, same out path -> resumes from partial.
        token2 = CancellationToken()
        second = acquisition.run_process(
            [sys.executable, str(Path(__file__).with_name("fake_resumable.py")),
             "--out", str(out), "--total", "1000", "--chunks", "10"],
            token=token2,
            on_progress=lambda d: None,
            timeout=60.0,
        )
        assert second.returncode == 0
        assert out.exists()
        assert out.stat().st_size == 1000, "resume must complete the full payload"

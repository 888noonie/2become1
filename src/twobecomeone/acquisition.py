"""Asynchronous acquisition: subprocess lifecycle and progress parsing.

Phase 2.2 mandates a deadlock-proof subprocess runner. The key hazards:

- A child that writes a lot to stderr while we block reading stdout (or vice
  versa) fills the OS pipe buffer and deadlocks. We drain BOTH pipes
  concurrently with dedicated reader threads.
- We must never call ``communicate()`` after reader threads have taken
  ownership of the pipes.
- Cancellation must terminate the whole process group, allow a short grace
  period, then kill.
- Only a bounded stderr tail is retained for diagnostics.

The progress parser (2.3) is defensive: it only parses lines carrying the
private ``2BECOME1`` marker, treats every field as optional, clamps/rejects
bad values, and never raises on malformed output.
"""

from __future__ import annotations

import math
import os
import re
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

from .jobs import CancellationToken

# Private marker prefix for machine-readable progress lines.
MARKER = "2BECOME1"

# Bounded stderr tail retained for diagnostics (bytes).
STDERR_TAIL_BYTES = 4096

# How often the supervising loop wakes to inspect cancellation (seconds).
SUPERVISE_INTERVAL = 0.2

# Grace period after SIGTERM before SIGKILL (seconds).
KILL_GRACE_SEC = 2.0

# ANSI escape sequences (color codes etc.) to strip before parsing.
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


@dataclass
class SubprocessResult:
    returncode: int
    cancelled: bool = False
    stderr_tail: str = ""
    progress: list[dict] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Progress parsing
# ---------------------------------------------------------------------------

def parse_progress_line(line: str) -> dict | None:
    """Parse a single progress line into a dict, or None if not a marker line.

    Only lines containing the private marker are parsed. ANSI escape sequences
    are stripped first. Every field is optional; unknown/NA totals, speed, and
    ETA are accepted as None. Percent is clamped to 0-100; negative or
    non-finite values are dropped to None. Malformed output never raises.
    """
    if MARKER not in line:
        return None

    # Strip ANSI color/control sequences before extracting fields.
    line = _ANSI_RE.sub("", line)

    # Strip the marker and split on whitespace into key=value tokens.
    body = line.split(MARKER, 1)[1]
    tokens = body.split()

    fields: dict[str, str] = {}
    # Tolerate both "key=value" and "key= value" (padded) forms.
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if "=" not in token:
            i += 1
            continue
        key, _, value = token.partition("=")
        if value == "" and i + 1 < len(tokens) and "=" not in tokens[i + 1]:
            # "key= value" — the value is the next whitespace-separated token.
            value = tokens[i + 1]
            i += 1
        fields[key] = value
        i += 1

    def _int(key: str) -> int | None:
        raw = fields.get(key)
        if raw is None or raw in {"NA", "N/A", "unknown", ""}:
            return None
        # Strip a trailing '%' and surrounding whitespace/padding.
        raw = raw.strip().rstrip("%").strip()
        try:
            value = int(float(raw))
        except (ValueError, OverflowError):
            return None
        if value < 0 or not math.isfinite(value):
            return None
        return value

    def _float(key: str) -> float | None:
        raw = fields.get(key)
        if raw is None or raw in {"NA", "N/A", "unknown", ""}:
            return None
        raw = raw.strip().rstrip("%").strip()
        try:
            value = float(raw)
        except (ValueError, OverflowError):
            return None
        if not math.isfinite(value) or value < 0:
            return None
        return value

    # Percent is clamped to 0-100 (including negative -> 0); non-finite -> None.
    percent = None
    raw_percent = fields.get("percent")
    if raw_percent not in (None, "NA", "N/A", "unknown", ""):
        raw_percent = raw_percent.strip().rstrip("%").strip()
        try:
            percent = float(raw_percent)
        except (ValueError, OverflowError):
            percent = None
        if percent is not None and not math.isfinite(percent):
            percent = None
        if percent is not None:
            percent = max(0.0, min(100.0, percent))

    return {
        "percent": percent,
        "bytes": _int("downloaded"),
        "total_bytes": _int("total"),
        "speed": _float("speed"),
        "eta": _float("eta"),
    }


# ---------------------------------------------------------------------------
# Subprocess runner
# ---------------------------------------------------------------------------

def _drain_stderr(stream, sink: Callable[[bytes], None]) -> None:
    """Read a stream to EOF in chunks, feeding each chunk to ``sink``."""
    try:
        while True:
            chunk = stream.read(65536)
            if not chunk:
                break
            sink(chunk)
    except Exception:  # noqa: BLE001 - reader thread must never raise
        pass


def _drain_stdout_lines(
    stream,
    on_line: Callable[[str], None],
) -> None:
    """Read a text stream line-by-line, feeding each line to ``on_line``.

    Uses ``readline()`` so lines are delivered as soon as a newline is emitted,
    giving live progress rather than buffering until process exit.
    """
    try:
        for raw in iter(stream.readline, b""):
            on_line(raw.decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001 - reader thread must never raise
        pass


def run_process(
    argv: list[str],
    *,
    token: CancellationToken,
    on_progress: Callable[[dict], None] | None = None,
    timeout: float | None = None,
    cwd: str | None = None,
) -> SubprocessResult:
    """Run ``argv`` as a subprocess, draining stdout/stderr concurrently.

    stdout is read line-by-line and progress callbacks fire LIVE (while the
    child is still running). stderr is drained concurrently into a bounded
    tail. Cancellation terminates the process group, waits a grace period,
    then kills. Reader threads are joined and the process reaped in ``finally``.
    """
    proc = subprocess.Popen(
        argv,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=cwd,
        start_new_session=True,
    )

    stderr_tail = bytearray()
    stderr_lock = threading.Lock()
    progress: list[dict] = []
    progress_lock = threading.Lock()

    def _stderr_sink(chunk: bytes) -> None:
        with stderr_lock:
            stderr_tail.extend(chunk)
            if len(stderr_tail) > STDERR_TAIL_BYTES:
                del stderr_tail[: len(stderr_tail) - STDERR_TAIL_BYTES]

    def _stdout_line(line: str) -> None:
        parsed = parse_progress_line(line)
        if parsed is None:
            return
        with progress_lock:
            progress.append(parsed)
        if on_progress is not None:
            on_progress(parsed)

    stdout_thread = threading.Thread(
        target=_drain_stdout_lines, args=(proc.stdout, _stdout_line), daemon=True
    )
    stderr_thread = threading.Thread(
        target=_drain_stderr, args=(proc.stderr, _stderr_sink), daemon=True
    )
    stdout_thread.start()
    stderr_thread.start()

    cancelled = False
    deadline = time.monotonic() + timeout if timeout is not None else None

    try:
        while True:
            if token.cancelled:
                cancelled = True
                _terminate_group(proc)
                break
            if proc.poll() is not None:
                break
            if deadline is not None and time.monotonic() >= deadline:
                cancelled = True
                _terminate_group(proc)
                break
            time.sleep(SUPERVISE_INTERVAL)
    finally:
        if proc.poll() is None:
            _terminate_group(proc)
        try:
            proc.stdout.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            proc.stderr.close()
        except Exception:  # noqa: BLE001
            pass
        stdout_thread.join(timeout=5.0)
        stderr_thread.join(timeout=5.0)
        proc.wait()

    with progress_lock:
        progress_snapshot = list(progress)

    return SubprocessResult(
        returncode=proc.returncode,
        cancelled=cancelled,
        stderr_tail=stderr_tail.decode("utf-8", "replace"),
        progress=progress_snapshot,
    )


def _terminate_group(proc: subprocess.Popen) -> None:
    """Terminate the process group, wait a grace period, then kill."""
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        pass
    try:
        proc.wait(timeout=KILL_GRACE_SEC)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
        try:
            proc.wait(timeout=KILL_GRACE_SEC)
        except subprocess.TimeoutExpired:
            pass


# ---------------------------------------------------------------------------
# yt-dlp download
# ---------------------------------------------------------------------------

# Progress template: a marker-prefixed, machine-readable line. yt-dlp
# substitutes the fields; we parse only lines carrying MARKER.
_PROGRESS_TEMPLATE = (
    f"{MARKER} downloaded=%(progress.downloaded_bytes)s "
    f"total=%(progress.total_bytes)s percent=%(progress._percent_str)s "
    f"speed=%(progress.speed)s eta=%(progress.eta)s"
)


def yt_dlp_argv(url: str, work_dir: str, output_template: str) -> list[str]:
    """Build the controlled yt-dlp argument list (no shell, no title paths)."""
    return [
        "yt-dlp",
        "--ignore-config",
        "--no-playlist",
        "--continue",
        "--newline",
        "--progress",
        "--progress-template", _PROGRESS_TEMPLATE,
        "--progress-delta", "0.5",
        "--write-info-json",
        "--write-thumbnail",
        "-x",
        "--audio-format", "mp3",
        "--audio-quality", "0",
        "-o", output_template,
        url,
    ]


def download_youtube(
    url: str,
    work_dir: str | Path,
    *,
    token: CancellationToken,
    on_progress: Callable[[dict], None] | None = None,
    timeout: float | None = None,
) -> SubprocessResult:
    """Download a YouTube video's audio into ``work_dir`` using yt-dlp.

    The output template is ID-based (never the video title as a path) and
    resolves beneath ``work_dir``. ``--continue`` makes the download resumable;
    a cancelled/failed run leaves the partial ``.part`` file in place for a
    later resume with the same ``work_dir``.
    """
    work_dir = Path(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    output_template = str(work_dir / "%(id)s.%(ext)s")
    argv = yt_dlp_argv(url, str(work_dir), output_template)
    return run_process(
        argv,
        token=token,
        on_progress=on_progress,
        timeout=timeout,
        cwd=str(work_dir),
    )

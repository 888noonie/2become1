"""Browser-test fixture server for 2become1 Phase 7A.

Runs the *real* FastAPI application (``twobecomeone.webapp.create_app``) against
a temporary data root, stubbing only the two external/expensive boundaries the
plan permits:

- ``acquisition.download_youtube`` (external network) is replaced with a
  deterministic local writer that produces a synthetic audio artifact and a
  thumbnail, so the real import job path (progress, analysis, managed ingest,
  dedupe) still runs end to end.
- ``separator.separate`` is left real for the cheap ffmpeg center/side path
  (no GPU); Demucs is never invoked by the browser journeys.

The browser harness (``tests/browser/run.js``) spawns this module as a
subprocess via ``python -m tests.browser.fixture_server``. It is also imported
directly by ``tests/test_browser_fixture.py`` so every helper has focused
coverage.
"""

from __future__ import annotations

import argparse
import base64
import math
import struct
import wave
from dataclasses import asdict
from pathlib import Path

from twobecomeone import acquisition, sources
from twobecomeone.contracts import JobKind, JobStatus
from twobecomeone.studio import RenderOptions, StudioService

# A valid 1x1 red PNG used as a deterministic YouTube thumbnail.
_PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQAB"
    "h6FO1AAAAABJRU5ErkJggg=="
)


def synth_track(path: Path, *, bpm: float, root: float, duration: float = 4.0) -> Path:
    """Write a deterministic stereo WAV with a detectable beat grid.

    Mirrors the generator used across the backend test suite so the browser
    journeys exercise the real analyzer/beatgrid path on known input.
    """
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
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(sr)
        output.writeframes(samples)
    return path


def _fake_download_youtube(url, work_dir, *, token=None, on_progress=None, timeout=None):
    """Deterministic stand-in for ``acquisition.download_youtube``.

    Writes a synthetic audio artifact named ``<video_id>.wav`` plus a thumbnail
    into ``work_dir``, then reports success. The real import job then resolves,
    analyzes, and ingests it through the normal managed path.
    """
    work_dir = Path(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    canonical = sources.canonicalize_youtube_url(url)
    video_id = canonical.rsplit("=", 1)[-1]
    synth_track(work_dir / f"{video_id}.wav", bpm=100.0, root=261.63, duration=6.0)
    (work_dir / f"{video_id}.png").write_bytes(_PNG_1X1)
    if on_progress is not None:
        # Emit a couple of measured progress callbacks so the UI's live-progress
        # path is exercised without any real network.
        on_progress({"percent": 40.0, "bytes": 1000, "total_bytes": 2500, "speed": 1.0, "eta": 2.0})
        on_progress({"percent": 100.0, "bytes": 2500, "total_bytes": 2500, "speed": 1.0, "eta": 0.0})
    return acquisition.SubprocessResult(returncode=0)


def patch_for_tests() -> None:
    """Stub the external-network boundary at the module level.

    Idempotent: safe to call more than once. Only ``download_youtube`` is
    replaced; the ffmpeg center/side separation and render paths stay real.
    """
    acquisition.download_youtube = _fake_download_youtube


def seed_library(service: StudioService, tmp_path: Path) -> tuple[dict, dict]:
    """Ingest two synthetic tracks and return ``(anchor, lead)`` track dicts."""
    anchor_path = synth_track(tmp_path / "anchor.wav", bpm=100.0, root=261.63, duration=8.0)
    lead_path = synth_track(tmp_path / "lead.wav", bpm=120.0, root=220.0, duration=8.0)
    with anchor_path.open("rb") as f:
        anchor = service.ingest(f, "anchor.wav", source_kind="local")
    with lead_path.open("rb") as f:
        lead = service.ingest(f, "lead.wav", source_kind="local")
    return anchor, lead


def seed_failed_render(service: StudioService, anchor: dict, lead: dict) -> str:
    """Create retryable immutable history without executing expensive work."""
    request = asdict(RenderOptions(
        anchor_id=anchor["id"], lead_id=lead["id"], duration=2.0,
    ))
    job_id = service._store.create(JobKind.RENDER, request, executor="audio")
    service._store.transition(
        job_id, JobStatus.RUNNING, stage="rendering", message="Rendering fixture",
    )
    service._store.transition(
        job_id, JobStatus.FAILED, stage="failed", message="Fixture render failed",
        error="Synthetic retry fixture",
    )
    return job_id


def create_fixture_app(
    data_dir: str | Path, *, seed: bool = True, bind_host: str = "127.0.0.1"
):
    """Create the real app against ``data_dir`` with network stubbed.

    When ``seed`` is true, two synthetic tracks are ingested so the library is
    populated for the browser journeys.
    """
    from twobecomeone.webapp import create_app

    patch_for_tests()
    app = create_app(data_dir, bind_host=bind_host)
    if seed:
        anchor, lead = seed_library(app.state.studio, Path(data_dir) / "_seed")
        seed_failed_render(app.state.studio, anchor, lead)
    return app


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="2become1 browser-test fixture server")
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8871)
    parser.add_argument("--no-seed", action="store_true", help="skip seeding two tracks")
    args = parser.parse_args(argv)

    import uvicorn
    from twobecomeone.webapp import _is_loopback_host

    if not _is_loopback_host(args.host):
        parser.error("the browser fixture server may bind only to loopback")

    app = create_fixture_app(
        args.data_dir, seed=not args.no_seed, bind_host=args.host,
    )
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

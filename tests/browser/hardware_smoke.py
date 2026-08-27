"""Phase 7B hardware smoke test (manual, bounded, temp data root only).

Verifies the claims mocks cannot prove, using a temporary data root so Richard's
real library is never touched:

1. A real ffmpeg render (plan -> preview -> full render) of two synthetic
   tracks, checking output duration and true peak < 0 dBFS.
2. A real Demucs separation, recording the actual selected device and any
   CUDA OOM fallback.

Run directly (not via pytest):  .venv/bin/python tests/browser/hardware_smoke.py
"""

from __future__ import annotations

import math
import struct
import sys
import tempfile
import wave
from pathlib import Path

from twobecomeone import assembler, separator
from twobecomeone.studio import RenderOptions, StudioService


def synth_track(path: Path, *, bpm: float, root: float, duration: float = 8.0) -> Path:
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


def main() -> int:
    results: list[tuple[str, str, str]] = []  # (item, status, detail)

    with tempfile.TemporaryDirectory(prefix="2become1-smoke-") as tmp:
        tmp_path = Path(tmp)
        service = StudioService(tmp_path / "data")
        try:
            # --- 1. Real render smoke ---
            anchor_path = synth_track(tmp_path / "anchor.wav", bpm=100.0, root=261.63, duration=8.0)
            lead_path = synth_track(tmp_path / "lead.wav", bpm=120.0, root=220.0, duration=8.0)
            with anchor_path.open("rb") as f:
                anchor = service.ingest(f, "anchor.wav", source_kind="local")
            with lead_path.open("rb") as f:
                lead = service.ingest(f, "lead.wav", source_kind="local")

            plan = service.plan_render(RenderOptions(anchor_id=anchor["id"], lead_id=lead["id"]))
            results.append((
                "render plan",
                "pass",
                f"output_bpm={plan['output_bpm']}, duration={plan['duration']['output']}s, "
                f"lead_ratio={plan['lead_tempo_ratio']}",
            ))

            job = service.submit_render(RenderOptions(
                anchor_id=anchor["id"], lead_id=lead["id"], duration=4.0, preview=False,
            ))
            completed = service.wait_for_job(job["id"], timeout=120)
            if completed["status"] != "complete":
                results.append(("full render", "fail", completed.get("error", "unknown")))
            else:
                result = completed["result"]
                duration = result.get("duration")
                peak = result.get("true_peak_db")
                ok = duration is not None and 3.5 <= duration <= 4.5 and peak is not None and peak < 0.0
                results.append((
                    "full render",
                    "pass" if ok else "fail",
                    f"duration={duration}s, true_peak={peak} dBFS",
                ))

            # --- 2. Real Demucs separation smoke ---
            preferred = separator._pick_demucs_device()
            try:
                import demucs.api  # noqa: F401
                demucs_available = True
            except Exception:
                demucs_available = False

            if not demucs_available:
                results.append(("demucs separation", "environment-blocked", "demucs not installed"))
            else:
                sep_job = service.submit_separation(anchor["id"], method="demucs")
                # First-run model acquisition is large on Richard's slow link;
                # never kill it at the old ten-minute default.
                sep_done = service.wait_for_job(sep_job["id"], timeout=3600)
                if sep_done["status"] != "complete":
                    results.append(("demucs separation", "fail", sep_done.get("error", "unknown")))
                else:
                    device = sep_done["result"].get("device")
                    detail = sep_done.get("progress_detail") or {}
                    oom = "GPU Memory Limit Reached" in detail.get("warning", "")
                    results.append((
                        "demucs separation",
                        "pass",
                        f"preferred={preferred}, device={device}, oom_fallback={oom}",
                    ))
        finally:
            service.close()
            # The production process intentionally caches its model, but this
            # one-shot verifier should return GPU memory before it exits.
            separator._release_cuda()

    for item, status, detail in results:
        print(f"{status.upper():20s} {item}: {detail}")
    failed = [r for r in results if r[1] == "fail"]
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

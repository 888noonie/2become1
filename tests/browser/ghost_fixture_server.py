"""Phase 9C browser fixture server.

Runs the real FastAPI app against a temporary data root, seeds a project with
two tracks and real Demucs-style vocals stems, and exposes a small helper that
prepares a Ghost asset for a human preview_layer. The browser harness drives
the real API and the real GhostScheduler against a real AudioContext.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import time
import wave
from pathlib import Path

import uvicorn

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
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(sr)
        output.writeframes(bytes(samples))
    return path


def make_vocals_stem(service: StudioService, track_id: str) -> None:
    """Register a completed Demucs-style vocals stem set for a track."""
    track_sha256 = service._track_content_hash(track_id)
    stem_dir = service.stem_dir / f"set-{track_sha256[:12]}"
    stem_dir.mkdir(parents=True, exist_ok=True)
    stem_file = stem_dir / "vocals.wav"
    if not stem_file.exists():
        # 32s to match the seeded tracks: the deck plays the vocals variant,
        # and the A7 ownership gate needs playing=true at the transport read.
        synth_track(stem_file, bpm=120, root=261.63, duration=32.0)
    rel = f"stems/set-{track_sha256[:12]}/vocals.wav"
    with service._connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO stem_sets ("
            " id, track_id, track_sha256, method, model_name, device, status, paths_json, created_at"
            ") VALUES (?, ?, ?, 'demucs', 'htdemucs', 'cpu', 'complete', ?, ?)",
            (f"set-{track_sha256[:12]}", track_id, track_sha256, json.dumps({"vocals": rel}), time.time()),
        )


def seed(data_dir: Path) -> dict:
    """Create a project with anchor+lead tracks and vocals stems."""
    service = StudioService(data_dir)
    try:
        # 32s tracks: long enough that Lead stays playing through the full
        # preview→decode→schedule flow (A7 ownership gate needs playing=true
        # at the transport read; a 4s track would end first).
        anchor_wav = synth_track(data_dir / "seed-anchor.wav", bpm=120, root=261.63, duration=32.0)
        lead_wav = synth_track(data_dir / "seed-lead.wav", bpm=140, root=220.0, duration=32.0)
        anchor = service.ingest(anchor_wav.open("rb"), "anchor.wav")
        lead = service.ingest(lead_wav.open("rb"), "lead.wav")
        make_vocals_stem(service, anchor["id"])
        make_vocals_stem(service, lead["id"])
        project = service.create_project("Ghost browser mix")
        service.update_project(
            project["id"],
            anchor_track_id=anchor["id"],
            lead_track_id=lead["id"],
            anchor_variant="vocals",
            lead_variant="vocals",
        )
        return {"project_id": project["id"], "anchor_id": anchor["id"], "lead_id": lead["id"]}
    finally:
        service.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--no-seed", action="store_true")
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    if not args.no_seed:
        seed(data_dir)

    from twobecomeone.webapp import create_app

    app = create_app(data_dir)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
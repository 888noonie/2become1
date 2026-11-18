#!/usr/bin/env python3
"""Seed a temporary Studio for the STEM PASSPORT demonstration.

Two library tracks:
  * Track A — an owner-supplied set imported through the real import path.
  * Track B — a synthetic Demucs set written in the shape the separator uses,
              so the demo can mix an imported set with a separated one.

Nothing here touches the production data directory. The generated audio is the
four-part fixture from ``stem_passport_fixture.py``; the two tracks use
different seeds so they are audibly different arrangements.

Usage:
  .venv/bin/python tests/browser/stem_passport_seed.py --data-dir <dir>
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from stem_passport_fixture import build, _write  # noqa: E402

ROLES = ("vocals", "drums", "bass", "other")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--work", default=None)
    parser.add_argument("--demucs", action="store_true",
                        help="produce track B's set with the real separator instead of a seeded one")
    args = parser.parse_args()
    data_dir = Path(args.data_dir)
    work = Path(args.work or (data_dir.parent / f"{data_dir.name}-fixture"))
    work.mkdir(parents=True, exist_ok=True)

    from twobecomeone.studio import StudioService

    service = StudioService(data_dir)
    try:
        # Track A: mix + four externally supplied stems.
        stems_a = build(seed=20261118)
        mix_a = work / "a" / "mix.wav"
        _write(mix_a, sum(stems_a.values()))
        for role in ROLES:
            _write(work / "a" / f"{role}.wav", stems_a[role])
        with mix_a.open("rb") as handle:
            track_a = service.ingest(handle, "owner-arrangement-a.wav", source_kind="local")

        entries = []
        for role in ROLES:
            with (work / "a" / f"{role}.wav").open("rb") as handle:
                key = service.stage_upload(handle, f"{role}.wav")
            entries.append({"role": role, "staging_key": key, "original_name": f"{role}.wav"})
        imported = service.import_stem_set(track_a["id"], entries)

        # Track B: mix + a Demucs-shaped set written by the seed, not by a job.
        stems_b = build(seed=20261119)
        mix_b = work / "b" / "mix.wav"
        _write(mix_b, sum(stems_b.values()))
        with mix_b.open("rb") as handle:
            track_b = service.ingest(handle, "owner-arrangement-b.wav", source_kind="local")

        if args.demucs:
            job = service.submit_separation(track_b["id"], method="demucs")
            deadline = time.time() + 900
            while time.time() < deadline:
                state = service.get_job(job["id"])
                if state["status"] in {"complete", "failed", "cancelled"}:
                    break
                time.sleep(2)
            if state["status"] != "complete":
                raise SystemExit(f"real separation did not complete: {state['status']}")
            listing = service.list_stems(track_b["id"])
            real = [v for v in listing["variants"] if v.get("method") == "demucs"]
            print(json.dumps({
                "dataDir": str(data_dir),
                "trackA": track_a["id"], "setA": imported["stem_set_id"],
                "trackB": track_b["id"], "setB": real[0]["stem_set_id"] if real else None,
                "fixture": str(work), "demucs": True,
            }))
            return

        set_id = "demucsseed" + track_b["id"][:12]
        set_dir = service.stem_dir / set_id
        for role in ROLES:
            _write(set_dir / f"{role}.wav", stems_b[role] * 0.9)
        paths = {role: f"stems/{set_id}/{role}.wav" for role in ROLES}
        with sqlite3.connect(service.data_dir / "studio.sqlite3") as conn:
            conn.execute(
                "INSERT INTO stem_sets (id, track_id, method, model, device, status,"
                " paths_json, track_sha256, model_name, created_at)"
                " VALUES (?, ?, 'demucs', 'htdemucs@4.1.0', 'cpu', 'complete', ?, ?, 'htdemucs@4.1.0', ?)",
                (set_id, track_b["id"], json.dumps(paths),
                 service._track_content_hash(track_b["id"]), time.time()),
            )

        # Track C: a library track with no stems, for the UI import journey.
        stems_c = build(seed=20261120)
        mix_c = work / "c" / "mix.wav"
        _write(mix_c, sum(stems_c.values()))
        with mix_c.open("rb") as handle:
            track_c = service.ingest(handle, "owner-arrangement-c.wav", source_kind="local")
        for role in ROLES:
            _write(work / "c" / f"{role}.wav", stems_c[role])

        print(json.dumps({
            "dataDir": str(data_dir),
            "trackA": track_a["id"], "setA": imported["stem_set_id"],
            "trackB": track_b["id"], "setB": set_id,
            "trackC": track_c["id"], "fixture": str(work),
        }))
    finally:
        service.close()


if __name__ == "__main__":
    main()

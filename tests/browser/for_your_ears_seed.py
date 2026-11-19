#!/usr/bin/env python3
"""Seed a temporary Studio for OPERATION FOR YOUR EARS ONLY.

Both library tracks are created through the real HTTP routes, not by writing
rows: ``POST /api/tracks`` for the full mix, ``PATCH /api/tracks/{id}`` for the
meaningful label, then ``POST /api/stems/stage`` and
``POST /api/tracks/{id}/stem-import`` for the four already-separated parts.

The upload route normally queues an automatic separation. That hook is disabled
for this seed on purpose: the four parts already exist, so starting Demucs would
be unnecessary reprocessing (and would race the imported set the desk shows).

Nothing here touches the production data directory.

Usage:
  .venv/bin/python tests/browser/for_your_ears_seed.py \
      --data-dir /var/tmp/for-your-ears/demo \
      --fixture /var/tmp/for-your-ears/fixture
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

TRACKS = {
    "midnight-circuit": "Midnight Circuit",
    "paper-lanterns": "Paper Lanterns",
}
ROLES = ("vocals", "drums", "bass", "other")


async def seed(data_dir: Path, fixture: Path) -> dict:
    import httpx
    from twobecomeone.webapp import create_app

    manifest = json.loads((fixture / "manifest.json").read_text())
    app = create_app(data_dir)
    service = app.state.studio
    # The parts are supplied; do not start a separation job for them.
    service._queue_auto_separation = lambda track_id: None  # type: ignore[method-assign]

    result = {"dataDir": str(data_dir), "fixture": str(fixture), "tracks": {}}
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost", timeout=600) as client:
        for slug, display_name in TRACKS.items():
            entry = manifest[slug]
            mix = Path(entry["files"]["mix"])
            with mix.open("rb") as handle:
                created = await client.post(
                    "/api/tracks",
                    files={"file": (f"{slug}.wav", handle, "audio/wav")},
                )
            created.raise_for_status()
            track = created.json()

            renamed = await client.patch(
                f"/api/tracks/{track['id']}", json={"display_name": display_name}
            )
            renamed.raise_for_status()
            track = renamed.json()

            entries = []
            for role in ROLES:
                path = Path(entry["files"][role])
                with path.open("rb") as handle:
                    staged = await client.post(
                        "/api/stems/stage",
                        files={"file": (f"{role}.wav", handle, "audio/wav")},
                    )
                staged.raise_for_status()
                entries.append({
                    "role": role,
                    "staging_key": staged.json()["staging_key"],
                    "original_name": f"{slug}-{role}.wav",
                })
            committed = await client.post(
                f"/api/tracks/{track['id']}/stem-import", json={"files": entries}
            )
            committed.raise_for_status()

            stems = (await client.get(f"/api/tracks/{track['id']}/stems")).json()
            lanes = [
                variant for variant in stems["variants"]
                if variant["name"] in ROLES
            ]
            result["tracks"][slug] = {
                "id": track["id"],
                "name": track["name"],
                "displayName": track.get("display_name"),
                "bpm": track.get("bpm"),
                "duration": track.get("duration"),
                "stemSetId": committed.json()["stem_set_id"],
                "setHash": committed.json()["set_hash"],
                "lanes": [
                    {
                        "name": lane["name"],
                        "method": lane["method"],
                        "originalName": lane.get("original_name"),
                    }
                    for lane in lanes
                ],
            }

        jobs = (await client.get("/api/jobs")).json()
        if isinstance(jobs, dict):
            jobs = jobs.get("items", jobs.get("jobs", []))
        result["jobs"] = jobs
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--fixture", required=True)
    args = parser.parse_args()
    result = asyncio.run(seed(Path(args.data_dir), Path(args.fixture)))
    print(json.dumps(result, indent=2))
    if result["jobs"]:
        raise SystemExit(f"unexpected separation jobs were queued: {result['jobs']}")


if __name__ == "__main__":
    main()

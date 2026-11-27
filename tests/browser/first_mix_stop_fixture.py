#!/usr/bin/env python3
"""Short two-bank musical stem fixture for OPERATION FIRST MIX Act II-C.

The Stop regression needs the same material as the accepted two-track desk
demonstration, but it must stay inside the ordinary per-stem decoded ceiling
(40 MiB) so a four-lane group loads without switching on the opt-in
full-length allowance.  The full FOR YOUR EARS arrangements are 180 s and
171 s, and one full stem already decodes past that ceiling.

This script therefore reuses the established synthesiser in
``for_your_ears_fixture.py`` unchanged and builds the same two arrangements
(Midnight Circuit in A minor at 96 BPM, Paper Lanterns in E minor at 84 BPM),
trimmed to eight bars.  The eight bars are chorus-forward (bars 0-5), then one
breakdown bar and one outro bar, so drums, bass, pad/other and lead all sound
from the first frame and the Stop regression measures a full four-lane mix.

The two banks are different songs at different tempos and keys, and every
stem is original synthesis, so there is no licensing question and no second
library or engine is involved.

Usage:
  .venv/bin/python tests/browser/first_mix_stop_fixture.py --out /tmp/opencode/first-mix-stop

The browser harness calls this automatically when no stems are supplied; the
``--out`` directory then receives ``manifest.json`` plus
``midnight-circuit/{vocals,drums,bass,other,mix}.wav`` and the same for
``paper-lanterns``.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from for_your_ears_fixture import ARRANGEMENTS, SR, build, write_wav  # noqa: E402

BARS = 8
# Chorus-forward so all four lanes sound from the first frame.  The Stop
# regression measures the first second, and a conventional intro would leave
# the vocal and "other" lanes silent exactly there.
SECTIONS = {
    "intro": (0, 0),
    "verse": (0, 0),
    "chorus": (0, 6),
    "breakdown": (6, 7),
    "outro": (7, 8),
}
ROLES = ("vocals", "drums", "bass", "other")


def build_all(out: Path) -> dict:
    manifest = {}
    for name, spec in ARRANGEMENTS.items():
        short = dict(spec)
        short["bars"] = BARS
        short["sections"] = dict(SECTIONS)
        built = build(**short)
        folder = out / name
        files = {role: str(write_wav(folder / f"{role}.wav", signal))
                 for role, signal in built["stems"].items()}
        files["mix"] = str(write_wav(folder / "mix.wav", built["mix"]))
        duration = len(built["mix"]) / SR
        manifest[name] = {
            "bpm": spec["bpm"],
            "bars": BARS,
            "duration_seconds": round(duration, 3),
            "source_arrangement": "for_your_ears_fixture.py",
            "files": files,
        }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    out = Path(args.out)
    manifest = build_all(out)
    for name, entry in manifest.items():
        print(f"{name}: {entry['duration_seconds']:.3f}s, {BARS} bars, {entry['bpm']} BPM")


if __name__ == "__main__":
    main()

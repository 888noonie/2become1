#!/usr/bin/env python3
"""Resume-capable fake downloader for testing .part integrity.

Writes a deterministic payload to a ``.part`` file in chunks. On each run it
appends to any existing ``.part`` file (simulating ``--continue``), so a second
invocation with the same ``--out`` continues from the existing bytes rather than
restarting. Emits 2BECOME1 progress markers to stdout.

Usage:
    fake_resumable.py --out PATH --total N --chunks N [--delay SEC]
"""

from __future__ import annotations

import argparse
import os
import sys
import time


MARKER = "2BECOME1"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--total", type=int, default=1000)
    ap.add_argument("--chunks", type=int, default=10)
    ap.add_argument("--delay", type=float, default=0.0)
    args = ap.parse_args()

    part = args.out + ".part"
    chunk_size = args.total // args.chunks

    # Resume from existing bytes.
    existing = os.path.getsize(part) if os.path.exists(part) else 0
    start_chunk = existing // chunk_size

    with open(part, "ab") as f:
        for i in range(start_chunk, args.chunks):
            downloaded = (i + 1) * chunk_size
            percent = downloaded * 100.0 / args.total
            print(
                f"{MARKER} downloaded={downloaded} total={args.total} "
                f"percent={percent:.1f} speed=1000 eta=1",
                flush=True,
            )
            f.write(b"a" * chunk_size)
            f.flush()
            os.fsync(f.fileno())
            if args.delay:
                time.sleep(args.delay)

    # Finalize: rename .part -> final.
    os.replace(part, args.out)
    print(f"{MARKER} done=1", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Fake downloader used to test the acquisition executor's deadlock resistance.

This script deliberately floods stderr with megabytes of garbage while
occasionally printing valid 2BECOME1 progress markers to stdout. A correct
executor must drain both pipes concurrently; a naive implementation that reads
stdout to completion before touching stderr will deadlock once stderr's pipe
buffer fills.

Usage:
    fake_downloader.py [--total N] [--chunks N] [--stderr-mb N] [--out PATH]

It writes a deterministic payload to --out (default: ./fake_download.bin) in
chunks, emitting a progress marker after each chunk, and interleaves large
stderr writes to simulate a noisy subprocess.
"""

from __future__ import annotations

import argparse
import sys
import time


MARKER = "2BECOME1"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--total", type=int, default=1000)
    ap.add_argument("--chunks", type=int, default=10)
    ap.add_argument("--stderr-mb", type=int, default=8)
    ap.add_argument("--out", default="fake_download.bin")
    ap.add_argument("--delay", type=float, default=0.0)
    args = ap.parse_args()

    chunk_size = args.total // args.chunks
    garbage = b"x" * (1024 * 1024)  # 1 MB of stderr noise per write

    with open(args.out, "wb") as f:
        for i in range(args.chunks):
            # Emit a valid progress marker to stdout.
            downloaded = (i + 1) * chunk_size
            percent = downloaded * 100.0 / args.total
            print(
                f"{MARKER} downloaded={downloaded} total={args.total} "
                f"percent={percent:.1f} speed=1000 eta=1",
                flush=True,
            )
            # Write a chunk of the payload.
            f.write(b"a" * chunk_size)
            # Flood stderr with garbage (several MB) to fill the pipe buffer.
            for _ in range(args.stderr_mb):
                sys.stderr.write(garbage.decode("ascii", "replace"))
            sys.stderr.flush()
            if args.delay:
                time.sleep(args.delay)

    print(f"{MARKER} done=1", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

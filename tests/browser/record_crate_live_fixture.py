"""Add partial and unseparated tracks to a disposable copy of the hearing Library."""
import argparse
from pathlib import Path

from tests.test_crate import _add_stem_set, _ingest, synth_track
from twobecomeone.studio import StudioService


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("data_dir", type=Path)
    args = parser.parse_args()
    root = args.data_dir.resolve()
    if "record-crate-stage1" not in root.parts or not (root / "studio.sqlite3").is_file():
        parser.error("pass a disposable hearing Library copy inside record-crate-stage1")
    service = StudioService(root)
    try:
        partial = _ingest(
            service, synth_track(service.temp_dir / "Crate Stage Partial.wav", root=349.23)
        )
        _add_stem_set(service, partial, "demucs", ["vocals", "bass"])
        _ingest(service, synth_track(service.temp_dir / "Crate Stage Unseparated.wav", root=293.66))
    finally:
        service.close()


if __name__ == "__main__":
    main()

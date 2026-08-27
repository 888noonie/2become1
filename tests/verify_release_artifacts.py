"""Verify built V0.3 archives contain no private or generated material."""

from __future__ import annotations

import tarfile
import zipfile
from pathlib import Path

from twobecomeone import __version__

ROOT = Path(__file__).parent.parent
DIST = ROOT / "dist"
FORBIDDEN = (
    "Sol to Sol",
    "CODEX.md",
    "IMPLEMENTATION_PLAN",
    "RELEASE_EVIDENCE",
    "GHOST_ARCHITECTURE",
    "node_modules/",
    "browser/artifacts/",
    ".git/",
)


def _assert_clean(names: list[str], *, archive: str) -> None:
    leaked = sorted(name for name in names if any(item in name for item in FORBIDDEN))
    if leaked:
        raise AssertionError(f"{archive} contains forbidden files: {leaked}")


def main() -> int:
    wheel = DIST / f"2become1-{__version__}-py3-none-any.whl"
    sdist = DIST / f"2become1-{__version__}.tar.gz"
    if not wheel.is_file() or not sdist.is_file():
        raise AssertionError(f"missing {__version__} wheel or source distribution")

    with zipfile.ZipFile(wheel) as archive:
        wheel_names = archive.namelist()
        _assert_clean(wheel_names, archive=wheel.name)
        metadata_name = next(name for name in wheel_names if name.endswith("METADATA"))
        metadata = archive.read(metadata_name).decode("utf-8")
        assert f"Version: {__version__}" in metadata
        assert any(name.endswith("studio_static/index.html") for name in wheel_names)

    with tarfile.open(sdist, "r:gz") as archive:
        sdist_names = archive.getnames()
        _assert_clean(sdist_names, archive=sdist.name)
        prefix = f"2become1-{__version__}/"
        for required in ("README.md", "CHANGELOG.md", "LICENSE", "pyproject.toml"):
            assert prefix + required in sdist_names, f"sdist missing {required}"
        assert any(name.startswith(prefix + "src/twobecomeone/") for name in sdist_names)

    print(f"verified clean release archives for {__version__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

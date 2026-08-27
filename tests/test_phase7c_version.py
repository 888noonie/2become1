"""Phase 7C release-candidate: version metadata agreement.

The package version is declared in two places — ``pyproject.toml`` and
``twobecomeone.__version__`` — and must agree. This regression pins that
contract so a future bump in one place cannot silently drift from the other.
"""

from __future__ import annotations

import tomllib
import json
from pathlib import Path

from twobecomeone import __version__

ROOT = Path(__file__).parent.parent


def test_package_version_is_030():
    assert __version__ == "0.3.0"


def test_pyproject_version_matches_package():
    data = tomllib.loads((ROOT / "pyproject.toml").read_text())
    assert data["project"]["version"] == __version__


def test_frontend_and_changelog_versions_match_package():
    package = json.loads((ROOT / "package.json").read_text())
    lock = json.loads((ROOT / "package-lock.json").read_text())
    changelog = (ROOT / "CHANGELOG.md").read_text()

    assert package["version"] == __version__
    assert lock["version"] == __version__
    assert lock["packages"][""]["version"] == __version__
    assert f"## [{__version__}]" in changelog


def test_uv_lock_version_and_declared_dev_dependency_match_package():
    lock = tomllib.loads((ROOT / "uv.lock").read_text())
    project = next(package for package in lock["package"] if package["name"] == "2become1")

    assert project["version"] == __version__
    assert {dependency["name"] for dependency in project["optional-dependencies"]["dev"]} == {
        "httpx",
        "pytest",
    }


def test_sdist_uses_public_source_allowlist():
    data = tomllib.loads((ROOT / "pyproject.toml").read_text())
    included = set(data["tool"]["hatch"]["build"]["targets"]["sdist"]["include"])

    assert included == {
        "/src",
        "/tests",
        "/README.md",
        "/CHANGELOG.md",
        "/LICENSE",
        "/pyproject.toml",
    }
    assert "/Sol to Sol.txt" not in included


def test_cli_reports_package_version():
    from twobecomeone.cli import main

    # The --version flag must report the same version string.
    import contextlib
    import io

    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        try:
            main(["--version"])
        except SystemExit:
            pass
    assert __version__ in buf.getvalue()

"""Shared exceptions and utilities for 2become1."""

from __future__ import annotations

import sys


class UserError(Exception):
    """An error that should be reported to the user without a traceback."""
    pass


def log(message: str) -> None:
    """Emit a diagnostic line to stderr."""
    print(message, file=sys.stderr)


def nice_size(num: int | float) -> str:
    """Format bytes as human-readable."""
    for unit in ("B", "KB", "MB", "GB"):
        if abs(num) < 1024.0:
            return f"{num:.1f} {unit}"
        num /= 1024.0
    return f"{num:.1f} TB"

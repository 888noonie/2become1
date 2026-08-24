"""Shared exceptions and utilities for 2become1."""

from __future__ import annotations

import sys


class UserError(Exception):
    """An error that should be reported to the user without a traceback."""
    pass


def log(message: str) -> None:
    """Emit a diagnostic line to stderr."""
    print(message, file=sys.stderr)

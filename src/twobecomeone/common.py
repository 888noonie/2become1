"""Shared exceptions and utilities for 2become1."""

from __future__ import annotations

import sys


class UserError(Exception):
    """An error that should be reported to the user without a traceback.

    Subclasses carry an HTTP status and a stable machine-readable ``code`` so
    the web layer can emit the single error envelope
    ``{"error": {"code", "message", "detail"}}`` with the correct status.
    """

    status = 400
    code = "bad_request"

    def __init__(self, message: str, *, detail: str | None = None):
        super().__init__(message)
        self.message = message
        self.detail = detail


class NotFoundError(UserError):
    """A referenced resource does not exist (HTTP 404)."""

    status = 404
    code = "not_found"


class ConflictError(UserError):
    """The request conflicts with current state (HTTP 409)."""

    status = 409
    code = "conflict"


class ValidationError(UserError):
    """The request is well-formed but semantically invalid (HTTP 422)."""

    status = 422
    code = "validation_error"


class PayloadTooLargeError(UserError):
    """The upload exceeds the configured ceiling (HTTP 413)."""

    status = 413
    code = "payload_too_large"


class CapabilityError(UserError):
    """A required capability (e.g. Demucs) is unavailable (HTTP 503)."""

    status = 503
    code = "capability_unavailable"


def log(message: str) -> None:
    """Emit a diagnostic line to stderr."""
    print(message, file=sys.stderr)

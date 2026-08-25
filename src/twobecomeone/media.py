"""Managed media: hashing, deduplication, metadata sanitization, waveforms.

Phase 2.5/2.6. This module owns the safe handling of untrusted media and
metadata:

- content SHA-256 hashing for deduplication;
- metadata sanitization (whitelisted fields, Unicode normalization, control/
  bidi-character stripping, length limits);
- versioned waveform peak generation (target 1,200 bins);
- managed-path validation so no file outside a managed root is ever served,
  trashed, or purged.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import unicodedata
from pathlib import Path

import numpy as np

from . import analyzer
from .common import UserError

# Waveform payload version and target bin count.
WAVEFORM_VERSION = 1
WAVEFORM_BINS = 1200

# Metadata fields the product actually needs. Everything else is dropped.
ALLOWED_METADATA_FIELDS = {
    "video_id",
    "title",
    "uploader",
    "channel",
    "duration",
    "webpage_url",
    "thumbnail",
    "extractor",
}

# Strict length limits for stored text (characters).
MAX_TITLE_LEN = 300
MAX_UPLOADER_LEN = 200
MAX_URL_LEN = 2048
MAX_EXTRACTOR_LEN = 64

# Control characters (including NUL) and bidi-control characters to strip.
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]")
_WHITESPACE_RE = re.compile(r"\s+")


def sha256_file(path: str | Path, chunk_size: int = 1024 * 1024) -> str:
    """Return the hex SHA-256 of a file's contents."""
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def sanitize_text(value: str, max_len: int) -> str:
    """Normalize and sanitize untrusted text.

    - normalize Unicode (NFC);
    - strip NUL, control, and bidi-control characters;
    - collapse pathological whitespace;
    - enforce a strict length limit.
    """
    if not isinstance(value, str):
        return ""
    value = unicodedata.normalize("NFC", value)
    value = _CONTROL_RE.sub("", value)
    value = _WHITESPACE_RE.sub(" ", value).strip()
    return value[:max_len]


def sanitize_metadata(raw: dict) -> dict:
    """Whitelist and sanitize yt-dlp metadata into a safe, JSON-serializable dict.

    Only fields in ``ALLOWED_METADATA_FIELDS`` are kept. Text fields are
    sanitized; ``duration`` is coerced to a finite non-negative float or None.
    No descriptions, comments, cookies, or arbitrary nested objects survive.
    """
    clean: dict = {}
    for field in ALLOWED_METADATA_FIELDS:
        if field not in raw:
            continue
        value = raw[field]
        if field in {"title", "uploader", "channel", "extractor"}:
            limit = {
                "title": MAX_TITLE_LEN,
                "uploader": MAX_UPLOADER_LEN,
                "channel": MAX_UPLOADER_LEN,
                "extractor": MAX_EXTRACTOR_LEN,
            }[field]
            clean[field] = sanitize_text(str(value), limit)
        elif field in {"webpage_url", "thumbnail"}:
            clean[field] = sanitize_text(str(value), MAX_URL_LEN)
        elif field == "video_id":
            clean[field] = sanitize_text(str(value), 64)
        elif field == "duration":
            try:
                duration = float(value)
            except (TypeError, ValueError):
                duration = None
            if duration is not None and (not math.isfinite(duration) or duration < 0):
                duration = None
            clean[field] = duration
    return clean


def metadata_json(raw: dict) -> str:
    """Serialize sanitized metadata to a JSON string."""
    return json.dumps(sanitize_metadata(raw), ensure_ascii=False)


def generate_waveform(path: str | Path, bins: int = WAVEFORM_BINS) -> dict:
    """Generate normalized min/max waveform peaks for an audio file.

    Returns a versioned payload: ``{"version": 1, "bins": N, "peaks": [[min,max],...]}``.
    """
    audio = analyzer.decode_mono(path)
    if len(audio) == 0:
        raise UserError("cannot generate waveform from empty audio")
    n = len(audio)
    peaks: list[list[float]] = []
    for i in range(bins):
        start = int(i * n / bins)
        end = int((i + 1) * n / bins)
        if end <= start:
            end = start + 1
        segment = audio[start:end]
        if len(segment) == 0:
            peaks.append([0.0, 0.0])
            continue
        lo = float(np.min(segment))
        hi = float(np.max(segment))
        peaks.append([round(lo, 6), round(hi, 6)])
    return {"version": WAVEFORM_VERSION, "bins": bins, "peaks": peaks}


def validate_managed_path(path: str | Path, root: str | Path) -> Path:
    """Resolve ``path`` and require it to live beneath ``root``.

    Rejects path traversal, symlinks escaping the root, and non-existent files.
    """
    root_resolved = Path(root).resolve()
    candidate = Path(path)
    try:
        resolved = candidate.resolve(strict=True)
    except (OSError, RuntimeError):
        raise UserError(f"path is unavailable: {path}")
    if root_resolved not in resolved.parents and resolved != root_resolved:
        raise UserError(f"path escapes the managed root: {path}")
    return resolved

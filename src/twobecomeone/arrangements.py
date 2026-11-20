"""Saved Studio arrangements (OPERATION FULL HOUSE).

An arrangement is the Studio editor's ProjectState: plain JSON with asset
*references* (stem audio URLs) and clip/mixer metadata. Decoded audio never
enters it. This store only keeps that document on disk so a musician can close
the Studio and reopen the same arrangement.

The browser's ProjectState validator is the authority on musical content. The
server checks only what it must not trust a client for: the identifier, the
document size, that it is a JSON object with the supported ``schemaVersion``,
and that every asset reference points at this Studio's own stem or track
media routes (never a filesystem path or another host).
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import time
from pathlib import Path

from .common import ConflictError, NotFoundError, PayloadTooLargeError, ValidationError

SCHEMA_VERSION = 1
MAX_BYTES = 1024 * 1024  # the request guard caps JSON bodies at 1 MiB too
MAX_SAVED = 200
_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
_REFERENCE = re.compile(
    r"^/api/(stems/[A-Za-z0-9_-]{1,80}/audio\?[A-Za-z0-9_=&.%-]{1,200}"
    r"|tracks/[A-Za-z0-9_-]{1,80}/audio)$"
)


def _check_id(arrangement_id: str) -> str:
    if not isinstance(arrangement_id, str) or not _ID.match(arrangement_id):
        raise ValidationError(
            "arrangement id must be 1-63 lowercase letters, digits or dashes",
            code="ARRANGEMENT_ID_INVALID")
    return arrangement_id


def _check_document(document: object) -> dict:
    if not isinstance(document, dict):
        raise ValidationError("an arrangement must be a JSON object", code="ARRANGEMENT_INVALID")
    if document.get("schemaVersion") != SCHEMA_VERSION:
        raise ValidationError(
            f"arrangement schemaVersion must be {SCHEMA_VERSION}",
            code="ARRANGEMENT_SCHEMA_UNSUPPORTED")
    assets = document.get("assets")
    if not isinstance(assets, dict) or not isinstance(document.get("clips"), list):
        raise ValidationError("an arrangement needs assets and clips", code="ARRANGEMENT_INVALID")
    for key, asset in assets.items():
        reference = asset.get("bufferReference") if isinstance(asset, dict) else None
        if not isinstance(reference, str) or not _REFERENCE.match(reference):
            raise ValidationError(
                f"asset {key!s:.40} must reference this Studio's stem or track audio",
                code="ARRANGEMENT_REFERENCE_INVALID")
    return document


class ArrangementStore:
    """JSON documents under ``<data_dir>/arrangements``; atomic replace on save."""

    def __init__(self, data_dir: str | Path):
        self.root = Path(data_dir) / "arrangements"
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, arrangement_id: str) -> Path:
        return self.root / f"{_check_id(arrangement_id)}.json"

    def list(self) -> dict:
        items = []
        for path in sorted(self.root.glob("*.json")):
            try:
                envelope = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            project = envelope.get("project") or {}
            items.append({
                "id": path.stem,
                "name": envelope.get("name") or path.stem,
                "savedAt": envelope.get("savedAt"),
                "clipCount": len(project.get("clips") or []),
            })
        items.sort(key=lambda item: item.get("savedAt") or 0, reverse=True)
        return {"items": items}

    def get(self, arrangement_id: str) -> dict:
        path = self._path(arrangement_id)
        if not path.exists():
            raise NotFoundError("no saved arrangement with that id", code="ARRANGEMENT_NOT_FOUND")
        return json.loads(path.read_text(encoding="utf-8"))

    def save(self, arrangement_id: str, name: object, project: object) -> dict:
        path = self._path(arrangement_id)
        document = _check_document(project)
        label = name if isinstance(name, str) and name.strip() else arrangement_id
        if len(label) > 120:
            raise ValidationError("arrangement name must be at most 120 characters", code="ARRANGEMENT_NAME_INVALID")
        if not path.exists() and len(list(self.root.glob("*.json"))) >= MAX_SAVED:
            raise ConflictError(f"at most {MAX_SAVED} saved arrangements", code="ARRANGEMENT_LIMIT")
        envelope = {"id": arrangement_id, "name": label.strip(), "savedAt": time.time(), "project": document}
        text = json.dumps(envelope, separators=(",", ":"), sort_keys=True)
        if len(text.encode("utf-8")) > MAX_BYTES:
            raise PayloadTooLargeError("arrangement is larger than 1 MiB", code="ARRANGEMENT_TOO_LARGE")
        fd, temp = tempfile.mkstemp(dir=self.root, prefix=".save-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp, path)
        except BaseException:
            Path(temp).unlink(missing_ok=True)
            raise
        return {"id": arrangement_id, "name": envelope["name"], "savedAt": envelope["savedAt"]}

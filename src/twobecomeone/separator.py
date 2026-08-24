"""Stem separation for 2become1.

Two strategies:
  1. Demucs (best quality, optional dependency) — 4 stems: vocals/drums/bass/other
  2. ffmpeg phase-cancellation fallback — separates center-panned content from
     side content. This is NOT a real vocal/instrumental split; outputs are
     labeled honestly as "center" and "sides".
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

from .common import UserError, log

_STEM_NAMES = ["vocals", "drums", "bass", "other"]

# Module-level cache so the Demucs model is loaded only once per process.
_demucs_separator: object | None = None
_demucs_device: str | None = None


def _pick_demucs_device() -> str:
    """Choose cuda if torch reports it available, otherwise cpu."""
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


def _demucs_separator_instance(device: str | None = None) -> object:
    global _demucs_separator, _demucs_device
    import demucs.api
    requested = device or _pick_demucs_device()
    if _demucs_separator is not None and _demucs_device == requested:
        return _demucs_separator
    log(f"Loading Demucs model on {requested} ...")
    try:
        _demucs_separator = demucs.api.Separator(device=requested)
        _demucs_device = requested
    except RuntimeError as exc:
        if requested == "cuda" and "out of memory" in str(exc).lower():
            log("CUDA OOM loading Demucs; falling back to CPU")
            _demucs_separator = demucs.api.Separator(device="cpu")
            _demucs_device = "cpu"
        else:
            raise
    return _demucs_separator


def demucs_device() -> str | None:
    """Return the currently cached Demucs device, or None if not loaded."""
    return _demucs_device


def _ffmpeg_fallback(path: str, out_dir: Path) -> dict[str, Path]:
    """Honest center/side split. Not labeled as vocals/instrumental."""
    out_dir.mkdir(parents=True, exist_ok=True)
    center = out_dir / "center.wav"
    sides = out_dir / "sides.wav"
    cmd_center = [
        "ffmpeg", "-y", "-v", "error", "-i", str(path),
        "-af", "pan=mono|c0=c0+c1",
        "-ar", "44100", "-ac", "1", str(center),
    ]
    cmd_sides = [
        "ffmpeg", "-y", "-v", "error", "-i", str(path),
        "-af", "pan=mono|c0=c0-c1",
        "-ar", "44100", "-ac", "1", str(sides),
    ]
    for cmd in (cmd_center, cmd_sides):
        proc = subprocess.run(cmd, capture_output=True)
        if proc.returncode != 0:
            raise UserError(f"ffmpeg separation failed: {proc.stderr.decode()[:400]}")
    return {"center": center, "sides": sides}


def separate(path: str, out_dir: str | Path, method: str = "auto") -> dict[str, Path]:
    """Separate `path` into stems under `out_dir`.

    `method`: "demucs", "ffmpeg", or "auto" (prefer demucs if importable).
    Returns dict mapping stem name to file path.
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if method == "auto":
        try:
            import demucs.api  # noqa: F401
            method = "demucs"
        except Exception:
            method = "ffmpeg"

    if method == "ffmpeg":
        return _ffmpeg_fallback(path, out_dir)

    if method == "demucs":
        try:
            sep = _demucs_separator_instance()
        except Exception as exc:
            log(f"Demucs failed to load ({exc}); falling back to ffmpeg center/side split")
            return _ffmpeg_fallback(path, out_dir)

        try:
            origin, separated = sep.separate_audio_file(path)
        except RuntimeError as exc:
            if "out of memory" in str(exc).lower() and demucs_device() == "cuda":
                log("CUDA OOM during separation; clearing cache and falling back to CPU")
                import torch
                torch.cuda.empty_cache()
                sep = _demucs_separator_instance("cpu")
                origin, separated = sep.separate_audio_file(path)
            else:
                raise

        result: dict[str, Path] = {}
        for stem in _STEM_NAMES:
            out_path = out_dir / f"{stem}.wav"
            import demucs.api
            demucs.api.save_audio(separated[stem], out_path, samplerate=sep.samplerate)
            result[stem] = out_path
        return result

    raise ValueError(f"unknown separation method: {method}")

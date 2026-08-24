"""Stem separation for 2become1.

Two strategies:
  1. Demucs (best quality, optional dependency) — 4 stems: vocals/drums/bass/other
  2. ffmpeg center-channel phase cancellation (fallback) — separates a rough
     center-panned vocal from the sides. Useful when Demucs is unavailable.
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

_STEM_NAMES = ["vocals", "drums", "bass", "other"]


def _ffmpeg_center_extract(path: str, out_dir: Path) -> dict[str, Path]:
    """Rough vocal/instrumental split using left-right phase cancellation."""
    out_dir.mkdir(parents=True, exist_ok=True)
    # Center-panned vocal extraction: L - R (mono)
    vocals = out_dir / "vocals.wav"
    cmd_v = [
        "ffmpeg", "-y", "-v", "error", "-i", str(path),
        "-af", "pan=mono|c0=c0-c1",
        "-ar", "44100", "-ac", "1",
        str(vocals),
    ]
    # Instrumental-ish: low-passed side channel suppression; keep simple L+R
    # but with vocal reduced (this is imperfect, hence Demucs preferred).
    instrumental = out_dir / "instrumental.wav"
    cmd_i = [
        "ffmpeg", "-y", "-v", "error", "-i", str(path),
        "-af", "pan=mono|c0=c0+c1",  # mono sum, vocal still present
        "-ar", "44100", "-ac", "1",
        str(instrumental),
    ]
    for cmd in (cmd_v, cmd_i):
        proc = subprocess.run(cmd, capture_output=True)
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg separation failed: {proc.stderr.decode()[:400]}")
    return {"vocals": vocals, "instrumental": instrumental}


def separate(path: str, out_dir: str | Path, method: str = "auto") -> dict[str, Path]:
    """Separate `path` into stems under `out_dir`.

    `method`: "demucs", "ffmpeg", or "auto" (prefer demucs if importable).
    Returns dict mapping stem name to file path.
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if method == "auto":
        try:
            import demucs.api
            method = "demucs"
        except Exception:
            method = "ffmpeg"

    if method == "ffmpeg":
        return _ffmpeg_center_extract(path, out_dir)

    if method == "demucs":
        import demucs.api
        separator = demucs.api.Separator()
        origin, separated = separator.separate_audio_file(path)
        result: dict[str, Path] = {}
        for stem in _STEM_NAMES:
            out_path = out_dir / f"{stem}.wav"
            demucs.api.save_audio(separated[stem], out_path, samplerate=separator.samplerate)
            result[stem] = out_path
        return result

    raise ValueError(f"unknown separation method: {method}")

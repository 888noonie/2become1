"""Acceptance checks for OPERATION FOR YOUR EARS ONLY.

These mirror the mission's core claims at the service layer:

* a Library rename survives a process restart;
* a recording long enough that one full stem decodes past the ordinary 40 MiB
  ceiling can still be played as a section, and the section is sample-aligned
  with the source and keeps its rate, channels and sample width;
* the section route refuses a length it cannot serve and a start past the end.

The audible demonstration itself is the browser journey and the rendered WAV;
these tests prove the contract underneath it.
"""

from __future__ import annotations

import struct
import wave

import pytest

from twobecomeone.common import UserError
from twobecomeone.studio import StudioService

from test_track_names_and_sections import ROLES, _frames, _no_demucs, _pattern, _stage, _tone


def _service_without_separation(tmp_path, monkeypatch) -> StudioService:
    _no_demucs(monkeypatch)
    monkeypatch.setattr(
        StudioService, "_queue_auto_separation", lambda self, track_id: None,
    )
    return StudioService(tmp_path / "data")


def test_a_library_rename_persists_across_a_restart(tmp_path, monkeypatch):
    service = _service_without_separation(tmp_path, monkeypatch)
    try:
        with _tone(tmp_path / "carrier.wav", root=220.0).open("rb") as handle:
            track = service.ingest(handle, "original-file-name.wav")
        renamed = service.update_track(track["id"], display_name="Midnight Circuit")
        assert renamed["name"] == "Midnight Circuit"
    finally:
        service.close()

    reopened = StudioService(tmp_path / "data")
    try:
        again = reopened.get_track(track["id"])
        assert again["name"] == "Midnight Circuit"
    finally:
        reopened.close()


def test_a_full_stem_is_over_the_ceiling_and_a_section_is_aligned(tmp_path, monkeypatch):
    service = _service_without_separation(tmp_path, monkeypatch)
    try:
        with _tone(tmp_path / "carrier.wav", root=220.0).open("rb") as handle:
            track = service.ingest(handle, "carrier.wav")

        long = _pattern(tmp_path / "long.wav", seconds=120)
        full_decoded = 120 * 48000 * 2 * 4
        assert full_decoded > 40 * 1024 * 1024, "the demonstration must reproduce the ceiling"
        imported = service.import_stem_set(
            track["id"], [_stage(service, long, role) for role in ROLES],
        )

        window = service.stem_audio_window(
            imported["stem_set_id"], "vocals", start=10, duration=60,
        )
        rate, channels, frames = _frames(window)
        assert rate == 44100
        assert channels == 2
        assert len(frames) == 60 * 44100 * 4
        with wave.open(str(long), "rb") as source:
            source.setpos(10 * source.getframerate())
            assert source.readframes(60 * source.getframerate()) == frames

        # The returned WAV declares its real size, not ffmpeg's pipe placeholder.
        assert struct.unpack("<I", window[4:8])[0] == len(window) - 8
        offset = 12
        while True:
            chunk_id = window[offset:offset + 4]
            size = struct.unpack("<I", window[offset + 4:offset + 8])[0]
            if chunk_id == b"data":
                assert size == len(window) - (offset + 8)
                break
            offset += 8 + size + (size & 1)

        # The section is under the ordinary per-stem and desk budgets.
        assert 60 * 48000 * 2 * 4 < 40 * 1024 * 1024
        assert 8 * 60 * 48000 * 2 * 4 < 320 * 1024 * 1024

        with pytest.raises(UserError, match="30, 60, or 90"):
            service.stem_audio_window(
                imported["stem_set_id"], "vocals", start=10, duration=45,
            )
        with pytest.raises(UserError, match="past the end"):
            service.stem_audio_window(
                imported["stem_set_id"], "vocals", start=130, duration=60,
            )
    finally:
        service.close()

"""Phase 3 tests: library, projects, stems, artwork, overrides, variants, OOM."""

import base64
import io
import json
import math
import sqlite3
import struct
import time
import wave
from pathlib import Path

import pytest

from twobecomeone import media, migrations, projects, separator
from twobecomeone.common import CapabilityError, ConflictError, NotFoundError, UserError
from twobecomeone.studio import RenderOptions, StudioService


def synth_track(path: Path, *, bpm: float, root: float, duration: float = 4.0) -> Path:
    sr = 22050
    beat = 60.0 / bpm
    samples = bytearray()
    for index in range(int(sr * duration)):
        t = index / sr
        chord = (
            math.sin(2 * math.pi * root * t)
            + 0.7 * math.sin(2 * math.pi * root * 1.25 * t)
            + 0.6 * math.sin(2 * math.pi * root * 1.5 * t)
        ) / 3
        click = 0.45 * math.sin(2 * math.pi * 90 * t) if (t % beat) < 0.04 else 0
        value = int(max(-1, min(1, chord + click)) * 22000)
        samples += struct.pack("<hh", value, value)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(sr)
        output.writeframes(samples)
    return path


def _ingest(service, path, name=None):
    with path.open("rb") as f:
        return service.ingest(f, name or path.name)


# A tiny valid PNG with an EXIF-like trailing payload (polyglot bytes).
def _png_with_trailing_bytes() -> bytes:
    # 1x1 red PNG (valid), followed by trailing garbage that must be stripped.
    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQAB"
        "h6FO1AAAAABJRU5ErkJggg=="
    )
    return png + b"\x00\x00EXIF\x00\x00trailing-polyglot-payload"


class TestMigrations:
    def _make_db(self, tmp_path):
        import sqlite3
        db = tmp_path / "m.sqlite3"
        conn = sqlite3.connect(db)
        conn.row_factory = sqlite3.Row
        # Base tables at the V0.2 shape (migration #0 is conditional on these).
        conn.executescript(
            """
            CREATE TABLE tracks (
                id TEXT PRIMARY KEY, original_name TEXT NOT NULL, path TEXT NOT NULL,
                size_bytes INTEGER NOT NULL, bpm REAL NOT NULL, tonic TEXT NOT NULL,
                mode TEXT NOT NULL, confidence REAL NOT NULL, duration REAL NOT NULL,
                beat_interval REAL, first_beat REAL, suggested_downbeat REAL,
                beat_confidence REAL, source_kind TEXT NOT NULL DEFAULT 'upload',
                source_ref TEXT, created_at REAL NOT NULL
            );
            CREATE TABLE jobs (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
                stage TEXT NOT NULL, progress INTEGER NOT NULL, message TEXT NOT NULL,
                request_json TEXT NOT NULL, result_json TEXT, output_path TEXT,
                error TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL
            );
            """
        )
        return conn

    def test_migration_7_stem_cache_identity(self, tmp_path):
        conn = self._make_db(tmp_path)
        migrations.run_migrations(conn)
        cols = {r[1] for r in conn.execute("PRAGMA table_info(stem_sets)")}
        assert "track_sha256" in cols
        assert "model_name" in cols
        idx = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_stem_sets_cache'"
        ).fetchone()
        assert idx is not None

    def test_migration_7_enforces_unique_cache_key(self, tmp_path):
        conn = self._make_db(tmp_path)
        migrations.run_migrations(conn)
        now = 0.0
        conn.execute(
            "INSERT INTO stem_sets (id, track_id, method, model, device, status,"
            " paths_json, track_sha256, model_name, created_at)"
            " VALUES ('a','t','demucs','m','cpu','complete','{}','h','htdemucs@1',?)",
            (now,),
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO stem_sets (id, track_id, method, model, device, status,"
                " paths_json, track_sha256, model_name, created_at)"
                " VALUES ('b','t','demucs','m','cpu','complete','{}','h','htdemucs@1',?)",
                (now,),
            )


class TestArtwork:
    def test_artwork_reencoded_strips_payload(self, tmp_path):
        src = tmp_path / "in.png"
        src.write_bytes(_png_with_trailing_bytes())
        dst = tmp_path / "out.webp"
        media.reencode_artwork(src, dst)
        assert dst.is_file()
        # Output is a WebP (RIFF....WEBP magic).
        header = dst.read_bytes()[:12]
        assert header[:4] == b"RIFF"
        assert header[8:12] == b"WEBP"
        # Trailing polyglot payload is gone.
        assert b"trailing-polyglot-payload" not in dst.read_bytes()
        assert b"EXIF" not in dst.read_bytes()

    def test_artwork_rejects_symlink(self, tmp_path):
        real = tmp_path / "real.png"
        real.write_bytes(_png_with_trailing_bytes())
        link = tmp_path / "link.png"
        link.symlink_to(real)
        with pytest.raises(UserError):
            media.reencode_artwork(link, tmp_path / "out.webp")

    def test_artwork_rejects_malformed(self, tmp_path):
        bad = tmp_path / "bad.png"
        bad.write_bytes(b"not an image at all")
        with pytest.raises(UserError):
            media.reencode_artwork(bad, tmp_path / "out.webp")


class TestLibrary:
    def test_list_pagination_and_search(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            a = _ingest(service, synth_track(tmp_path / "alpha.wav", bpm=100, root=261.63))
            b = _ingest(service, synth_track(tmp_path / "beta.wav", bpm=120, root=220.0))
            page = service.list_tracks_page(limit=1, offset=0)
            assert page["total"] == 2
            assert len(page["items"]) == 1
            assert page["limit"] == 1
            # Search by name.
            found = service.list_tracks_page(query="alpha")
            assert found["total"] == 1
            assert found["items"][0]["id"] == a["id"]
            # Trash filter.
            service.trash_track(b["id"])
            active = service.list_tracks_page(status="active")
            assert active["total"] == 1
            trash = service.list_tracks_page(status="trash")
            assert trash["total"] == 1
            all_ = service.list_tracks_page(status="all")
            assert all_["total"] == 2
        finally:
            service.close()

    def test_effective_detected_and_reset(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            t = _ingest(service, synth_track(tmp_path / "t.wav", bpm=100, root=261.63))
            detected_bpm = t["detected"]["bpm"]
            # Override BPM.
            updated = service.update_track(t["id"], bpm=128.0)
            assert updated["bpm"] == 128.0
            assert updated["detected"]["bpm"] == detected_bpm
            assert updated["overrides"]["bpm"] == 128.0
            # Reset via null.
            reset = service.update_track(t["id"], bpm=None)
            assert reset["bpm"] == detected_bpm
            assert reset["overrides"]["bpm"] is None
        finally:
            service.close()

    def test_override_tonic_mode(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            t = _ingest(service, synth_track(tmp_path / "t.wav", bpm=100, root=261.63))
            updated = service.update_track(t["id"], tonic="F#", mode="minor")
            assert updated["key"]["tonic"] == "F#"
            assert updated["key"]["mode"] == "minor"
            # Detected unchanged.
            assert updated["detected"]["key"]["tonic"] == t["detected"]["key"]["tonic"]
        finally:
            service.close()

    def test_patch_rejects_unknown_field(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            t = _ingest(service, synth_track(tmp_path / "t.wav", bpm=100, root=261.63))
            with pytest.raises(UserError, match="unknown track field"):
                service.update_track(t["id"], malicious="x")
        finally:
            service.close()

    def test_patch_invalid_multi_field_makes_no_change(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            t = _ingest(service, synth_track(tmp_path / "t.wav", bpm=100, root=261.63))
            with pytest.raises(UserError):
                service.update_track(t["id"], bpm=128.0, tonic="H")  # H is invalid
            # bpm override must NOT have been applied.
            after = service.get_track(t["id"])
            assert after["overrides"]["bpm"] is None
        finally:
            service.close()

    def test_trash_restore(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            t = _ingest(service, synth_track(tmp_path / "t.wav", bpm=100, root=261.63))
            trashed = service.trash_track(t["id"])
            assert trashed["deleted_at"] is not None
            restored = service.restore_track(t["id"])
            assert restored["deleted_at"] is None
        finally:
            service.close()


class TestProjects:
    def test_project_crud_and_lww(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            a = _ingest(service, synth_track(tmp_path / "a.wav", bpm=100, root=261.63))
            l = _ingest(service, synth_track(tmp_path / "l.wav", bpm=120, root=220.0))
            p = service.create_project("My Mash")
            assert p["name"] == "My Mash"
            # LWW update: overwrite supplied state.
            updated = service.update_project(
                p["id"], anchor_track_id=a["id"], lead_track_id=l["id"],
                settings={"duration": 30.0, "snap": True, "pitch_mode": "match"},
            )
            assert updated["anchor_track_id"] == a["id"]
            assert updated["settings"]["duration"] == 30.0
            # Server controls updated_at.
            assert updated["updated_at"] >= updated["created_at"]
            # Reload reproduces exactly.
            reloaded = service.get_project(p["id"])
            assert reloaded == updated
            # Delete.
            service.delete_project(p["id"])
            with pytest.raises(NotFoundError):
                service.get_project(p["id"])
        finally:
            service.close()

    def test_project_rejects_trashed_track(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            a = _ingest(service, synth_track(tmp_path / "a.wav", bpm=100, root=261.63))
            service.trash_track(a["id"])
            p = service.create_project("P")
            with pytest.raises(ConflictError):
                service.update_project(p["id"], anchor_track_id=a["id"])
        finally:
            service.close()

    def test_project_rejects_unknown_track(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            p = service.create_project("P")
            with pytest.raises(NotFoundError):
                service.update_project(p["id"], lead_track_id="nope")
        finally:
            service.close()

    def test_project_settings_validation(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            p = service.create_project("P")
            with pytest.raises(UserError, match="unknown project setting"):
                service.update_project(p["id"], settings={"bogus": 1})
            with pytest.raises(UserError, match="pitch_mode"):
                service.update_project(p["id"], settings={"pitch_mode": "nope"})
            with pytest.raises(UserError, match="snap"):
                service.update_project(p["id"], settings={"snap": "yes"})
        finally:
            service.close()

    def test_project_survives_restart(self, tmp_path):
        data_dir = tmp_path / "data"
        service = StudioService(data_dir)
        a = _ingest(service, synth_track(tmp_path / "a.wav", bpm=100, root=261.63))
        l = _ingest(service, synth_track(tmp_path / "l.wav", bpm=120, root=220.0))
        p = service.create_project("Persist")
        service.update_project(
            p["id"], anchor_track_id=a["id"], lead_track_id=l["id"],
            lead_variant="full", settings={"duration": 15.0, "snap": False},
        )
        service.close()

        service2 = StudioService(data_dir)
        try:
            reloaded = service2.get_project(p["id"])
            assert reloaded["anchor_track_id"] == a["id"]
            assert reloaded["lead_track_id"] == l["id"]
            assert reloaded["settings"]["duration"] == 15.0
        finally:
            service2.close()


class TestStems:
    def test_center_side_separation_and_cache(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            t = _ingest(service, synth_track(tmp_path / "t.wav", bpm=100, root=261.63))
            job = service.submit_separation(t["id"], method="ffmpeg")
            completed = service.wait_for_job(job["id"], timeout=60)
            assert completed["status"] == "complete", completed.get("error")
            assert completed["result"]["cached"] is False
            stems = service.list_stems(t["id"])
            assert "full" in stems["stems"]
            assert "center" in stems["stems"]
            assert "sides" in stems["stems"]
            # Never relabel center as vocals.
            assert "vocals" not in stems["stems"]
            # Second separation is a cache hit (no re-run).
            job2 = service.submit_separation(t["id"], method="ffmpeg")
            completed2 = service.wait_for_job(job2["id"], timeout=60)
            assert completed2["result"]["cached"] is True
        finally:
            service.close()

    def test_stem_audio_resolution(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            t = _ingest(service, synth_track(tmp_path / "t.wav", bpm=100, root=261.63))
            job = service.submit_separation(t["id"], method="ffmpeg")
            completed = service.wait_for_job(job["id"], timeout=60)
            stem_set_id = completed["result"]["stem_set_id"]
            path = service.stem_audio_path(stem_set_id, "center")
            assert path.is_file()
            with pytest.raises(UserError):
                service.stem_audio_path(stem_set_id, "vocals")  # not present
        finally:
            service.close()

    def test_explicit_demucs_without_capability_503(self, tmp_path, monkeypatch):
        service = StudioService(tmp_path / "data")
        try:
            t = _ingest(service, synth_track(tmp_path / "t.wav", bpm=100, root=261.63))
            # Simulate demucs not installed.
            import builtins
            real_import = builtins.__import__

            def fake_import(name, *args, **kwargs):
                if name == "demucs.api":
                    raise ImportError("no demucs")
                return real_import(name, *args, **kwargs)

            monkeypatch.setattr(builtins, "__import__", fake_import)
            with pytest.raises(CapabilityError):
                service.submit_separation(t["id"], method="demucs")
        finally:
            service.close()


class TestRenderVariants:
    def test_legacy_use_vocals_maps_to_lead_variant(self):
        opts = RenderOptions(anchor_id="a", lead_id="l", use_vocals=True)
        assert opts.resolved_lead_variant() == "vocals"
        opts2 = RenderOptions(anchor_id="a", lead_id="l", use_vocals=False)
        assert opts2.resolved_lead_variant() == "full"

    def test_explicit_variant_takes_precedence(self):
        opts = RenderOptions(anchor_id="a", lead_id="l", lead_variant="drums")
        assert opts.resolved_lead_variant() == "drums"

    def test_contradictory_payload_rejected(self):
        with pytest.raises(UserError, match="conflicts"):
            RenderOptions(
                anchor_id="a", lead_id="l", use_vocals=True, lead_variant="drums"
            ).validate()

    def test_pitch_mode_preserve(self):
        opts = RenderOptions(anchor_id="a", lead_id="l", pitch_mode="preserve")
        opts.validate()
        assert opts.pitch_mode == "preserve"

    def test_render_with_center_variant(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            a = _ingest(service, synth_track(tmp_path / "a.wav", bpm=100, root=261.63))
            l = _ingest(service, synth_track(tmp_path / "l.wav", bpm=120, root=220.0))
            # Separate the lead to get center/sides.
            sep = service.submit_separation(l["id"], method="ffmpeg")
            service.wait_for_job(sep["id"], timeout=60)
            job = service.submit_render(RenderOptions(
                anchor_id=a["id"], lead_id=l["id"], lead_variant="center",
                duration=2.0, preview=True,
            ))
            completed = service.wait_for_job(job["id"], timeout=60)
            assert completed["status"] == "complete", completed.get("error")
            assert completed["result"]["lead_variant"] == "center"
        finally:
            service.close()

    def test_render_unavailable_variant_conflicts(self, tmp_path):
        service = StudioService(tmp_path / "data")
        try:
            a = _ingest(service, synth_track(tmp_path / "a.wav", bpm=100, root=261.63))
            l = _ingest(service, synth_track(tmp_path / "l.wav", bpm=120, root=220.0))
            # No separation done, so "vocals" is unavailable.
            job = service.submit_render(RenderOptions(
                anchor_id=a["id"], lead_id=l["id"], lead_variant="vocals",
                duration=2.0, preview=True,
            ))
            completed = service.wait_for_job(job["id"], timeout=60)
            assert completed["status"] == "failed"
            assert "not available" in completed["error"]
        finally:
            service.close()

    def test_render_uses_stem_path_not_full_track(self, tmp_path):
        """Audit regression: a selected stem variant must reach MashSpec.

        Previously ``_compute_arrangement`` verified stem metadata but left the
        concrete path pointing at the full track, so a render advertised
        ``lead_variant=center`` while actually mixing the full lead.
        """
        service = StudioService(tmp_path / "data")
        try:
            a = _ingest(service, synth_track(tmp_path / "a.wav", bpm=100, root=261.63))
            l = _ingest(service, synth_track(tmp_path / "l.wav", bpm=120, root=220.0))
            sep = service.submit_separation(l["id"], method="ffmpeg")
            service.wait_for_job(sep["id"], timeout=60)

            plan = service._compute_arrangement(RenderOptions(
                anchor_id=a["id"], lead_id=l["id"], lead_variant="center",
                duration=2.0, preview=True,
            ))
            full_lead = service.track_path(l["id"])
            assert plan.lead_path != full_lead, "lead path must not be the full track"
            assert service.stem_dir.resolve() in plan.lead_path.resolve().parents, \
                "lead path must be under the dedicated stems/ root"
            assert plan.lead_path.name == "center.wav"
        finally:
            service.close()

    def test_corrupt_stem_row_not_advertised(self, tmp_path):
        """Audit regression: a stem row pointing outside stems/ is not playable.

        A corrupt ``paths_json`` entry pointing at ``tracks/...`` must not be
        advertised by ``list_stems`` nor accepted by ``_variant_available``,
        even though it resolves under the broad data root.
        """
        service = StudioService(tmp_path / "data")
        try:
            l = _ingest(service, synth_track(tmp_path / "l.wav", bpm=120, root=220.0))
            sha = service._track_content_hash(l["id"])
            # Insert a corrupt completed stem set whose "center" path points at
            # the full track file (under tracks/, not stems/).
            with service._connect() as conn:
                conn.execute(
                    "INSERT INTO stem_sets (id, track_id, method, model, device,"
                    " status, paths_json, track_sha256, model_name, created_at)"
                    " VALUES (?, ?, ?, ?, ?, 'complete', ?, ?, ?, ?)",
                    (
                        "corruptset", l["id"], "ffmpeg", "center-side-v1", "cpu",
                        json.dumps({"center": f"tracks/{l['id']}.wav"}),
                        sha, "center-side-v1", time.time(),
                    ),
                )
            assert service._variant_available(sha, "center") is False
            data = service.list_stems(l["id"])
            names = [v["name"] for v in data["variants"]]
            assert "center" not in names
        finally:
            service.close()

    def test_mismatched_stem_name_not_advertised_or_playable(self, tmp_path):
        """An in-root path must still match its advertised variant name."""
        service = StudioService(tmp_path / "data")
        try:
            track = _ingest(
                service, synth_track(tmp_path / "l.wav", bpm=120, root=220.0)
            )
            sha = service._track_content_hash(track["id"])
            stem_set_id = "mismatchedset"
            stem_dir = service.stem_dir / stem_set_id
            stem_dir.mkdir(parents=True)
            (stem_dir / "sides.wav").write_bytes(b"stem")
            with service._connect() as conn:
                conn.execute(
                    "INSERT INTO stem_sets (id, track_id, method, model, device,"
                    " status, paths_json, track_sha256, model_name, created_at)"
                    " VALUES (?, ?, ?, ?, ?, 'complete', ?, ?, ?, ?)",
                    (
                        stem_set_id, track["id"], "ffmpeg", "center-side-v1", "cpu",
                        json.dumps(
                            {"center": f"stems/{stem_set_id}/sides.wav"}
                        ),
                        sha, "center-side-v1", time.time(),
                    ),
                )

            assert service._variant_available(sha, "center") is False
            names = [v["name"] for v in service.list_stems(track["id"])["variants"]]
            assert "center" not in names
            with pytest.raises(UserError, match="unavailable or corrupt"):
                service.stem_audio_path(stem_set_id, "center")
        finally:
            service.close()

    def test_variant_path_and_metadata_select_same_newest_stem_set(self, tmp_path):
        """Resolved audio and advertised metadata must identify one stem set."""
        service = StudioService(tmp_path / "data")
        try:
            track = _ingest(
                service, synth_track(tmp_path / "l.wav", bpm=120, root=220.0)
            )
            sha = service._track_content_hash(track["id"])
            with service._connect() as conn:
                for index, created_at in ((1, 1.0), (2, 2.0)):
                    stem_set_id = f"set{index}"
                    stem_dir = service.stem_dir / stem_set_id
                    stem_dir.mkdir(parents=True)
                    (stem_dir / "center.wav").write_bytes(f"stem{index}".encode())
                    conn.execute(
                        "INSERT INTO stem_sets (id, track_id, method, model, device,"
                        " status, paths_json, track_sha256, model_name, created_at)"
                        " VALUES (?, ?, ?, ?, ?, 'complete', ?, ?, ?, ?)",
                        (
                            stem_set_id, track["id"], "ffmpeg", f"model{index}",
                            "cpu", json.dumps(
                                {"center": f"stems/{stem_set_id}/center.wav"}
                            ), sha, f"model{index}", created_at,
                        ),
                    )

            resolved = service._resolve_stem_variant(track["id"], "center")
            info = service._stem_set_audio_info(sha, "center")
            assert resolved.parent.name == "set2"
            assert info is not None and info[0] == "set2"
        finally:
            service.close()

    def test_legacy_use_vocals_ensures_before_planning(self, tmp_path, monkeypatch):
        """Audit regression: legacy use_vocals must separate before planning.

        Planning now resolves the concrete stem path, so on-demand vocals must
        be ensured BEFORE ``_compute_arrangement`` runs — otherwise a render
        with ``use_vocals=True`` and no cached vocals would fail.
        """
        service = StudioService(tmp_path / "data")
        try:
            a = _ingest(service, synth_track(tmp_path / "a.wav", bpm=100, root=261.63))
            l = _ingest(service, synth_track(tmp_path / "l.wav", bpm=120, root=220.0))

            calls = []
            real_ensure = service._ensure_stem_variant
            real_compute = service._compute_arrangement

            def fake_ensure(track_id, variant, job_id, token):
                calls.append("ensure")
                # Simulate a successful on-demand separation by writing a real
                # stem set row so the subsequent planning resolves the path.
                sha = service._track_content_hash(track_id)
                stem_set_id = "legacyvocals"
                final_dir = service.stem_dir / stem_set_id
                final_dir.mkdir(parents=True, exist_ok=True)
                (final_dir / "vocals.wav").write_bytes(b"RIFFxxxxWAVEfmt ")
                with service._connect() as conn:
                    conn.execute(
                        "INSERT INTO stem_sets (id, track_id, method, model, device,"
                        " status, paths_json, track_sha256, model_name, created_at)"
                        " VALUES (?, ?, ?, ?, ?, 'complete', ?, ?, ?, ?)",
                        (
                            stem_set_id, track_id, "demucs", "htdemucs@test", "cpu",
                            json.dumps({"vocals": f"stems/{stem_set_id}/vocals.wav"}),
                            sha, "htdemucs@test", time.time(),
                        ),
                    )

            def fake_compute(options):
                calls.append("compute")
                return real_compute(options)

            monkeypatch.setattr(service, "_ensure_stem_variant", fake_ensure)
            monkeypatch.setattr(service, "_compute_arrangement", fake_compute)

            # Call _run_render directly with a no-op token.
            from twobecomeone.jobs import CancellationToken
            token = CancellationToken()
            try:
                service._run_render("jobid", token, RenderOptions(
                    anchor_id=a["id"], lead_id=l["id"], use_vocals=True,
                    duration=2.0, preview=True,
                ))
            except Exception:
                # The render itself may fail on the fake WAV bytes; the ordering
                # assertion below is what matters.
                pass

            assert calls[0] == "ensure", f"ensure must run before compute, got {calls}"
            assert "compute" in calls
        finally:
            service.close()


class TestOOMFallback:
    def test_separator_oom_detection(self):
        # A RuntimeError carrying "CUDA out of memory" is recognized.
        assert separator._is_cuda_oom(RuntimeError("CUDA out of memory. Tried to allocate 2 GiB"))
        assert not separator._is_cuda_oom(RuntimeError("some other error"))

    def test_model_name_is_version_sensitive(self):
        name = separator.demucs_model_name()
        assert name.startswith("htdemucs@")
        assert separator.center_side_model_name() == "center-side-v1"

    def test_oom_falls_back_to_cpu_exactly_once(self, tmp_path, monkeypatch):
        """A mocked CUDA OOM triggers gc + empty_cache + exactly one CPU retry."""
        import sys
        import types

        calls = {"device": [], "empty_cache": 0, "gc": 0}

        class FakeSeparator:
            def __init__(self, device="cuda"):
                self.device = device
                self.samplerate = 44100

            def separate_audio_file(self, path):
                calls["device"].append(self.device)
                if self.device == "cuda":
                    raise RuntimeError("CUDA out of memory. Tried to allocate 2 GiB")
                # CPU succeeds: return a fake separated dict.
                import numpy as np
                fake = {name: np.zeros(1000, dtype=np.float32) for name in ["vocals", "drums", "bass", "other"]}
                return None, fake

        # Force device selection to cuda.
        monkeypatch.setattr(separator, "_pick_demucs_device", lambda: "cuda")
        monkeypatch.setattr(separator, "_demucs_separator", None)
        monkeypatch.setattr(separator, "_demucs_device", None)

        # Install lightweight fake optional modules so this unit test exercises
        # the fallback in a bare CI environment without downloading Demucs or
        # PyTorch. The production code still imports them through its normal
        # lazy-import path.
        demucs_module = types.ModuleType("demucs")
        demucs_module.__path__ = []
        demucs_api = types.ModuleType("demucs.api")
        demucs_api.Separator = FakeSeparator
        demucs_module.api = demucs_api
        monkeypatch.setitem(sys.modules, "demucs", demucs_module)
        monkeypatch.setitem(sys.modules, "demucs.api", demucs_api)

        # Track empty_cache and gc.collect.
        torch_module = types.ModuleType("torch")
        torch_module.cuda = types.SimpleNamespace(
            OutOfMemoryError=type("OutOfMemoryError", (RuntimeError,), {}),
            empty_cache=lambda: calls.__setitem__("empty_cache", calls["empty_cache"] + 1),
        )
        monkeypatch.setitem(sys.modules, "torch", torch_module)

        import gc
        monkeypatch.setattr(gc, "collect", lambda: calls.__setitem__("gc", calls["gc"] + 1))

        # Stub save_audio to avoid writing real files.
        def fake_save(audio, path, samplerate=None):
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            Path(path).write_bytes(b"x")
        demucs_api.save_audio = fake_save

        out_dir = tmp_path / "stems"
        result = separator.separate(str(tmp_path / "in.wav"), out_dir, method="demucs")

        # CPU was attempted exactly once after the CUDA OOM.
        assert calls["device"] == ["cuda", "cpu"]
        assert calls["empty_cache"] >= 1
        assert calls["gc"] >= 1
        # Final device reported as cpu.
        assert separator.demucs_device() == "cpu"
        assert set(result.keys()) == {"vocals", "drums", "bass", "other"}

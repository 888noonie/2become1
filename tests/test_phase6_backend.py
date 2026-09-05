"""Phase 6 backend contracts: render submission, results, and recovery."""

from __future__ import annotations

import json
import time
from pathlib import Path
from urllib.parse import quote

import pytest

from twobecomeone.contracts import JobKind, JobStatus
from twobecomeone.common import UserError
from twobecomeone.jobs import CancellationToken
from twobecomeone.studio import StudioService


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _render_request(*, preview: bool = False) -> dict:
    return {
        "anchor_id": "anchor-id",
        "lead_id": "lead-id",
        "anchor_start": 1.25,
        "lead_start": 2.5,
        "duration": 12.0 if preview else 90.0,
        "anchor_gain": 0.75,
        "lead_gain": 0.9,
        "use_vocals": False,
        "stem_method": "auto",
        "preview": preview,
        "anchor_variant": "full",
        "lead_variant": "full",
        "pitch_mode": "match",
        "result_display_name": "Saved preview" if preview else "Saved full mix",
        "source_names": {"anchor": "Foundation", "lead": "Lead"},
    }


def _complete_render(
    service: StudioService,
    *,
    preview: bool = False,
    display_name: str | None = None,
    output_path: Path | None = None,
) -> str:
    kind = JobKind.PREVIEW if preview else JobKind.RENDER
    request = _render_request(preview=preview)
    if display_name is not None:
        request["result_display_name"] = display_name
    job_id = service._store.create(kind, request, executor="audio")
    service._store.transition(job_id, JobStatus.RUNNING)
    path = output_path or (service.render_dir / f"{job_id}.mp3")
    path.write_bytes(b"ID3\x04\x00\x00")
    service._store.transition(
        job_id,
        JobStatus.COMPLETE,
        result={
            "display_name": request["result_display_name"],
            "completed_at": 1234.5,
            "duration": request["duration"],
        },
        output_path=str(path),
    )
    return job_id


@pytest.mark.anyio
async def test_post_renders_is_canonical_and_jobs_remains_compatible(tmp_path, monkeypatch):
    pytest.importorskip("fastapi")
    import httpx

    from twobecomeone.webapp import create_app

    app = create_app(tmp_path / "data")
    received = []

    def fake_submit(options):
        received.append(options)
        return {"id": f"job-{len(received)}", "status": "queued"}

    monkeypatch.setattr(app.state.studio, "submit_render", fake_submit)
    transport = httpx.ASGITransport(app=app)
    body = {
        "anchor_id": "anchor-id",
        "lead_id": "lead-id",
        "anchor_start": 1.25,
        "lead_start": 2.5,
        "duration": 12,
        "anchor_gain": 0.75,
        "lead_gain": 0.9,
        "preview": True,
        "anchor_variant": "full",
        "lead_variant": "center",
        "pitch_mode": "preserve",
    }
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
            canonical = await client.post("/api/renders", json=body)
            compatible = await client.post("/api/jobs", json=body)
        assert canonical.status_code == 202
        assert compatible.status_code == 202
        assert [item.__dict__ for item in received] == [received[0].__dict__] * 2
        assert received[0].preview is True
        assert received[0].lead_variant == "center"
        assert received[0].pitch_mode == "preserve"
    finally:
        app.state.studio.close()


@pytest.mark.anyio
async def test_result_rename_and_safe_download_name_survive_restart(tmp_path):
    pytest.importorskip("fastapi")
    import httpx

    from twobecomeone.webapp import create_app

    data_dir = tmp_path / "data"
    app = create_app(data_dir)
    job_id = _complete_render(app.state.studio)
    transport = httpx.ASGITransport(app=app)
    unsafe_display = "../../  My\r\n Mix / final ✓  "
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
            renamed = await client.patch(
                f"/api/renders/{job_id}", json={"display_name": unsafe_display}
            )
            assert renamed.status_code == 200, renamed.text
            payload = renamed.json()
            assert payload["result"]["display_name"] == "../../ My Mix / final ✓"
            assert payload["audio_url"] == f"/api/jobs/{job_id}/audio"
            assert payload["download_url"] == f"/api/jobs/{job_id}/audio?download=true"
            assert "/" not in payload["download_name"]
            assert "\\" not in payload["download_name"]
            assert "\r" not in payload["download_name"]
            assert "\n" not in payload["download_name"]
            assert payload["download_name"].endswith(".mp3")

            inline = await client.get(payload["audio_url"])
            download = await client.get(payload["download_url"])
            assert inline.status_code == 200
            assert "inline" in inline.headers["content-disposition"]
            assert download.status_code == 200
            assert "attachment" in download.headers["content-disposition"]
            assert quote(payload["download_name"]) in download.headers["content-disposition"]
    finally:
        app.state.studio.close()

    restarted = create_app(data_dir)
    transport2 = httpx.ASGITransport(app=restarted)
    try:
        async with httpx.AsyncClient(transport=transport2, base_url="http://localhost") as client:
            persisted = (await client.get(f"/api/jobs/{job_id}")).json()
            assert persisted["result"]["display_name"] == "../../ My Mix / final ✓"
            assert persisted["download_name"].endswith(".mp3")
    finally:
        restarted.state.studio.close()


@pytest.mark.anyio
async def test_rename_rejects_incomplete_non_render_and_corrupt_output(tmp_path):
    pytest.importorskip("fastapi")
    import httpx

    from twobecomeone.webapp import create_app

    app = create_app(tmp_path / "data")
    service = app.state.studio
    queued_id = service._store.create(JobKind.RENDER, _render_request(), executor="audio")
    import_id = service._store.create(JobKind.IMPORT, {"source_kind": "upload"})
    service._store.transition(import_id, JobStatus.RUNNING)
    service._store.transition(import_id, JobStatus.COMPLETE, result={"track_id": "t"})

    outside = tmp_path / "outside.mp3"
    corrupt_id = _complete_render(service, output_path=outside)

    # A row may not point sideways to a different opaque render filename even
    # when that file lives under the managed renders root.
    cross_job_id = _complete_render(
        service, output_path=service.render_dir / "another-job.mp3"
    )

    # An exact-looking <job-id>.mp3 symlink is also never playable. Keeping the
    # target in-root proves the explicit no-symlink rule, not merely containment.
    symlink_id = service._store.create(
        JobKind.RENDER, _render_request(), executor="audio"
    )
    service._store.transition(symlink_id, JobStatus.RUNNING)
    symlink_target = service.render_dir / "symlink-target.mp3"
    symlink_target.write_bytes(b"ID3\x04\x00\x00")
    symlink_path = service.render_dir / f"{symlink_id}.mp3"
    symlink_path.symlink_to(symlink_target.name)
    service._store.transition(
        symlink_id,
        JobStatus.COMPLETE,
        result={"display_name": "Symlink result", "completed_at": 1234.5},
        output_path=str(symlink_path),
    )

    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
            for job_id in (
                queued_id, import_id, corrupt_id, cross_job_id, symlink_id,
            ):
                response = await client.patch(
                    f"/api/renders/{job_id}", json={"display_name": "Renamed"}
                )
                assert response.status_code == 409
                assert set(response.json()) == {"error"}
                assert str(tmp_path) not in json.dumps(response.json())

            for job_id in (corrupt_id, cross_job_id, symlink_id):
                corrupt = (await client.get(f"/api/jobs/{job_id}")).json()
                assert corrupt["audio_url"] is None
                assert corrupt["download_url"] is None
                assert corrupt["download_name"] is None
                audio = await client.get(f"/api/jobs/{job_id}/audio")
                assert audio.status_code == 409
                assert set(audio.json()) == {"error"}
                assert str(tmp_path) not in audio.text
    finally:
        service.close()


@pytest.mark.anyio
async def test_preview_history_does_not_replace_last_completed_full_render(tmp_path):
    pytest.importorskip("fastapi")
    import httpx

    from twobecomeone.webapp import create_app

    app = create_app(tmp_path / "data")
    service = app.state.studio
    full_id = _complete_render(service, display_name="Keep this full mix")
    preview_id = _complete_render(service, preview=True, display_name="Later preview")
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
            activity = (await client.get("/api/jobs", params={"limit": 100})).json()
            assert [item["id"] for item in activity["items"][:2]] == [preview_id, full_id]

            full_history = (
                await client.get("/api/jobs", params={"limit": 100, "kind": "render"})
            ).json()
            assert [item["id"] for item in full_history["items"]] == [full_id]
            assert full_history["items"][0]["result"]["display_name"] == "Keep this full mix"
            assert full_history["items"][0]["audio_url"]
    finally:
        service.close()


@pytest.mark.anyio
async def test_restart_recovery_distinguishes_render_retry_from_import_resume(tmp_path):
    pytest.importorskip("fastapi")
    import httpx

    from twobecomeone.webapp import create_app

    data_dir = tmp_path / "data"
    service = StudioService(data_dir)
    render_id = service._store.create(JobKind.RENDER, _render_request(), executor="audio")
    import_id = service._store.create(
        JobKind.IMPORT,
        {
            "source_kind": "youtube",
            "canonical_url": "https://www.youtube.com/watch?v=abcdefghijk",
            "work_key": "opaque-work-key",
        },
        executor="acquisition",
    )
    # Simulate an unclean process stop without calling close(), whose engine
    # shutdown would cooperatively handle its own live jobs.
    service._engine.shutdown(wait=True)
    service._closed = True

    app = create_app(data_dir)
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
            render = (await client.get(f"/api/jobs/{render_id}")).json()
            imported = (await client.get(f"/api/jobs/{import_id}")).json()
            assert render["status"] == "interrupted"
            assert render["recovery"] == {"can_retry": True, "action": "retry"}
            assert imported["status"] == "interrupted"
            assert imported["recovery"] == {"can_retry": True, "action": "resume"}
            assert "work_key" in imported["request"]
            assert str(tmp_path) not in json.dumps(render)
            assert str(tmp_path) not in json.dumps(imported)
    finally:
        app.state.studio.close()


def test_retry_accepts_metadata_enriched_render_request(tmp_path, monkeypatch):
    service = StudioService(tmp_path / "data")
    request = _render_request()
    old_id = service._store.create(JobKind.RENDER, request, executor="audio")
    service._store.transition(old_id, JobStatus.INTERRUPTED)
    new_id = service._store.create(JobKind.RENDER, request, executor="audio")
    captured = {}

    def fake_run(job_id, token, options, metadata):
        captured.update({"job_id": job_id, "options": options, "metadata": metadata})
        return {"result": {}, "message": "not rendered"}

    def fake_retry(job_id, run_fn):
        assert job_id == old_id
        run_fn("retry-probe", CancellationToken())
        return service._store.get(new_id)

    monkeypatch.setattr(service, "_run_render", fake_run)
    monkeypatch.setattr(service._engine, "retry", fake_retry)
    try:
        retried = service.retry_job(old_id)
        assert retried["id"] == new_id
        assert captured["options"].anchor_id == "anchor-id"
        assert captured["options"].duration == 90.0
        assert captured["metadata"] == {
            "result_display_name": "Saved full mix",
            "source_names": {"anchor": "Foundation", "lead": "Lead"},
        }
    finally:
        service.close()


def test_background_job_error_does_not_leak_managed_path(tmp_path):
    service = StudioService(tmp_path / "data")
    secret_path = service.data_dir / "temp" / "secret-input.wav"

    def fail(_job_id, _token):
        raise UserError(f"could not decode {secret_path}")

    try:
        submitted = service._engine.submit(
            JobKind.RENDER, _render_request(), fail, executor="audio"
        )
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            failed = service.get_job(submitted["id"])
            if failed["status"] == "failed":
                break
            time.sleep(0.01)
        assert failed["status"] == "failed"
        assert "could not decode" in failed["error"]
        assert str(tmp_path) not in failed["error"]
        assert "managed data" in failed["error"]
        assert failed["audio_url"] is None
    finally:
        service.close()

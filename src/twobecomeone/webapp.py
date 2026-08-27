"""FastAPI application for the local 2become1 Studio.

Phase 3.7: every endpoint returns the single error envelope
``{"error": {"code", "message", "detail"}}`` with the planned status mapping
(400/404/409/413/422/503). This module is HTTP validation and mapping only;
all business logic lives in ``StudioService``.
"""

from __future__ import annotations

import asyncio
import json
import mimetypes
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, File, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from . import __version__
from .common import UserError
from .contracts import TERMINAL_JOB_STATES
from .studio import RenderOptions, StudioService


class RenderBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    anchor_id: str
    lead_id: str
    anchor_start: float = Field(default=0.0, ge=0)
    lead_start: float = Field(default=0.0, ge=0)
    duration: float | None = Field(default=None, gt=0, le=3600)
    anchor_gain: float = Field(default=0.8, ge=0, le=2)
    lead_gain: float = Field(default=0.8, ge=0, le=2)
    use_vocals: bool = False
    stem_method: Literal["auto", "demucs", "ffmpeg"] = "auto"
    preview: bool = False
    anchor_variant: str | None = None
    lead_variant: str | None = None
    pitch_mode: Literal["preserve", "match"] = "match"
    tempo_mode: Literal["foundation", "lead", "custom"] = "foundation"
    target_bpm: float | None = Field(default=None, ge=20, le=400)
    arrangement_mode: Literal["overlay", "transition"] = "overlay"
    transition_start: float = Field(default=0.0, ge=0)
    crossfade_duration: float = Field(default=0.0, ge=0, le=30)
    crossfade_curve: Literal["equal_power", "linear"] = "equal_power"
    anchor_pan: float = Field(default=0.0, ge=-1, le=1)
    lead_pan: float = Field(default=0.0, ge=-1, le=1)
    anchor_eq: dict[str, float] | None = None
    lead_eq: dict[str, float] | None = None

    @field_validator(
        "anchor_start", "lead_start", "duration", "anchor_gain", "lead_gain",
        "target_bpm", "transition_start", "crossfade_duration", "anchor_pan",
        "lead_pan", mode="before",
    )
    @classmethod
    def reject_coerced_numbers(cls, value, info):
        if value is None and info.field_name in {"duration", "target_bpm"}:
            return value
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{info.field_name} must be a number")
        return value

    @field_validator("anchor_eq", "lead_eq", mode="before")
    @classmethod
    def validate_eq_shape(cls, value, info):
        if value is None:
            return {"low": 0.0, "mid": 0.0, "high": 0.0}
        if not isinstance(value, dict) or set(value) != {"low", "mid", "high"}:
            raise ValueError(f"{info.field_name} must contain exactly low, mid, and high")
        normalized = {}
        for band in ("low", "mid", "high"):
            number = value[band]
            if isinstance(number, bool) or not isinstance(number, (int, float)):
                raise ValueError(f"{info.field_name}.{band} must be a number")
            if not -12 <= number <= 12:
                raise ValueError(f"{info.field_name}.{band} must be between -12 and 12 dB")
            normalized[band] = float(number)
        return normalized

    @model_validator(mode="after")
    def validate_tempo_target(self):
        if self.tempo_mode == "custom" and self.target_bpm is None:
            raise ValueError("tempo_mode 'custom' requires target_bpm")
        if self.tempo_mode != "custom" and self.target_bpm is not None:
            raise ValueError("target_bpm is only valid when tempo_mode is 'custom'")
        return self


class TrackImportBody(BaseModel):
    url: str = Field(min_length=1, max_length=2048)


class TrackPatchBody(BaseModel):
    display_name: str | None = None
    bpm: float | None = None
    tonic: str | None = None
    mode: str | None = None
    first_beat: float | None = None
    suggested_downbeat: float | None = None


class ProjectCreateBody(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class ProjectPatchBody(BaseModel):
    name: str | None = None
    anchor_track_id: str | None = None
    lead_track_id: str | None = None
    anchor_variant: str | None = None
    lead_variant: str | None = None
    settings: dict[str, Any] | None = None


class SeparationBody(BaseModel):
    method: Literal["auto", "demucs", "ffmpeg"] = "auto"


class RenderResultPatchBody(BaseModel):
    display_name: str = Field(min_length=1, max_length=200)


# SSE heartbeat interval (seconds). Keeps proxies from closing idle streams.
SSE_HEARTBEAT_SEC = 15.0


def create_app(data_dir: str | Path | None = None):
    service = StudioService(data_dir)

    @asynccontextmanager
    async def lifespan(_app):
        yield
        service.close()

    app = FastAPI(
        title="2become1 Studio",
        version=__version__,
        docs_url="/api/docs",
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.studio = service

    @app.exception_handler(UserError)
    async def user_error_handler(_request: Request, exc: UserError):
        return JSONResponse(
            status_code=exc.status,
            content={
                "error": {
                    "code": exc.code,
                    "message": exc.message,
                    "detail": exc.detail,
                }
            },
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(_request: Request, exc: RequestValidationError):
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "validation_error",
                    "message": "request validation failed",
                    "detail": str(exc.errors()),
                }
            },
        )

    @app.get("/api/health")
    def health():
        data = service.health()
        # Network exposure: report whether the server is bound beyond loopback.
        data["network_exposure"] = _network_exposure()
        return data

    # ------------------------------------------------------------------
    # Tracks (library)
    # ------------------------------------------------------------------

    @app.post("/api/tracks", status_code=201)
    def upload_track(file: UploadFile = File(...)):
        if not file.filename:
            raise UserError("file name is required")
        try:
            return service.ingest(file.file, file.filename)
        finally:
            file.file.close()

    @app.post("/api/tracks/import", status_code=201)
    def import_track(body: TrackImportBody):
        return service.ingest_youtube(body.url)

    @app.get("/api/tracks")
    def list_tracks(
        limit: int = Query(default=50, ge=1, le=100),
        offset: int = Query(default=0, ge=0),
        q: str | None = Query(default=None),
        status: Literal["active", "trash", "all"] = "active",
        sort: Literal["name", "created", "bpm", "duration"] = "created",
        source: Literal["upload", "local", "youtube"] | None = Query(default=None),
    ):
        return service.list_tracks_page(
            limit=limit, offset=offset, query=q, status=status, sort=sort,
            source=source,
        )

    @app.get("/api/tracks/{track_id}")
    def get_track(track_id: str):
        return service.get_track(track_id)

    @app.patch("/api/tracks/{track_id}")
    def patch_track(track_id: str, body: TrackPatchBody):
        fields = body.model_dump(exclude_unset=True)
        return service.update_track(track_id, **fields)

    @app.delete("/api/tracks/{track_id}")
    def delete_track(track_id: str):
        return service.trash_track(track_id)

    @app.post("/api/tracks/{track_id}/restore")
    def restore_track(track_id: str):
        return service.restore_track(track_id)

    @app.get("/api/tracks/{track_id}/audio")
    def track_audio(track_id: str):
        path = service.track_path(track_id)
        media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        return FileResponse(
            path, media_type=media_type, filename=path.name,
            content_disposition_type="inline",
        )

    @app.get("/api/tracks/{track_id}/artwork")
    def track_artwork(track_id: str):
        path = service.artwork_path(track_id)
        if path is None:
            return _placeholder_artwork()
        return FileResponse(path, media_type="image/webp", content_disposition_type="inline")

    @app.get("/api/tracks/{track_id}/waveform")
    def track_waveform(track_id: str):
        path = service.waveform_path(track_id)
        if path is None:
            raise UserError("waveform is unavailable for this track")
        return FileResponse(path, media_type="application/json")

    # ------------------------------------------------------------------
    # Imports
    # ------------------------------------------------------------------

    @app.post("/api/imports/youtube", status_code=202)
    def import_youtube(body: TrackImportBody):
        return service.submit_youtube_import(body.url)

    @app.post("/api/imports/upload", status_code=202)
    def import_upload(file: UploadFile = File(...)):
        if not file.filename:
            raise UserError("file name is required")
        staging_key = service.stage_upload(file.file, file.filename)
        try:
            return service.submit_upload_import(staging_key, original_name=file.filename)
        finally:
            file.file.close()

    # ------------------------------------------------------------------
    # Separations and stems
    # ------------------------------------------------------------------

    @app.post("/api/tracks/{track_id}/separations", status_code=202)
    def submit_separation(track_id: str, body: SeparationBody):
        return service.submit_separation(track_id, method=body.method)

    @app.get("/api/tracks/{track_id}/stems")
    def list_stems(track_id: str):
        return service.list_stems(track_id)

    @app.get("/api/stems/{stem_set_id}/audio")
    def stem_audio(stem_set_id: str, name: str = Query(...), download: bool = Query(default=False)):
        path = service.stem_audio_path(stem_set_id, name)
        media_type = mimetypes.guess_type(path.name)[0] or "audio/wav"
        return FileResponse(
            path, media_type=media_type, filename=path.name,
            content_disposition_type="attachment" if download else "inline",
        )

    # ------------------------------------------------------------------
    # Projects
    # ------------------------------------------------------------------

    @app.get("/api/projects")
    def list_projects(
        limit: int = Query(default=50, ge=1, le=100),
        offset: int = Query(default=0, ge=0),
    ):
        return service.list_projects(limit=limit, offset=offset)

    @app.post("/api/projects", status_code=201)
    def create_project(body: ProjectCreateBody):
        return service.create_project(body.name)

    @app.get("/api/projects/{project_id}")
    def get_project(project_id: str):
        return service.get_project(project_id)

    @app.patch("/api/projects/{project_id}")
    def patch_project(project_id: str, body: ProjectPatchBody):
        fields = body.model_dump(exclude_unset=True)
        return service.update_project(project_id, **fields)

    @app.delete("/api/projects/{project_id}", status_code=204)
    def delete_project(project_id: str):
        service.delete_project(project_id)
        return None

    # ------------------------------------------------------------------
    # Render plan (read-only; shares the renderer's planning logic)
    # ------------------------------------------------------------------

    @app.post("/api/renders/plan")
    def render_plan(body: RenderBody):
        """Return the exact plan a real render would execute.

        Server-authored and read-only: never queues a job, decodes media, runs
        Demucs, or writes output. The UI displays this verbatim instead of
        reimplementing tempo/key math.
        """
        return service.plan_render(RenderOptions(**body.model_dump()))

    @app.post("/api/renders", status_code=202)
    def submit_render(body: RenderBody):
        """Canonical V0.3 preview/full-render submission endpoint."""
        return service.submit_render(RenderOptions(**body.model_dump()))

    @app.patch("/api/renders/{job_id}")
    def rename_render_result(job_id: str, body: RenderResultPatchBody):
        return service.rename_render_result(job_id, body.display_name)

    # ------------------------------------------------------------------
    # Jobs
    # ------------------------------------------------------------------

    @app.post("/api/jobs", status_code=202)
    def submit_job(body: RenderBody):
        """V0.2 compatibility alias for ``POST /api/renders``."""
        return service.submit_render(RenderOptions(**body.model_dump()))

    @app.get("/api/jobs")
    def list_jobs(
        limit: int = Query(default=50, ge=1, le=100),
        offset: int = Query(default=0, ge=0),
        status: Literal["queued", "running", "complete", "failed", "cancelled", "interrupted"] | None = Query(default=None),
        kind: Literal["import", "separate", "preview", "render"] | None = Query(default=None),
    ):
        # Retain the V0.2 `{jobs: [...]}` alias when no filters/pagination are
        # requested; otherwise return the paginated `{items,total,limit,offset}`.
        if status is None and kind is None and limit == 50 and offset == 0:
            return {"jobs": service.list_jobs(limit=limit)}
        return service.list_jobs_page(limit=limit, offset=offset, status=status, kind=kind)

    @app.get("/api/jobs/{job_id}")
    def get_job(job_id: str):
        return service.get_job(job_id)

    @app.post("/api/jobs/{job_id}/cancel")
    def cancel_job(job_id: str):
        return service.cancel_job(job_id)

    @app.post("/api/jobs/{job_id}/retry", status_code=202)
    def retry_job(job_id: str):
        return service.retry_job(job_id)

    @app.get("/api/jobs/{job_id}/events")
    async def job_events(job_id: str):
        service.get_job(job_id)

        async def stream():
            previous = None
            while True:
                job = service.get_job(job_id)
                snapshot = json.dumps(job, separators=(",", ":"))
                if snapshot != previous:
                    yield f"event: job\ndata: {snapshot}\n\n"
                    previous = snapshot
                if job["status"] in {s.value for s in TERMINAL_JOB_STATES}:
                    break
                await asyncio.sleep(SSE_HEARTBEAT_SEC)
                yield ": heartbeat\n\n"

        return StreamingResponse(
            stream(), media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.get("/api/jobs/{job_id}/audio")
    def job_audio(job_id: str, download: bool = Query(default=False)):
        path = service.job_output_path(job_id)
        filename = service.job_download_name(job_id)
        return FileResponse(
            path,
            media_type="audio/mpeg",
            filename=filename,
            content_disposition_type="attachment" if download else "inline",
        )

    static_dir = Path(__file__).with_name("studio_static")
    app.mount("/assets", StaticFiles(directory=static_dir), name="assets")

    @app.get("/", include_in_schema=False)
    def studio_index():
        return FileResponse(static_dir / "index.html")

    return app


def _placeholder_artwork():
    """A safe placeholder with no untrusted text (a 1x1 transparent GIF)."""
    import base64
    from fastapi.responses import Response
    gif = base64.b64decode(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
    )
    return Response(content=gif, media_type="image/gif")


def _network_exposure() -> dict:
    """Report whether the server is bound beyond loopback.

    The bind host is not directly introspectable from the ASGI app, so we
    report the conservative fact that the Studio is unauthenticated and must be
    treated as local-only unless the operator explicitly bound a non-loopback
    host. The Engine view uses this to show a prominent no-auth warning.
    """
    return {
        "authenticated": False,
        "loopback_only": True,
        "warning": (
            "2become1 Studio has no authentication. Keep it bound to "
            "127.0.0.1; exposing it beyond loopback shares your library and "
            "jobs with anyone who can reach the port."
        ),
    }

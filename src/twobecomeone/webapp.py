"""FastAPI application for the local 2become1 Studio."""

from __future__ import annotations

import asyncio
import json
import mimetypes
import shutil
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__, separator
from .common import UserError
from .studio import RenderOptions, StudioService


class RenderBody(BaseModel):
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


class TrackImportBody(BaseModel):
    url: str = Field(min_length=1, max_length=2048)


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
        return JSONResponse(status_code=400, content={"error": str(exc)})

    @app.get("/api/health")
    def health():
        return {
            "status": "ready",
            "version": __version__,
            "ffmpeg": bool(shutil.which("ffmpeg")),
            "preferred_device": separator._pick_demucs_device(),
            "data_dir": str(service.data_dir),
        }

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
    def list_tracks():
        return {"tracks": service.list_tracks()}

    @app.get("/api/tracks/{track_id}")
    def get_track(track_id: str):
        return service.get_track(track_id)

    @app.get("/api/tracks/{track_id}/audio")
    def track_audio(track_id: str):
        path = service.track_path(track_id)
        media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        return FileResponse(path, media_type=media_type, filename=path.name, content_disposition_type="inline")

    @app.post("/api/jobs", status_code=202)
    def submit_job(body: RenderBody):
        return service.submit_render(RenderOptions(**body.model_dump()))

    @app.get("/api/jobs")
    def list_jobs():
        return {"jobs": service.list_jobs()}

    @app.get("/api/jobs/{job_id}")
    def get_job(job_id: str):
        return service.get_job(job_id)

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
                if job["status"] in {"complete", "failed"}:
                    break
                await asyncio.sleep(0.35)

        return StreamingResponse(
            stream(), media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.get("/api/jobs/{job_id}/audio")
    def job_audio(job_id: str, download: bool = Query(default=False)):
        path = service.job_output_path(job_id)
        return FileResponse(
            path,
            media_type="audio/mpeg",
            filename=f"2become1-{job_id[:8]}.mp3",
            content_disposition_type="attachment" if download else "inline",
        )

    static_dir = Path(__file__).with_name("studio_static")
    app.mount("/assets", StaticFiles(directory=static_dir), name="assets")

    @app.get("/", include_in_schema=False)
    def studio_index():
        return FileResponse(static_dir / "index.html")

    return app

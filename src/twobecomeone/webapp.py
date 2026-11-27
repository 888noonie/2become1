"""FastAPI application for the local 2become1 Studio.

Phase 3.7: every endpoint returns the single error envelope
``{"error": {"code", "message", "detail"}}`` with the planned status mapping
(400/404/409/413/422/503). This module is HTTP validation and mapping only;
all business logic lives in ``StudioService``.
"""

from __future__ import annotations

import asyncio
import json
import math
import mimetypes
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, File, Form, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, RootModel, field_validator, model_validator

from . import __version__
from .common import NotFoundError, UserError
from .contracts import TERMINAL_JOB_STATES
from .http_safety import RequestSafetyMiddleware
from .arrangements import ArrangementStore
from . import listening, producer_brain
from .chorus_fit import rank_fit
from .studio import RenderOptions, StudioService


def _optional_display_name(value: str | None) -> str | None:
    """Blank import text means 'use the source default', not an empty label."""
    if value is None:
        return None
    if not str(value).strip():
        return None
    return value


class ActionBody(RootModel):
    """Raw V1 Action envelope.

    Deliberately a passthrough: the strict, pure Python contract validator
    (``actions.validate_action``) owns every rule — unknown keys, finite
    numbers, ranges, actor policy. Pydantic is not allowed to coerce or
    weaken the Node contract. (``RootModel`` forbids ``extra='forbid'``;
    unknown top-level keys are rejected by the contract validator itself.)
    """


class LifecycleBody(RootModel):
    """Raw proposal lifecycle request (Phase 10A).

    Passthrough for the same reason as ``ActionBody``: the pure
    ``proposal_lifecycle.validate_lifecycle_request`` owns every rule
    (allowed keys, frozen receipt-echo schema, actor policy, bounded sizes).
    Pydantic must not coerce or weaken it.
    """


class RenderBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    anchor_id: str
    lead_id: str
    # Phase 11B: optional project scope so the server reads committed layers
    # from the durable Action projection (Sol judgment call 1).
    project_id: str | None = None
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
    display_name: str | None = Field(default=None, max_length=400)


class MashupCommandBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=500)


class TrackPatchBody(BaseModel):
    display_name: str | None = None
    bpm: float | None = None
    tonic: str | None = None
    mode: str | None = None
    first_beat: float | None = None
    suggested_downbeat: float | None = None


class ArrangementSaveBody(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    project: dict[str, Any]


class ProjectCreateBody(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class ProjectPatchBody(BaseModel):
    name: str | None = None
    anchor_track_id: str | None = None
    lead_track_id: str | None = None
    anchor_variant: str | None = None
    lead_variant: str | None = None
    settings: dict[str, Any] | None = None


class StemImportEntry(BaseModel):
    role: str
    staging_key: str
    original_name: str | None = None


class StemImportBody(BaseModel):
    files: list[StemImportEntry]


class StagedDiscardBody(BaseModel):
    staging_keys: list[str]


class SeparationBody(BaseModel):
    method: Literal["auto", "demucs", "ffmpeg"] = "auto"


class StemNamesPatchBody(BaseModel):
    """Rename or clear labels for roles in one existing stem set.

    Keys are validated against the set's own roles by the service, so an
    unknown role is a 400 rather than a silently created label. ``null``
    clears a label; the role token remains the fallback.
    """

    model_config = ConfigDict(extra="forbid")

    names: dict[str, str | None] = Field(min_length=1, max_length=8)


class StemCrateCreateBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    track_id: str = Field(min_length=1)
    stem_set_id: str = Field(min_length=1)
    stem_name: str = Field(min_length=1)
    role: Literal["beat", "bass", "other", "voice"]
    loop_bars: Literal[1, 2, 4, 8] = 4
    region_start_beat: float = Field(default=0.0, ge=0)
    region_end_beat: float | None = Field(default=None, gt=0)
    label: str | None = None
    gain_db: float | None = Field(default=None, ge=-24, le=12)

    @field_validator("region_start_beat", "region_end_beat", mode="before")
    @classmethod
    def reject_coerced_numbers(cls, value, info):
        if value is None and info.field_name == "region_end_beat":
            return value
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{info.field_name} must be a number")
        return value

    @field_validator("gain_db", mode="before")
    @classmethod
    def reject_coerced_gain(cls, value):
        if value is None:
            return value
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("gain_db must be a number")
        return value


class StemCratePatchBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str | None = None
    role: Literal["beat", "bass", "other", "voice"] | None = None
    loop_bars: Literal[1, 2, 4, 8] | None = None
    region_start_beat: float | None = Field(default=None, ge=0)
    region_end_beat: float | None = Field(default=None, gt=0)
    gain_db: float | None = Field(default=None, ge=-24, le=12)

    @field_validator(
        "region_start_beat", "region_end_beat", "gain_db", mode="before",
    )
    @classmethod
    def reject_coerced_numbers(cls, value, info):
        if value is None:
            return value
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{info.field_name} must be a number")
        return value


class RenderResultPatchBody(BaseModel):
    display_name: str = Field(min_length=1, max_length=200)


# SSE heartbeat interval (seconds). Keeps proxies from closing idle streams.
SSE_HEARTBEAT_SEC = 15.0


class SectionCorrectionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sections: list[dict[str, Any]] = Field(min_length=1, max_length=64)


class ConverseBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message: str = Field(min_length=1, max_length=400)
    project: dict[str, Any]
    history: list[dict[str, Any]] = Field(default_factory=list, max_length=16)


class ChorusFitSection(BaseModel):
    """One section's numbers. Nested audio, PCM, or any other field is refused."""

    model_config = ConfigDict(extra="forbid")
    id: str | None = None
    label: str | None = Field(default=None, max_length=200)
    name: str | None = Field(default=None, max_length=200)
    meanChroma: list[float] | None = Field(default=None, max_length=12, min_length=12)
    bars: float | None = None
    vocalPresence: float | None = None
    bpm: float | None = None
    swing: float | None = None
    swingRatio: float | None = None
    key: str | None = Field(default=None, max_length=40)
    startSec: float | None = None
    endSec: float | None = None
    downbeatSec: float | None = None

    @field_validator("meanChroma")
    @classmethod
    def _finite_chroma(cls, value: list[float] | None) -> list[float] | None:
        if value is None:
            return None
        if any(not math.isfinite(item) for item in value):
            raise ValueError("meanChroma must be twelve finite numbers")
        return value


class ChorusFitBody(BaseModel):
    """Descriptors only. Audio is never accepted on this route."""

    model_config = ConfigDict(extra="forbid")
    target: ChorusFitSection
    candidates: list[ChorusFitSection] = Field(min_length=1, max_length=64)


def create_app(data_dir: str | Path | None = None, *, bind_host: str | None = None, trusted_hosts: list[str] | None = None):
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
    app.state.bind_host = bind_host or "127.0.0.1"
    allowed_hosts = {"localhost", "127.0.0.1", "::1"}
    if bind_host and bind_host not in {"0.0.0.0", "::"}:
        allowed_hosts.add(bind_host.lower())
    allowed_hosts.update(trusted_hosts or [])
    app.add_middleware(RequestSafetyMiddleware, allowed_hosts=allowed_hosts)

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
        data["network_exposure"] = _network_exposure(app.state.bind_host)
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

    @app.get("/api/crate")
    def list_crate(
        limit: int = Query(default=50, ge=1, le=100),
        offset: int = Query(default=0, ge=0),
        q: str | None = Query(default=None),
        status: Literal["active", "trash", "all"] = "active",
        sort: Literal["name", "created", "bpm", "duration"] = "created",
        source: Literal["upload", "local", "youtube"] | None = Query(default=None),
    ):
        """Read-only Library projection for the Crate; no audio or paths."""
        return service.list_crate_page(
            limit=limit, offset=offset, query=q, status=status, sort=sort,
            source=source,
        )

    # ------------------------------------------------------------------
    # Imports
    # ------------------------------------------------------------------

    @app.post("/api/imports/youtube", status_code=202)
    def import_youtube(body: TrackImportBody):
        return service.submit_youtube_import(
            body.url, display_name=_optional_display_name(body.display_name),
        )

    @app.post("/api/mashup/interpret")
    def interpret_mashup(body: MashupCommandBody):
        from . import mashup_provider
        from .mashup_intent import directive_from_model_json, escalation, interpret

        result = interpret(body.text)
        if result["ok"]:
            return result
        plan = escalation(body.text)
        if not plan.get("escalate"):
            return result
        try:
            raw = mashup_provider.complete_json(plan["model"], body.text)
        except Exception:
            raw = None
        if not raw:
            failed = dict(result)
            failed["error"] = {
                "code": "PR_PROVIDER_UNAVAILABLE",
                "message": "No mashup model is available. Playback is unchanged.",
            }
            return failed
        return directive_from_model_json(raw, tier=plan["tier"])

    @app.post("/api/imports/upload", status_code=202)
    def import_upload(
        file: UploadFile = File(...),
        display_name: str | None = Form(default=None),
    ):
        if not file.filename:
            raise UserError("file name is required")
        try:
            staging_key = service.stage_upload(file.file, file.filename)
            try:
                return service.submit_upload_import(
                    staging_key,
                    original_name=file.filename,
                    display_name=_optional_display_name(display_name),
                )
            except Exception:
                # This route owns this newly staged upload until admission.
                service._resolve_staging_key(staging_key).unlink(missing_ok=True)
                raise
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

    @app.get("/api/stem-sets/{stem_set_id}")
    def get_stem_set(stem_set_id: str):
        """One stem set's identity card: track, roles and owner labels."""
        return service.stem_set_info(stem_set_id)

    @app.patch("/api/stem-sets/{stem_set_id}/names")
    def patch_stem_names(stem_set_id: str, body: StemNamesPatchBody):
        """Set or clear display names without renaming media or paths."""
        return service.set_stem_names(stem_set_id, body.names)

    @app.post("/api/stems/stage", status_code=201)
    def stage_stem_file(file: UploadFile = File(...)):
        """Stage one supplied stem file and return an opaque key.

        The owner then commits four role-tagged keys. Staging uses the existing
        managed ``incoming/`` directory and its 750 MB / suffix rules.
        """
        if not file.filename:
            raise UserError("file name is required")
        if str(Path(file.filename).suffix).lower() != ".wav":
            raise UserError("stem files must be WAV; export the four stems as WAV")
        try:
            staging_key = service.stage_upload(file.file, file.filename)
        finally:
            file.file.close()
        return {"staging_key": staging_key, "original_name": file.filename}

    @app.post("/api/stems/stage/discard")
    def discard_staged_stems(body: StagedDiscardBody):
        """Remove staged stem inputs an abandoned import no longer needs."""
        return {"removed": service.discard_staged_stems(body.staging_keys)}

    @app.post("/api/tracks/{track_id}/stem-import", status_code=201)
    def import_stems(track_id: str, body: StemImportBody):
        """Attach four owner-supplied, already separated stems to a track.

        Roles are explicit; nothing is inferred from a filename, no separation
        job or model call is started, and a failed commit removes its staged
        inputs instead of leaving orphans.
        """
        entries = [entry.model_dump() for entry in body.files]
        try:
            return service.import_stem_set(track_id, entries)
        except Exception:
            for entry in entries:
                try:
                    service._resolve_staging_key(entry["staging_key"]).unlink(missing_ok=True)
                except Exception:
                    pass
            raise

    @app.get("/api/stems/{stem_set_id}/waveform")
    def stem_waveform(stem_set_id: str, name: str = Query(...)):
        """Peaks of one stored stem (Stem-Focus). Reads the file, never writes it."""
        return service.stem_waveform(stem_set_id, name)

    @app.get("/api/stems/{stem_set_id}/audio")
    def stem_audio(
        stem_set_id: str,
        name: str = Query(...),
        download: bool = Query(default=False),
        start: float | None = Query(default=None),
        duration: int | None = Query(default=None),
    ):
        if start is None and duration is None:
            path = service.stem_audio_path(stem_set_id, name)
            media_type = mimetypes.guess_type(path.name)[0] or "audio/wav"
            return FileResponse(
                path, media_type=media_type, filename=path.name,
                content_disposition_type="attachment" if download else "inline",
            )
        if start is None or duration is None:
            raise UserError("a section needs both a start and a length")
        data = service.stem_audio_window(
            stem_set_id, name, start=start, duration=duration,
        )
        return Response(content=data, media_type="audio/wav")

    # ------------------------------------------------------------------
    # Stem crate (Phase 14B.1)
    # ------------------------------------------------------------------

    @app.get("/api/stem-crate")
    def list_stem_crate(
        limit: int = Query(default=50, ge=1, le=100),
        offset: int = Query(default=0, ge=0),
        q: str | None = Query(default=None),
        role: Literal["beat", "bass", "other", "voice"] | None = Query(default=None),
        against: str | None = Query(default=None),
    ):
        return service.list_stem_crate_items(
            limit=limit, offset=offset, query=q, role=role, against_id=against
        )

    @app.get("/api/stem-crate/compatibility")
    def stem_crate_compatibility(
        source: str = Query(min_length=1),
        against: str = Query(min_length=1),
    ):
        return service.stem_crate_compatibility(source, against)

    @app.post("/api/stem-crate", status_code=201)
    def create_stem_crate_item(body: StemCrateCreateBody):
        return service.create_stem_crate_item(**body.model_dump())

    @app.patch("/api/stem-crate/{item_id}")
    def patch_stem_crate_item(item_id: str, body: StemCratePatchBody):
        fields = body.model_dump(exclude_unset=True)
        return service.update_stem_crate_item(item_id, **fields)

    @app.delete("/api/stem-crate/{item_id}", status_code=204)
    def delete_stem_crate_item(item_id: str):
        service.delete_stem_crate_item(item_id)
        return None

    # ------------------------------------------------------------------
    # Projects
    # ------------------------------------------------------------------

    # ------------------------------------------------------------------
    # Saved Studio arrangements (OPERATION FULL HOUSE)
    # ------------------------------------------------------------------
    arrangements = ArrangementStore(service.data_dir)

    @app.get("/api/arrangements")
    def list_arrangements():
        return arrangements.list()

    @app.get("/api/arrangements/{arrangement_id}")
    def get_arrangement(arrangement_id: str):
        return arrangements.get(arrangement_id)

    @app.put("/api/arrangements/{arrangement_id}")
    def save_arrangement(arrangement_id: str, body: ArrangementSaveBody):
        return arrangements.save(arrangement_id, body.name, body.project)

    # ------------------------------------------------------------------
    # The Listening Room: source analysis and the conversational Producer
    # ------------------------------------------------------------------

    @app.get("/api/tracks/{track_id}/listening")
    def get_listening(track_id: str):
        analysis = listening.for_track(service, track_id, compute=False)
        if analysis is None:
            raise NotFoundError("this recording has not been listened to yet", code="NOT_ANALYSED")
        return analysis

    @app.post("/api/tracks/{track_id}/listening")
    def run_listening(track_id: str):
        return listening.for_track(service, track_id, compute=True)

    @app.put("/api/tracks/{track_id}/listening/sections")
    def correct_sections(track_id: str, body: SectionCorrectionBody):
        return listening.save_corrections(service, track_id, body.sections)

    @app.delete("/api/tracks/{track_id}/listening/sections")
    def reset_sections(track_id: str):
        return listening.save_corrections(service, track_id, None)

    @app.post("/api/chorus-fit")
    def chorus_fit_route(body: ChorusFitBody):
        """Rank one target section against other sections. No audio, no model, no project write."""
        return rank_fit(body.target.model_dump(), [item.model_dump() for item in body.candidates])

    @app.get("/api/producer/model")
    def producer_model():
        return producer_brain.status()

    @app.post("/api/producer/creative")
    def producer_creative(body: ConverseBody):
        """Classify one sentence. The model does not receive audio or edit the project."""
        try:
            return producer_brain.classify_creative(body.message)
        except producer_brain.ProducerUnavailable as exc:
            err = UserError(str(exc), code=exc.code)
            err.status = 503 if exc.code == "PRODUCER_MODEL_UNAVAILABLE" else 422
            raise err from exc

    @app.post("/api/producer/converse")
    def producer_converse(body: ConverseBody):
        analyses = {}
        for key, group in (body.project.get("groups") or {}).items():
            if key in ("A", "B") and isinstance(group, dict) and isinstance(group.get("trackId"), str):
                analyses[key] = listening.for_track(service, group["trackId"], compute=True)
        try:
            return producer_brain.converse(body.message, body.project, analyses, body.history)
        except producer_brain.ProducerUnavailable as exc:
            err = UserError(str(exc), code=exc.code)
            err.status = 503 if exc.code == "PRODUCER_MODEL_UNAVAILABLE" else 422
            raise err from exc

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
    # V1 durable Action ledger (Phase 9A)
    # ------------------------------------------------------------------

    @app.post("/api/projects/{project_id}/actions", status_code=201)
    def post_project_action(project_id: str, body: ActionBody):
        return service.record_project_action(project_id, body.root)

    @app.get("/api/projects/{project_id}/action-state")
    def get_project_action_state(project_id: str):
        return service.project_action_state(project_id)

    @app.get("/api/projects/{project_id}/actions")
    def get_project_actions(
        project_id: str,
        after: int = Query(default=0, ge=0),
        limit: int = Query(default=50, ge=1, le=200),
    ):
        return service.project_actions(project_id, after=after, limit=limit)

    @app.post("/api/projects/{project_id}/proposals/{proposal_id}/lifecycle")
    def post_proposal_lifecycle(project_id: str, proposal_id: str, body: LifecycleBody):
        """Durable runtime lifecycle fact for one proposal (Phase 10A).

        Strict schema validation lives in the pure
        ``proposal_lifecycle.validate_lifecycle_request``; Pydantic is a
        passthrough exactly like ``ActionBody`` so nothing is coerced.
        """
        return service.record_proposal_lifecycle(project_id, proposal_id, body.root)

    @app.get("/api/ghost-assets/{asset_id}/audio")
    def ghost_asset_audio(asset_id: str):
        """Serve a managed Ghost preview asset by opaque ID only.

        The route never accepts a path: resolution is by database row and
        strict managed-root validation. Expired, unpinned assets are not served.
        """
        path = service.ghost_asset_audio_path(asset_id)
        return FileResponse(path, media_type="audio/wav", content_disposition_type="inline")

    @app.get("/api/stem-stack-assets/{asset_id}/audio")
    def stem_stack_asset_audio(asset_id: str):
        """Serve a managed stem-stack asset by opaque ID only."""
        path = service.stem_stack_audio_path(asset_id)
        return FileResponse(path, media_type="audio/wav", content_disposition_type="inline")

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


def _is_loopback_host(host: str) -> bool:
    """Return whether ``host`` binds only to the local machine.

    ``localhost`` and the IPv4/IPv6 loopback addresses are local-only. Any
    wildcard (``0.0.0.0``/``::``) or a concrete non-loopback address is not.
    """
    normalized = (host or "").strip().lower()
    if normalized in {"127.0.0.1", "localhost", "::1"}:
        return True
    return False


def _network_exposure(host: str | None = None) -> dict:
    """Report whether the server is bound beyond loopback.

    ``host`` is the bind address the operator passed to ``uvicorn.run``. When
    it is a loopback address the Studio is local-only; any other address (or a
    wildcard) exposes the unauthenticated Studio and its media routes to the
    network, so the Engine view shows a prominent no-auth warning.
    """
    loopback_only = _is_loopback_host(host or "127.0.0.1")
    return {
        "authenticated": False,
        "loopback_only": loopback_only,
        "warning": (
            "2become1 Studio has no authentication. Keep it bound to "
            "127.0.0.1; exposing it beyond loopback shares your library and "
            "jobs with anyone who can reach the port."
        ),
    }

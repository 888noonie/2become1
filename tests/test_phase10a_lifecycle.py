"""Phase 10A: durable proposal lifecycle facts, hardening, HTTP envelope."""

import json
import sqlite3
import time

import pytest

from twobecomeone import actions as action_contract
from twobecomeone import proposal_lifecycle as lc
from twobecomeone.common import ConflictError, NotFoundError
from twobecomeone.ghost_assets import (
    GhostAssetPreparationError,
    GhostAssetStore,
    MIN_GHOST_REGION_BEATS,
    MAX_GHOST_REGION_BEATS,
    MEDIA_EDGE_TOLERANCE_SECONDS,
)
from twobecomeone.migrations import latest_version, run_migrations
from twobecomeone.studio import StudioService


def preview_action(action_id="a-1", key="k-1", **region_overrides):
    region = {"id": "r1", "startBeat": 0, "endBeat": 8, "gridRevision": "grid-1"}
    region.update(region_overrides)
    return {
        "id": action_id,
        "schemaVersion": 1,
        "type": "preview_layer",
        "actor": {"type": "human", "id": "richard"},
        "requestedAt": "2026-08-28T00:00:00Z",
        "idempotencyKey": key,
        "payload": {
            "source": {"deck": "A", "stem": "vocal", "region": region},
            "destination": {"deck": "B"},
            "timing": {"launch": "next_phrase", "quantize": True},
            "gainDb": -3,
        },
    }


def fact_body(to="scheduled", actor=None, **extra):
    body = {
        "to": to,
        "actor": actor or {"type": "human", "id": "richard"},
        "at": "2026-08-29T00:00:00Z",
    }
    body.update(extra)
    return body


VALID_ECHO = {
    "assetId": "ga-" + "a" * 32,
    "contentHash": "sha256:" + "b" * 64,
    "launchBeat": 32.0,
    "launchAudioTime": 12.5,
    "gridRevision": "grid-v1:" + "c" * 64,
}


@pytest.fixture
def service(tmp_path):
    svc = StudioService(tmp_path / "data")
    svc._actions._asset_preparer = lambda project_id, action, conn=None: {
        "asset": {
            "id": "ga-stub",
            "contentHash": "sha256:stub",
            "transformSpec": {},
            "audioUrl": "/api/ghost-assets/ga-stub/audio",
            "expiresAt": 0,
        }
    }
    svc._actions._asset_registrar = None
    yield svc
    svc.close()


@pytest.fixture
def project_id(service):
    return service.create_project("Lifecycle mix")["id"]


def seeded_proposal(service, project_id, action_id="a-1", key="k-1"):
    service.record_project_action(project_id, preview_action(action_id, key))
    return action_id


# ---------------------------------------------------------------------------
# Pure schema validation (A5)
# ---------------------------------------------------------------------------


class TestLifecycleSchema:
    def test_minimal_request_canonicalizes(self):
        out = lc.validate_lifecycle_request(fact_body())
        assert out == {
            "to": "scheduled",
            "actor": {"type": "human", "id": "richard"},
            "at": "2026-08-29T00:00:00Z",
            "fact": {},
        }

    def test_unknown_body_key_rejected(self):
        with pytest.raises(lc.LifecycleRequestError) as e:
            lc.validate_lifecycle_request(fact_body(supersedes="x"))
        assert e.value.code == "V_UNEXPECTED_PAYLOAD_KEY"

    def test_invalid_to_state_rejected(self):
        for bad in ("accepted", "ready", "REJECTED", "", None, 7):
            with pytest.raises(lc.LifecycleRequestError) as e:
                body = fact_body()
                body["to"] = bad
                lc.validate_lifecycle_request(body)
            assert e.value.code == "L_INVALID_TRANSITION"

    def test_producer_denied(self):
        with pytest.raises(ConflictError) as e:
            lc.validate_lifecycle_request(fact_body(actor={"type": "producer", "id": "p1"}))
        assert e.value.code == "P_ACTOR_NOT_ALLOWED"

    def test_actor_schema_enforced(self):
        with pytest.raises(lc.LifecycleRequestError) as e:
            lc.validate_lifecycle_request(fact_body(actor={"type": "human"}))
        assert e.value.code == "V_INVALID_ACTOR"
        # Unknown actor keys reject with V_UNEXPECTED_PAYLOAD_KEY before any
        # actor-type policy is consulted.
        with pytest.raises(lc.LifecycleRequestError) as e:
            lc.validate_lifecycle_request(
                fact_body(actor={"type": "producer", "id": "p", "extra": 1})
            )
        assert e.value.code == "V_UNEXPECTED_PAYLOAD_KEY"

    def test_missing_at_rejected(self):
        body = fact_body()
        del body["at"]
        with pytest.raises(lc.LifecycleRequestError) as e:
            lc.validate_lifecycle_request(body)
        assert e.value.code == "V_MISSING_REQUESTED_AT"

    def test_at_is_bounded_provenance(self):
        with pytest.raises(lc.LifecycleRequestError):
            lc.validate_lifecycle_request(fact_body(at="x" * 41))
        # at does not override server time ordering; validated only.
        out = lc.validate_lifecycle_request(fact_body(at="not-even-a-timestamp"))
        assert out["at"] == "not-even-a-timestamp"

    def test_fact_unknown_key_rejected(self):
        with pytest.raises(lc.LifecycleRequestError) as e:
            lc.validate_lifecycle_request(fact_body(fact={"paths": ["/etc/passwd"]}))
        assert e.value.code == "V_UNEXPECTED_PAYLOAD_KEY"

    def test_fact_formats_strict(self):
        bad = dict(VALID_ECHO)
        bad["assetId"] = "../etc/passwd"
        with pytest.raises(lc.LifecycleRequestError):
            lc.validate_lifecycle_request(fact_body(fact=bad))
        bad = dict(VALID_ECHO)
        bad["contentHash"] = "md5:zz"
        with pytest.raises(lc.LifecycleRequestError):
            lc.validate_lifecycle_request(fact_body(fact=bad))
        bad = dict(VALID_ECHO)
        bad["gridRevision"] = "grid-client-invented"
        with pytest.raises(lc.LifecycleRequestError):
            lc.validate_lifecycle_request(fact_body(fact=bad))

    def test_fact_numeric_bounds(self):
        bad = dict(VALID_ECHO)
        bad["launchAudioTime"] = float("inf")
        with pytest.raises(lc.LifecycleRequestError):
            lc.validate_lifecycle_request(fact_body(fact=bad))
        bad = dict(VALID_ECHO)
        bad["launchBeat"] = -1
        with pytest.raises(lc.LifecycleRequestError):
            lc.validate_lifecycle_request(fact_body(fact=bad))
        bad = dict(VALID_ECHO)
        bad["launchBeat"] = True
        with pytest.raises(lc.LifecycleRequestError):
            lc.validate_lifecycle_request(fact_body(fact=bad))

    def test_fact_size_bounded(self, monkeypatch):
        lc.validate_lifecycle_request(fact_body(fact=VALID_ECHO))
        # The encoded ceiling guard itself (A5, "small maximum encoded size"):
        # shrink the limit and the same legal echo must be rejected.
        monkeypatch.setattr(lc, "MAX_FACT_JSON_BYTES", 100)
        with pytest.raises(lc.LifecycleRequestError):
            lc.validate_lifecycle_request(fact_body(fact=VALID_ECHO))

    def test_fact_not_object_rejected(self):
        for bad in ([], "x", 5, True):
            with pytest.raises(lc.LifecycleRequestError):
                lc.validate_lifecycle_request(fact_body(fact=bad))

    def test_scrub_fact_empty(self):
        assert lc.scrub_fact(None) == {}
        assert lc.scrub_fact({}) == {}


# ---------------------------------------------------------------------------
# Durable transitions (A4)
# ---------------------------------------------------------------------------


class TestDurableTransitions:
    def test_full_runtime_journey(self, service, project_id):
        seeded_proposal(service, project_id)
        r1 = service.record_proposal_lifecycle(project_id, "a-1", fact_body("scheduled"))
        assert r1["outcome"] == "lifecycle_recorded"
        assert r1["from"] == "ready"
        assert r1["lifecycle"] == "scheduled"
        assert r1["idempotentReplay"] is False
        r2 = service.record_proposal_lifecycle(
            project_id, "a-1", fact_body("auditioning", fact=VALID_ECHO)
        )
        assert r2["outcome"] == "lifecycle_recorded"
        assert r2["lifecycle"] == "auditioning"
        # action-state reflects the advanced lifecycle (hydratable truth).
        state = service.project_action_state(project_id)
        assert state["proposals"]["byId"]["a-1"]["lifecycle"] == "auditioning"

    def test_unknown_proposal_404(self, service, project_id):
        with pytest.raises(NotFoundError) as e:
            service.record_proposal_lifecycle(project_id, "ghost", fact_body())
        assert e.value.code == "L_UNKNOWN_PROPOSAL"

    def test_unknown_project_404(self, service):
        created = service.create_project("Elsewhere")
        other = created["id"]
        with pytest.raises(NotFoundError):
            service.record_proposal_lifecycle(other, "a-1", fact_body())

    def test_invalid_hops_rejected_zero_mutation(self, service, project_id):
        seeded_proposal(service, project_id)
        # ready -> auditioning is not a permitted hop.
        with pytest.raises(ConflictError) as e:
            service.record_proposal_lifecycle(project_id, "a-1", fact_body("auditioning"))
        assert e.value.code == "L_INVALID_TRANSITION"
        # Projection untouched.
        state = service.project_action_state(project_id)
        assert state["proposals"]["byId"]["a-1"]["lifecycle"] == "ready"
        with service._connect() as conn:
            rows = conn.execute("SELECT COUNT(*) FROM proposal_lifecycle_facts").fetchone()[0]
        assert rows == 0

    def test_backward_and_terminal_hops_rejected(self, service, project_id):
        seeded_proposal(service, project_id)
        service.record_proposal_lifecycle(project_id, "a-1", fact_body("scheduled"))
        # Backward and skipping hops denied + no third/premature fact.
        with pytest.raises(ConflictError):
            service.record_proposal_lifecycle(
                project_id, "a-1", fact_body("auditioning", actor={"type": "producer", "id": "p"})
            )
        # Terminal proposals never transition (reject first).
        service.record_project_action(
            project_id,
            {
                "id": "rej-1",
                "schemaVersion": 1,
                "type": "reject_proposal",
                "actor": {"type": "human", "id": "richard"},
                "requestedAt": "t",
                "idempotencyKey": "rej-1",
                "payload": {"proposalId": "a-1", "rejectedAt": "t2"},
            },
        )
        with pytest.raises(ConflictError) as e:
            service.record_proposal_lifecycle(project_id, "a-1", fact_body("scheduled"))
        assert e.value.code == "L_INVALID_TRANSITION"

    def test_replay_is_success_without_new_row(self, service, project_id):
        seeded_proposal(service, project_id)
        first = service.record_proposal_lifecycle(project_id, "a-1", fact_body("scheduled"))
        assert first["idempotentReplay"] is False
        second = service.record_proposal_lifecycle(project_id, "a-1", fact_body("scheduled"))
        assert second["idempotentReplay"] is True
        assert second["outcome"] == "lifecycle_replayed"
        with service._connect() as conn:
            rows = conn.execute(
                "SELECT COUNT(*) FROM proposal_lifecycle_facts WHERE project_id = ?",
                (project_id,),
            ).fetchone()[0]
        assert rows == 1

    def test_producer_denied_on_store(self, service, project_id):
        seeded_proposal(service, project_id)
        with pytest.raises(ConflictError) as e:
            service.record_proposal_lifecycle(
                project_id, "a-1",
                fact_body(actor={"type": "producer", "id": "auto"}),
            )
        assert e.value.code == "P_ACTOR_NOT_ALLOWED"

    def test_facts_survive_service_restart(self, service, project_id, tmp_path):
        seeded_proposal(service, project_id)
        service.record_proposal_lifecycle(project_id, "a-1", fact_body("scheduled"))
        service.record_proposal_lifecycle(
            project_id, "a-1", fact_body("auditioning", fact=VALID_ECHO)
        )
        service.close()
        revived = StudioService(tmp_path / "data")
        try:
            state = revived.project_action_state(project_id)
            assert state["proposals"]["byId"]["a-1"]["lifecycle"] == "auditioning"
        finally:
            revived.close()

    def test_rebuild_after_snapshot_deletion(self, service, project_id):
        """A4: rebuild from ledger+facts, not only from the stored snapshot."""
        seeded_proposal(service, project_id)
        service.record_proposal_lifecycle(project_id, "a-1", fact_body("scheduled"))
        service.record_proposal_lifecycle(
            project_id, "a-1", fact_body("auditioning", fact=VALID_ECHO)
        )
        with service._connect() as conn:
            conn.execute("DELETE FROM action_projection WHERE project_id = ?", (project_id,))
        rebuilt = service._actions.rebuild_projection(project_id)
        assert rebuilt["proposals"]["byId"]["a-1"]["lifecycle"] == "auditioning"

    def test_reject_decisive_over_following_fact(self, service, project_id):
        """A terminal musical Action stays decisive during rebuild."""
        seeded_proposal(service, project_id)
        service.record_proposal_lifecycle(project_id, "a-1", fact_body("scheduled"))
        service.record_project_action(
            project_id,
            {
                "id": "rej-1",
                "schemaVersion": 1,
                "type": "reject_proposal",
                "actor": {"type": "human", "id": "richard"},
                "requestedAt": "t",
                "idempotencyKey": "rej-1",
                "payload": {"proposalId": "a-1", "rejectedAt": "t2"},
            },
        )
        rebuilt = service._actions.rebuild_projection(project_id)
        assert rebuilt["proposals"]["byId"]["a-1"]["lifecycle"] == "rejected"

    def test_migration_10_table_and_uniqueness(self, service):
        with service._connect() as conn:
            tables = {
                r[0] for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
            assert "proposal_lifecycle_facts" in tables
            idx = {
                r[1] for r in conn.execute(
                    "PRAGMA index_list(proposal_lifecycle_facts)"
                ).fetchall()
            }
            assert "idx_lifecycle_facts_one_per_state" in idx
            assert latest_version() == 10

    def test_migration_is_idempotent(self, tmp_path):
        svc = StudioService(tmp_path / "data")
        try:
            with svc._connect() as conn:
                assert run_migrations(conn) == []
        finally:
            svc.close()

    def test_at_never_overrides_server_time(self, service, project_id):
        seeded_proposal(service, project_id)
        result = service.record_proposal_lifecycle(
            project_id, "a-1",
            fact_body(at="1999-01-01T00:00:00Z"),
        )
        with service._connect() as conn:
            row = conn.execute(
                "SELECT recorded_at FROM proposal_lifecycle_facts WHERE project_id = ?",
                (project_id,),
            ).fetchone()
        assert abs(row["recorded_at"] - time.time()) < 60
        assert result["recordedAt"] > 1_500_000_000


# ---------------------------------------------------------------------------
# Concurrency (A4): serialize on the projection row; identical replays yield
# one fact + one replay response; competing transitions never partially mutate.
# ---------------------------------------------------------------------------


class TestConcurrency:
    def test_concurrent_identical_transitions_yield_one_fact(self, service, project_id):
        import threading

        seeded_proposal(service, project_id)
        results = []
        errors = []
        barrier = threading.Barrier(4)

        def worker():
            try:
                barrier.wait()

                results.append(
                    service.record_proposal_lifecycle(project_id, "a-1", fact_body("scheduled"))
                )
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors, errors
        recorded = [r for r in results if r["idempotentReplay"] is False]
        replayed = [r for r in results if r["idempotentReplay"] is True]
        assert len(recorded) == 1
        assert len(replayed) == 3
        with service._connect() as conn:
            rows = conn.execute(
                "SELECT COUNT(*) FROM proposal_lifecycle_facts WHERE project_id = ?",
                (project_id,),
            ).fetchone()[0]
        assert rows == 1

    def test_concurrent_competing_transitions_serialize(self, service, project_id):
        import threading

        seeded_proposal(service, project_id)
        outcomes = []
        errors = []
        barrier = threading.Barrier(2)

        def to_auditioning():
            try:
                barrier.wait()
                outcomes.append(
                    service.record_proposal_lifecycle(
                        project_id, "a-1", fact_body("auditioning")
                    )
                )
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        def to_scheduled():
            try:
                barrier.wait()
                outcomes.append(
                    service.record_proposal_lifecycle(project_id, "a-1", fact_body("scheduled"))
                )
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        t1 = threading.Thread(target=to_auditioning)
        t2 = threading.Thread(target=to_scheduled)
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        # Both requests resolve without raw SQLite lock errors; whoever lost
        # gets an honest replay/conflict, and the proposal ends in a state
        # consistent with the sequence order of the facts table.
        assert not [e for e in errors if "locked" in str(e).lower()], errors
        with service._connect() as conn:
            state = service.project_action_state(project_id)
            rows = conn.execute(
                "SELECT to_state FROM proposal_lifecycle_facts WHERE project_id = ? ORDER BY id",
                (project_id,),
            ).fetchall()
        final = state["proposals"]["byId"]["a-1"]["lifecycle"]
        valid_ends = {"scheduled", "auditioning"}
        assert final in valid_ends
        if len(rows) == 2:
            assert rows[-1]["to_state"] == final


# ---------------------------------------------------------------------------
# HTTP envelope (Phase 10A endpoint)
# ---------------------------------------------------------------------------


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client(tmp_path):
    pytest.importorskip("fastapi")
    import httpx
    from twobecomeone.webapp import create_app

    app = create_app(tmp_path / "data")
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://studio.test") as c:
            resp = await c.post("/api/projects", json={"name": "Lifecycle HTTP"})
            project_id = resp.json()["id"]
            # Stub the asset preparer so a proposal can be seeded without
            # real tracks (assembly-level tests cover real preparation).
            studio = app.state.studio
            studio._actions._asset_preparer = lambda project_id, action, conn=None: {
                "asset": {
                    "id": "ga-stub",
                    "contentHash": "sha256:stub",
                    "transformSpec": {},
                    "audioUrl": "/api/ghost-assets/ga-stub/audio",
                    "expiresAt": 0,
                }
            }
            studio._actions._asset_registrar = None
            # Seed one proposal through the real API.
            action = preview_action()
            resp = await c.post(
                f"/api/projects/{project_id}/actions", json=action
            )
            assert resp.status_code == 201
            yield c, project_id
    finally:
        app.state.studio.close()


class TestLifecycleHTTP:
    @pytest.mark.anyio
    async def test_record_and_replay(self, client):
        c, project_id = client
        resp = await c.post(
            f"/api/projects/{project_id}/proposals/a-1/lifecycle",
            json=fact_body("scheduled"),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["outcome"] == "lifecycle_recorded"
        resp = await c.post(
            f"/api/projects/{project_id}/proposals/a-1/lifecycle",
            json=fact_body("scheduled"),
        )
        assert resp.status_code == 200
        assert resp.json()["idempotentReplay"] is True

    @pytest.mark.anyio
    async def test_unknown_proposal_envelope(self, client):
        c, project_id = client
        resp = await c.post(
            f"/api/projects/{project_id}/proposals/ghost/lifecycle",
            json=fact_body(),
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "L_UNKNOWN_PROPOSAL"

    @pytest.mark.anyio
    async def test_unknown_project_envelope(self, client):
        c, _ = client
        resp = await c.post(
            "/api/projects/ghost-project/proposals/a-1/lifecycle",
            json=fact_body(),
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "not_found"

    @pytest.mark.anyio
    async def test_producer_409(self, client):
        c, project_id = client
        resp = await c.post(
            f"/api/projects/{project_id}/proposals/a-1/lifecycle",
            json=fact_body(actor={"type": "producer", "id": "auto"}),
        )
        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "P_ACTOR_NOT_ALLOWED"

    @pytest.mark.anyio
    async def test_invalid_transition_409(self, client):
        c, project_id = client
        resp = await c.post(
            f"/api/projects/{project_id}/proposals/a-1/lifecycle",
            json=fact_body("auditioning"),  # skip
        )
        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "L_INVALID_TRANSITION"

    @pytest.mark.anyio
    async def test_schema_422(self, client):
        c, project_id = client
        resp = await c.post(
            f"/api/projects/{project_id}/proposals/a-1/lifecycle",
            json=fact_body(fact={"weapon": "path"}),
        )
        assert resp.status_code == 422
        assert resp.json()["error"]["code"] == "V_UNEXPECTED_PAYLOAD_KEY"

    @pytest.mark.anyio
    async def test_action_state_reflects_fact(self, client):
        c, project_id = client
        await c.post(
            f"/api/projects/{project_id}/proposals/a-1/lifecycle",
            json=fact_body("scheduled"),
        )
        resp = await c.get(f"/api/projects/{project_id}/action-state")
        assert resp.json()["proposals"]["byId"]["a-1"]["lifecycle"] == "scheduled"
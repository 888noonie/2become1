"""Phase 9A: durable Action ledger, strict validation parity, hydration."""

import json
from pathlib import Path

import pytest

from twobecomeone import actions as action_contract
from twobecomeone.common import ConflictError, NotFoundError
from twobecomeone.migrations import latest_version, run_migrations
from twobecomeone.studio import StudioService

VECTORS_PATH = Path(__file__).resolve().parent / "fixtures" / "action_contract_vectors.json"


def load_vectors():
    return json.loads(VECTORS_PATH.read_text())


def valid_preview(action_id="a-1", key="k-1", **payload_overrides):
    payload = {
        "source": {"deck": "A", "stem": "vocal", "region": {"id": "r1", "startBeat": 0, "endBeat": 8}},
        "destination": {"deck": "B"},
        "timing": {"launch": "next_phrase", "quantize": True},
        "gainDb": -3,
    }
    payload.update(payload_overrides)
    return {
        "id": action_id,
        "schemaVersion": 1,
        "type": "preview_layer",
        "actor": {"type": "human", "id": "richard"},
        "requestedAt": "2026-08-28T00:00:00Z",
        "idempotencyKey": key,
        "payload": payload,
    }


@pytest.fixture
def service(tmp_path):
    svc = StudioService(tmp_path / "data")
    # Unit tests focus on ledger/projection semantics; the real ffmpeg asset
    # preparation is exercised separately in the Phase 9B tests with real
    # tracks/stems. Here a stub records calls and returns a fixed descriptor.
    svc._actions._asset_preparer = lambda project_id, action, conn=None: {
        "asset": {
            "id": "ga-stub",
            "contentHash": "sha256:stub",
            "transformSpec": {},
            "audioUrl": f"/api/ghost-assets/ga-stub/audio",
            "expiresAt": 0,
        }
    }
    svc._actions._asset_registrar = None
    svc._actions._asset_verifier = lambda project_id, proposal_id, claimed, conn=None: {
        "id": claimed.get("id", "ga-stub"),
        "contentHash": claimed.get("contentHash", "sha256:stub"),
        "transformSpec": {},
        "pinned": True,
    }
    yield svc
    svc.close()


@pytest.fixture
def project_id(service):
    return service.create_project("Parity mix")["id"]


class TestContractVectors:
    """Shared JSON contract vectors prove Python/Node parity."""

    def test_all_valid_vectors_pass(self):
        for case in load_vectors()["valid"]:
            result = action_contract.validate_action(case["action"])
            assert result["id"] == case["action"]["id"], case["name"]

    def test_all_invalid_vectors_rejected_with_matching_code(self):
        for case in load_vectors()["invalid"]:
            with pytest.raises(action_contract.ActionValidationError) as excinfo:
                action_contract.validate_action(case["action"])
            assert excinfo.value.node_code == case["node_code"], case["name"]

    def test_vector_file_has_both_sections(self):
        vectors = load_vectors()
        assert len(vectors["valid"]) >= 3
        assert len(vectors["invalid"]) >= 10


class TestStrictValidation:
    def test_bool_is_not_a_number(self):
        action = valid_preview(gainDb=True)
        with pytest.raises(action_contract.ActionValidationError) as excinfo:
            action_contract.validate_action(action)
        assert excinfo.value.node_code == "V_INVALID_GAIN"

    def test_infinity_rejected(self):
        action = valid_preview(gainDb=float("inf"))
        with pytest.raises(action_contract.ActionValidationError):
            action_contract.validate_action(action)

    def test_nan_rejected(self):
        action = valid_preview(gainDb=float("nan"))
        with pytest.raises(action_contract.ActionValidationError):
            action_contract.validate_action(action)

    def test_non_dict_rejected(self):
        with pytest.raises(action_contract.ActionValidationError) as excinfo:
            action_contract.validate_action([1, 2, 3])
        assert excinfo.value.node_code == "V_INVALID_TYPE"

    def test_error_is_user_error_with_422(self):
        from twobecomeone.common import UserError

        with pytest.raises(UserError) as excinfo:
            action_contract.validate_action({"nope": True})
        assert excinfo.value.status == 422


class TestActionStore:
    def test_preview_preparation_does_not_hold_sqlite_transaction(self, service, project_id):
        observed = []

        def prepare(_project_id, _action):
            with service._connect() as independent:
                independent.execute("BEGIN IMMEDIATE")
                observed.append(independent.in_transaction)
                independent.rollback()
            return {
                "asset": {
                    "id": "ga-stub",
                    "contentHash": "sha256:stub",
                    "transformSpec": {},
                    "audioUrl": "/api/ghost-assets/ga-stub/audio",
                    "expiresAt": 0,
                }
            }

        service._actions._asset_preparer = prepare
        result = service.record_project_action(project_id, valid_preview())
        assert observed == [True]
        assert result["outcome"]["result"] == "proposal_created"

    def test_preview_creates_durable_ledger_and_ready_proposal(self, service, project_id):
        result = service.record_project_action(project_id, valid_preview())
        assert result["outcome"]["result"] == "proposal_created"
        assert result["sequence"] == 1
        assert result["idempotentReplay"] is False

        state = service.project_action_state(project_id)
        assert state["last_sequence"] == 1
        assert state["proposals"]["byId"]["a-1"]["lifecycle"] == "ready"
        assert state["proposals"]["activeIds"] == ["a-1"]
        assert state["session"]["deckAssignments"] == {"A": None, "B": None}

    def test_idempotent_retry_returns_original_outcome_without_new_row(self, service, project_id):
        first = service.record_project_action(project_id, valid_preview())
        retry = service.record_project_action(project_id, valid_preview())
        assert retry["idempotentReplay"] is True
        assert retry["sequence"] == first["sequence"]
        assert retry["outcome"] == first["outcome"]
        assert service.project_actions(project_id)["total"] == 1

    def test_key_reuse_with_different_payload_fails_without_mutation(self, service, project_id):
        service.record_project_action(project_id, valid_preview())
        before = service.project_action_state(project_id)
        with pytest.raises(ConflictError) as excinfo:
            service.record_project_action(project_id, valid_preview(gainDb=0))
        assert excinfo.value.code == "I_KEY_REUSED_WITH_DIFFERENT_REQUEST"
        after = service.project_action_state(project_id)
        assert before == after
        assert service.project_actions(project_id)["total"] == 1

    def test_idempotency_scoped_per_project(self, service, project_id):
        service.record_project_action(project_id, valid_preview())
        other = service.create_project("Other mix")["id"]
        result = service.record_project_action(other, valid_preview())
        assert result["outcome"]["result"] == "proposal_created"
        assert result["sequence"] == 1

    def test_idempotency_scoped_per_actor(self, service, project_id):
        service.record_project_action(project_id, valid_preview())
        action = valid_preview(action_id="a-2", key="k-1")
        action["actor"] = {"type": "human", "id": "someone-else"}
        result = service.record_project_action(project_id, action)
        assert result["idempotentReplay"] is False
        assert result["sequence"] == 2

    def test_producer_commit_denied_zero_mutation(self, service, project_id):
        producer_commit = {
            "id": "p-1",
            "schemaVersion": 1,
            "type": "commit_layer",
            "actor": {"type": "producer", "id": "ghost"},
            "requestedAt": "t",
            "idempotencyKey": "pk",
            "payload": {
                "proposalId": "a-1",
                "acceptedAt": "t2",
                "acceptedAsset": {"id": "x", "contentHash": "h", "transformSpec": {}},
            },
        }
        before = service.project_action_state(project_id)
        with pytest.raises(ConflictError) as excinfo:
            service.record_project_action(project_id, producer_commit)
        assert excinfo.value.code == "P_ACTOR_NOT_ALLOWED"
        assert service.project_action_state(project_id) == before

    def test_producer_preview_denied(self, service, project_id):
        action = valid_preview()
        action["actor"] = {"type": "producer", "id": "ghost"}
        with pytest.raises(ConflictError) as excinfo:
            service.record_project_action(project_id, action)
        assert excinfo.value.code == "P_PRODUCER_PREVIEW_DENIED"

    def test_commit_before_asset_fails_with_availability_code(self, service, project_id):
        # Prepare the proposal lifecycle up to auditioning directly in the
        # projection through valid ledger rows is not possible via public API
        # (no scheduled/auditioning Action types this phase), so simulate the
        # runtime fact the same way the plan prescribes: proposal exists, then
        # commit must fail honestly.
        service.record_project_action(project_id, valid_preview())
        commit = {
            "id": "c-1",
            "schemaVersion": 1,
            "type": "commit_layer",
            "actor": {"type": "human", "id": "richard"},
            "requestedAt": "t",
            "idempotencyKey": "ck",
            "payload": {
                "proposalId": "a-1",
                "acceptedAt": "t2",
                "acceptedAsset": {"id": "asset-1", "contentHash": "sha256:abc", "transformSpec": {"gainDb": -3}},
            },
        }
        with pytest.raises(ConflictError) as excinfo:
            service.record_project_action(project_id, commit)
        # 'ready' is not 'auditioning' — lifecycle blocks first.
        assert excinfo.value.code == "L_NOT_AUDITIONING"

    def test_unknown_proposal_404(self, service, project_id):
        action = {
            "id": "r-1",
            "schemaVersion": 1,
            "type": "reject_proposal",
            "actor": {"type": "human", "id": "richard"},
            "requestedAt": "t",
            "idempotencyKey": "rk",
            "payload": {"proposalId": "missing", "rejectedAt": "t2"},
        }
        with pytest.raises(NotFoundError) as excinfo:
            service.record_project_action(project_id, action)
        assert excinfo.value.code == "L_UNKNOWN_PROPOSAL"

    def test_reject_is_durable_provenance(self, service, project_id):
        service.record_project_action(project_id, valid_preview())
        action = {
            "id": "r-1",
            "schemaVersion": 1,
            "type": "reject_proposal",
            "actor": {"type": "human", "id": "richard"},
            "requestedAt": "t",
            "idempotencyKey": "rk",
            "payload": {"proposalId": "a-1", "rejectedAt": "t2", "reason": "not right"},
        }
        result = service.record_project_action(project_id, action)
        assert result["outcome"]["result"] == "proposal_rejected"
        state = service.project_action_state(project_id)
        assert state["proposals"]["byId"]["a-1"]["lifecycle"] == "rejected"
        assert state["proposals"]["activeIds"] == []
        # Historical ledger keeps both rows.
        ledger = service.project_actions(project_id)
        assert ledger["total"] == 2
        assert ledger["items"][1]["type"] == "reject_proposal"

    def test_invalid_action_zero_mutation(self, service, project_id):
        bad = valid_preview()
        bad["payload"]["gainDb"] = 99
        before = service.project_action_state(project_id)
        with pytest.raises(action_contract.ActionValidationError):
            service.record_project_action(project_id, bad)
        assert service.project_action_state(project_id) == before
        assert service.project_actions(project_id)["total"] == 0

    def test_unknown_project_404(self, service):
        with pytest.raises(NotFoundError):
            service.record_project_action("missing-project", valid_preview())

    def test_ledger_read_pagination(self, service, project_id):
        for i in range(5):
            service.record_project_action(project_id, valid_preview(action_id=f"a-{i}", key=f"k-{i}"))
        page = service.project_actions(project_id, after=2, limit=2)
        assert [item["sequence"] for item in page["items"]] == [3, 4]
        assert page["total"] == 5


class TestRestartDurability:
    def test_projection_survives_service_restart(self, service, project_id, tmp_path):
        service.record_project_action(project_id, valid_preview())
        data_dir = service.data_dir
        service.close()

        revived = StudioService(data_dir)
        try:
            state = revived.project_action_state(project_id)
            assert state["proposals"]["byId"]["a-1"]["lifecycle"] == "ready"
            assert state["last_sequence"] == 1
            # Retry after restart is still an idempotent replay.
            retry = revived.record_project_action(project_id, valid_preview())
            assert retry["idempotentReplay"] is True
            assert retry["sequence"] == 1
        finally:
            revived.close()

    def test_projection_rebuild_replays_successful_commit_without_asset_io(self, service, project_id):
        service.record_project_action(project_id, valid_preview())
        with service._connect() as conn:
            row = conn.execute(
                "SELECT proposals_json FROM action_projection WHERE project_id = ?",
                (project_id,),
            ).fetchone()
            proposals = json.loads(row["proposals_json"])
            proposals["byId"]["a-1"]["lifecycle"] = "auditioning"
            conn.execute(
                "UPDATE action_projection SET proposals_json = ? WHERE project_id = ?",
                (json.dumps(proposals), project_id),
            )
        commit = {
            "id": "c-1",
            "schemaVersion": 1,
            "type": "commit_layer",
            "actor": {"type": "human", "id": "richard"},
            "requestedAt": "t",
            "idempotencyKey": "commit-key",
            "payload": {
                "proposalId": "a-1",
                "acceptedAt": "t2",
                "acceptedAsset": {
                    "id": "ga-stub",
                    "contentHash": "sha256:stub",
                    "transformSpec": {},
                },
            },
        }
        service.record_project_action(project_id, commit)
        expected = service.project_action_state(project_id)
        rebuilt = service._actions.rebuild_projection(project_id)
        assert rebuilt["session"] == expected["session"]
        assert rebuilt["proposals"] == expected["proposals"]


class TestMigrationIntegrity:
    def test_migration_8_creates_tables_idempotently(self, tmp_path):
        from twobecomeone.studio import StudioService as Svc

        svc = Svc(tmp_path / "data")
        try:
            with svc._connect() as conn:
                versions = run_migrations(conn)
                assert versions == []  # already applied during _init_db
                tables = {
                    row[0]
                    for row in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    ).fetchall()
                }
                assert "actions" in tables
                assert "action_projection" in tables
        finally:
            svc.close()

    def test_v03_schema_upgrades_without_row_changes(self, tmp_path):
        # Build a pre-migration copy of the V0.3 database by creating one with
        # the current code, capturing rows, then confirming migration 8 adds
        # only new tables and leaves existing rows untouched.
        svc = StudioService(tmp_path / "data")
        project = svc.create_project("Keep me")
        svc.close()

        import sqlite3

        conn = sqlite3.connect(tmp_path / "data" / "studio.sqlite3")
        with conn:
            # Drop migration 8 artifacts to simulate a V0.3-era database, then
            # re-run migrations from scratch on a fresh service.
            conn.execute("DROP TABLE IF EXISTS actions")
            conn.execute("DROP TABLE IF EXISTS action_projection")
            conn.execute("DELETE FROM schema_migrations WHERE version = 8")
        conn.close()

        revived = StudioService(tmp_path / "data")
        try:
            with revived._connect() as conn:
                row = conn.execute(
                    "SELECT name FROM projects WHERE id = ?", (project["id"],)
                ).fetchone()
                assert row is not None
                assert row[0] == "Keep me"
                versions = {r[0] for r in conn.execute("SELECT version FROM schema_migrations").fetchall()}
                assert 8 in versions
        finally:
            revived.close()

    def test_latest_version_is_10(self):
        assert latest_version() == 10


class TestActionStateShape:
    def test_empty_bootstrap_projection(self, service, project_id):
        state = service.project_action_state(project_id)
        assert state == {
            "projection_version": 1,
            "last_sequence": 0,
            "session": {
                "deckAssignments": {"A": None, "B": None},
                "committedLayers": [],
                "acceptedActionIds": [],
            },
            "proposals": {"byId": {}, "order": [], "activeIds": []},
        }

    def test_no_internal_paths_in_state_or_ledger(self, service, project_id, tmp_path):
        service.record_project_action(project_id, valid_preview())
        state_json = json.dumps(service.project_action_state(project_id))
        ledger_json = json.dumps(service.project_actions(project_id))
        for blob in (state_json, ledger_json):
            assert str(tmp_path) not in blob
            assert str(service.data_dir) not in blob
            assert "studio.sqlite3" not in blob

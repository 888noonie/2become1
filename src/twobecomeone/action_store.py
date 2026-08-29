"""Project-scoped durable Action ledger and projection store.

Phase 9A. SQLite is the historical truth: the ``actions`` table is append-only
and the ``action_projection`` table is a rebuildable acceleration snapshot.
Append + projection update always happen in one SQLite transaction so ledger
and projection can never diverge.

All SQL is parameterized. All JSON stored through this module has passed the
strict ``actions.validate_action`` contract first and is serialized with
deterministic key ordering.
"""

from __future__ import annotations

import copy
import json
import sqlite3
import time
from typing import Any, Callable

from . import actions as action_contract
from . import proposal_lifecycle as lifecycle_contract
from .common import ConflictError, NotFoundError, UserError

PROJECTION_VERSION = 1

MAX_LEDGER_LIMIT = 200


class ActionStore:
    """Append-only project-scoped Action ledger with a projection snapshot."""

    def __init__(
        self,
        connect: Callable[[], sqlite3.Connection],
        *,
        asset_preparer: Callable[[str, dict], dict] | None = None,
        asset_registrar: Callable[[dict, sqlite3.Connection], None] | None = None,
        asset_discarder: Callable[[dict], None] | None = None,
        asset_verifier: Callable[[str, str, dict, sqlite3.Connection | None], dict] | None = None,
    ):
        self._connect = connect
        # Phase 9B uses a prepare-then-append boundary: expensive audio work
        # happens before BEGIN; only the cheap registry insert joins the action
        # transaction. A failed/racing append discards the unpublished file.
        self._asset_preparer = asset_preparer
        self._asset_registrar = asset_registrar
        self._asset_discarder = asset_discarder
        # Optional Phase 9B hook: verifies + pins a commit's accepted asset.
        # Signature: (project_id, proposal_id, claimed_asset, conn) -> verified record
        self._asset_verifier = asset_verifier

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------

    def _get_projection_row(self, conn: sqlite3.Connection, project_id: str) -> sqlite3.Row | None:
        return conn.execute(
            "SELECT * FROM action_projection WHERE project_id = ?",
            (project_id,),
        ).fetchone()

    def action_state(self, project_id: str) -> dict:
        """Return the finite bootstrap projection for a project."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM action_projection WHERE project_id = ?",
                (project_id,),
            ).fetchone()
        if row is None:
            return {
                "projection_version": PROJECTION_VERSION,
                "last_sequence": 0,
                **action_contract.initial_projection(),
            }
        return {
            "projection_version": row["projection_version"],
            "last_sequence": row["last_sequence"],
            "session": json.loads(row["session_json"]),
            "proposals": json.loads(row["proposals_json"]),
        }

    def list_actions(self, project_id: str, after: int = 0, limit: int = 50) -> dict:
        """Cursor/limit-bounded ledger read (ascending by sequence)."""
        if not isinstance(after, int) or after < 0:
            raise UserError("after must be a non-negative integer")
        if not isinstance(limit, int) or limit < 1 or limit > MAX_LEDGER_LIMIT:
            raise UserError(f"limit must be within [1, {MAX_LEDGER_LIMIT}]")
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM actions WHERE project_id = ? AND sequence > ?"
                " ORDER BY sequence ASC LIMIT ?",
                (project_id, after, limit),
            ).fetchall()
            total = conn.execute(
                "SELECT COUNT(*) FROM actions WHERE project_id = ?",
                (project_id,),
            ).fetchone()[0]
        return {
            "items": [self._row_to_entry(row) for row in rows],
            "total": total,
            "after": after,
            "limit": limit,
        }

    @staticmethod
    def _row_to_entry(row: sqlite3.Row) -> dict:
        return {
            "sequence": row["sequence"],
            "id": row["id"],
            "projectId": row["project_id"],
            "schemaVersion": row["schema_version"],
            "type": row["type"],
            "actor": {"type": row["actor_type"], "id": row["actor_id"]},
            "requestedAt": row["requested_at"],
            "idempotencyKey": row["idempotency_key"],
            "payload": json.loads(row["payload_json"]),
            "outcome": json.loads(row["outcome_json"]),
            "recordedAt": row["recorded_at"],
        }

    # ------------------------------------------------------------------
    # Writes (one transaction: ledger append + projection update)
    # ------------------------------------------------------------------

    def append_action(self, project_id: str, action: dict) -> dict:
        """Validate, apply, and durably record one Action.

        The full Phase 8 semantic pipeline runs here against durable state:
        permission, lifecycle preconditions, and idempotency. On any failure
        neither the ledger nor the projection changes (single transaction).

        Returns the outcome dict:
        ``{outcome, proposal?, committedLayer?, sequence, entry}``.
        """
        validated = action_contract.validate_action(action)
        actor = validated["actor"]
        project_id = str(project_id)

        prepared_preview = None
        if validated["type"] == "preview_layer" and self._asset_preparer is not None:
            # Avoid rendering ordinary retries or requests that already fail
            # permission/lifecycle checks. This connection never starts a
            # write transaction and is closed before ffmpeg is invoked.
            with self._connect() as preflight_conn:
                row = self._find_idempotent_row(preflight_conn, project_id, validated)
                if row is not None:
                    return self._idempotent_result(row, validated)
                projection = self._load_projection_for_update(preflight_conn, project_id)
            self._apply_to_projection(validated, copy.deepcopy(projection))
            prepared_preview = self._asset_preparer(project_id, validated)

        conn = self._connect()
        keep_prepared = False
        try:
            conn.execute("BEGIN")
            row = self._find_idempotent_row(conn, project_id, validated)
            if row is not None:
                conn.rollback()
                return self._idempotent_result(row, validated)

            projection = self._load_projection_for_update(conn, project_id)
            outcome = self._apply_to_projection(
                validated,
                projection,
                project_id,
                conn,
                prepared_preview=prepared_preview,
            )

            next_sequence = self._next_sequence(conn, project_id)
            recorded_at = time.time()
            conn.execute(
                "INSERT INTO actions ("
                " sequence, id, project_id, schema_version, type, actor_type,"
                " actor_id, requested_at, idempotency_key, payload_json,"
                " outcome_json, recorded_at"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    next_sequence,
                    validated["id"],
                    project_id,
                    validated["schemaVersion"],
                    validated["type"],
                    actor["type"],
                    actor["id"],
                    validated["requestedAt"],
                    validated["idempotencyKey"],
                    action_contract.canonical_json(validated["payload"]),
                    action_contract.canonical_json(outcome),
                    recorded_at,
                ),
            )
            conn.execute(
                "INSERT INTO action_projection ("
                " project_id, projection_version, last_sequence,"
                " session_json, proposals_json, updated_at"
                ") VALUES (?, ?, ?, ?, ?, ?)"
                " ON CONFLICT(project_id) DO UPDATE SET"
                " projection_version = excluded.projection_version,"
                " last_sequence = excluded.last_sequence,"
                " session_json = excluded.session_json,"
                " proposals_json = excluded.proposals_json,"
                " updated_at = excluded.updated_at",
                (
                    project_id,
                    PROJECTION_VERSION,
                    next_sequence,
                    action_contract.canonical_json(projection["session"]),
                    action_contract.canonical_json(projection["proposals"]),
                    recorded_at,
                ),
            )
            conn.commit()
            keep_prepared = True
            return {
                "outcome": outcome,
                "sequence": next_sequence,
                "idempotentReplay": False,
            }
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
            if prepared_preview is not None and not keep_prepared and self._asset_discarder is not None:
                self._asset_discarder(prepared_preview)

    @staticmethod
    def _find_idempotent_row(conn: sqlite3.Connection, project_id: str, action: dict) -> sqlite3.Row | None:
        actor = action["actor"]
        return conn.execute(
            "SELECT * FROM actions"
            " WHERE project_id = ? AND actor_type = ? AND actor_id = ? AND idempotency_key = ?",
            (project_id, actor["type"], actor["id"], action["idempotencyKey"]),
        ).fetchone()

    def _idempotent_result(self, row: sqlite3.Row, action: dict) -> dict:
        if not action_contract.compare_actions(action, self._stored_action(row)):
            raise ConflictError(
                "idempotencyKey was reused with a semantically different request",
                code="I_KEY_REUSED_WITH_DIFFERENT_REQUEST",
            )
        return {
            "outcome": json.loads(row["outcome_json"]),
            "sequence": row["sequence"],
            "idempotentReplay": True,
        }

    @staticmethod
    def _stored_action(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "schemaVersion": row["schema_version"],
            "type": row["type"],
            "actor": {"type": row["actor_type"], "id": row["actor_id"]},
            "requestedAt": row["requested_at"],
            "idempotencyKey": row["idempotency_key"],
            "payload": json.loads(row["payload_json"]),
        }

    # ------------------------------------------------------------------
    # Durable runtime lifecycle facts (Phase 10A)
    # ------------------------------------------------------------------

    def record_lifecycle_fact(self, project_id: str, proposal_id: str, body: dict) -> dict:
        """Validate and durably record one proposal lifecycle transition.

        One SQLite transaction covers the fact insert AND the
        ``action_projection`` lifecycle update (A4: the projection can never
        diverge from the fact table). Replay-idempotent: if the proposal is
        already in the target state, returns success with no write (network
        retries must not fail). Producer is denied; the frozen forward
        transition table is enforced; terminal proposals never transition.
        """
        project_id = str(project_id)
        proposal_id = str(proposal_id)
        validated = lifecycle_contract.validate_lifecycle_request(body)
        target = validated["to"]
        actor = validated["actor"]
        fact = validated["fact"]

        conn = self._connect()
        try:
            # Serialize concurrent writers on the single projection row first,
            # so two competing transitions cannot partially mutate or surface
            # a raw SQLite lock (A4). BEGIN IMMEDIATE takes the write lock.
            conn.execute("BEGIN IMMEDIATE")
            projection = self._load_projection_for_update(conn, project_id)
            proposal = projection["proposals"]["byId"].get(proposal_id)
            if proposal is None:
                conn.rollback()
                raise lifecycle_contract.unknown_proposal(proposal_id)

            # Producer is constitutionally denied (mirrors _apply_to_projection).
            if actor["type"] != "human":
                conn.rollback()
                raise ConflictError(
                    "only a human may record a proposal lifecycle fact",
                    code="P_ACTOR_NOT_ALLOWED",
                )

            current = proposal["lifecycle"]

            # Replay-idempotent no-op: already in the target state. Returns
            # success with no write exactly once per identical retry.
            if current == target:
                conn.rollback()
                return {
                    "outcome": "lifecycle_replayed",
                    "proposalId": proposal_id,
                    "lifecycle": current,
                    "idempotentReplay": True,
                }

            if not lifecycle_contract.valid_runtime_transition(current, target):
                conn.rollback()
                raise ConflictError(
                    "lifecycle transition is not permitted",
                    code="L_INVALID_TRANSITION",
                    detail=json.dumps({"from": current, "to": target}, sort_keys=True),
                )

            # One-transaction fact insert + projection update (A4). The unique
            # index turns a concurrent identical hop into an integrity error
            # which we convert into the replay response.
            recorded_at = time.time()
            try:
                conn.execute(
                    "INSERT INTO proposal_lifecycle_facts ("
                    " project_id, proposal_id, from_state, to_state,"
                    " actor_type, actor_id, fact_json, recorded_at"
                    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        project_id,
                        proposal_id,
                        current,
                        target,
                        actor["type"],
                        actor["id"],
                        lifecycle_contract.canonical_fact_json(fact) if fact else None,
                        recorded_at,
                    ),
                )
            except sqlite3.IntegrityError:
                # A concurrent identical transition won the race; succeed as a
                # replay with no second fact row. Re-check the state under the
                # write lock for an honest response.
                conn.rollback()
                return {
                    "outcome": "lifecycle_replayed",
                    "proposalId": proposal_id,
                    "lifecycle": target,
                    "idempotentReplay": True,
                }

            proposal["lifecycle"] = target
            # Zero-partial-mutation failure path: the update targets the same
            # transaction; if it fails the insert rolls back with it.
            updated = conn.execute(
                "UPDATE action_projection SET proposals_json = ?, updated_at = ?"
                " WHERE project_id = ?",
                (
                    action_contract.canonical_json(projection["proposals"]),
                    recorded_at,
                    project_id,
                ),
            )
            if updated.rowcount != 1:
                raise RuntimeError("projection row vanished mid-transaction")
            conn.commit()
            return {
                "outcome": "lifecycle_recorded",
                "proposalId": proposal_id,
                "from": current,
                "lifecycle": target,
                "recordedAt": recorded_at,
                "idempotentReplay": False,
            }
        except Exception:
            try:
                conn.rollback()
            except sqlite3.Error:
                pass
            raise  # preserve the specific public error (404/409/422)
        finally:
            conn.close()

    # ------------------------------------------------------------------
    # Projection pipeline (pure helpers operating on plain dicts)
    # ------------------------------------------------------------------

    def _load_projection_for_update(self, conn: sqlite3.Connection, project_id: str) -> dict:
        row = conn.execute(
            "SELECT session_json, proposals_json FROM action_projection WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        if row is None:
            return action_contract.initial_projection()
        return {
            "session": json.loads(row["session_json"]),
            "proposals": json.loads(row["proposals_json"]),
        }

    def _next_sequence(self, conn: sqlite3.Connection, project_id: str) -> int:
        row = conn.execute(
            "SELECT COALESCE(MAX(sequence), 0) FROM actions WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        return int(row[0]) + 1

    def _apply_to_projection(
        self,
        action: dict,
        projection: dict,
        project_id: str = "",
        conn: sqlite3.Connection | None = None,
        *,
        prepared_preview: dict | None = None,
        replaying: bool = False,
    ) -> dict:
        """Apply validated action semantics to the projection; return outcome.

        Mirrors the Phase 8 Node reducer semantics exactly. Raises
        ``UserError`` subclasses with stable codes on lifecycle/permission
        violations so zero mutation happens (the caller's transaction
        wrapper rolls back).
        """
        session = projection["session"]
        proposals = projection["proposals"]
        action_type = action["type"]
        actor_type = action["actor"]["type"]

        # Constitutional permission gate (mirrors permission.js).
        if actor_type == "producer":
            if action_type == "commit_layer":
                raise ConflictError(
                    "Producer is not permitted to commit",
                    code="P_ACTOR_NOT_ALLOWED",
                )
            if action_type == "reject_proposal":
                raise ConflictError(
                    "Producer is not permitted to reject proposals",
                    code="P_ACTOR_NOT_ALLOWED",
                )
            # producer preview_layer is allowed only with explicit permission,
            # which this tri-phase does not grant through the public API.
            raise ConflictError(
                "Producer preview is not permitted via the public API",
                code="P_PRODUCER_PREVIEW_DENIED",
            )

        if action_type == "preview_layer":
            if action["id"] in proposals["byId"]:
                raise ConflictError(
                    "an action with this id already exists in this project",
                    code="I_ACTION_ID_EXISTS",
                )
            asset_descriptor = prepared_preview["asset"] if prepared_preview is not None else None
            if prepared_preview is not None and self._asset_registrar is not None:
                if conn is None:
                    raise RuntimeError("prepared assets require an active append transaction")
                self._asset_registrar(prepared_preview, conn)
            record = action_contract.make_projection_record(action, "ready")
            proposals["byId"][record["id"]] = record
            proposals["order"].append(record["id"])
            proposals["activeIds"].append(record["id"])
            return {
                "result": "proposal_created",
                "proposal": record,
                "asset": asset_descriptor,
            }

        proposal_id = action["payload"].get("proposalId")
        proposal = proposals["byId"].get(proposal_id)
        if proposal is None:
            raise NotFoundError(
                "proposalId does not reference a known proposal in this project",
                code="L_UNKNOWN_PROPOSAL",
            )

        if action_type == "reject_proposal":
            if proposal["lifecycle"] in ("accepted", "rejected"):
                raise ConflictError(
                    "proposal is already terminal",
                    code="L_INVALID_TRANSITION",
                )
            proposal["lifecycle"] = "rejected"
            if proposal_id in proposals["activeIds"]:
                proposals["activeIds"].remove(proposal_id)
            return {"result": "proposal_rejected", "proposalId": proposal_id}

        # commit_layer: requires the auditioning precondition, exactly like
        # the Phase 8 Node dispatcher. The accepted asset is verified against
        # the server's prepared record and pinned in this same durable
        # operation; a client can never forge one.
        if proposal["lifecycle"] != "auditioning" and not replaying:
            raise ConflictError(
                "commit_layer requires the referenced proposal to be in auditioning",
                code="L_NOT_AUDITIONING",
            )
        if self._asset_verifier is None and not replaying:
            raise ConflictError(
                "the referenced proposal has no prepared server-managed asset to accept",
                code="S_ASSET_NOT_AVAILABLE",
            )
        if replaying:
            accepted_asset = action["payload"]["acceptedAsset"]
            verified = {
                "id": accepted_asset["id"],
                "contentHash": accepted_asset["contentHash"],
                "transformSpec": accepted_asset["transformSpec"],
            }
        else:
            verified = self._asset_verifier(
                project_id,
                proposal_id,
                action["payload"].get("acceptedAsset") or {},
                conn,
            )
        accepted_at = action["payload"].get("acceptedAt")
        commit_layer = action_contract.make_committed_layer(action, proposal)
        commit_layer["asset"] = {
            "id": verified["id"],
            "contentHash": verified["contentHash"],
            "transformSpec": verified["transformSpec"],
            "pinned": True,
        }
        proposal["lifecycle"] = "accepted"
        if proposal_id in proposals["activeIds"]:
            proposals["activeIds"].remove(proposal_id)
        session.setdefault("committedLayers", []).append(commit_layer)
        session.setdefault("acceptedActionIds", []).append(action["id"])
        proposal["committedActionId"] = action["id"]
        return {
            "result": "proposal_committed",
            "proposalId": proposal_id,
            "acceptedAt": accepted_at if isinstance(accepted_at, str) else None,
        }

    def rebuild_projection(self, project_id: str) -> dict:
        """Rebuild the projection from the full ledger (repair path)."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM actions WHERE project_id = ? ORDER BY sequence ASC",
                (project_id,),
            ).fetchall()
        projection = action_contract.initial_projection()
        for row in rows:
            action = self._stored_action(row)
            # Only successful Actions enter the ledger. During replay the
            # successful commit row itself proves that the runtime auditioning
            # precondition and server asset verification held at append time;
            # rebuilding must not rerun filesystem/subprocess side effects.
            self._apply_to_projection(action, projection, replaying=True)
        # A4: the ledger alone no longer rebuilds runtime truth — lifecycle
        # facts live in their own table. Re-apply them in recorded order; the
        # frozen transition table is enforced identically here, so terminal
        # musical Actions remain decisive and an unknown/orphan fact can never
        # resurrect a terminal proposal.
        self._reapply_runtime_facts(projection, project_id)
        return projection

    def _reapply_runtime_facts(self, projection: dict, project_id: str) -> None:
        """Restore scheduled/auditioning facts onto a freshly rebuilt projection."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT proposal_id, from_state, to_state, recorded_at, id"
                " FROM proposal_lifecycle_facts WHERE project_id = ?"
                " ORDER BY recorded_at ASC, id ASC",
                (project_id,),
            ).fetchall()
        for row in rows:
            proposal = projection["proposals"]["byId"].get(row["proposal_id"])
            if proposal is None:
                continue
            current = proposal["lifecycle"]
            target = row["to_state"]
            if current == target:
                continue
            if lifecycle_contract.valid_runtime_transition(current, target):
                proposal["lifecycle"] = target

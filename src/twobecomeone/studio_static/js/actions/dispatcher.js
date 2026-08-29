// js/actions/dispatcher.js — injected ActionDispatcher.
//
// Part of the V1 Action and DeckTransport foundation (Phase 8C).
// Pure coordination module: no DOM, no audio, no network, no persistence.
// It follows the frozen dispatch order:
//
//   raw request -> validate -> permission/idempotency -> transport fact (optional)
//   -> immutable ledger outcome -> reducer projection -> deep-cloned result
//
// The dispatcher never mutates the StateStore directly; it dispatches reducer
// actions. Runtime work (audio scheduling, clocks, etc.) is explicitly outside
// this module.

import { validateAction, ACTION_TYPES } from './contracts.js';
import { checkPermission } from './permission.js';
import { canTransition, LIFECYCLE_STATES } from './lifecycle.js';
import { resolveNextPhrase } from '../transport/derive.js';
import { V1_ACTION_TYPES, makeProposalRecord, makeCommittedLayer } from './reducers.js';
import { buildFailure, buildSuccess, ERROR_CODES } from './errors.js';
import { compareActions } from './ledger.js';

export class ActionDispatcher {
  /**
   * @param {object} deps
   * @param {import('../state.js').StateStore} deps.store
   * @param {import('./ledger.js').ActionLedger} deps.ledger
   * @param {object} deps.context — { producerPreviewAllowed }
   * @param {() => object} deps.transportFactory — returns raw transport for destination deck (no audio)
   * @param {() => string} deps.timestampFactory
   */
  constructor(deps) {
    if (!deps || !deps.store || !deps.ledger) {
      throw new Error('ActionDispatcher requires store and ledger');
    }
    this.store = deps.store;
    this.ledger = deps.ledger;
    this.context = deps.context || {};
    this.transportFactory = deps.transportFactory || (() => ({
      deck: 'B', playing: false, tempoBpm: 120, beatsPerBar: 4, phraseBars: 8,
      beatAtStart: 0, startedAtAudioTime: 0, gridRevision: 'grid-default',
    }));
    this.timestampFactory = deps.timestampFactory || (() => new Date().toISOString());
  }

  dispatch(rawAction) {
    // 1. Validate contract.
    const validation = validateAction(rawAction);
    if (!validation.ok) {
      return this._result(validation, null);
    }
    const action = validation.value;

    // 2. Permission and idempotency.
    const permission = checkPermission(action, this.context);
    if (!permission.ok) {
      return this._result(permission, null);
    }

    const existing = this.ledger.findByIdempotencyKey(action.idempotencyKey);
    if (existing) {
      const cmp = compareActions(action, existing.action);
      if (!cmp.equal) {
        return this._result(
          buildFailure(ERROR_CODES.I_KEY_REUSED_WITH_DIFFERENT_REQUEST, { reason: cmp.reason }),
          null,
        );
      }
      // Idempotent retry: return deep-cloned existing outcome without mutation.
      return this._result(buildSuccess(this._cloneOutcome(existing)), existing);
    }

    // 3. Lifecycle/proposal lookup for commit/reject.
    const state = this.store.getState();
    if (action.type === ACTION_TYPES.COMMIT_LAYER || action.type === ACTION_TYPES.REJECT_PROPOSAL) {
      const proposal = state.proposals.byId[action.payload.proposalId];
      if (!proposal) {
        return this._result(
          buildFailure(ERROR_CODES.L_UNKNOWN_PROPOSAL, { proposalId: action.payload.proposalId }),
          null,
        );
      }
      if (action.type === ACTION_TYPES.COMMIT_LAYER) {
        if (proposal.lifecycle !== LIFECYCLE_STATES.AUDITIONING) {
          return this._result(
            buildFailure(ERROR_CODES.L_NOT_AUDITIONING, { lifecycle: proposal.lifecycle }),
            null,
          );
        }
      }
    }
    if (action.type === ACTION_TYPES.REVERT_COMMIT) {
      const commitActionId = action.payload.commitActionId;
      if ((state.session.revertedLayers || []).some((layer) => layer.actionId === commitActionId)) {
        return this._result(buildFailure(ERROR_CODES.L_ALREADY_REVERTED), null);
      }
      if (!(state.session.committedLayers || []).some((layer) => layer.actionId === commitActionId)) {
        return this._result(
          buildFailure(ERROR_CODES.L_UNKNOWN_COMMIT, { commitActionId }), null,
        );
      }
    }

    // 4. Optional transport fact for preview_layer.
    let transportFact = null;
    if (action.type === ACTION_TYPES.PREVIEW_LAYER) {
      const rawTransport = this.transportFactory(action.payload.destination.deck);
      const resolved = resolveNextPhrase(rawTransport, this._nowAudioTime());
      if (!resolved.ok) {
        return this._result(resolved, null);
      }
      transportFact = resolved.value;
    }

    // 5. Ledger outcome + reducer projection.
    return this._recordAndProject(action, transportFact);
  }

  /**
   * Test-only lifecycle helper: advance a proposal to a later lifecycle state
   * by emitting a reducer action and a ledger fact. No audio is scheduled.
   */
  advanceLifecycle(proposalId, toState) {
    const state = this.store.getState();
    const proposal = state.proposals.byId[proposalId];
    if (!proposal) {
      return this._result(buildFailure(ERROR_CODES.L_UNKNOWN_PROPOSAL, { proposalId }), null);
    }
    if (!canTransition(proposal.lifecycle, toState)) {
      return this._result(
        buildFailure(ERROR_CODES.L_INVALID_TRANSITION, { from: proposal.lifecycle, to: toState }),
        null,
      );
    }
    this.store.dispatch({
      type: V1_ACTION_TYPES.V1_PROPOSAL_TRANSITION,
      proposalId,
      toState,
    });
    this.ledger.append({
      action: { id: proposalId, type: 'lifecycle_advance' },
      outcome: toState === LIFECYCLE_STATES.AUDITIONING ? 'auditioning' : 'scheduled',
      transportFact: null,
    });
    return this._result(buildSuccess({ proposalId, lifecycle: toState }), null);
  }

  _recordAndProject(action, transportFact) {
    const proposal = makeProposalRecord(action, LIFECYCLE_STATES.READY);

    if (action.type === ACTION_TYPES.PREVIEW_LAYER) {
      this.ledger.append({
        action,
        outcome: 'proposal_created',
        transportFact,
      });
      this.store.dispatch({
        type: V1_ACTION_TYPES.V1_PROPOSAL_RECORD,
        proposal,
      });
      return this._result(buildSuccess({
        proposal,
        launchFact: transportFact,
      }), null);
    }

    if (action.type === ACTION_TYPES.COMMIT_LAYER) {
      const state = this.store.getState();
      const originalProposal = state.proposals.byId[action.payload.proposalId];
      const committedLayer = makeCommittedLayer(action, originalProposal);
      this.ledger.append({
        action,
        outcome: 'committed',
        transportFact,
      });
      this.store.dispatch({
        type: V1_ACTION_TYPES.V1_PROPOSAL_COMMIT_RECORDED,
        proposalId: action.payload.proposalId,
        commitAction: action,
        committedLayer,
      });
      return this._result(buildSuccess({
        proposal: originalProposal,
        committedLayer,
      }), null);
    }

    if (action.type === ACTION_TYPES.REJECT_PROPOSAL) {
      this.ledger.append({
        action,
        outcome: 'rejected',
        rejectionReason: action.payload.reason || null,
      });
      this.store.dispatch({
        type: V1_ACTION_TYPES.V1_PROPOSAL_REJECTED,
        proposalId: action.payload.proposalId,
      });
      return this._result(buildSuccess({ rejected: true }), null);
    }

    if (action.type === ACTION_TYPES.REVERT_COMMIT) {
      this.ledger.append({ action, outcome: 'commit_reverted', transportFact: null });
      this.store.dispatch({
        type: V1_ACTION_TYPES.V1_COMMIT_REVERTED,
        commitActionId: action.payload.commitActionId,
        revertActionId: action.id,
      });
      return this._result(buildSuccess({
        reverted: true,
        commitActionId: action.payload.commitActionId,
      }), null);
    }

    return this._result(buildFailure(ERROR_CODES.X_INTERNAL), null);
  }

  _cloneOutcome(entry) {
    const action = entry.action;
    const proposal = makeProposalRecord(action, LIFECYCLE_STATES.READY);
    return structuredClone({
      proposal,
      outcome: entry.outcome,
      launchFact: entry.transportFact,
    });
  }

  _nowAudioTime() {
    // The dispatcher does NOT read a real clock. Tests inject this or we
    // default to 0; any non-finite value is caught by transport validation.
    return 0;
  }

  _result(result, ledgerEntry) {
    return Object.freeze({
      ok: result.ok,
      ...(result.ok
        ? { value: structuredClone(result.value) }
        : { code: result.code, message: result.message, details: result.details }),
      ledgerEntry: ledgerEntry ? structuredClone(ledgerEntry) : null,
    });
  }
}

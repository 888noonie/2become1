// js/actions/reducers.js — additive V1 reducers for proposals + session.
//
// This module is part of the V1 Action and DeckTransport foundation
// (Phase 8A). It is intentionally pure: no imports from DOM, view, audio,
// fetch, app-context, or any controller. It owns the frozen V1 projection
// slices:
//
//   state.session   = { deckAssignments, committedLayers, acceptedActionIds }
//   state.proposals = { byId, order, activeIds }
//
// Every reducer returns a NEW state object. No reducer mutates its input,
// attaches runtime objects (audio contexts/nodes/buffers/timers/DOM/etc.),
// or stores anything that structuredClone cannot reproduce.
//
// The reducers are pure projections: they take a normalized projection and
// a fact, and return the next projection. The dispatcher (Phase 8C) is the
// only authorized caller; views and components must not call these
// reducers directly.

import {
  ACTION_TYPES,
  SCHEMA_VERSION,
} from './contracts.js';
import { LIFECYCLE_STATES, isLifecycleState } from './lifecycle.js';
import { ERROR_CODES } from './errors.js';

export const V1_ACTION_TYPES = Object.freeze({
  // Lifecycle fact reducers.
  V1_PROPOSAL_RECORD: 'v1/proposal/record',
  V1_PROPOSAL_TRANSITION: 'v1/proposal/transition',
  V1_PROPOSAL_SUPERSEDED: 'v1/proposal/superseded',
  V1_PROPOSAL_REJECTED: 'v1/proposal/rejected',
  V1_PROPOSAL_COMMIT_RECORDED: 'v1/proposal/commit-recorded',
  V1_SESSION_ASSIGN_DECK: 'v1/session/assign-deck',
});

export const V1_INITIAL_SESSION = Object.freeze({
  deckAssignments: Object.freeze({ A: null, B: null }),
  committedLayers: Object.freeze([]),
  acceptedActionIds: Object.freeze([]),
});

export const V1_INITIAL_PROPOSALS = Object.freeze({
  byId: Object.freeze({}),
  order: Object.freeze([]),
  activeIds: Object.freeze([]),
});

function ensureProposalSlots(proposals) {
  if (!proposals || typeof proposals !== 'object') {
    return { byId: {}, order: [], activeIds: [] };
  }
  return {
    byId: proposals.byId || {},
    order: proposals.order || [],
    activeIds: proposals.activeIds || [],
  };
}

function ensureSessionSlots(session) {
  if (!session || typeof session !== 'object') {
    return {
      deckAssignments: { A: null, B: null },
      committedLayers: [],
      acceptedActionIds: [],
    };
  }
  return {
    deckAssignments: session.deckAssignments || { A: null, B: null },
    committedLayers: session.committedLayers || [],
    acceptedActionIds: session.acceptedActionIds || [],
  };
}

function freezeDeep(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeDeep));
  }
  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = freezeDeep(value[key]);
  }
  return Object.freeze(out);
}

function normalizeProposal(action, lifecycle) {
  // Project only the immutable proposal record. We do NOT store the full
  // Action envelope in state — only the durable projection. The dispatcher
  // writes the full action to the ActionLedger separately.
  return {
    id: action.id,
    actionType: action.type,
    actor: { type: action.actor.type, id: action.actor.id },
    requestedAt: action.requestedAt,
    idempotencyKey: action.idempotencyKey,
    lifecycle,
    payload: action.payload,
  };
}

export function reduceV1(state, action) {
  switch (action.type) {
    case V1_ACTION_TYPES.V1_PROPOSAL_RECORD: {
      const { proposal } = action;
      if (!proposal || !proposal.id || !proposal.actionType) return state;
      const proposals = ensureProposalSlots(state.proposals);
      const existing = proposals.byId[proposal.id];
      if (existing) return state; // immutable; ignore duplicate record
      const byId = { ...proposals.byId, [proposal.id]: freezeDeep(proposal) };
      const order = [...proposals.order, proposal.id];
      const activeIds = proposal.lifecycle === LIFECYCLE_STATES.REJECTED
        || proposal.lifecycle === LIFECYCLE_STATES.ACCEPTED
          ? proposals.activeIds
          : [...proposals.activeIds, proposal.id];
      return {
        ...state,
        proposals: { byId, order, activeIds },
      };
    }

    case V1_ACTION_TYPES.V1_PROPOSAL_TRANSITION: {
      const { proposalId, toState } = action;
      if (!proposalId || !isLifecycleState(toState)) return state;
      const proposals = ensureProposalSlots(state.proposals);
      const current = proposals.byId[proposalId];
      if (!current) return state;
      const next = freezeDeep({ ...current, lifecycle: toState });
      const byId = { ...proposals.byId, [proposalId]: next };
      let activeIds = proposals.activeIds;
      if (toState === LIFECYCLE_STATES.REJECTED
          || toState === LIFECYCLE_STATES.ACCEPTED) {
        activeIds = proposals.activeIds.filter((id) => id !== proposalId);
      } else if (!proposals.activeIds.includes(proposalId)) {
        activeIds = [...proposals.activeIds, proposalId];
      }
      return { ...state, proposals: { ...proposals, byId, activeIds } };
    }

    case V1_ACTION_TYPES.V1_PROPOSAL_SUPERSEDED: {
      // A revision creates a new proposal linked by `supersedes`. The
      // previous proposal must not be mutated; we simply mark it superseded
      // in its own projection slot. The new proposal is recorded via the
      // RECORD action.
      const { previousId, revisedId } = action;
      if (!previousId || !revisedId) return state;
      const proposals = ensureProposalSlots(state.proposals);
      const previous = proposals.byId[previousId];
      if (!previous) return state;
      const next = freezeDeep({ ...previous, supersededBy: revisedId });
      const byId = { ...proposals.byId, [previousId]: next };
      return { ...state, proposals: { ...proposals, byId } };
    }

    case V1_ACTION_TYPES.V1_PROPOSAL_REJECTED: {
      const { proposalId } = action;
      if (!proposalId) return state;
      const proposals = ensureProposalSlots(state.proposals);
      const current = proposals.byId[proposalId];
      if (!current) return state;
      const next = freezeDeep({
        ...current,
        lifecycle: LIFECYCLE_STATES.REJECTED,
      });
      const activeIds = proposals.activeIds.filter((id) => id !== proposalId);
      const byId = { ...proposals.byId, [proposalId]: next };
      return { ...state, proposals: { ...proposals, byId, activeIds } };
    }

    case V1_ACTION_TYPES.V1_PROPOSAL_COMMIT_RECORDED: {
      const { proposalId, commitAction, committedLayer } = action;
      if (!proposalId || !commitAction || !committedLayer) return state;
      const proposals = ensureProposalSlots(state.proposals);
      const session = ensureSessionSlots(state.session);
      const current = proposals.byId[proposalId];
      if (!current) return state;
      const next = freezeDeep({
        ...current,
        lifecycle: LIFECYCLE_STATES.ACCEPTED,
        committedActionId: commitAction.id,
      });
      const byId = { ...proposals.byId, [proposalId]: next };
      const activeIds = proposals.activeIds.filter((id) => id !== proposalId);
      const committedLayers = [...session.committedLayers, freezeDeep(committedLayer)];
      const acceptedActionIds = [...session.acceptedActionIds, commitAction.id];
      return {
        ...state,
        proposals: { ...proposals, byId, activeIds },
        session: { ...session, committedLayers, acceptedActionIds },
      };
    }

    case V1_ACTION_TYPES.V1_SESSION_ASSIGN_DECK: {
      const { deck, trackId } = action;
      if (deck !== 'A' && deck !== 'B') return state;
      const session = ensureSessionSlots(state.session);
      const deckAssignments = {
        ...session.deckAssignments,
        [deck]: trackId === undefined ? null : trackId,
      };
      return {
        ...state,
        session: { ...session, deckAssignments },
      };
    }

    default:
      return state;
  }
}

// Helper for tests + dispatcher: produce the normalized projection record
// for an Action that just passed validation. Pure.
export function makeProposalRecord(action, lifecycle = LIFECYCLE_STATES.READY) {
  return normalizeProposal(action, lifecycle);
}

export function makeCommittedLayer(commitAction, proposal) {
  if (!commitAction || !proposal) return null;
  return Object.freeze({
    layerId: `layer-${commitAction.id}`,
    actionId: commitAction.id,
    actionType: commitAction.type,
    actionSchemaVersion: SCHEMA_VERSION,
    proposalId: proposal.id,
    sourceRegionRef: freezeDeep(proposal.payload.source.region),
    acceptedAsset: freezeDeep({
      id: commitAction.payload.acceptedAsset.id,
      contentHash: commitAction.payload.acceptedAsset.contentHash,
      transformSpec: commitAction.payload.acceptedAsset.transformSpec,
    }),
    transformSpec: freezeDeep(commitAction.payload.acceptedAsset.transformSpec),
    placement: freezeDeep({
      source: proposal.payload.source,
      destination: proposal.payload.destination,
      timing: proposal.payload.timing,
      gainDb: proposal.payload.gainDb,
    }),
    acceptedAt: commitAction.payload.acceptedAt,
    acceptedBy: freezeDeep(commitAction.actor),
  });
}

export { ERROR_CODES };

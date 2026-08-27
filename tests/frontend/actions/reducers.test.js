// tests/frontend/actions/reducers.test.js — V1 additive reducers.
//
// Phase 8A acceptance: reducers are pure, return new state, and never store
// runtime objects. Validation, permission, and lifecycle rejections leave
// the projection unchanged (zero-mutation invariant).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  V1_ACTION_TYPES,
  V1_INITIAL_SESSION,
  V1_INITIAL_PROPOSALS,
  makeProposalRecord,
  makeCommittedLayer,
  reduceV1,
} from '../../../src/twobecomeone/studio_static/js/actions/reducers.js';
import { LIFECYCLE_STATES } from '../../../src/twobecomeone/studio_static/js/actions/lifecycle.js';
import { ACTION_TYPES } from '../../../src/twobecomeone/studio_static/js/actions/contracts.js';

function previewAction(id = 'a-1', overrides = {}) {
  return {
    id,
    schemaVersion: 1,
    type: ACTION_TYPES.PREVIEW_LAYER,
    actor: { type: 'human', id: 'richard' },
    requestedAt: '2026-08-27T00:00:00Z',
    idempotencyKey: `key-${id}`,
    payload: {
      source: {
        deck: 'A', stem: 'vocal',
        region: {
          id: 'chorus_2', startBeat: 16, endBeat: 32, gridRevision: 'g-1',
        },
      },
      destination: { deck: 'B' },
      timing: { launch: 'next_phrase', quantize: true },
      gainDb: -3,
    },
    ...overrides,
  };
}

function commitAction(id = 'a-2', proposalId = 'a-1') {
  return {
    id,
    schemaVersion: 1,
    type: ACTION_TYPES.COMMIT_LAYER,
    actor: { type: 'human', id: 'richard' },
    requestedAt: '2026-08-27T00:00:01Z',
    idempotencyKey: `key-${id}`,
    payload: {
      proposalId,
      acceptedAt: '2026-08-27T00:00:02Z',
      acceptedAsset: {
        id: 'asset-1',
        contentHash: 'sha256:abc',
        transformSpec: { gainDb: -3, startBeat: 16 },
      },
    },
  };
}

function baseState() {
  return {
    session: structuredClone(V1_INITIAL_SESSION),
    proposals: structuredClone(V1_INITIAL_PROPOSALS),
  };
}

test('initial slices are empty and serializable', () => {
  const s = baseState();
  assert.deepEqual(s.session.deckAssignments, { A: null, B: null });
  assert.deepEqual(s.session.committedLayers, []);
  assert.deepEqual(s.session.acceptedActionIds, []);
  assert.deepEqual(s.proposals.byId, {});
  assert.deepEqual(s.proposals.order, []);
  assert.deepEqual(s.proposals.activeIds, []);
});

test('record adds proposal to byId, order, and activeIds (ready)', () => {
  const action = previewAction();
  const proposal = makeProposalRecord(action, LIFECYCLE_STATES.READY);
  const next = reduceV1(baseState(), {
    type: V1_ACTION_TYPES.V1_PROPOSAL_RECORD,
    proposal,
  });
  assert.equal(next.proposals.byId[action.id].lifecycle, 'ready');
  assert.deepEqual(next.proposals.order, [action.id]);
  assert.deepEqual(next.proposals.activeIds, [action.id]);
});

test('record is idempotent: duplicate record is a no-op', () => {
  const action = previewAction();
  const proposal = makeProposalRecord(action, LIFECYCLE_STATES.READY);
  const s1 = reduceV1(baseState(), {
    type: V1_ACTION_TYPES.V1_PROPOSAL_RECORD,
    proposal,
  });
  const s2 = reduceV1(s1, {
    type: V1_ACTION_TYPES.V1_PROPOSAL_RECORD,
    proposal,
  });
  assert.equal(s2, s1);
});

test('transition moves lifecycle state and trims activeIds on terminal', () => {
  const action = previewAction();
  const proposal = makeProposalRecord(action, LIFECYCLE_STATES.READY);
  let s = reduceV1(baseState(), {
    type: V1_ACTION_TYPES.V1_PROPOSAL_RECORD,
    proposal,
  });
  s = reduceV1(s, {
    type: V1_ACTION_TYPES.V1_PROPOSAL_TRANSITION,
    proposalId: action.id, toState: 'scheduled',
  });
  assert.equal(s.proposals.byId[action.id].lifecycle, 'scheduled');
  assert.deepEqual(s.proposals.activeIds, [action.id]);

  s = reduceV1(s, {
    type: V1_ACTION_TYPES.V1_PROPOSAL_TRANSITION,
    proposalId: action.id, toState: 'auditioning',
  });
  assert.equal(s.proposals.byId[action.id].lifecycle, 'auditioning');

  s = reduceV1(s, {
    type: V1_ACTION_TYPES.V1_PROPOSAL_TRANSITION,
    proposalId: action.id, toState: 'accepted',
  });
  assert.equal(s.proposals.byId[action.id].lifecycle, 'accepted');
  assert.deepEqual(s.proposals.activeIds, []);
});

test('superseded adds supersededBy without mutating the previous proposal fields', () => {
  const a = previewAction('a-1');
  const b = previewAction('a-2');
  const pa = makeProposalRecord(a, LIFECYCLE_STATES.READY);
  const pb = makeProposalRecord(b, LIFECYCLE_STATES.READY);
  let s = reduceV1(baseState(), {
    type: V1_ACTION_TYPES.V1_PROPOSAL_RECORD, proposal: pa,
  });
  s = reduceV1(s, {
    type: V1_ACTION_TYPES.V1_PROPOSAL_RECORD, proposal: pb,
  });
  const before = structuredClone(s.proposals.byId['a-1']);
  s = reduceV1(s, {
    type: V1_ACTION_TYPES.V1_PROPOSAL_SUPERSEDED,
    previousId: 'a-1', revisedId: 'a-2',
  });
  assert.equal(s.proposals.byId['a-1'].supersededBy, 'a-2');
  // The previous record's musical fields must be untouched.
  assert.equal(s.proposals.byId['a-1'].payload.gainDb, before.payload.gainDb);
  assert.equal(s.proposals.byId['a-1'].payload.source.deck, before.payload.source.deck);
});

test('commit-recorded retains proposal and adds a CommittedLayer with regionRef + asset', () => {
  const action = previewAction();
  const proposal = makeProposalRecord(action, LIFECYCLE_STATES.AUDITIONING);
  let s = reduceV1(baseState(), {
    type: V1_ACTION_TYPES.V1_PROPOSAL_RECORD, proposal,
  });
  const commit = commitAction('a-commit', action.id);
  const layer = makeCommittedLayer(commit, proposal);
  s = reduceV1(s, {
    type: V1_ACTION_TYPES.V1_PROPOSAL_COMMIT_RECORDED,
    proposalId: action.id,
    commitAction: commit,
    committedLayer: layer,
  });

  // proposal retained, lifecycle is accepted
  assert.equal(s.proposals.byId[action.id].lifecycle, 'accepted');
  assert.deepEqual(s.proposals.activeIds, []);

  // first-class committed layer
  assert.equal(s.session.committedLayers.length, 1);
  const L = s.session.committedLayers[0];
  assert.equal(L.actionId, commit.id);
  assert.equal(L.proposalId, action.id);
  assert.equal(L.sourceRegionRef.id, 'chorus_2');
  assert.equal(L.sourceRegionRef.startBeat, 16);
  assert.equal(L.sourceRegionRef.endBeat, 32);
  assert.equal(L.acceptedAsset.id, 'asset-1');
  assert.equal(L.acceptedAsset.contentHash, 'sha256:abc');
  assert.deepEqual(L.placement, {
    source: { deck: 'A', stem: 'vocal', region: action.payload.source.region },
    destination: { deck: 'B' },
    timing: { launch: 'next_phrase', quantize: true },
    gainDb: -3,
  });
  assert.deepEqual(s.session.acceptedActionIds, [commit.id]);
});

test('unknown v1 action types return state unchanged', () => {
  const s = baseState();
  const before = structuredClone(s);
  const next = reduceV1(s, { type: 'v1/some-other', payload: { who: 'cares' } });
  assert.equal(next, s);
  assert.deepEqual(next, before);
});

test('session deck assignment is pure and structural on reassign', () => {
  let s = baseState();
  s = reduceV1(s, {
    type: V1_ACTION_TYPES.V1_SESSION_ASSIGN_DECK,
    deck: 'A', trackId: 'track-1',
  });
  assert.equal(s.session.deckAssignments.A, 'track-1');
  assert.equal(s.session.deckAssignments.B, null);

  // Re-assigning with the same value leaves the value identical. The
  // reducer is still pure: it does not mutate; the input state is not
  // modified by reference.
  const before = JSON.stringify(s.session);
  const s2 = reduceV1(s, {
    type: V1_ACTION_TYPES.V1_SESSION_ASSIGN_DECK,
    deck: 'A', trackId: 'track-1',
  });
  assert.equal(JSON.stringify(s2.session), before);
  assert.equal(s2.session.deckAssignments.A, 'track-1');
});

test('reducer rejects deck values outside A/B', () => {
  const s = baseState();
  const next = reduceV1(s, {
    type: V1_ACTION_TYPES.V1_SESSION_ASSIGN_DECK,
    deck: 'C', trackId: 'x',
  });
  assert.equal(next, s);
});

test('reducer accepts bus assignment explicitly null', () => {
  let s = baseState();
  s = reduceV1(s, {
    type: V1_ACTION_TYPES.V1_SESSION_ASSIGN_DECK,
    deck: 'A', trackId: 'track-1',
  });
  const next = reduceV1(s, {
    type: V1_ACTION_TYPES.V1_SESSION_ASSIGN_DECK,
    deck: 'A', trackId: null,
  });
  assert.equal(next.session.deckAssignments.A, null);
});

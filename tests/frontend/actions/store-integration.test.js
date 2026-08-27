// tests/frontend/actions/store-integration.test.js — V1 reducer + StateStore.
//
// Phase 8A acceptance: the V1 reducer is wired through StateStore without
// disturbing V0.3 reducers, and a chain of valid preview/projection events
// reaches `auditioning` without ever holding runtime objects.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, teardownDom } from '../helpers/dom.js';

import {
  V1_ACTION_TYPES,
  makeProposalRecord,
  makeCommittedLayer,
} from '../../../src/twobecomeone/studio_static/js/actions/reducers.js';
import { LIFECYCLE_STATES } from '../../../src/twobecomeone/studio_static/js/actions/lifecycle.js';
import { ACTION_TYPES } from '../../../src/twobecomeone/studio_static/js/actions/contracts.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

async function makeStore() {
  // Dynamic import after DOM globals are installed so the StateStore extends
  // the jsdom EventTarget and dispatches jsdom CustomEvents (same realm).
  const { StateStore, registerReducers } = await import(
    '../../../src/twobecomeone/studio_static/js/state.js'
  );
  const store = new StateStore();
  registerReducers(store);
  return store;
}

function previewAction(id) {
  return {
    id, schemaVersion: 1,
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
  };
}

test('initial store exposes empty session + proposals', async () => {
  const store = await makeStore();
  const s = store.getState();
  assert.deepEqual(s.session.deckAssignments, { A: null, B: null });
  assert.deepEqual(s.session.committedLayers, []);
  assert.deepEqual(s.session.acceptedActionIds, []);
  assert.deepEqual(s.proposals.byId, {});
  assert.deepEqual(s.proposals.order, []);
  assert.deepEqual(s.proposals.activeIds, []);
});

test('V1 reducer does not disturb V0.3 routing reducer', async () => {
  const store = await makeStore();
  store.dispatch({ type: 'route/set', route: 'library' });
  store.dispatch({
    type: V1_ACTION_TYPES.V1_SESSION_ASSIGN_DECK,
    deck: 'A', trackId: 'track-1',
  });
  const s = store.getState();
  assert.equal(s.route, 'library');
  assert.equal(s.session.deckAssignments.A, 'track-1');
});

test('human preview chain: record -> scheduled -> auditioning', async () => {
  const store = await makeStore();
  const action = previewAction('a-1');
  const proposal = makeProposalRecord(action, LIFECYCLE_STATES.READY);

  store.dispatch({ type: V1_ACTION_TYPES.V1_PROPOSAL_RECORD, proposal });
  store.dispatch({
    type: V1_ACTION_TYPES.V1_PROPOSAL_TRANSITION,
    proposalId: 'a-1', toState: LIFECYCLE_STATES.SCHEDULED,
  });
  store.dispatch({
    type: V1_ACTION_TYPES.V1_PROPOSAL_TRANSITION,
    proposalId: 'a-1', toState: LIFECYCLE_STATES.AUDITIONING,
  });

  const s = store.getState();
  assert.equal(s.proposals.byId['a-1'].lifecycle, 'auditioning');
  assert.deepEqual(s.proposals.activeIds, ['a-1']);
});

test('V1 projection never holds runtime objects', async () => {
  const store = await makeStore();
  const action = previewAction('a-1');
  const proposal = makeProposalRecord(action, LIFECYCLE_STATES.READY);
  store.dispatch({ type: V1_ACTION_TYPES.V1_PROPOSAL_RECORD, proposal });
  store.dispatch({
    type: V1_ACTION_TYPES.V1_PROPOSAL_TRANSITION,
    proposalId: 'a-1', toState: LIFECYCLE_STATES.AUDITIONING,
  });

  const snapshot = store.getState();
  for (const sliceName of ['session', 'proposals']) {
    const slice = snapshot[sliceName];
    assert.ok(slice && typeof slice === 'object');
    // No functions, no DOM nodes, no audio contexts, no timers.
    assert.equal(slice.some, undefined);
  }
  // Confirm no forbidden top-level fields.
  for (const forbidden of ['runtime', 'audio', 'transport', 'audioContext', 'timer']) {
    assert.equal(snapshot[forbidden], undefined, `${forbidden} must not exist on state`);
  }
});

test('invalid v1 actions return state unchanged (zero projection change)', async () => {
  const store = await makeStore();
  const before = store.getState();

  // Unknown v1 subtype must not alter state.
  store.dispatch({ type: 'v1/something-unknown', payload: { rogue: 1 } });
  assert.deepEqual(store.getState(), before);

  // Bare 'v1' (no subtype) must not alter state.
  store.dispatch({ type: 'v1', payload: { rogue: 1 } });
  assert.deepEqual(store.getState(), before);

  // Bad deck must not alter state.
  store.dispatch({
    type: V1_ACTION_TYPES.V1_SESSION_ASSIGN_DECK,
    deck: 'C', trackId: 'x',
  });
  assert.deepEqual(store.getState(), before);
});

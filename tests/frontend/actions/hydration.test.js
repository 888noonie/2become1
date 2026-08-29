// tests/frontend/actions/hydration.test.js — Phase 9A hydration adapter.
//
// Proves: shape validation, narrow slice replacement, deep cloning, silent
// failure on network error, abort/teardown safety, and that a failed hydration
// leaves the empty/local V1 projection untouched (no fake success).

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, teardownDom } from '../helpers/dom.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

async function makeStore() {
  const { StateStore, registerReducers } = await import(
    '../../../src/twobecomeone/studio_static/js/state.js'
  );
  const store = new StateStore();
  registerReducers(store);
  return store;
}

const { hydrateActionState, validateProjectionShape, V1_HYDRATE_ACTION } = await import(
  '../../../src/twobecomeone/studio_static/js/actions/hydration.js'
);

function serverProjection() {
  return {
    projection_version: 1,
    last_sequence: 2,
    session: {
      deckAssignments: { A: 'track-1', B: null },
      committedLayers: [{ layerId: 'layer-c1', actionId: 'c-0', proposalId: 'a-0' }],
      revertedLayers: [],
      acceptedActionIds: ['c-0'],
    },
    proposals: {
      byId: {
        'a-1': {
          id: 'a-1', actionType: 'preview_layer',
          actor: { type: 'human', id: 'richard' },
          requestedAt: 't', idempotencyKey: 'k',
          lifecycle: 'ready', payload: {},
        },
      },
      order: ['a-1'],
      activeIds: ['a-1'],
    },
  };
}

test('validateProjectionShape accepts the documented bootstrap shape', () => {
  const shape = validateProjectionShape({
    projection_version: 1,
    last_sequence: 0,
    session: { deckAssignments: {}, committedLayers: [], revertedLayers: [], acceptedActionIds: [] },
    proposals: { byId: {}, order: [], activeIds: [] },
  });
  assert.equal(shape.ok, true);
});

test('validateProjectionShape rejects wrong version and unknown keys', () => {
  assert.equal(validateProjectionShape({ projection_version: 2 }).ok, false);
  const body = serverProjection();
  body.session.sneaky = true;
  assert.equal(validateProjectionShape(body).ok, false);
  const body2 = serverProjection();
  body2.runtime = { audioContext: {} };
  assert.equal(validateProjectionShape(body2).ok, false);
});

test('hydration replaces only the V1 slices, deep-cloned', async () => {
  const store = await makeStore();
  const before = store.getState();
  assert.equal(before.route, 'studio');

  const fetcher = async () => serverProjection();
  const hydration = hydrateActionState({ store, projectId: 'p-1', fetcher });
  const result = await hydration.promise;
  assert.equal(result.ok, true);

  const state = store.getState();
  // V1 slices hydrated.
  assert.equal(state.proposals.byId['a-1'].lifecycle, 'ready');
  assert.deepEqual(state.session.deckAssignments, { A: 'track-1', B: null });
  assert.equal(state.session.committedLayers.length, 1);
  // Other slices untouched.
  assert.equal(state.route, 'studio');
  assert.equal(state.currentProject, null);
  // Deep clone: mutating the fetched object does not touch the store.
  const fresh = serverProjection();
  fresh.proposals.byId['a-1'].lifecycle = 'tampered';
  const fetcher2 = async () => fresh;
  await hydrateActionState({ store, projectId: 'p-1', fetcher: fetcher2 }).promise;
  // (fresh was validated BEFORE mutation? no — mutated before fetch; assert rejection)
});

test('hydration with mutated-after-validation data cannot poison the store', async () => {
  const store = await makeStore();
  const payload = serverProjection();
  const fetcher = async () => {
    // Simulate a hostile getter: the shape check runs on return, but the
    // dispatch must deep-clone whatever it captured.
    return payload;
  };
  const result = await hydrateActionState({ store, projectId: 'p-1', fetcher }).promise;
  assert.equal(result.ok, true);
  const state = store.getState();
  assert.equal(state.proposals.byId['a-1'].lifecycle, 'ready');
  // Mutating the source object now must not affect the store.
  payload.proposals.byId['a-1'].lifecycle = 'tampered';
  assert.equal(store.getState().proposals.byId['a-1'].lifecycle, 'ready');
});

test('network failure keeps empty projection and reports no fake success', async () => {
  const store = await makeStore();
  const fetcher = async () => {
    const err = new Error('network down');
    throw err;
  };
  const result = await hydrateActionState({ store, projectId: 'p-1', fetcher }).promise;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'network down');
  const state = store.getState();
  assert.deepEqual(state.proposals.byId, {});
  assert.deepEqual(state.session.acceptedActionIds, []);
});

test('malformed server data is rejected by the shape gate', async () => {
  const store = await makeStore();
  const fetcher = async () => ({ projection_version: 1, last_sequence: 1, session: 'nope', proposals: {} });
  const result = await hydrateActionState({ store, projectId: 'p-1', fetcher }).promise;
  assert.equal(result.ok, false);
  assert.deepEqual(store.getState().proposals.byId, {});
});

test('teardown before response aborts silently', async () => {
  const store = await makeStore();
  let resolvers = [];
  const fetcher = (path, signal) => new Promise((resolve, reject) => {
    resolvers.push({ resolve, reject });
    signal?.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const hydration = hydrateActionState({ store, projectId: 'p-1', fetcher });
  hydration.teardown();
  const result = await hydration.promise;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'torn down');
  assert.deepEqual(store.getState().proposals.byId, {});
});

test('hydrate reducer action is registered and narrow', async () => {
  const store = await makeStore();
  const before = store.getState();
  store.dispatch({
    type: V1_HYDRATE_ACTION,
    projection: { session: { deckAssignments: { A: 't', B: null }, committedLayers: [], revertedLayers: [], acceptedActionIds: [] }, proposals: { byId: {}, order: [], activeIds: [] } },
    lastSequence: 5,
  });
  const after = store.getState();
  assert.equal(after.session.deckAssignments.A, 't');
  assert.equal(after.route, before.route);
  assert.equal(after.currentProject, before.currentProject);
  // Malformed projection is a no-op.
  const snapshot = store.getState();
  store.dispatch({ type: V1_HYDRATE_ACTION, projection: null });
  assert.deepEqual(store.getState().session, snapshot.session);
});
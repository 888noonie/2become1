// tests/frontend/actions/ghost-api.test.js — Phase 10B api client + hydration
// lifecycle tests. Fetch is stubbed globally (Node 22+ has fetch, but tests
// must not touch a network); the envelope error code mapping is the contract.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLifecycleBody,
  buildPreviewAction,
  buildRejectAction,
  postProjectAction,
  postProposalLifecycle,
} from '../../../src/twobecomeone/studio_static/js/api.js';
import { hydrateActionState } from '../../../src/twobecomeone/studio_static/js/actions/hydration.js';

// ---------------------------------------------------------------------------
// Minimal fetch stub
// ---------------------------------------------------------------------------

function stubFetch(responses) {
  const calls = [];
  globalThis.fetch = async (path, options = {}) => {
    if (options.signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    calls.push({ path, options });
    const entry = responses.find((r) =>
      typeof r.match === 'function' ? r.match(path, options) : path.includes(r.match),
    );
    if (!entry) throw new Error(`unexpected fetch: ${path}`);
    if (entry.throw) throw entry.throw;
    return {
      ok: entry.status === undefined || (entry.status >= 200 && entry.status < 300),
      status: entry.status ?? 200,
      json: async () => entry.body,
    };
  };
  return calls;
}

test.afterEach(() => {
  delete globalThis.fetch;
});

// ---------------------------------------------------------------------------
// Action / lifecycle client
// ---------------------------------------------------------------------------

test('postProjectAction posts and returns the body', async () => {
  const calls = stubFetch([
    { match: '/actions', body: { outcome: {}, sequence: 1 } },
  ]);
  const action = { id: 'a-1', type: 'preview_layer' };
  const result = await postProjectAction('p1', action);
  assert.equal(result.sequence, 1);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), action);
});

test('postProjectAction maps the envelope code onto err.code', async () => {
  stubFetch([
    {
      match: '/actions',
      status: 422,
      body: { error: { code: 'S_STEM_UNAVAILABLE', message: 'Separate vocals first.' } },
    },
  ]);
  await assert.rejects(
    () => postProjectAction('p1', { id: 'a-1' }),
    (err) => err.code === 'S_STEM_UNAVAILABLE' && err.status === 422,
  );
});

test('postProposalLifecycle posts to the scoped route', async () => {
  const calls = stubFetch([
    { match: '/proposals/a-1/lifecycle', body: { outcome: 'lifecycle_recorded' } },
  ]);
  const body = buildLifecycleBody('scheduled');
  const result = await postProposalLifecycle('p1', 'a-1', body);
  assert.equal(result.outcome, 'lifecycle_recorded');
  assert.ok(calls[0].path.endsWith('/api/projects/p1/proposals/a-1/lifecycle'));
  assert.deepEqual(JSON.parse(calls[0].options.body), body);
});

test('buildPreviewAction builds the frozen human envelope', () => {
  const action = buildPreviewAction({ region: { id: 'r1', startBeat: 0, endBeat: 8 }, gainDb: -3 });
  assert.equal(action.type, 'preview_layer');
  assert.equal(action.schemaVersion, 1);
  assert.equal(action.actor.type, 'human');
  assert.equal(action.payload.source.deck, 'A');
  assert.equal(action.payload.source.stem, 'vocal');
  assert.equal(action.payload.destination.deck, 'B');
  assert.equal(action.payload.timing.launch, 'next_phrase');
  assert.equal(action.payload.timing.quantize, true);
  assert.equal(action.payload.gainDb, -3);
  assert.ok(action.id && action.idempotencyKey);
});

test('buildRejectAction targets the proposal with a human actor', () => {
  const action = buildRejectAction('a-1', 'released');
  assert.equal(action.type, 'reject_proposal');
  assert.equal(action.payload.proposalId, 'a-1');
  assert.equal(action.payload.reason, 'released');
  assert.equal(action.actor.type, 'human');
});

// ---------------------------------------------------------------------------
// Hydration lifecycle with the ProjectManager-level wiring
// ---------------------------------------------------------------------------

function validProjection() {
  return {
    projection_version: 1,
    last_sequence: 2,
    session: { deckAssignments: { A: null, B: null }, committedLayers: [], acceptedActionIds: [] },
    proposals: {
      byId: { 'a-9': { id: 'a-9', lifecycle: 'scheduled' } },
      order: ['a-9'],
      activeIds: ['a-9'],
    },
  };
}

test('hydration resolves ok and dispatches the projection', async () => {
  stubFetch([{ match: '/action-state', body: validProjection() }]);
  const dispatched = [];
  const store = { dispatch: (a) => dispatched.push(a) };
  const hydration = hydrateActionState({ store, projectId: 'p1' });
  const result = await hydration.promise;
  assert.equal(result.ok, true);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, 'v1/hydrate-projection');
});

test('hydration failure reports ok:false without dispatching', async () => {
  stubFetch([
    { match: '/action-state', status: 500, body: { error: { code: 'boom' } } },
  ]);
  const dispatched = [];
  const store = { dispatch: (a) => dispatched.push(a) };
  const hydration = hydrateActionState({ store, projectId: 'p1' });
  const result = await hydration.promise;
  assert.equal(result.ok, false);
  assert.equal(dispatched.length, 0);
});

test('hydration teardown aborts and reports no fake success', async () => {
  let sawAbort = false;
  const calls = [];
  globalThis.fetch = async (path, options = {}) => {
    if (options.signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    calls.push({ path, signal: options.signal });
    return await new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };
  const store = { dispatch: () => {} };
  const hydration = hydrateActionState({ store, projectId: 'p1' });
  hydration.teardown();
  const result = await hydration.promise;
  assert.equal(result.ok, false);
});
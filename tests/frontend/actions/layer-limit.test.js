// tests/frontend/actions/layer-limit.test.js — Phase 12A.0 frontend parity.
//
// The single committed-layer live-action gate mirrors the server's
// L_LAYER_LIMIT: a second live commit while a committed layer exists fails
// with the stable code, leaves zero projection/ledger change, an idempotent
// retry of the SAME commit envelope still returns its durable success, and
// a revert frees the slot for a new commit.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, teardownDom } from '../helpers/dom.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

async function makeDeps() {
  const [{ StateStore, registerReducers }] = await Promise.all([
    import('../../../src/twobecomeone/studio_static/js/state.js'),
  ]);
  const { ActionLedger } = await import('../../../src/twobecomeone/studio_static/js/actions/ledger.js');
  const { ActionDispatcher } = await import('../../../src/twobecomeone/studio_static/js/actions/dispatcher.js');
  const store = new StateStore();
  registerReducers(store);

  let entryCounter = 0;
  const ledger = new ActionLedger({
    idFactory: () => `entry-${++entryCounter}`,
    timestampFactory: () => '2026-09-02T00:00:00Z',
  });
  const dispatcher = new ActionDispatcher({
    store,
    ledger,
    context: {},
    transportFactory: (deck) => ({
      deck,
      playing: true,
      tempoBpm: 120,
      beatsPerBar: 4,
      phraseBars: 8,
      beatAtStart: 0,
      startedAtAudioTime: 0,
      gridRevision: 'grid-1',
    }),
    timestampFactory: () => '2026-09-02T00:00:00Z',
  });
  return { store, ledger, dispatcher };
}

function previewAction(overrides = {}) {
  return {
    id: 'a-1',
    schemaVersion: 1,
    type: 'preview_layer',
    actor: { type: 'human', id: 'richard' },
    requestedAt: '2026-09-02T00:00:00Z',
    idempotencyKey: 'key-1',
    payload: {
      source: {
        deck: 'A', stem: 'vocal',
        region: { id: 'chorus_2', startBeat: 16, endBeat: 32, gridRevision: 'grid-1' },
      },
      destination: { deck: 'B' },
      timing: { launch: 'next_phrase', quantize: true },
      gainDb: -3,
    },
    ...overrides,
  };
}

function commitAction(proposalId = 'a-1', overrides = {}) {
  return {
    id: 'a-2',
    schemaVersion: 1,
    type: 'commit_layer',
    actor: { type: 'human', id: 'richard' },
    requestedAt: '2026-09-02T00:00:01Z',
    idempotencyKey: 'key-2',
    payload: {
      proposalId,
      acceptedAt: '2026-09-02T00:00:02Z',
      acceptedAsset: {
        id: 'asset-1',
        contentHash: 'sha256:abc',
        transformSpec: { gainDb: -3, startBeat: 16 },
      },
      ...overrides.payload,
    },
    ...overrides,
  };
}

function revertAction(commitActionId = 'a-2', overrides = {}) {
  return {
    id: 'a-4',
    schemaVersion: 1,
    type: 'revert_commit',
    actor: { type: 'human', id: 'richard' },
    requestedAt: '2026-09-02T00:00:04Z',
    idempotencyKey: 'key-4',
    payload: { commitActionId, revertedAt: '2026-09-02T00:00:05Z' },
    ...overrides,
  };
}

/** Drive a second fully-legal preview -> auditioning -> commit attempt. */
function driveSecondCommit(dispatcher, id = 'a-x', key = `key-${id}`) {
  const preview = dispatcher.dispatch(previewAction({
    id, idempotencyKey: `${key}-p`,
  }));
  if (!preview.ok) return preview;
  dispatcher.advanceLifecycle(id, 'scheduled');
  dispatcher.advanceLifecycle(id, 'auditioning');
  return dispatcher.dispatch(commitAction(id, {
    id: `c-${id}`, idempotencyKey: `${key}-c`,
  }));
}

test('second live commit while a committed layer exists fails L_LAYER_LIMIT', async () => {
  const { store, ledger, dispatcher } = await makeDeps();
  // First full provenance: preview -> scheduled -> auditioning -> commit.
  assert.equal(dispatcher.dispatch(previewAction()).ok, true);
  dispatcher.advanceLifecycle('a-1', 'scheduled');
  dispatcher.advanceLifecycle('a-1', 'auditioning');
  assert.equal(dispatcher.dispatch(commitAction('a-1')).ok, true);
  assert.equal(store.getState().session.committedLayers.length, 1);

  // Second provenance chain on a fresh proposal.
  const second = driveSecondCommit(dispatcher, 'a-9', 'key-9');
  assert.equal(second.ok, false);
  assert.equal(second.code, 'L_LAYER_LIMIT');

  // Zero projection/ledger change from the failed commit.
  assert.equal(store.getState().session.committedLayers.length, 1);
  assert.equal(store.getState().proposals.byId['a-9'].lifecycle, 'auditioning');
  const committedEntries = ledger.entries().filter((e) => e.outcome === 'committed');
  assert.equal(committedEntries.length, 1);
});

test('idempotent retry of the SAME commit envelope is still its durable success', async () => {
  const { store, dispatcher } = await makeDeps();
  assert.equal(dispatcher.dispatch(previewAction()).ok, true);
  dispatcher.advanceLifecycle('a-1', 'scheduled');
  dispatcher.advanceLifecycle('a-1', 'auditioning');
  const action = commitAction('a-1');
  assert.equal(dispatcher.dispatch(action).ok, true);
  // Same id/idempotencyKey/payload: replay returns the original outcome.
  const retry = dispatcher.dispatch(action);
  assert.equal(retry.ok, true);
  assert.equal(store.getState().session.committedLayers.length, 1);
});

test('revert frees the single-layer slot for a new commit', async () => {
  const { store, dispatcher } = await makeDeps();
  assert.equal(dispatcher.dispatch(previewAction()).ok, true);
  dispatcher.advanceLifecycle('a-1', 'scheduled');
  dispatcher.advanceLifecycle('a-1', 'auditioning');
  assert.equal(dispatcher.dispatch(commitAction('a-1')).ok, true);
  assert.equal(dispatcher.dispatch(revertAction('a-2')).ok, true);
  assert.equal(store.getState().session.committedLayers.length, 0);

  const second = driveSecondCommit(dispatcher, 'a-9', 'key-9');
  assert.equal(second.ok, true);
  assert.equal(store.getState().session.committedLayers.length, 1);
});

test('L_LAYER_LIMIT error code and message exist in the frozen table', async () => {
  const { ERROR_CODES, buildFailure } = await import(
    '../../../src/twobecomeone/studio_static/js/actions/errors.js'
  );
  assert.equal(ERROR_CODES.L_LAYER_LIMIT, 'L_LAYER_LIMIT');
  const failure = buildFailure('L_LAYER_LIMIT');
  assert.equal(failure.code, 'L_LAYER_LIMIT');
  assert.ok(failure.message.length > 0);
});
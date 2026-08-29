// tests/frontend/actions/dispatcher.test.js — injected dispatcher + ledger provenance proof.
//
// Phase 8C acceptance: the dispatcher follows the frozen order; human preview
// creates a proposal and optional launch fact; human commit requires
// auditioning, retains the proposal, appends a distinct ledger record, and
// creates a first-class CommittedLayer with semantic sourceRegionRef + immutable
// accepted asset. Producer cannot commit; idempotent retry works; rejected
// provenance stays in history.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, teardownDom } from '../helpers/dom.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

async function makeDeps(overrides = {}) {
  const [{ StateStore, registerReducers }] = await Promise.all([
    import('../../../src/twobecomeone/studio_static/js/state.js'),
  ]);
  const { ActionLedger } = await import('../../../src/twobecomeone/studio_static/js/actions/ledger.js');
  const { ActionDispatcher } = await import('../../../src/twobecomeone/studio_static/js/actions/dispatcher.js');
  const store = new StateStore();
  registerReducers(store);

  let entryCounter = 0;
  let nowAudioTime = 0;

  const ledger = new ActionLedger({
    idFactory: () => `entry-${++entryCounter}`,
    timestampFactory: () => '2026-08-27T00:00:00Z',
  });

  const dispatcher = new ActionDispatcher({
    store,
    ledger,
    context: overrides.context || {},
    transportFactory: overrides.transportFactory || ((deck) => ({
      deck,
      playing: true,
      tempoBpm: 120,
      beatsPerBar: 4,
      phraseBars: 8,
      beatAtStart: 0,
      startedAtAudioTime: 0,
      gridRevision: 'grid-1',
    })),
    timestampFactory: () => '2026-08-27T00:00:00Z',
  });
  // Allow tests to override the audio-time used for launch resolution.
  dispatcher._nowAudioTime = () => nowAudioTime;
  dispatcher._setNowAudioTime = (t) => { nowAudioTime = t; };

  return { store, ledger, dispatcher };
}

function previewAction(overrides = {}) {
  return {
    id: 'a-1',
    schemaVersion: 1,
    type: 'preview_layer',
    actor: { type: 'human', id: 'richard' },
    requestedAt: '2026-08-27T00:00:00Z',
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
    requestedAt: '2026-08-27T00:00:01Z',
    idempotencyKey: 'key-2',
    payload: {
      proposalId,
      acceptedAt: '2026-08-27T00:00:02Z',
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

function rejectAction(proposalId = 'a-1') {
  return {
    id: 'a-3',
    schemaVersion: 1,
    type: 'reject_proposal',
    actor: { type: 'human', id: 'richard' },
    requestedAt: '2026-08-27T00:00:03Z',
    idempotencyKey: 'key-3',
    payload: {
      proposalId,
      rejectedAt: '2026-08-27T00:00:04Z',
      reason: 'nope',
    },
  };
}

function revertAction(overrides = {}) {
  return {
    id: 'a-4', schemaVersion: 1, type: 'revert_commit',
    actor: { type: 'human', id: 'richard' },
    requestedAt: '2026-08-27T00:00:05Z', idempotencyKey: 'key-4',
    payload: { commitActionId: 'a-2', revertedAt: '2026-08-27T00:00:06Z' },
    ...overrides,
  };
}

test('human preview creates ready proposal and launch fact', async () => {
  const { store, ledger, dispatcher } = await makeDeps();
  dispatcher._setNowAudioTime(5);

  const action = previewAction();
  const result = dispatcher.dispatch(action);

  assert.equal(result.ok, true);
  assert.equal(result.value.proposal.lifecycle, 'ready');
  assert.equal(result.value.proposal.id, 'a-1');
  assert.equal(result.value.launchFact.launchBeat, 32);
  assert.equal(result.value.launchFact.deck, 'B');

  const state = store.getState();
  assert.equal(state.proposals.byId['a-1'].lifecycle, 'ready');
  assert.deepEqual(state.proposals.activeIds, ['a-1']);

  const entries = ledger.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].outcome, 'proposal_created');
  assert.equal(entries[0].action.id, 'a-1');
});

test('full provenance: preview -> ready -> scheduled -> auditioning -> commit', async () => {
  const { store, ledger, dispatcher } = await makeDeps();

  // 1. Human preview: proposal becomes ready.
  const preview = dispatcher.dispatch(previewAction());
  assert.equal(preview.ok, true);
  assert.equal(store.getState().proposals.byId['a-1'].lifecycle, 'ready');

  // 2. Test-only lifecycle advance: scheduled -> auditioning.
  const s1 = dispatcher.advanceLifecycle('a-1', 'scheduled');
  assert.equal(s1.ok, true);
  const s2 = dispatcher.advanceLifecycle('a-1', 'auditioning');
  assert.equal(s2.ok, true);
  assert.equal(store.getState().proposals.byId['a-1'].lifecycle, 'auditioning');

  // 3. Human commit: retains original proposal, creates CommittedLayer.
  const commit = dispatcher.dispatch(commitAction('a-1'));
  assert.equal(commit.ok, true);

  const state = store.getState();
  assert.equal(state.proposals.byId['a-1'].lifecycle, 'accepted');
  assert.equal(state.proposals.byId['a-1'].committedActionId, 'a-2');
  assert.deepEqual(state.proposals.activeIds, []);
  assert.equal(state.session.committedLayers.length, 1);

  const layer = state.session.committedLayers[0];
  assert.equal(layer.actionId, 'a-2');
  assert.equal(layer.proposalId, 'a-1');
  assert.equal(layer.sourceRegionRef.id, 'chorus_2');
  assert.equal(layer.acceptedAsset.id, 'asset-1');
  assert.equal(layer.acceptedAsset.contentHash, 'sha256:abc');
  assert.deepEqual(layer.placement.gainDb, -3);
  assert.deepEqual(state.session.acceptedActionIds, ['a-2']);

  // Ledger contains a distinct commit entry.
  const entries = ledger.entries();
  const commitEntry = entries.find((e) => e.outcome === 'committed');
  assert.ok(commitEntry);
  assert.equal(commitEntry.action.id, 'a-2');
  assert.equal(commitEntry.action.payload.proposalId, 'a-1');
});

test('commit requires proposal to be in auditioning', async () => {
  const { store, ledger, dispatcher } = await makeDeps();
  dispatcher.dispatch(previewAction());
  const result = dispatcher.dispatch(commitAction('a-1'));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'L_NOT_AUDITIONING');
  assert.equal(store.getState().session.committedLayers.length, 0);
  assert.equal(ledger.entries().filter((e) => e.outcome === 'committed').length, 0);
});

test('revert moves one committed layer, rejects Producer and distinct repeats', async () => {
  const { store, ledger, dispatcher } = await makeDeps();
  dispatcher.dispatch(previewAction());
  dispatcher.advanceLifecycle('a-1', 'scheduled');
  dispatcher.advanceLifecycle('a-1', 'auditioning');
  assert.equal(dispatcher.dispatch(commitAction()).ok, true);

  const producer = dispatcher.dispatch(revertAction({
    id: 'producer-revert', idempotencyKey: 'producer-key',
    actor: { type: 'producer', id: 'ghost' },
  }));
  assert.equal(producer.code, 'P_ACTOR_NOT_ALLOWED');
  assert.equal(dispatcher.dispatch(revertAction()).ok, true);
  assert.equal(store.getState().session.committedLayers.length, 0);
  assert.equal(store.getState().session.revertedLayers.length, 1);
  const second = dispatcher.dispatch(revertAction({ id: 'a-5', idempotencyKey: 'key-5' }));
  assert.equal(second.code, 'L_ALREADY_REVERTED');
  assert.equal(ledger.entries().filter((entry) => entry.outcome === 'commit_reverted').length, 1);
});

test('Producer preview is allowed only with permission', async () => {
  const { ledger, dispatcher } = await makeDeps();
  const producerPreview = previewAction({
    id: 'a-prod', idempotencyKey: 'key-prod',
    actor: { type: 'producer', id: 'ghost' },
  });
  const denied = dispatcher.dispatch(producerPreview);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'P_PRODUCER_PREVIEW_DENIED');
  assert.equal(ledger.entries().length, 0);
});

test('Producer commit is always denied', async () => {
  const { store, ledger, dispatcher } = await makeDeps({ context: { producerPreviewAllowed: true } });
  const preview = previewAction({ actor: { type: 'producer', id: 'ghost' } });
  const p = dispatcher.dispatch(preview);
  assert.equal(p.ok, true);
  dispatcher.advanceLifecycle('a-1', 'scheduled');
  dispatcher.advanceLifecycle('a-1', 'auditioning');

  const commit = commitAction('a-1', { actor: { type: 'producer', id: 'ghost' } });
  const result = dispatcher.dispatch(commit);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'P_ACTOR_NOT_ALLOWED');
  assert.equal(store.getState().proposals.byId['a-1'].lifecycle, 'auditioning');
  assert.equal(ledger.entries().filter((e) => e.outcome === 'committed').length, 0);
});

test('reject_proposal removes from active and records reason', async () => {
  const { store, ledger, dispatcher } = await makeDeps();
  dispatcher.dispatch(previewAction());
  const result = dispatcher.dispatch(rejectAction('a-1'));
  assert.equal(result.ok, true);
  assert.equal(store.getState().proposals.byId['a-1'].lifecycle, 'rejected');
  assert.deepEqual(store.getState().proposals.activeIds, []);

  const rejected = ledger.entries().find((e) => e.outcome === 'rejected');
  assert.equal(rejected.rejectionReason, 'nope');
});

test('idempotent retry returns same result without duplicate ledger entry', async () => {
  const { ledger, dispatcher } = await makeDeps();
  const action = previewAction();
  const r1 = dispatcher.dispatch(action);
  const r2 = dispatcher.dispatch(action);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.deepEqual(r1.value.launchFact, r2.value.launchFact);
  assert.equal(ledger.entries().length, 1);
});

test('idempotency key reused with different request fails', async () => {
  const { ledger, dispatcher } = await makeDeps();
  const a1 = previewAction({ id: 'a-1', idempotencyKey: 'k' });
  const a2 = previewAction({ id: 'a-1b', idempotencyKey: 'k', payload: { ...a1.payload, gainDb: 0 } });
  const r1 = dispatcher.dispatch(a1);
  assert.equal(r1.ok, true);
  const r2 = dispatcher.dispatch(a2);
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'I_KEY_REUSED_WITH_DIFFERENT_REQUEST');
  assert.equal(ledger.entries().length, 1);
});

test('invalid preview action aborts with zero projection/ledger change', async () => {
  const { store, ledger, dispatcher } = await makeDeps();
  const bad = previewAction({ payload: { ...previewAction().payload, gainDb: 99 } });
  const result = dispatcher.dispatch(bad);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'V_INVALID_GAIN');
  assert.deepEqual(store.getState().proposals.byId, {});
  assert.equal(ledger.entries().length, 0);
});

test('launch fact includes grid revision and is deterministic', async () => {
  const { dispatcher } = await makeDeps({
    transportFactory: (deck) => ({
      deck,
      playing: true,
      tempoBpm: 120,
      beatsPerBar: 4,
      phraseBars: 8,
      beatAtStart: 16,
      startedAtAudioTime: 0,
      gridRevision: 'grid-provenance-v1',
    }),
  });
  dispatcher._setNowAudioTime(0);
  const result = dispatcher.dispatch(previewAction());
  assert.equal(result.value.launchFact.gridRevision, 'grid-provenance-v1');
  assert.equal(result.value.launchFact.launchBeat, 32);
});

test('rejected provenance keeps immutable history', async () => {
  const { ledger, dispatcher } = await makeDeps();
  dispatcher.dispatch(previewAction());
  dispatcher.dispatch(rejectAction('a-1'));
  const entries = ledger.entries();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].outcome, 'proposal_created');
  assert.equal(entries[1].outcome, 'rejected');
  assert.equal(entries[0].action.id, 'a-1');
  assert.equal(entries[1].action.id, 'a-3');
});

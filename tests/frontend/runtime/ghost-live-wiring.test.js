// tests/frontend/runtime/ghost-live-wiring.test.js — Phase 12A.6 controller wiring.
//
// Proves the live committed-layer reconciliation at the GhostController level:
// successful commit/hydration/reconciliation converge through one idempotent
// engine.sync() path; confirmed Undo removes immediately; audio events
// suspend (never destroy) the live engine; project switch and app shutdown
// tear it down; reload hydrates idle with no autoplay; and a later owned
// Lead play re-syncs and resumes. All with a fake engine (call-order truth)
// plus the ghostLiveStatus slice contract.

import test from 'node:test';
import assert from 'node:assert/strict';

import { GhostController } from '../../../src/twobecomeone/studio_static/js/runtime/ghost-controller.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeStore {
  constructor() {
    this.state = {
      currentProject: { id: 'p1', lead_track_id: 'lead-1' },
      deckTracks: {
        'lead-1': { id: 'lead-1', bpm: 120, beat_grid: { first_beat: 0, interval: 0.5 } },
      },
      proposals: { byId: {}, order: [], activeIds: [] },
      session: { committedLayers: [], revertedLayers: [], acceptedActionIds: [] },
      ghostStatus: {
        activeProposalId: null, phase: 'idle', summary: null,
        receipt: null, error: null, hydrating: false,
      },
      ghostLiveStatus: null,
    };
  }
  getState() { return structuredClone(this.state); }
  dispatch(action) {
    if (action.type === 'v1/ghost-status/set') {
      this.state.ghostStatus = { ...this.state.ghostStatus, ...structuredClone(action.patch) };
    } else if (action.type === 'v1/ghost-live-status/set') {
      this.state.ghostLiveStatus = structuredClone(action.patch);
    } else if (action.type === 'v1/proposal/record') {
      this.state.proposals.byId[action.proposal.id] = structuredClone(action.proposal);
      this.state.proposals.order.push(action.proposal.id);
      this.state.proposals.activeIds.push(action.proposal.id);
    } else if (action.type === 'v1/proposal/transition') {
      const p = this.state.proposals.byId[action.proposalId];
      if (p) p.lifecycle = action.toState;
    } else if (action.type === 'v1/hydrate-projection') {
      this.state.session = structuredClone(action.projection.session);
    } else if (action.type === 'v1/commit/reverted') {
      this.state.session.committedLayers = (this.state.session.committedLayers || [])
        .filter((l) => l.actionId !== action.commitActionId);
    }
  }
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.closed = false;
  }
  resume() { return Promise.resolve(); }
  async close() { this.closed = true; }
}

class FakeEngine {
  constructor() {
    this.syncCalls = [];
    this.removes = [];
    this.suspends = [];
    this.shutdownCalls = 0;
    this._syncResult = { ok: true, code: 'scheduled' };
  }
  async sync(layers) { this.syncCalls.push(structuredClone(layers)); return this._syncResult; }
  remove(id) { this.removes.push(id); }
  suspend(reason) { this.suspends.push(reason || null); }
  shutdown() { this.shutdownCalls += 1; }
  snapshot() {
    return { layers: this.syncCalls.length ? [] : [] };
  }
}

function committedLayer() {
  return {
    actionId: 'c-1',
    layerId: 'layer-c-1',
    proposalId: 'a-1',
    launchReceipt: {
      launchBeat: 32,
      destinationGridRevision: 'grid-v1:' + 'a'.repeat(64),
      destinationOriginSeconds: 0,
      targetBpm: 120,
      assetId: 'ga-1',
      contentHash: 'sha256:abc',
    },
    transformSpec: { targetBpm: 120, semanticRegion: { startBeat: 0, endBeat: 16 } },
    placement: { gainDb: -6 },
    asset: { id: 'ga-1', contentHash: 'sha256:abc', pinned: true },
  };
}

function makeController({ engine } = {}) {
  const store = new FakeStore();
  const ctx = new FakeAudioContext();
  const liveEngine = engine || new FakeEngine();
  const api = {
    getActionState: async () => ({
      session: { committedLayers: [committedLayer()], revertedLayers: [] },
      proposals: { byId: {}, order: [], activeIds: [] },
      last_sequence: 5,
    }),
    buildRevertAction: (commitActionId) => ({
      id: 'r-1', schemaVersion: 1, type: 'revert_commit',
      actor: { type: 'human', id: 'local-human' }, requestedAt: 't', idempotencyKey: 'rk',
      payload: { commitActionId, revertedAt: 't' },
    }),
    postProjectAction: async (projectId, action) => {
      if (action.type === 'revert_commit') {
        if (action.payload.commitActionId !== 'c-1') {
          // L_UNKNOWN_COMMIT: a stable server rejection, like the real API.
          const err = new Error('commitActionId does not reference a committed layer');
          err.code = 'L_UNKNOWN_COMMIT';
          err.status = 409;
          throw err;
        }
        return { outcome: { result: 'commit_reverted', commitActionId: action.payload.commitActionId } };
      }
      return { outcome: {} };
    },
  };
  const controller = new GhostController({
    store,
    api,
    audioController: { current: { trackId: 'lead-1' }, playing: true, time: 4 },
    audioContextFactory: { create: () => ctx },
    liveEngineFactory: () => liveEngine,
  });
  return { store, ctx, controller, liveEngine };
}

/** Real flow parity: app.js dispatches the hydration, THEN calls the hook. */
async function hydrate(controller, store, committedLayers) {
  const projection = {
    session: { committedLayers, revertedLayers: [] },
    proposals: { byId: {}, order: [], activeIds: [] },
  };
  store.dispatch({ type: 'v1/hydrate-projection', projection, lastSequence: 5 });
  await controller.handleHydratedProjection(projection);
}

// ---------------------------------------------------------------------------
// Authoritative sync convergence (Amendment 2)
// ---------------------------------------------------------------------------

test('commit success drives one engine sync from the refreshed projection', async () => {
  const { store, controller, liveEngine } = makeController();
  await hydrate(controller, store, [committedLayer()]);
  assert.equal(liveEngine.syncCalls.length, 1);
  assert.equal(liveEngine.syncCalls[0][0].actionId, 'c-1');
  controller.shutdown();
});

test('an empty projection sync clears a previously armed engine', async () => {
  const { store, controller, liveEngine } = makeController();
  await hydrate(controller, store, [committedLayer()]);
  assert.equal(liveEngine.syncCalls.length, 1);
  await hydrate(controller, store, []);
  assert.equal(liveEngine.syncCalls.length, 2);
  assert.deepEqual(liveEngine.syncCalls[1], []);
  assert.equal(store.getState().ghostLiveStatus.layers.length, 0);
  controller.shutdown();
});

test('hydration of the same projection is idempotent (one sync per refresh)', async () => {
  const { store, controller, liveEngine } = makeController();
  await hydrate(controller, store, [committedLayer()]);
  await hydrate(controller, store, [structuredClone(committedLayer())]);
  assert.equal(liveEngine.syncCalls.length, 2); // one per authoritative refresh
  controller.shutdown();
});

test('confirmed Undo removes the live layer immediately', async () => {
  const { store, controller, liveEngine } = makeController();
  await hydrate(controller, store, [committedLayer()]);
  assert.equal(liveEngine.syncCalls.length, 1);
  // The real flow: revert() posts durably, then removes the live layer
  // immediately once the server confirms (durable-first ordering).
  const result = await controller.revert('c-1');
  assert.equal(result.ok, true);
  assert.equal(liveEngine.removes.length, 1);
  assert.equal(liveEngine.removes[0], 'c-1');
  controller.shutdown();
});

test('a failed Undo leaves live playback and projection unchanged', async () => {
  const { store, controller, liveEngine } = makeController();
  await hydrate(controller, store, [committedLayer()]);
  assert.equal(liveEngine.syncCalls.length, 1);
  // The server rejects the unknown commit id: no remove, no slice change.
  const result = await controller.revert('c-unknown');
  assert.equal(result.ok, false);
  assert.equal(liveEngine.removes.length, 0); // nothing removed
  assert.equal(store.getState().ghostLiveStatus.layers.length, 1);
  controller.shutdown();
});

// ---------------------------------------------------------------------------
// Suspend / resume semantics (Amendment 4)
// ---------------------------------------------------------------------------

test('pause/stop/ended/seek audio events suspend the live engine', async () => {
  const { store, controller, liveEngine } = makeController();
  await hydrate(controller, store, [committedLayer()]); // engine exists
  for (const type of ['pause', 'stop', 'ended', 'seek']) {
    controller.handleAudioEvent(type);
  }
  assert.equal(liveEngine.suspends.length, 4);
  controller.shutdown();
});

test('a later owned Lead play re-syncs the suspended engine', async () => {
  const { store, controller, liveEngine } = makeController();
  await hydrate(controller, store, [committedLayer()]);
  controller.handleAudioEvent('pause');
  assert.equal(liveEngine.suspends.length, 1);
  const before = liveEngine.syncCalls.length;
  controller.handleAudioEvent('play');
  assert.equal(liveEngine.syncCalls.length, before + 1);
  controller.shutdown();
});

// ---------------------------------------------------------------------------
// Teardown boundaries (A8 parity)
// ---------------------------------------------------------------------------

test('project switch hard-tears-down the live engine', async () => {
  const { store, controller, liveEngine } = makeController();
  await hydrate(controller, store, [committedLayer()]);
  controller.onBeforeProjectChange();
  assert.equal(liveEngine.shutdownCalls, 1);
  controller.shutdown();
});

test('app shutdown tears down the live engine exactly once', async () => {
  const { store, controller, liveEngine } = makeController();
  await hydrate(controller, store, [committedLayer()]);
  await controller.shutdown();
  assert.equal(liveEngine.shutdownCalls, 1);
  // Second shutdown call is a no-op for the live engine too.
  await controller.shutdown();
  assert.equal(liveEngine.shutdownCalls, 1);
});

test('reload (hydration) never autoplays: idle state, no sync-driven start', async () => {
  const { store, controller, liveEngine } = makeController();
  await hydrate(controller, store, [committedLayer()]);
  // The engine receives the authoritative layers; the fake engine's sync is
  // the ONLY entry. No autoplay: no schedule/start call beyond sync itself.
  assert.equal(liveEngine.syncCalls.length, 1);
  const slice = store.getState().ghostLiveStatus;
  assert.equal(slice.layers[0].state, 'idle'); // honest idle before any play
  controller.shutdown();
});

// ---------------------------------------------------------------------------
// ghostLiveStatus slice contract (Amendment 9 discipline)
// ---------------------------------------------------------------------------

test('ghostLiveStatus slice maps engine state and stays serializable', async () => {
  const { store, controller, liveEngine } = makeController();
  await hydrate(controller, store, [committedLayer()]);
  const slice = store.getState().ghostLiveStatus;
  assert.ok(slice);
  assert.equal(slice.layers.length, 1);
  assert.equal(slice.layers[0].layerId, 'layer-c-1');
  assert.equal(slice.layers[0].actionId, 'c-1');
  assert.equal(slice.layers[0].state, 'idle');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(slice)));
  assert.equal(JSON.stringify(slice).includes('FakeEngine'), false);
  controller.shutdown();
});

test('engine state changes update the ghostLiveStatus slice live', async () => {
  const { store, controller, liveEngine } = makeController();
  await hydrate(controller, store, [committedLayer()]);
  // The controller subscribed to engine state changes; simulate the engine
  // publishing `live` and verify the slice updates.
  assert.equal(typeof controller._onLiveStateChange, 'function');
  controller._onLiveStateChange('layer-c-1', 'live', null);
  const slice = store.getState().ghostLiveStatus;
  assert.equal(slice.layers[0].state, 'live');
  controller.shutdown();
});
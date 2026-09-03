// tests/frontend/runtime/ghost-live-adversarial.test.js — Phase 12 corrective pass.
//
// Permanent adversarial coverage for the three audit blockers:
//   1. Lead grid parity is enforced in the live transport provider
//      (a Lead whose BPM changed since the commit is refused GHOST_GRID_STALE).
//   2. Ambiguous reconciliation converges the engine:
//      a. a reconciled commit hydrates + syncs the committed layer;
//      b. a reconciled Undo stops/syncs the engine (projection removed).
//   3. (gain-node leak is covered in committed-layer-engine.test.js)

import test from 'node:test';
import assert from 'node:assert/strict';

import { GhostController } from '../../../src/twobecomeone/studio_static/js/runtime/ghost-controller.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeStore {
  constructor(leadBpm = 120) {
    this.state = {
      currentProject: { id: 'p1', lead_track_id: 'lead-1' },
      deckTracks: {
        'lead-1': { id: 'lead-1', bpm: leadBpm, beat_grid: { first_beat: 0, interval: 0.5 } },
      },
      proposals: { byId: {}, order: [], activeIds: [] },
      session: { committedLayers: [], revertedLayers: [], acceptedActionIds: [] },
      ghostStatus: { activeProposalId: null, phase: 'idle', summary: null, receipt: null, error: null, hydrating: false },
      ghostLiveStatus: { layers: [] },
    };
  }
  getState() { return structuredClone(this.state); }
  dispatch(action) {
    if (action.type === 'v1/ghost-status/set') {
      this.state.ghostStatus = { ...this.state.ghostStatus, ...structuredClone(action.patch) };
    } else if (action.type === 'v1/ghost-live-status/set') {
      this.state.ghostLiveStatus = structuredClone(action.patch);
    } else if (action.type === 'v1/hydrate-projection') {
      this.state.session = structuredClone(action.projection.session);
      this.state.proposals = structuredClone(action.projection.proposals);
    } else if (action.type === 'v1/proposal/record') {
      this.state.proposals.byId[action.proposal.id] = structuredClone(action.proposal);
      this.state.proposals.order.push(action.proposal.id);
      this.state.proposals.activeIds.push(action.proposal.id);
    } else if (action.type === 'v1/proposal/transition') {
      const p = this.state.proposals.byId[action.proposalId];
      if (p) p.lifecycle = action.toState;
    }
  }
}

class FakeAudioContext {
  constructor() { this.currentTime = 0; this.state = 'running'; this.closed = false; }
  resume() { return Promise.resolve(); }
  async close() { this.closed = true; }
}

class FakeEngine {
  constructor() {
    this.syncCalls = [];
    this.removes = [];
    this.shutdownCalls = 0;
  }
  async sync(layers) { this.syncCalls.push(structuredClone(layers)); return { ok: true, code: 'scheduled' }; }
  remove(id) { this.removes.push(id); }
  suspend() {}
  shutdown() { this.shutdownCalls += 1; }
  snapshot() { return { layers: [] }; }
}

function committedLayer(overrides = {}) {
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
    transformSpec: {
      targetBpm: 120,
      destinationGrid: { originSeconds: 0, intervalSeconds: 0.5 },
      destinationGridRevision: 'grid-v1:' + 'a'.repeat(64),
      semanticRegion: { startBeat: 0, endBeat: 16 },
    },
    placement: { gainDb: -6 },
    asset: { id: 'ga-1', contentHash: 'sha256:abc', pinned: true },
    ...overrides,
  };
}

function auditioningProposal() {
  return {
    id: 'a-1',
    actionType: 'preview_layer',
    lifecycle: 'auditioning',
    payload: { source: { deck: 'A', stem: 'vocal', region: { startBeat: 0, endBeat: 2 } }, destination: { deck: 'B' }, timing: { launch: 'next_phrase', quantize: true }, gainDb: -3 },
  };
}

function makeController({ leadBpm = 120, apiOverrides = {} } = {}) {
  const store = new FakeStore(leadBpm);
  const ctx = new FakeAudioContext();
  const liveEngine = new FakeEngine();
  const api = {
    getActionState: async () => ({
      session: { committedLayers: [committedLayer()], revertedLayers: [] },
      proposals: { byId: {}, order: [], activeIds: [] },
      last_sequence: 5,
    }),
    buildCommitAction: (proposalId, asset) => ({
      id: 'commit-1', schemaVersion: 1, type: 'commit_layer',
      actor: { type: 'human', id: 'local-human' }, requestedAt: 't', idempotencyKey: 'ck',
      payload: { proposalId, assetId: asset.id },
    }),
    buildRevertAction: (commitActionId) => ({
      id: 'r-1', schemaVersion: 1, type: 'revert_commit',
      actor: { type: 'human', id: 'local-human' }, requestedAt: 't', idempotencyKey: 'rk',
      payload: { commitActionId, revertedAt: 't' },
    }),
    postProjectAction: async () => ({ outcome: {} }),
    postProposalLifecycle: async () => ({ outcome: 'lifecycle_recorded' }),
    ...apiOverrides,
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

// ---------------------------------------------------------------------------
// Blocker 1: Lead grid parity
// ---------------------------------------------------------------------------

test('live transport provider refuses a Lead whose BPM changed (GHOST_GRID_STALE)', () => {
  const { controller } = makeController({ leadBpm: 121 }); // Lead drifted 120 -> 121
  const layer = committedLayer(); // server-authored targetBpm 120, interval 0.5
  assert.throws(
    () => controller._liveTransportProvider(layer),
    (err) => err.code === 'GHOST_GRID_STALE',
  );
  controller.shutdown();
});

test('live transport provider accepts a matching Lead grid', () => {
  const { controller } = makeController({ leadBpm: 120 });
  const layer = committedLayer();
  const transport = controller._liveTransportProvider(layer);
  assert.equal(transport.tempoBpm, 120);
  controller.shutdown();
});

// ---------------------------------------------------------------------------
// Blocker 2a: reconciled commit converges the engine
// ---------------------------------------------------------------------------

test('a reconciled commit hydrates and syncs the committed layer', async () => {
  const { store, controller, liveEngine } = makeController({
    apiOverrides: {
      // The commit POST fails ambiguously (5xx), but the server DID commit.
      postProjectAction: async (projectId, action) => {
        if (action.type === 'commit_layer') {
          const err = new Error('gateway timeout');
          err.status = 504;
          throw err;
        }
        return { outcome: {} };
      },
      getActionState: async () => ({
        session: { committedLayers: [committedLayer()], revertedLayers: [] },
        proposals: { byId: { 'a-1': { ...auditioningProposal(), lifecycle: 'accepted' } }, order: ['a-1'], activeIds: [] },
        last_sequence: 5,
      }),
    },
  });

  // Seed an auditioning generation so commit() has something to commit.
  store.state.proposals.byId['a-1'] = auditioningProposal();
  store.state.proposals.activeIds = ['a-1'];
  controller._gen = {
    id: 'g1', projectId: 'p1', proposalId: 'a-1',
    asset: { id: 'ga-1', contentHash: 'sha256:abc' },
    released: false,
  };

  const result = await controller.commit();
  assert.equal(result.ok, true);
  // The reconciled commit MUST have converged the engine: the authoritative
  // projection was hydrated and the committed layer synced.
  assert.equal(liveEngine.syncCalls.length, 1);
  assert.equal(liveEngine.syncCalls[0][0].actionId, 'c-1');
  assert.equal(store.getState().session.committedLayers.length, 1);
  controller.shutdown();
});

// ---------------------------------------------------------------------------
// Blocker 2b: reconciled Undo stops/syncs the engine
// ---------------------------------------------------------------------------

test('a reconciled Undo stops the engine (projection removed)', async () => {
  const { store, controller, liveEngine } = makeController({
    apiOverrides: {
      // The revert POST fails ambiguously (5xx), but the server DID revert.
      postProjectAction: async (projectId, action) => {
        if (action.type === 'revert_commit') {
          const err = new Error('gateway timeout');
          err.status = 504;
          throw err;
        }
        return { outcome: {} };
      },
      getActionState: async () => ({
        session: { committedLayers: [], revertedLayers: [committedLayer()] },
        proposals: { byId: {}, order: [], activeIds: [] },
        last_sequence: 6,
      }),
    },
  });

  // The engine currently holds the committed layer.
  store.state.session.committedLayers = [committedLayer()];
  await controller._syncLiveEngine();
  assert.equal(liveEngine.syncCalls.length, 1);

  const result = await controller.revert('c-1');
  assert.equal(result.ok, true);
  // The reconciled Undo MUST have converged the engine: the hydrated empty
  // projection was synced, so the engine no longer holds the layer.
  assert.equal(liveEngine.syncCalls.length, 2);
  assert.deepEqual(liveEngine.syncCalls[1], []);
  assert.equal(store.getState().session.committedLayers.length, 0);
  controller.shutdown();
});

test('a late Undo response from the prior project cannot mutate the new project', async () => {
  let resolvePost;
  const { store, controller, liveEngine } = makeController({
    apiOverrides: {
      postProjectAction: async (_projectId, action) => {
        if (action.type === 'revert_commit') {
          return new Promise((resolve) => { resolvePost = resolve; });
        }
        return { outcome: {} };
      },
    },
  });
  store.state.session.committedLayers = [committedLayer()];
  await controller._syncLiveEngine();
  const syncingBefore = liveEngine.syncCalls.length;

  const reverting = controller.revert('c-1');
  await new Promise((resolve) => setTimeout(resolve, 0));
  store.state.currentProject = { id: 'p2', lead_track_id: 'lead-2' };
  store.state.session = { committedLayers: [], revertedLayers: [], acceptedActionIds: [] };
  resolvePost({ outcome: { result: 'commit_reverted' } });

  const result = await reverting;
  assert.equal(result.ok, true);
  assert.equal(liveEngine.syncCalls.length, syncingBefore);
  assert.deepEqual(store.state.session, {
    committedLayers: [], revertedLayers: [], acceptedActionIds: [],
  });
  controller.shutdown();
});

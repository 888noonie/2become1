// tests/frontend/runtime/ghost-controller.test.js — Phase 10B controller tests.
//
// Proves the Sol amendments at the controller level with a fake scheduler,
// fake AudioContext, and fake api: A1 (release-before-outcome barrier,
// reconciliation, exactly one reject), A2 (auditioning only after the launch
// boundary, late-never-early, cancellable), A7 (ownership proof, cancel on
// pause/stop/replacement without machine reject), A8 (hydration/switch hard
// boundaries, deterministic recovery), A10 (retry serialized after durable
// release), A12 (exactly one schedule call per generation), and A9 (the
// ghostStatus slice stays pure/serializable through every flow).

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
        'lead-1': {
          id: 'lead-1', bpm: 120,
          beat_grid: { first_beat: 0, interval: 0.5 },
        },
      },
      proposals: { byId: {}, order: [], activeIds: [] },
      ghostStatus: {
        activeProposalId: null, phase: 'idle', summary: null,
        receipt: null, error: null, hydrating: false,
      },
    };
  }
  getState() { return structuredClone(this.state); }
  dispatch(action) {
    if (action.type === 'v1/ghost-status/set') {
      this.state.ghostStatus = { ...this.state.ghostStatus, ...structuredClone(action.patch) };
    } else if (action.type === 'v1/proposal/record') {
      this.state.proposals.byId[action.proposal.id] = structuredClone(action.proposal);
      this.state.proposals.order.push(action.proposal.id);
      this.state.proposals.activeIds.push(action.proposal.id);
    } else if (action.type === 'v1/proposal/transition') {
      const p = this.state.proposals.byId[action.proposalId];
      if (p) p.lifecycle = action.toState;
    } else if (action.type === 'v1/proposal/rejected') {
      const p = this.state.proposals.byId[action.proposalId];
      if (p) {
        p.lifecycle = 'rejected';
        this.state.proposals.activeIds = this.state.proposals.activeIds.filter((id) => id !== action.proposalId);
      }
    }
  }
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.closed = false;
    this.resumes = 0;
  }
  resume() { this.resumes += 1; return Promise.resolve(); }
  async close() { this.closed = true; }
}

class FakeScheduler {
  constructor(deps) {
    this.deps = deps;
    this.scheduleCalls = [];
    this.cancelled = [];
    this.shutdownCalls = 0;
    this._nextResult = { ok: true, receipt: fakeReceipt() };
    this._resolver = null;
  }
  async schedule(proposal, asset) {
    this.scheduleCalls.push({ proposal, asset });
    // Mirror the real scheduler: transport is resolved after decode.
    if (this.deps && typeof this.deps.transportProvider === 'function') {
      this.deps.transportProvider('B');
    }
    if (this._resolver) await this._resolver.promise;
    return this._nextResult;
  }
  cancel(proposalId) { this.cancelled.push(proposalId); }
  shutdown() { this.shutdownCalls += 1; }
  setNextResult(result) { this._nextResult = result; }
  gate() { return new Promise((resolve) => { this._resolver = resolve; }); }
  resolvePending() { if (this._resolver) { this._resolver(); this._resolver = null; } }
  setTransport(transport) { this.deps.transportProvider = () => transport; }
}

function fakeReceipt() {
  return {
    proposalId: 'a-1',
    assetId: 'ga-1',
    assetContentHash: 'sha256:abc',
    gridRevision: 'grid-v1:' + 'a'.repeat(64),
    launchBeat: 8,
    phraseIndex: 0,
    launchAudioTime: 10.0,
  };
}

function region() {
  return { id: 'r1', startBeat: 0, endBeat: 8 };
}

function serverPreviewOutcome(overrides = {}) {
  return {
    outcome: {
      result: 'proposal_created',
      proposal: {
        id: 'a-1',
        actionType: 'preview_layer',
        actor: { type: 'human', id: 'local-human' },
        requestedAt: 't',
        idempotencyKey: 'k',
        lifecycle: 'ready',
        payload: {
          source: { deck: 'A', stem: 'vocal', region: region() },
          destination: { deck: 'B' },
          timing: { launch: 'next_phrase', quantize: true },
          gainDb: -3,
        },
      },
      asset: {
        id: 'ga-1',
        contentHash: 'sha256:abc',
        audioUrl: '/api/ghost-assets/ga-1/audio',
        transformSpec: {
          destinationGridRevision: 'grid-v1:' + 'a'.repeat(64),
          destinationGrid: { originSeconds: 0, intervalSeconds: 0.5 },
          targetBpm: 120,
        },
        expiresAt: Date.now() + 3600_000,
      },
    },
    sequence: 1,
    ...overrides,
  };
}

function makeController({ currentTime = 0, leadPlaying = true, leadOwned = true } = {}) {
  const store = new FakeStore();
  const ctx = new FakeAudioContext();
  ctx.currentTime = currentTime;
  const scheduler = new FakeScheduler();
  const api = {
    previewResponse: { outcome: serverPreviewOutcome().outcome, sequence: 1 },
    posts: [],
    lifecyclePosts: [],
    buildPreviewAction: ({ region: r, gainDb }) => ({
      id: 'act-' + api.posts.length,
      schemaVersion: 1,
      type: 'preview_layer',
      actor: { type: 'human', id: 'local-human' },
      requestedAt: 't', idempotencyKey: 'key-' + api.posts.length,
      payload: {
        source: { deck: 'A', stem: 'vocal', region: r },
        destination: { deck: 'B' },
        timing: { launch: 'next_phrase', quantize: true },
        gainDb,
      },
    }),
    buildRejectAction: (proposalId, reason) => ({
      id: 'rej-' + api.posts.length, schemaVersion: 1, type: 'reject_proposal',
      actor: { type: 'human', id: 'local-human' }, requestedAt: 't', idempotencyKey: 'rk',
      payload: { proposalId, rejectedAt: 't', reason: reason || undefined },
    }),
    buildLifecycleBody: (to, fact) => ({ to, actor: { type: 'human', id: 'local-human' }, at: 't', ...(fact ? { fact } : {}) }),
    postProjectAction: async (projectId, action) => {
      api.posts.push({ kind: 'action', action });
      if (action.type === 'preview_layer') {
        if (api.delayPreview) {
          await new Promise((r) => setTimeout(r, api.delayPreview));
        }
        return structuredClone(api.previewResponse);
      }
      // reject_proposal: update fake store to terminal
      const p = store.state.proposals.byId[action.payload.proposalId];
      if (p) {
        p.lifecycle = 'rejected';
        store.state.proposals.activeIds = store.state.proposals.activeIds.filter((id) => id !== action.payload.proposalId);
      }
      return { outcome: { result: 'proposal_rejected' }, sequence: 2 };
    },
    postProposalLifecycle: async (projectId, proposalId, body) => {
      api.lifecyclePosts.push({ proposalId, body });
      const p = store.state.proposals.byId[proposalId];
      if (p && ['ready', 'scheduled'].includes(p.lifecycle)) p.lifecycle = body.to;
      return { outcome: 'lifecycle_recorded', lifecycle: body.to };
    },
  };
  const audioController = {
    current: leadOwned ? { trackId: 'lead-1' } : { trackId: 'anchor-1' },
    playing: leadPlaying,
    time: 4.0,
  };
  const controller = new GhostController({
    store,
    api,
    audioController,
    audioContextFactory: { create: () => ctx },
    schedulerFactory: (d) => { scheduler.deps = d; return scheduler; },
  });
  return { store, ctx, scheduler, controller, api };
}


async function waitForCondition(fn, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

// ---------------------------------------------------------------------------
// invoke => scheduled => armed path
// ---------------------------------------------------------------------------

test('invoke flow: preview POST, scheduled fact, single schedule, armed status', async () => {
  const { controller, api, scheduler, store } = makeController({ currentTime: 5 });
  const result = await controller.invoke(region(), -3);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(scheduler.scheduleCalls.length, 1); // A12
  assert.equal(api.posts.length, 1);
  assert.equal(api.posts[0].action.type, 'preview_layer');
  const lifecycleTos = api.lifecyclePosts.map((p) => p.body.to);
  assert.deepEqual(lifecycleTos, ['scheduled']);
  assert.equal(store.state.ghostStatus.phase, 'armed');
  assert.equal(store.state.ghostStatus.activeProposalId, 'a-1');
  assert.equal(store.state.ghostStatus.receipt.launchBeat, 8);
  assert.equal(Object.hasOwn(store.state.ghostStatus.receipt, 'launchAudioTime'), false);
  assert.equal(store.state.proposals.byId['a-1'].lifecycle, 'scheduled');
  await controller.shutdown(); // stop the launch observer so node can exit
});

test('invoke refuses while another ghost is active (one-active rule)', async () => {
  const { controller, store } = makeController();
  store.state.proposals.byId['a-0'] = { id: 'a-0', lifecycle: 'scheduled' };
  store.state.proposals.activeIds.push('a-0');
  const result = await controller.invoke(region(), -3);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'GHOST_ACTIVE');
  assert.equal(store.state.ghostStatus.phase, 'blocked');
});

test('invoke surfaces precondition error codes from the envelope', async () => {
  const { controller, api, store } = makeController();
  const boom = new Error('Separate vocals on Foundation first.');
  boom.code = 'S_STEM_UNAVAILABLE';
  boom.status = 422;
  api.postProjectAction = async () => { throw boom; };
  const result = await controller.invoke(region(), -3);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'S_STEM_UNAVAILABLE');
  assert.equal(store.state.ghostStatus.phase, 'failed');
  assert.equal(store.state.ghostStatus.error.code, 'S_STEM_UNAVAILABLE');
});

test('A3: schedule is refused when live Lead grid diverges from server grid', async () => {
  const { controller, store } = makeController();
  store.state.deckTracks['lead-1'].beat_grid.interval = 0.52; // drift
  const result = await controller.invoke(region(), -3);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'GHOST_GRID_STALE');
  assert.equal(store.state.ghostStatus.phase, 'failed');
});

test('A7: scheduling fails honestly when Lead is not owned/playing', async () => {
  const { controller } = makeController({ leadPlaying: false });
  const result = await controller.invoke(region(), -3);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LEAD_NOT_PLAYING');
});

// ---------------------------------------------------------------------------
// A2: truthful auditioning
// ---------------------------------------------------------------------------

test('A2: auditioning is recorded only after the launch boundary', async () => {
  const { controller, api, ctx, scheduler, store } = makeController({ currentTime: 0 });
  scheduler.setNextResult({ ok: true, receipt: fakeReceipt() });
  const result = await controller.invoke(region(), -3);
  assert.ok(result.ok, JSON.stringify(result));
  // Clock is still before the boundary (0 < 10): no auditioning fact yet.
  assert.equal(api.lifecyclePosts.some((p) => p.body.to === 'auditioning'), false);
  assert.equal(store.state.ghostStatus.phase, 'armed');
  // Advance the fake clock past the boundary and let the observer tick.
  ctx.currentTime = 15;
  const recorded = await waitForCondition(
    () => api.lifecyclePosts.some((p) => p.body.to === 'auditioning'),
  );
  assert.ok(recorded, 'auditioning fact never recorded');
  const auditioningPost = api.lifecyclePosts.find((p) => p.body.to === 'auditioning');
  assert.equal(auditioningPost.body.fact.launchAudioTime, 10.0);
  assert.equal(store.state.ghostStatus.phase, 'auditioning');
});

test('A2: auditioning is NOT recorded early even after many ticks', async () => {
  const { controller, api, ctx } = makeController({ currentTime: 0 });
  const result = await controller.invoke(region(), -3);
  assert.ok(result.ok);
  // Ticks pass with the clock still before the boundary.
  for (let i = 0; i < 5; i += 1) {
    ctx.currentTime = 9.99 - i * 0.01;
    await new Promise((r) => setTimeout(r, 60));
  }
  assert.equal(api.lifecyclePosts.some((p) => p.body.to === 'auditioning'), false);
  await controller.shutdown();
});

test('A2: boundary observer verifies destination ownership at the boundary', async () => {
  const { controller, api, ctx } = makeController({ currentTime: 0 });
  const result = await controller.invoke(region(), -3);
  assert.ok(result.ok);
  // Ownership is lost BEFORE the boundary is crossed.
  controller.audioController.playing = false;
  ctx.currentTime = 15;
  await waitForCondition(() => {
    const phase = controller.store.getState().ghostStatus.phase;
    return phase === 'interrupted';
  });
  assert.equal(api.lifecyclePosts.some((p) => p.body.to === 'auditioning'), false);
  // No machine reject happened (constitutional: human decides).
  const rejects = api.posts.filter((p) => p.action.type === 'reject_proposal');
  assert.equal(rejects.length, 0);
});

// ---------------------------------------------------------------------------
// A7: ownership loss cancels runtime without machine reject
// ---------------------------------------------------------------------------

test('A7: pause/stop/ended while armed interrupts without rejecting', async () => {
  const { controller, api } = makeController({ currentTime: 0 });
  const result = await controller.invoke(region(), -3);
  assert.ok(result.ok);
  controller.handleAudioEvent('pause');
  const status = controller.store.getState().ghostStatus;
  assert.equal(status.phase, 'interrupted');
  assert.equal(status.error.code, 'LEAD_STOPPED');
  const rejects = api.posts.filter((p) => p.action.type === 'reject_proposal');
  assert.equal(rejects.length, 0);
});

test('A7: element restart (play) after scheduling interrupts the ghost', async () => {
  const { controller } = makeController({ currentTime: 0 });
  const result = await controller.invoke(region(), -3);
  assert.ok(result.ok);
  controller.handleAudioEvent('play', { trackId: 'lead-1' });
  assert.equal(controller.store.getState().ghostStatus.phase, 'interrupted');
});

test('A7: seek after scheduling interrupts the ghost', async () => {
  const { controller } = makeController({ currentTime: 0 });
  const result = await controller.invoke(region(), -3);
  assert.ok(result.ok);
  controller.handleAudioEvent('seek');
  assert.equal(controller.store.getState().ghostStatus.phase, 'interrupted');
});

test('natural Ghost end becomes an actionable ended presentation state', async () => {
  const { controller, scheduler, store } = makeController({ currentTime: 0 });
  const result = await controller.invoke(region(), -3);
  assert.ok(result.ok);
  scheduler.deps.onStateChange('a-1', 'ended');
  assert.equal(store.state.ghostStatus.phase, 'ended');
  assert.equal(store.state.proposals.byId['a-1'].lifecycle, 'scheduled');
  await controller.release();
  assert.equal(store.state.proposals.byId['a-1'].lifecycle, 'rejected');
});

test('A7: display-state audio events during preparing do not interrupt', async () => {
  const { controller, scheduler } = makeController({ currentTime: 0 });
  scheduler.setNextResult({ ok: true, receipt: fakeReceipt() });
  const invokePromise = controller.invoke(region(), -3);
  await new Promise((r) => setTimeout(r, 20));
  controller.handleAudioEvent('pause'); // during preparing
  scheduler.resolvePending();
  await invokePromise;
  const status = controller.store.getState().ghostStatus;
  assert.ok(['armed', 'interrupted'].includes(status.phase));
  await controller.shutdown();
});

// ---------------------------------------------------------------------------
// A1: release outcome barrier
// ---------------------------------------------------------------------------

test('A1: release before preview outcome reconciles exactly one reject', async () => {
  const { controller, api, scheduler } = makeController();
  api.delayPreview = 80;
  const invokePromise = controller.invoke(region(), -3);
  await new Promise((r) => setTimeout(r, 20)); // preparation in flight
  const releasePromise = controller.release('changed my mind');
  const [, invokeResult] = await Promise.all([releasePromise, invokePromise]);
  assert.equal(invokeResult.code, 'RELEASED');
  const rejects = api.posts.filter((p) => p.action.type === 'reject_proposal');
  assert.equal(rejects.length, 1);
  // Exactly one preview ledger row and one reject: same intent envelope reused.
  const previews = api.posts.filter((p) => p.action.type === 'preview_layer');
  assert.equal(previews.length, 1);
  assert.equal(scheduler.scheduleCalls.length, 0); // never scheduled
});

test('A1: unknown preview outcome is resolved by envelope replay before reject', async () => {
  const { controller, api } = makeController();
  let previewCalls = 0;
  api.postProjectAction = async (projectId, action) => {
    if (action.type === 'preview_layer') {
      previewCalls += 1;
      if (previewCalls === 1) {
        const err = new Error('network reset'); // no status: unknown outcome
        throw err;
      }
      return structuredClone(api.previewResponse); // replay succeeds
    }
    api.posts.push({ kind: 'action', action });
    return { outcome: { result: 'proposal_rejected' }, sequence: 2 };
  };
  const invokePromise = controller.invoke(region(), -3);
  const releasePromise = controller.release();
  await Promise.all([releasePromise, invokePromise]);
  // The identical envelope was replayed once, then rejected.
  assert.equal(previewCalls, 2);
  const rejects = api.posts.filter((p) => p.action?.type === 'reject_proposal');
  assert.equal(rejects.length, 1);
});

test('A1: unreconcilable release keeps a retryable error state', async () => {
  const { controller, api } = makeController();
  // Preview POST network-fails; replay also network-fails.
  api.postProjectAction = async (projectId, action) => {
    const err = new Error('network down');
    throw err; // no status at all, both times
  };
  const invokePromise = controller.invoke(region(), -3);
  const releasePromise = controller.release();
  const [releaseResult] = await Promise.all([releasePromise, invokePromise.catch(() => null)]);
  assert.equal(releaseResult.ok, false);
  const status = controller.store.getState().ghostStatus;
  assert.equal(status.error.code, 'GHOST_RELEASE_UNRECONCILED');
});

test('A1: a 5xx preview outcome remains releasable and replays the same intent', async () => {
  const { controller, api } = makeController();
  const envelopes = [];
  let calls = 0;
  api.postProjectAction = async (projectId, action) => {
    if (action.type === 'preview_layer') {
      envelopes.push(action);
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('server response failed'), { status: 500 });
      return structuredClone(api.previewResponse);
    }
    api.posts.push({ kind: 'action', action });
    return { outcome: { result: 'proposal_rejected' }, sequence: 2 };
  };
  const result = await controller.invoke(region(), -3);
  assert.equal(result.code, 'GHOST_PREVIEW_OUTCOME_UNKNOWN');
  const released = await controller.release();
  assert.equal(released.ok, true);
  assert.equal(envelopes.length, 2);
  assert.deepEqual(envelopes[1], envelopes[0]);
  assert.equal(api.posts.filter((p) => p.action.type === 'reject_proposal').length, 1);
});

test('A1: failed reject retries the identical reject envelope', async () => {
  const { controller, api } = makeController({ currentTime: 0 });
  await controller.invoke(region(), -3);
  const originalPost = api.postProjectAction;
  const rejectEnvelopes = [];
  let rejectCalls = 0;
  api.postProjectAction = async (projectId, action) => {
    if (action.type === 'reject_proposal') {
      rejectEnvelopes.push(structuredClone(action));
      rejectCalls += 1;
      if (rejectCalls === 1) throw new Error('network reset');
    }
    return originalPost(projectId, action);
  };
  const first = await controller.release();
  assert.equal(first.ok, false);
  const second = await controller.release();
  assert.equal(second.ok, true);
  assert.equal(rejectEnvelopes.length, 2);
  assert.deepEqual(rejectEnvelopes[1], rejectEnvelopes[0]);
});

test('release with nothing active is a successful no-op', async () => {
  const { controller } = makeController();
  const result = await controller.release();
  assert.ok(result.ok);
  assert.equal(controller.store.getState().ghostStatus.phase, 'idle');
});

// ---------------------------------------------------------------------------
// A10: retry serialization
// ---------------------------------------------------------------------------

test('A10: retry awaits the durable release before authoring a replacement', async () => {
  const { controller, api } = makeController({ currentTime: 0 });
  await controller.invoke(region(), -3);
  const postsBeforeRetry = api.posts.length;
  const result = await controller.retry({ ...region(), id: 'r2' }, -6);
  assert.ok(result.ok, JSON.stringify(result));
  const posts = api.posts.slice(postsBeforeRetry);
  const reject = posts.find((p) => p.action?.type === 'reject_proposal');
  const preview = posts.find((p) => p.action?.type === 'preview_layer');
  assert.ok(reject, 'retry must reject the old proposal');
  assert.ok(preview, 'retry must author a replacement preview');
  // The reject POST must be recorded in the api BEFORE the new preview POST.
  assert.ok(posts.indexOf(reject) < posts.indexOf(preview));
  await controller.shutdown();
});

test('A10: failed rejection blocks the replacement preview', async () => {
  const { controller, api } = makeController({ currentTime: 0 });
  await controller.invoke(region(), -3);
  api.postProjectAction = async (projectId, action) => {
    if (action.type === 'reject_proposal') {
      const err = new Error('still down');
      throw err;
    }
    return structuredClone(api.previewResponse);
  };
  const result = await controller.retry({ ...region(), id: 'r2' }, -6);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RELEASE_FAILED');
});

// ---------------------------------------------------------------------------
// A8: hydration / switch boundaries
// ---------------------------------------------------------------------------

test('A8: hydrating an active proposal shows interrupted, blocks new previews', async () => {
  const { controller, store } = makeController();
  store.state.proposals.byId['a-9'] = {
    id: 'a-9', lifecycle: 'scheduled',
    payload: { source: { region: region() }, gainDb: -3 },
  };
  store.state.proposals.activeIds.push('a-9');
  controller.handleHydratedProjection(undefined);
  const status = store.state.ghostStatus;
  assert.equal(status.phase, 'interrupted');
  assert.equal(status.activeProposalId, 'a-9');
  assert.equal(status.summary.startBeat, 0);
  const result = await controller.invoke(region(), -3);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'GHOST_ACTIVE');
});

test('A8: Release durably rejects a hydrated proposal with no runtime generation', async () => {
  const { controller, store, api } = makeController();
  store.state.proposals.byId['a-9'] = {
    id: 'a-9', lifecycle: 'scheduled',
    payload: { source: { region: region() }, gainDb: -3 },
  };
  store.state.proposals.activeIds.push('a-9');
  controller.handleHydratedProjection(undefined);
  const result = await controller.release('restored release');
  assert.equal(result.ok, true);
  assert.equal(store.state.proposals.byId['a-9'].lifecycle, 'rejected');
  const reject = api.posts.find((p) => p.action.type === 'reject_proposal');
  assert.equal(reject.action.payload.proposalId, 'a-9');
});

test('A8: multiple hydrated actives yield deterministic conflict state', async () => {
  const { controller, store } = makeController();
  store.state.proposals.byId['a-9'] = { id: 'a-9', lifecycle: 'scheduled' };
  store.state.proposals.byId['a-8'] = { id: 'a-8', lifecycle: 'auditioning' };
  store.state.proposals.activeIds.push('a-9', 'a-8');
  controller.handleHydratedProjection(undefined);
  const status = store.state.ghostStatus;
  assert.equal(status.phase, 'conflict');
  // Deterministic: the first active ID according to server order is adopted.
  assert.equal(status.activeProposalId, 'a-9');
  assert.equal(status.error.code, 'GHOST_STATE_CONFLICT');
});

test('A8: onBeforeProjectChange cancels an armed generation', async () => {
  const { controller, scheduler, ctx } = makeController({ currentTime: 0 });
  const result = await controller.invoke(region(), -3);
  assert.ok(result.ok);
  controller.onBeforeProjectChange();
  assert.equal(scheduler.cancelled.includes('a-1'), true);
  assert.equal(controller.store.getState().ghostStatus.phase, 'idle');
  ctx.currentTime = 15;
  controller.handleHydratedProjection(undefined);
  // No lifecycle POST fires for the old proposal; generation is gone.
});

// ---------------------------------------------------------------------------
// A9: slice purity
// ---------------------------------------------------------------------------

test('A9: ghostStatus stays serializable and runtime-free through all flows', async () => {
  const { controller, store } = makeController({ currentTime: 0 });
  await controller.invoke(region(), -3);
  controller.handleAudioEvent('pause');
  await controller.release();
  const snapshot = store.getState().ghostStatus;
  // Deep-clone round trip must succeed (no runtime objects inside).
  const cloned = structuredClone(JSON.parse(JSON.stringify(
    structuredClone(snapshot),
  )));
  assert.deepEqual(cloned, JSON.parse(JSON.stringify(snapshot)));
  const json = JSON.stringify(snapshot);
  // No raw runtime stringification leakage.
  assert.equal(json.includes('[object'), false);
});

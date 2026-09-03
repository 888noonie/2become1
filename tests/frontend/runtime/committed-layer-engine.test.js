// tests/frontend/runtime/committed-layer-engine.test.js — Phase 12A.1/12A.4/12A.5.
//
// The CommittedLayerEngine is the live committed-layer player: authoritative
// sync() from server-projected committed layers, per-phrase loop scheduling
// via resolveLivePlacement, injected cancellation-safe timers, suspend on
// transport changes, immediate remove on confirmed Undo, hard teardown on
// project switch/shutdown, honest loading/scheduled/live/idle/error states,
// and a refusal to choose among legacy multi-layer projections.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CommittedLayerEngine, ENGINE_STATES } from '../../../src/twobecomeone/studio_static/js/runtime/committed-layer-engine.js';

// ---------------------------------------------------------------------------
// Fakes: AudioContext, timers, asset loader
// ---------------------------------------------------------------------------

class FakeBufferSource {
  constructor(ctx) {
    this.ctx = ctx;
    this.buffer = null;
    this.onended = null;
    this.startedAt = null;
    this.stopped = false;
    this.disconnected = false;
    this.connectedTo = null;
  }
  connect(node) { this.connectedTo = node; return node; }
  disconnect() { this.disconnected = true; }
  start(when) { this.startedAt = when; this.ctx.starts.push({ when, source: this }); }
  stop() { this.stopped = true; if (this.onended) this.onended(); }
}

class FakeGainNode {
  constructor() { this.gain = { value: 1 }; this.disconnected = false; }
  connect() { return this; }
  disconnect() { this.disconnected = true; }
}

class FakeAudioContext {
  constructor({ currentTime = 0 } = {}) {
    this.currentTime = currentTime;
    this.state = 'running';
    this.destination = { name: 'destination' };
    this.starts = [];
    this.sources = [];
    this.gains = [];
    this.closed = false;
  }
  createBufferSource() {
    const source = new FakeBufferSource(this);
    this.sources.push(source);
    return source;
  }
  createGain() {
    const gain = new FakeGainNode();
    this.gains.push(gain);
    return gain;
  }
  async decodeAudioData(buffer) { return { duration: 8 }; }
  async close() { this.closed = true; }
}

class FakeTimers {
  constructor() { this.ids = new Map(); this.nextId = 1; }
  set(delayMs, fn) {
    const id = this.nextId++;
    this.ids.set(id, { delayMs, fn });
    return id;
  }
  clear(id) { this.ids.delete(id); }
  async fire(id) {
    const entry = this.ids.get(id);
    if (!entry) return;
    this.ids.delete(id);
    await entry.fn();
  }
  fireAll() {
    for (const [id, entry] of [...this.ids.entries()]) {
      this.ids.delete(id);
      entry.fn();
    }
  }
  get pending() { return this.ids.size; }
}

function transport(overrides = {}) {
  return {
    deck: 'B',
    playing: true,
    tempoBpm: 120,
    beatsPerBar: 4,
    phraseBars: 8,
    beatAtStart: 0,
    startedAtAudioTime: 0,
    gridRevision: 'grid-v1:abc',
    ...overrides,
  };
}

function committedLayer(overrides = {}) {
  return {
    actionId: 'c-1',
    layerId: 'layer-c-1',
    proposalId: 'a-1',
    launchReceipt: {
      launchBeat: 32,
      destinationGridRevision: 'grid-v1:abc',
      destinationOriginSeconds: 0,
      targetBpm: 120,
      assetId: 'ga-1',
      contentHash: 'sha256:abc',
    },
    transformSpec: {
      targetBpm: 120,
      destinationGrid: { originSeconds: 0, intervalSeconds: 0.5 },
      destinationGridRevision: 'grid-v1:abc',
      semanticRegion: { id: 'r1', startBeat: 0, endBeat: 16 },
    },
    placement: { gainDb: -6, timing: { launch: 'next_phrase', quantize: true } },
    asset: { id: 'ga-1', contentHash: 'sha256:abc', pinned: true },
    ...overrides,
  };
}

function makeEngine({ currentTime = 0, transportOverrides = {}, decodeDelay = 0 } = {}) {
  const ctx = new FakeAudioContext({ currentTime });
  ctx.decodeDelay = decodeDelay;
  const timers = new FakeTimers();
  const states = [];
  const loads = [];
  const engine = new CommittedLayerEngine({
    audioContext: ctx,
    loadAsset: async (asset, signal) => {
      loads.push(asset.id);
      if (signal?.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return new ArrayBuffer(8);
    },
    transportProvider: () => transport(transportOverrides),
    resolvePlacement: null, // real resolveLivePlacement by default
    setTimer: (delayMs, fn) => timers.set(delayMs, fn),
    clearTimer: (id) => timers.clear(id),
    onStateChange: (layerId, state, detail) => states.push({ layerId, state, detail }),
  });
  return { ctx, timers, states, loads, engine };
}

// ---------------------------------------------------------------------------
// sync / states
// ---------------------------------------------------------------------------

test('sync with one committed layer arms loading then scheduled', async () => {
  const { ctx, timers, states, engine } = makeEngine();
  await engine.sync([committedLayer()]);
  assert.equal(states[0].state, ENGINE_STATES.LOADING);
  assert.equal(states.at(-1).state, ENGINE_STATES.SCHEDULED);
  assert.equal(ctx.starts.length, 1);
  assert.equal(ctx.starts[0].when, 16); // beat 32 at 120 BPM
  assert.equal(timers.pending, 1); // loop wake armed
  engine.shutdown();
});

test('snapshot reports layer identity and schedule receipt', async () => {
  const { engine } = makeEngine();
  await engine.sync([committedLayer()]);
  const snap = engine.snapshot();
  assert.equal(snap.layers.length, 1);
  assert.equal(snap.layers[0].layerId, 'layer-c-1');
  assert.equal(snap.layers[0].state, 'scheduled');
  assert.equal(snap.layers[0].receipt.launchBeat, 32);
  assert.equal(snap.layers[0].receipt.launchAudioTime, 16);
  assert.equal(snap.layers[0].receipt.gridRevision, 'grid-v1:abc');
  // Immutable + JSON-serializable: no runtime objects.
  assert.equal(Object.isFrozen(snap), true);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(snap)));
  engine.shutdown();
});

test('sync with zero layers clears everything (Undo / hydration)', async () => {
  const { ctx, timers, engine } = makeEngine();
  await engine.sync([committedLayer()]);
  assert.equal(ctx.starts.length, 1);
  await engine.sync([]);
  assert.equal(ctx.starts.length, 1); // no new starts
  assert.equal(timers.pending, 0);
  assert.equal(ctx.sources[0].stopped, true); // the armed source was cancelled
  const snap = engine.snapshot();
  assert.equal(snap.layers.length, 0);
  engine.shutdown();
});

test('second sync with the same layer is idempotent', async () => {
  const { ctx, states, engine } = makeEngine();
  await engine.sync([committedLayer()]);
  const before = states.length;
  await engine.sync([committedLayer()]);
  assert.equal(ctx.starts.length, 1); // no duplicate start
  assert.equal(states.length, before); // no redundant state churn
  engine.shutdown();
});

test('sync replaces a removed layer with a new one (revert then recommit)', async () => {
  const { ctx, engine } = makeEngine();
  await engine.sync([committedLayer()]);
  assert.equal(ctx.starts.length, 1);
  const second = committedLayer({
    actionId: 'c-2', layerId: 'layer-c-2',
    launchReceipt: { ...committedLayer().launchReceipt, launchBeat: 64 },
    asset: { id: 'ga-2', contentHash: 'sha256:def', pinned: true },
  });
  await engine.sync([second]);
  assert.equal(ctx.starts.length, 2);
  assert.equal(ctx.sources[0].stopped, true); // first layer's source cancelled
  assert.equal(ctx.starts[1].when, 32); // beat 64 -> 32s
  engine.shutdown();
});

test('legacy multi-layer projection fails honestly without choosing', async () => {
  const { ctx, states, engine } = makeEngine();
  const first = committedLayer();
  const second = committedLayer({
    actionId: 'c-2', layerId: 'layer-c-2',
    launchReceipt: { ...committedLayer().launchReceipt, launchBeat: 64 },
  });
  await engine.sync([first, second]);
  assert.equal(ctx.starts.length, 0); // nothing scheduled
  const last = states.at(-1);
  assert.equal(last.state, ENGINE_STATES.ERROR);
  assert.equal(last.detail.code, 'L_LAYER_LIMIT');
  const snap = engine.snapshot();
  assert.equal(snap.layers.length, 2);
  assert.ok(snap.layers.every((l) => l.state === 'error'));
  engine.shutdown();
});

// ---------------------------------------------------------------------------
// loop scheduling
// ---------------------------------------------------------------------------

test('loop wake re-resolves against the live clock each phrase', async () => {
  const { ctx, timers, engine } = makeEngine({ currentTime: 16 });
  await engine.sync([committedLayer()]);
  // Instances sit at the layer's launch position every phrase: beats
  // 32, 64, 96 -> t=16, 32, 48. At now=16 the beat-32 instance is on-now
  // (epsilon) -> the beat-64 instance at t=32 is armed first.
  assert.equal(ctx.starts[0].when, 32);
  // Simulate the phrase elapsing: advance the context clock, fire the wake.
  ctx.currentTime = 32;
  timers.fireAll();
  await new Promise((resolve) => setTimeout(resolve, 0)); // let async wake settle
  assert.equal(ctx.starts.length, 2);
  assert.equal(ctx.starts[1].when, 48); // next whole-phrase instance
  const state = engine.snapshot().layers[0].state;
  assert.equal(state, 'live');
  engine.shutdown();
});

test('loop repeats for N phrases then keeps going until cancelled', async () => {
  const { ctx, timers, engine } = makeEngine();
  await engine.sync([committedLayer()]);
  for (let i = 0; i < 3; i++) {
    ctx.currentTime = ctx.starts.at(-1).when;
    timers.fireAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(ctx.starts.length, 4);
  engine.shutdown();
});

test('gain node applies placement gainDb', async () => {
  const { ctx, engine } = makeEngine();
  await engine.sync([committedLayer()]);
  const gain = ctx.gains[0];
  assert.ok(Math.abs(gain.gain.value - Math.pow(10, -6 / 20)) < 1e-9);
  assert.equal(ctx.sources[0].connectedTo, gain);
  engine.shutdown();
});

// ---------------------------------------------------------------------------
// suspend / resume / teardown
// ---------------------------------------------------------------------------

test('suspend cancels timers and stops sounding sources', async () => {
  const { ctx, timers, engine } = makeEngine();
  await engine.sync([committedLayer()]);
  assert.equal(timers.pending, 1);
  engine.suspend('lead-paused');
  assert.equal(timers.pending, 0);
  assert.equal(ctx.sources[0].stopped, true);
  const snap = engine.snapshot();
  assert.equal(snap.layers[0].state, 'idle');
  engine.shutdown();
});

test('suspend then sync resumes on a later owned Lead play', async () => {
  const { ctx, timers, engine } = makeEngine();
  await engine.sync([committedLayer()]);
  engine.suspend('lead-paused');
  assert.equal(ctx.starts.length, 1);
  await engine.sync([committedLayer()]); // authoritative re-sync = resume
  assert.equal(ctx.starts.length, 2);
  assert.equal(timers.pending, 1);
  engine.shutdown();
});

test('remove cancels only the named layer immediately', async () => {
  const { ctx, timers, engine } = makeEngine();
  await engine.sync([committedLayer()]);
  engine.remove('c-1');
  assert.equal(timers.pending, 0);
  assert.equal(ctx.sources[0].stopped, true);
  assert.equal(engine.snapshot().layers.length, 0);
  engine.shutdown();
});

test('shutdown cancels everything and prevents future scheduling', async () => {
  const { ctx, timers, engine } = makeEngine();
  await engine.sync([committedLayer()]);
  engine.shutdown();
  assert.equal(timers.pending, 0);
  assert.equal(ctx.sources[0].stopped, true);
  await engine.sync([committedLayer()]); // shutdown is final
  assert.equal(ctx.starts.length, 1);
});

test('stale decode never starts after a cancel', async () => {
  const { ctx, engine } = makeEngine({ decodeDelay: 50 });
  const promise = engine.sync([committedLayer()]);
  engine.remove('c-1');
  await promise;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(ctx.starts.length, 0);
  engine.shutdown();
});

test('suspend aborts an in-flight asset fetch without publishing an error', async () => {
  const ctx = new FakeAudioContext();
  const states = [];
  let observedSignal = null;
  let rejectLoad;
  const engine = new CommittedLayerEngine({
    audioContext: ctx,
    loadAsset: async (_asset, signal) => {
      observedSignal = signal;
      return new Promise((_resolve, reject) => { rejectLoad = reject; });
    },
    transportProvider: () => transport(),
    setTimer: () => 1,
    clearTimer: () => {},
    onStateChange: (layerId, state, detail) => states.push({ layerId, state, detail }),
  });
  const syncing = engine.sync([committedLayer()]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  engine.suspend('lead-pause');
  assert.equal(observedSignal.aborted, true);
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  rejectLoad(abort);
  await syncing;
  assert.equal(states.at(-1).state, ENGINE_STATES.IDLE);
  assert.equal(ctx.starts.length, 0);
  engine.shutdown();
});

test('source.start failure disconnects source and gain and reports an honest error', async () => {
  const ctx = new FakeAudioContext();
  const originalCreate = ctx.createBufferSource.bind(ctx);
  ctx.createBufferSource = () => {
    const source = originalCreate();
    source.start = () => { throw new Error('device rejected schedule'); };
    return source;
  };
  const states = [];
  const engine = new CommittedLayerEngine({
    audioContext: ctx,
    loadAsset: async () => new ArrayBuffer(8),
    transportProvider: () => transport(),
    setTimer: () => 1,
    clearTimer: () => {},
    onStateChange: (layerId, state, detail) => states.push({ layerId, state, detail }),
  });
  await engine.sync([committedLayer()]);
  assert.equal(ctx.sources[0].disconnected, true);
  assert.equal(ctx.gains[0].disconnected, true);
  assert.equal(states.at(-1).state, ENGINE_STATES.ERROR);
  assert.equal(states.at(-1).detail.code, 'SCHEDULE_FAILED');
  engine.shutdown();
});

test('transport not playing yields idle, not error', async () => {
  const { ctx, states, engine } = makeEngine({ transportOverrides: { playing: false } });
  await engine.sync([committedLayer()]);
  assert.equal(ctx.starts.length, 0);
  assert.equal(states.at(-1).state, ENGINE_STATES.IDLE);
  engine.shutdown();
});

test('asset load failure is an honest error state', async () => {
  const ctx = new FakeAudioContext();
  const states = [];
  const engine = new CommittedLayerEngine({
    audioContext: ctx,
    loadAsset: async () => { throw new Error('network down'); },
    transportProvider: () => transport(),
    setTimer: () => 1,
    clearTimer: () => {},
    onStateChange: (layerId, state, detail) => states.push({ layerId, state, detail }),
  });
  await engine.sync([committedLayer()]);
  assert.equal(ctx.starts.length, 0);
  assert.equal(states.at(-1).state, ENGINE_STATES.ERROR);
  assert.equal(states.at(-1).detail.code, 'S_ASSET_UNAVAILABLE');
  engine.shutdown();
});

test('every phrase disconnects its GainNode (no connected-gain leak)', async () => {
  const { ctx, engine } = makeEngine({ currentTime: 0 });
  await engine.sync([committedLayer()]);
  // One instance armed; its gain is connected to the destination.
  assert.equal(ctx.gains.length, 1);
  assert.equal(ctx.gains[0].disconnected, false);

  // Suspend (pause/stop/ended/seek): the gain must be disconnected so the
  // graph does not keep a connected GainNode alive after suspension.
  engine.suspend('lead-pause');
  for (const gain of ctx.gains) {
    assert.equal(gain.disconnected, true, 'gain must be disconnected on suspend');
  }
  engine.shutdown();
});

test('scheduled announcement surfaces the re-resolved next launch beat', async () => {
  // At now=16 the accepted launch beat 32 is exactly "now", so the engine
  // whole-phrase-steps to the NEXT future instance (beat 64). The scheduled
  // announcement must carry that re-resolved beat, not the original 32.
  const { states, engine } = makeEngine({ currentTime: 16 });
  await engine.sync([committedLayer()]);
  const scheduled = states.find((s) => s.state === ENGINE_STATES.SCHEDULED);
  assert.ok(scheduled, 'a scheduled announcement exists');
  assert.equal(scheduled.detail.launchBeat, 64);
  engine.shutdown();
});

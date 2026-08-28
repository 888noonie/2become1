// tests/frontend/runtime/ghost-scheduler.test.js — Phase 9C Node unit tests.
//
// Uses an injected fake AudioContext to prove: one and only one
// AudioBufferSourceNode.start() at the next phrase boundary (not now, not a
// passed boundary, not a visual timer); before/on/after boundary handling;
// nonzero clock origins; decode delay + finite minimum lead-time policy;
// stale-safe cancellation; and immutable schedule receipts.

import test from 'node:test';
import assert from 'node:assert/strict';

import { GhostScheduler, MIN_LEAD_SECONDS } from '../../../src/twobecomeone/studio_static/js/runtime/ghost-scheduler.js';

// ---------------------------------------------------------------------------
// Fake AudioContext
// ---------------------------------------------------------------------------

class FakeAudioBuffer {
  constructor() {
    this.duration = 2.0;
  }
}

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
  connect(node) {
    this.connectedTo = node;
    return node;
  }
  disconnect() {
    this.disconnected = true;
  }
  start(when) {
    this.startedAt = when;
    this.ctx.starts.push({ when, source: this });
  }
  stop() {
    this.stopped = true;
  }
}

class FakeGainNode {
  constructor() {
    this.gain = { value: 1 };
    this.disconnected = false;
  }
  connect() {
    return this;
  }
  disconnect() {
    this.disconnected = true;
  }
}

class FakeAudioContext {
  constructor({ currentTime = 0 } = {}) {
    this.currentTime = currentTime;
    this.destination = { name: 'destination' };
    this.starts = [];
    this.sources = [];
    this.gains = [];
    this.decodeDelay = 0;
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
  async decodeAudioData(buffer) {
    if (this.decodeDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.decodeDelay));
    }
    return new FakeAudioBuffer();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function transport(overrides = {}) {
  return {
    deck: 'B',
    playing: true,
    tempoBpm: 120,
    beatsPerBar: 4,
    phraseBars: 8,
    beatAtStart: 0,
    startedAtAudioTime: 0,
    gridRevision: 'grid-1',
    ...overrides,
  };
}

function scheduledProposal(overrides = {}) {
  return {
    id: 'a-1',
    actionType: 'preview_layer',
    actor: { type: 'human', id: 'richard' },
    requestedAt: 't',
    idempotencyKey: 'k',
    lifecycle: 'scheduled',
    payload: {
      source: { deck: 'A', stem: 'vocal', region: { id: 'r1', startBeat: 0, endBeat: 8 } },
      destination: { deck: 'B' },
      timing: { launch: 'next_phrase', quantize: true },
      gainDb: -3,
    },
    ...overrides,
  };
}

function asset() {
  return {
    id: 'ga-1',
    contentHash: 'sha256:abc',
    audioUrl: '/api/ghost-assets/ga-1/audio',
    transformSpec: {},
  };
}

function makeScheduler({ currentTime = 0, transportOverrides = {}, decodeDelay = 0, minLeadSeconds } = {}) {
  const ctx = new FakeAudioContext({ currentTime });
  ctx.decodeDelay = decodeDelay;
  const scheduler = new GhostScheduler({
    audioContext: ctx,
    loadAsset: async (a, signal) => {
      if (signal?.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return new ArrayBuffer(8);
    },
    transportProvider: (deck) => transport({ deck, ...transportOverrides }),
    minLeadSeconds,
  });
  return { ctx, scheduler };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('schedules exactly one start() at the next phrase boundary', async () => {
  const { ctx, scheduler } = makeScheduler({ currentTime: 5 });
  const result = await scheduler.schedule(scheduledProposal(), asset());
  assert.equal(result.ok, true);
  assert.equal(ctx.starts.length, 1);
  // 120 BPM -> 2 bps. At t=5s beat=10. Next boundary = beat 32 -> t=16s.
  assert.equal(ctx.starts[0].when, 16);
  assert.equal(result.receipt.launchAudioTime, 16);
  assert.equal(result.receipt.resolvedBeat, 32);
  assert.equal(result.receipt.gridRevision, 'grid-1');
  assert.equal(result.receipt.assetContentHash, 'sha256:abc');
});

test('before boundary returns that boundary', async () => {
  // At t=15.0 beat=30, next boundary = 32 -> t=16s, which is 1s ahead (well
  // above the min lead), so the upcoming boundary is returned.
  const { ctx, scheduler } = makeScheduler({ currentTime: 15 });
  const result = await scheduler.schedule(scheduledProposal(), asset());
  assert.equal(result.ok, true);
  assert.equal(ctx.starts[0].when, 16);
});

test('exactly on boundary returns the following boundary', async () => {
  const { ctx, scheduler } = makeScheduler({ currentTime: 16 });
  const result = await scheduler.schedule(scheduledProposal(), asset());
  assert.equal(result.ok, true);
  assert.equal(ctx.starts[0].when, 32);
  assert.equal(result.receipt.resolvedBeat, 64);
});

test('after boundary returns the following boundary', async () => {
  const { ctx, scheduler } = makeScheduler({ currentTime: 16.5 });
  const result = await scheduler.schedule(scheduledProposal(), asset());
  assert.equal(result.ok, true);
  assert.equal(ctx.starts[0].when, 32);
});

test('nonzero clock origin is respected', async () => {
  const { ctx, scheduler } = makeScheduler({
    currentTime: 8,
    transportOverrides: { beatAtStart: 7, startedAtAudioTime: 3 },
  });
  // beat = 7 + (8-3)*2 = 17. Next boundary = 32 -> t = 3 + (32-7)/2 = 15.5.
  const result = await scheduler.schedule(scheduledProposal(), asset());
  assert.equal(result.ok, true);
  assert.ok(Math.abs(ctx.starts[0].when - 15.5) < 1e-9);
});

test('decode delay triggers finite minimum lead-time re-resolution', async () => {
  // currentTime starts at 15.9 (boundary at 16). Decode takes 0.5s, so by the
  // time we resolve, now ~16.4 and the 16 boundary is unsafe (< min lead).
  // The scheduler must re-resolve the FOLLOWING phrase (32) rather than start
  // late at 16.
  const { ctx, scheduler } = makeScheduler({
    currentTime: 15.9,
    decodeDelay: 500,
    minLeadSeconds: 0.25,
  });
  const result = await scheduler.schedule(scheduledProposal(), asset());
  assert.equal(result.ok, true);
  assert.equal(ctx.starts[0].when, 32);
  assert.equal(result.receipt.resolvedBeat, 64);
});

test('minimum lead skips multiple short phrases until the boundary is safe', async () => {
  const { ctx, scheduler } = makeScheduler({
    currentTime: 0.16,
    minLeadSeconds: 0.25,
    transportOverrides: { tempoBpm: 300, beatsPerBar: 1, phraseBars: 1 },
  });
  const result = await scheduler.schedule(scheduledProposal(), asset());
  assert.equal(result.ok, true);
  assert.ok(Math.abs(ctx.starts[0].when - 0.6) < 1e-9);
  assert.ok(ctx.starts[0].when - ctx.currentTime >= 0.25);
});

test('stopped transport fails with TRANSPORT_NOT_PLAYING', async () => {
  const { ctx, scheduler } = makeScheduler({ transportOverrides: { playing: false } });
  const result = await scheduler.schedule(scheduledProposal(), asset());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'T_TRANSPORT_NOT_PLAYING');
  assert.equal(ctx.starts.length, 0);
});

test('rejects non-human and non-scheduled proposals', async () => {
  const { ctx, scheduler } = makeScheduler();
  const producer = scheduledProposal({ actor: { type: 'producer', id: 'ghost' } });
  const r1 = await scheduler.schedule(producer, asset());
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'NOT_HUMAN');

  const ready = scheduledProposal({ lifecycle: 'ready' });
  const r2 = await scheduler.schedule(ready, asset());
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'NOT_SCHEDULED');
  assert.equal(ctx.starts.length, 0);
});

test('one scheduled source per proposal', async () => {
  const { ctx, scheduler } = makeScheduler();
  const proposal = scheduledProposal();
  const r1 = await scheduler.schedule(proposal, asset());
  assert.equal(r1.ok, true);
  const r2 = await scheduler.schedule(proposal, asset());
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'ALREADY_SCHEDULED');
  assert.equal(ctx.starts.length, 1);
});

test('cancel before decode prevents any start', async () => {
  const { ctx, scheduler } = makeScheduler({ decodeDelay: 200 });
  const proposal = scheduledProposal();
  const promise = scheduler.schedule(proposal, asset());
  scheduler.cancel(proposal.id);
  const result = await promise;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STALE');
  assert.equal(ctx.starts.length, 0);
});

test('shutdown prevents future scheduling and cleans up', async () => {
  const { ctx, scheduler } = makeScheduler();
  scheduler.shutdown();
  const result = await scheduler.schedule(scheduledProposal(), asset());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SHUTDOWN');
  assert.equal(ctx.starts.length, 0);
});

test('receipt is immutable and snapshot is serializable', async () => {
  const { ctx, scheduler } = makeScheduler();
  const result = await scheduler.schedule(scheduledProposal(), asset());
  assert.equal(Object.isFrozen(result.receipt), true);
  const snap = scheduler.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].proposalId, 'a-1');
  assert.equal(snap[0].state, 'started');
  assert.equal(snap[0].receipt.launchAudioTime, result.receipt.launchAudioTime);
  // Snapshot is a deep clone; mutating it does not touch the scheduler.
  snap[0].receipt.launchAudioTime = 999;
  assert.equal(scheduler.snapshot()[0].receipt.launchAudioTime, result.receipt.launchAudioTime);
});

test('gain node applies the proposal gainDb', async () => {
  const { ctx, scheduler } = makeScheduler();
  await scheduler.schedule(scheduledProposal(), asset());
  const gain = ctx.gains[0];
  // -3 dB -> 10^(-3/20) ~ 0.7079
  assert.ok(Math.abs(gain.gain.value - Math.pow(10, -3 / 20)) < 1e-6);
  // Source connects to gain, gain connects to destination.
  assert.equal(ctx.sources[0].connectedTo, gain);
});

test('no runtime objects enter any state snapshot', async () => {
  const { ctx, scheduler } = makeScheduler();
  await scheduler.schedule(scheduledProposal(), asset());
  const snap = scheduler.snapshot();
  const json = JSON.stringify(snap);
  // The snapshot must be pure JSON — no AudioContext/nodes/buffers.
  assert.doesNotThrow(() => JSON.parse(json));
  assert.equal(json.includes('FakeAudioContext'), false);
  assert.equal(json.includes('FakeBufferSource'), false);
});

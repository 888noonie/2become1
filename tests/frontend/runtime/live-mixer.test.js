// tests/frontend/runtime/live-mixer.test.js — Phase 15A RED contract.
//
// The LiveMixer retires the "one active HTMLAudioElement" policy: two
// independently controllable deck transports (A and B) sharing one
// AudioContext, each with its own private media element routed through a
// MediaElementAudioSourceNode into an independent gain bus and a common
// master. No DOM/window imports; everything is injected for Node tests.
//
// Sol hardening contract (re-audit): deferred-promise probes for the
// pause race, stale non-AbortError rejection, and generation-safe ended/error
// events; a serializable subscription contract; complete per-deck snapshot
// shape (ownership generation, paused/context state, context clock, full
// source identity); awaited/explicit context resume; complete shutdown with
// media-source release; and stable table-backed media error codes.

import test from 'node:test';
import assert from 'node:assert/strict';

import { LiveMixer } from '../../../src/twobecomeone/studio_static/js/runtime/live-mixer.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeMediaElement {
  constructor() {
    this.paused = true;
    this.ended = false;
    this.currentTime = 0;
    this.duration = 0;
    this.src = '';
    this.crossOrigin = null;
    this._listeners = {}; // type -> array of fns (supports stale-event simulation)
    this._playImpl = null; // optional override: () => Promise
  }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn);
  }
  play() {
    if (this._playImpl) return this._playImpl();
    this.paused = false;
    return Promise.resolve();
  }
  pause() { this.paused = true; }
  load() {}
  removeAttribute() { this.src = ''; }
  _emit(type) { for (const fn of (this._listeners[type] || [])) fn(); }
}

class FakeAudioParam {
  constructor() { this.value = 1; }
}

class FakeGainNode {
  constructor() { this.gain = new FakeAudioParam(); this.connectedTo = null; this.disconnected = false; }
  connect(node) { this.connectedTo = node; return node; }
  disconnect() { this.disconnected = true; }
}

class FakeMediaElementSource {
  constructor(element) { this.element = element; this.connectedTo = null; this.disconnected = false; }
  connect(node) { this.connectedTo = node; return node; }
  disconnect() { this.disconnected = true; }
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = 'suspended';
    this.destination = {};
    this._sources = [];
    this._gains = [];
    this._wrapped = new Set();
    this._closed = false;
    this._resumeReject = null;
  }
  createMediaElementSource(element) {
    if (this._wrapped.has(element)) {
      throw new Error('createMediaElementSource called twice on the same element');
    }
    this._wrapped.add(element);
    const source = new FakeMediaElementSource(element);
    this._sources.push(source);
    return source;
  }
  createGain() {
    const gain = new FakeGainNode();
    this._gains.push(gain);
    return gain;
  }
  resume() {
    if (this._resumeReject) {
      const err = this._resumeReject;
      this._resumeReject = null;
      return Promise.reject(err);
    }
    this.state = 'running';
    return Promise.resolve();
  }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close() { this._closed = true; this.state = 'closed'; return Promise.resolve(); }
}

function makeMixer({ elements = [] } = {}) {
  const ctx = new FakeAudioContext();
  let idx = 0;
  const mixer = new LiveMixer({
    audioContextFactory: { create: () => ctx },
    mediaElementFactory: {
      create: () => {
        const el = elements[idx] || new FakeMediaElement();
        if (!elements[idx]) elements[idx] = el;
        idx += 1;
        return el;
      },
    },
  });
  return { mixer, ctx, elements };
}

const DESC_A = { trackId: 'A', url: '/api/tracks/A/audio', kind: 'track', variant: 'full' };
const DESC_B = { trackId: 'B', url: '/api/tracks/B/audio', kind: 'track', variant: 'full' };

// ---------------------------------------------------------------------------
// Original RED contract (independent dual-deck)
// ---------------------------------------------------------------------------

test('playing A never stops B and vice versa', async () => {
  const { mixer } = makeMixer();
  await mixer.play('A', DESC_A);
  await mixer.play('B', DESC_B);
  assert.equal(mixer.getDeck('A').playing, true, 'A keeps playing after B starts');
  assert.equal(mixer.getDeck('B').playing, true, 'B is playing');
  assert.equal(mixer.getDeck('A').trackId, 'A');
  assert.equal(mixer.getDeck('B').trackId, 'B');
});

test('independent pause stops only the named deck', async () => {
  const { mixer } = makeMixer();
  await mixer.play('A', DESC_A);
  await mixer.play('B', DESC_B);
  mixer.pause('A');
  assert.equal(mixer.getDeck('A').playing, false);
  assert.equal(mixer.getDeck('B').playing, true, 'B unaffected by pausing A');
});

test('independent stop resets only the named deck', async () => {
  const { mixer } = makeMixer();
  await mixer.play('A', DESC_A);
  await mixer.play('B', DESC_B);
  mixer.stop('A');
  assert.equal(mixer.getDeck('A').trackId, null);
  assert.equal(mixer.getDeck('A').playing, false);
  assert.equal(mixer.getDeck('B').trackId, 'B', 'B unaffected by stopping A');
});

test('independent seek changes only the named deck time', async () => {
  const { mixer, elements } = makeMixer();
  await mixer.play('A', DESC_A);
  await mixer.play('B', DESC_B);
  mixer.seek('A', 12.5);
  assert.equal(elements[0].currentTime, 12.5);
  assert.equal(elements[1].currentTime, 0, 'B time unaffected by seeking A');
});

test('source replacement on one deck leaves the other intact', async () => {
  const { mixer } = makeMixer();
  await mixer.play('A', DESC_A);
  await mixer.play('B', DESC_B);
  await mixer.play('A', { ...DESC_A, trackId: 'A2', url: '/api/tracks/A2/audio' });
  assert.equal(mixer.getDeck('A').trackId, 'A2');
  assert.equal(mixer.getDeck('B').trackId, 'B', 'B unaffected by replacing A');
});

test('shutdown stops and disconnects both decks', async () => {
  const { mixer, ctx } = makeMixer();
  await mixer.play('A', DESC_A);
  await mixer.play('B', DESC_B);
  await mixer.shutdown();
  assert.equal(mixer.getDeck('A').playing, false);
  assert.equal(mixer.getDeck('B').playing, false);
  assert.equal(ctx._closed, true, 'context closed on shutdown');
  for (const source of ctx._sources) assert.equal(source.disconnected, true);
  for (const gain of ctx._gains) assert.equal(gain.disconnected, true);
});

test('each element is wrapped by createMediaElementSource exactly once', async () => {
  const { mixer, ctx } = makeMixer();
  await mixer.play('A', DESC_A);
  await mixer.play('B', DESC_B);
  await mixer.play('A', { ...DESC_A, trackId: 'A2', url: '/api/tracks/A2/audio' });
  assert.equal(ctx._wrapped.size, 2, 'two elements wrapped, each once');
});

test('suspended context is never reported as playing', async () => {
  const { mixer, ctx } = makeMixer();
  await mixer.play('A', DESC_A);
  ctx.state = 'suspended';
  assert.equal(mixer.getDeck('A').playing, false, 'suspended context is not playing');
});

test('snapshot is serializable and contains no runtime objects', async () => {
  const { mixer } = makeMixer();
  await mixer.play('A', DESC_A);
  await mixer.play('B', DESC_B);
  const snap = mixer.snapshot();
  const json = JSON.stringify(snap);
  assert.doesNotThrow(() => JSON.parse(json));
  const parsed = JSON.parse(json);
  assert.equal(parsed.decks.A.trackId, 'A');
  assert.equal(parsed.decks.B.trackId, 'B');
  assert.equal(typeof parsed.decks.A.playing, 'boolean');
  assert.ok(!('element' in parsed.decks.A));
  assert.ok(!('sourceNode' in parsed.decks.A));
});

test('invalid deck is rejected', async () => {
  const { mixer } = makeMixer();
  const result = await mixer.play('C', DESC_A);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'T_INVALID_DECK');
});

// ---------------------------------------------------------------------------
// Sol hardening contract (deferred-promise probes)
// ---------------------------------------------------------------------------

test('pause advances generation: a pending play() cannot publish playing:true', async () => {
  const elA = new FakeMediaElement();
  let resolvePlay = null;
  let playCalled = false;
  elA._playImpl = () => new Promise((resolve) => {
    playCalled = true;
    resolvePlay = () => { elA.paused = false; resolve(); };
  });
  const { mixer } = makeMixer({ elements: [elA] });
  const playPromise = mixer.play('A', DESC_A); // will suspend at await element.play()
  // Wait until element.play() has actually been invoked (past the context await).
  while (!playCalled) await new Promise((r) => setImmediate(r));
  mixer.pause('A'); // advances generation, invalidates the pending play
  resolvePlay(); // the stale play() now resolves
  await playPromise;
  assert.equal(mixer.getDeck('A').playing, false, 'stale play must not publish playing');
});

test('stale non-AbortError rejection cannot overwrite a newer successful source', async () => {
  const elA = new FakeMediaElement();
  let rejectFirst = null;
  let firstCalled = false;
  let call = 0;
  elA._playImpl = () => {
    call += 1;
    if (call === 1) {
      firstCalled = true;
      return new Promise((_resolve, reject) => { rejectFirst = reject; });
    }
    elA.paused = false;
    return Promise.resolve();
  };
  const { mixer } = makeMixer({ elements: [elA] });
  const first = mixer.play('A', { ...DESC_A, trackId: 'A1', url: '/a1' });
  while (!firstCalled) await new Promise((r) => setImmediate(r));
  const second = mixer.play('A', { ...DESC_A, trackId: 'A2', url: '/a2' });
  await second; // newer source succeeds
  // The older source rejects with a non-AbortError AFTER the newer succeeded.
  rejectFirst(Object.assign(new Error('NotSupportedError'), { name: 'NotSupportedError' }));
  await first;
  assert.equal(mixer.getDeck('A').trackId, 'A2', 'newer source wins');
  assert.equal(mixer.getDeck('A').playing, true, 'newer source stays playing');
  assert.equal(mixer.getDeck('A').error, null, 'stale error must not surface');
});

test('delayed ended from a replaced source is ignored', async () => {
  const elA = new FakeMediaElement();
  const { mixer } = makeMixer({ elements: [elA] });
  await mixer.play('A', DESC_A); // generation 1
  const oldEnded = elA._listeners['ended'][0]; // capture the gen-1 ended handler
  await mixer.play('A', { ...DESC_A, trackId: 'A2', url: '/a2' }); // generation 2
  oldEnded(); // a delayed ended from the OLD source fires
  assert.equal(mixer.getDeck('A').ended, false, 'stale ended must be ignored');
  assert.equal(mixer.getDeck('A').playing, true, 'replacement playback unaffected');
});

test('natural ended on the current source is honored and emitted', async () => {
  const elA = new FakeMediaElement();
  const { mixer } = makeMixer({ elements: [elA] });
  const events = [];
  const unsub = mixer.on((e) => events.push(e));
  await mixer.play('A', DESC_A);
  elA._emit('ended');
  assert.equal(mixer.getDeck('A').ended, true);
  assert.equal(mixer.getDeck('A').playing, false);
  assert.ok(events.some((e) => e.type === 'ended' && e.deck === 'A'), 'ended event emitted');
  unsub();
});

test('on() returns an unsubscribe that stops delivery', async () => {
  const elA = new FakeMediaElement();
  const { mixer } = makeMixer({ elements: [elA] });
  const events = [];
  const unsub = mixer.on((e) => events.push(e));
  await mixer.play('A', DESC_A);
  unsub();
  elA._emit('ended');
  assert.equal(events.length, 0, 'no events after unsubscribe');
});

test('media failure returns a stable table-backed error code', async () => {
  const elA = new FakeMediaElement();
  elA._playImpl = () => Promise.reject(Object.assign(new Error('NotSupportedError'), { name: 'NotSupportedError' }));
  const { mixer } = makeMixer({ elements: [elA] });
  const result = await mixer.play('A', DESC_A);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'T_MEDIA_UNAVAILABLE');
  assert.equal(mixer.getDeck('A').error.code, 'T_MEDIA_UNAVAILABLE');
});

test('context resume failure is awaited and surfaced, not a false success', async () => {
  const { mixer, ctx } = makeMixer();
  ctx._resumeReject = new Error('resume blocked');
  const result = await mixer.play('A', DESC_A);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'T_CONTEXT_RESUME_FAILED');
  assert.equal(mixer.getDeck('A').playing, false);
});

test('snapshot carries ownership generation, paused, context state and clock', async () => {
  const { mixer, ctx } = makeMixer();
  await mixer.play('A', DESC_A);
  ctx.currentTime = 3.5;
  const deck = mixer.getDeck('A');
  assert.equal(typeof deck.generation, 'number');
  assert.ok(deck.generation >= 1);
  assert.equal(deck.paused, false);
  assert.equal(deck.contextState, 'running');
  assert.equal(deck.contextClock, 3.5);
  assert.equal(deck.trackId, 'A');
  assert.equal(deck.kind, 'track');
  assert.equal(deck.variant, 'full');
});

test('shutdown releases media sources and clears ownership', async () => {
  const elA = new FakeMediaElement();
  const { mixer } = makeMixer({ elements: [elA] });
  await mixer.play('A', DESC_A);
  await mixer.shutdown();
  assert.equal(mixer.getDeck('A').trackId, null, 'ownership cleared');
  assert.equal(mixer.getDeck('A').playing, false);
  assert.equal(elA.src, '', 'media source released');
  // Post-shutdown operations are consistent no-ops/failures.
  const result = await mixer.play('A', DESC_A);
  assert.equal(result.ok, false);
});

test('post-shutdown getDeck and snapshot remain serializable', async () => {
  const { mixer } = makeMixer();
  await mixer.play('A', DESC_A);
  await mixer.shutdown();
  const snap = mixer.snapshot();
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(snap)));
  assert.equal(snap.decks.A.trackId, null);
});

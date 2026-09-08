// tests/frontend/runtime/live-mixer.test.js — Phase 15A RED contract.
//
// The LiveMixer retires the "one active HTMLAudioElement" policy: two
// independently controllable deck transports (A and B) sharing one
// AudioContext, each with its own private media element routed through a
// MediaElementAudioSourceNode into an independent gain bus and a common
// master. No DOM/window imports; everything is injected for Node tests.
//
// Sol second-pass contract: generation/disposal checks across the awaited
// context-resume boundary (pause/replacement/shutdown/stale-rejection races);
// source replacement by element generation (a delayed old-source event is
// attributed to its original generation, not the current one); explicit
// failure on a closed AudioContext; and a canonical full-snapshot event
// contract ({ type, deck, state }) for play/pause/stop/seek/ended/error/
// timeupdate/durationchange/contextstatechange.

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
    this._listeners = {}; // type -> array of fns (real EventTarget dispatch model)
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
  // Dispatches to the listeners registered AT DISPATCH TIME (browser model).
  _emit(type) { for (const fn of [...(this._listeners[type] || [])]) fn(); }
}

class FakeAudioParam {
  constructor() { this.value = 1; }
}

class FakeGainNode {
  constructor() { this.gain = new FakeAudioParam(); this.connectedTo = null; this.disconnected = false; this._throwOnConnect = false; }
  connect(node) { if (this._throwOnConnect) throw new Error('gain connect failed'); this.connectedTo = node; return node; }
  disconnect() { this.disconnected = true; }
}

class FakeMediaElementSource {
  constructor(element) { this.element = element; this.connectedTo = null; this.disconnected = false; this._throwOnConnect = false; }
  connect(node) { if (this._throwOnConnect) throw new Error('source connect failed'); this.connectedTo = node; return node; }
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
    this._resumeImpl = null; // optional override: () => Promise
    this._throwOnCreateSource = false;
    this._throwOnGainConnect = false;
    this._listeners = {}; // type -> array of fns (real EventTarget dispatch)
  }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn); }
  _emitStateChange() { for (const fn of [...(this._listeners['statechange'] || [])]) fn(); }
  createMediaElementSource(element) {
    if (this._throwOnCreateSource) throw new Error('graph construction failed');
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
    if (this._throwOnGainConnect) gain._throwOnConnect = true;
    this._gains.push(gain);
    return gain;
  }
  resume() {
    if (this._resumeImpl) return this._resumeImpl();
    if (this._resumeReject) {
      const err = this._resumeReject;
      this._resumeReject = null;
      return Promise.reject(err);
    }
    this.state = 'running';
    this._emitStateChange();
    return Promise.resolve();
  }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close() { this._closed = true; this.state = 'closed'; this._emitStateChange(); return Promise.resolve(); }
}

function makeMixer({ elements = [], ctx: injectedCtx } = {}) {
  const ctx = injectedCtx || new FakeAudioContext();
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
  // Source replacement retires the old element and creates a fresh one, so
  // three distinct elements are wrapped — each exactly once (no double-wrap).
  assert.equal(ctx._wrapped.size, 3, 'three distinct elements, each wrapped once');
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
// Sol first-pass contract (deferred-promise probes)
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
  const playPromise = mixer.play('A', DESC_A);
  while (!playCalled) await new Promise((r) => setImmediate(r));
  mixer.pause('A');
  resolvePlay();
  await playPromise;
  assert.equal(mixer.getDeck('A').playing, false, 'stale play must not publish playing');
});

test('stale non-AbortError rejection cannot overwrite a newer successful source', async () => {
  const elA1 = new FakeMediaElement();
  let rejectFirst = null;
  let firstPlayCalled = false;
  elA1._playImpl = () => new Promise((_resolve, reject) => {
    firstPlayCalled = true;
    rejectFirst = reject;
  });
  const { mixer } = makeMixer({ elements: [elA1] });
  const first = mixer.play('A', { ...DESC_A, trackId: 'A1', url: '/a1' });
  // Wait until the first play reaches element.play() (past resume + graph).
  while (!firstPlayCalled) await new Promise((r) => setImmediate(r));
  const second = mixer.play('A', { ...DESC_A, trackId: 'A2', url: '/a2' });
  await second; // newer source succeeds on a fresh element
  rejectFirst(Object.assign(new Error('NotSupportedError'), { name: 'NotSupportedError' }));
  await first;
  assert.equal(mixer.getDeck('A').trackId, 'A2', 'newer source wins');
  assert.equal(mixer.getDeck('A').playing, true, 'newer source stays playing');
  assert.equal(mixer.getDeck('A').error, null, 'stale error must not surface');
});

test('delayed ended from a retired element is ignored (real dispatch)', async () => {
  const { mixer, elements } = makeMixer();
  await mixer.play('A', DESC_A); // creates elements[0]
  const oldEl = elements[0];
  await mixer.play('A', { ...DESC_A, trackId: 'A2', url: '/a2' }); // creates elements[1]
  oldEl._emit('ended'); // old element dispatches to its OWN (old-gen) handler
  assert.equal(mixer.getDeck('A').ended, false, 'stale ended must be ignored');
  assert.equal(mixer.getDeck('A').playing, true, 'replacement playback unaffected');
  assert.equal(mixer.getDeck('A').trackId, 'A2');
});

test('natural ended on the current source is honored and emitted', async () => {
  const { mixer, elements } = makeMixer();
  const events = [];
  const unsub = mixer.on((e) => events.push(e));
  await mixer.play('A', DESC_A);
  elements[0]._emit('ended');
  assert.equal(mixer.getDeck('A').ended, true);
  assert.equal(mixer.getDeck('A').playing, false);
  assert.ok(events.some((e) => e.type === 'ended' && e.deck === 'A'), 'ended event emitted');
  unsub();
});

test('on() returns an unsubscribe that stops delivery', async () => {
  const { mixer, elements } = makeMixer();
  const events = [];
  const unsub = mixer.on((e) => events.push(e));
  await mixer.play('A', DESC_A);
  unsub();
  const before = events.length;
  elements[0]._emit('ended');
  assert.equal(events.length, before, 'no events after unsubscribe');
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
  const { mixer, elements } = makeMixer();
  await mixer.play('A', DESC_A);
  await mixer.shutdown();
  assert.equal(mixer.getDeck('A').trackId, null, 'ownership cleared');
  assert.equal(mixer.getDeck('A').playing, false);
  assert.equal(elements[0].src, '', 'media source released');
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

// ---------------------------------------------------------------------------
// Sol second-pass contract (resume-boundary races, element replacement,
// closed context, canonical event contract)
// ---------------------------------------------------------------------------

test('pause during resume: stale play cannot start the element', async () => {
  const ctx = new FakeAudioContext();
  let resolveResume = null;
  ctx._resumeImpl = () => new Promise((resolve) => {
    resolveResume = () => { ctx.state = 'running'; resolve(); };
  });
  const elA = new FakeMediaElement();
  const { mixer } = makeMixer({ ctx, elements: [elA] });
  const playPromise = mixer.play('A', DESC_A); // suspends at await resume
  mixer.pause('A'); // advances generation
  resolveResume(); // resume completes
  await playPromise;
  assert.equal(mixer.getDeck('A').playing, false);
  assert.equal(elA.paused, true, 'element must not be played after pause');
});

test('replacement during resume: stale A1 cannot retake ownership', async () => {
  const ctx = new FakeAudioContext();
  let call = 0;
  let resolveFirst = null;
  ctx._resumeImpl = () => {
    call += 1;
    if (call === 1) {
      return new Promise((resolve) => { resolveFirst = () => { ctx.state = 'running'; resolve(); }; });
    }
    ctx.state = 'running';
    return Promise.resolve();
  };
  const { mixer } = makeMixer({ ctx });
  const first = mixer.play('A', { ...DESC_A, trackId: 'A1', url: '/a1' });
  const second = mixer.play('A', { ...DESC_A, trackId: 'A2', url: '/a2' });
  await second;
  resolveFirst();
  await first;
  assert.equal(mixer.getDeck('A').trackId, 'A2', 'A2 keeps ownership');
  assert.equal(mixer.getDeck('A').playing, true);
});

test('shutdown during resume: stale continuation cannot touch cleared ctx', async () => {
  const ctx = new FakeAudioContext();
  let resolveResume = null;
  ctx._resumeImpl = () => new Promise((resolve) => {
    resolveResume = () => { ctx.state = 'running'; resolve(); };
  });
  const { mixer } = makeMixer({ ctx });
  const playPromise = mixer.play('A', DESC_A); // suspends at await resume
  await mixer.shutdown(); // closes ctx, sets disposed
  resolveResume(); // resume completes after shutdown
  await playPromise; // must not throw
  assert.equal(mixer.getDeck('A').playing, false);
});

test('stale resume rejection cannot overwrite newer successful playback', async () => {
  const ctx = new FakeAudioContext();
  let call = 0;
  let rejectFirst = null;
  ctx._resumeImpl = () => {
    call += 1;
    if (call === 1) {
      return new Promise((_resolve, reject) => { rejectFirst = reject; });
    }
    ctx.state = 'running';
    return Promise.resolve();
  };
  const { mixer } = makeMixer({ ctx });
  const first = mixer.play('A', { ...DESC_A, trackId: 'A1', url: '/a1' });
  const second = mixer.play('A', { ...DESC_A, trackId: 'A2', url: '/a2' });
  await second;
  rejectFirst(new Error('resume blocked'));
  await first;
  assert.equal(mixer.getDeck('A').trackId, 'A2');
  assert.equal(mixer.getDeck('A').playing, true);
  assert.equal(mixer.getDeck('A').error, null);
});

test('closed AudioContext fails explicitly, never false success', async () => {
  const ctx = new FakeAudioContext();
  ctx.state = 'closed';
  const { mixer } = makeMixer({ ctx });
  const result = await mixer.play('A', DESC_A);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'T_CONTEXT_CLOSED');
  assert.equal(mixer.getDeck('A').playing, false);
});

test('canonical events carry { type, deck, state } for command completion', async () => {
  const { mixer } = makeMixer();
  const events = [];
  mixer.on((e) => events.push(e));
  await mixer.play('A', DESC_A);
  mixer.pause('A');
  mixer.seek('A', 5);
  mixer.stop('A');
  const types = events.map((e) => e.type);
  assert.ok(types.includes('play'), 'play emitted');
  assert.ok(types.includes('pause'), 'pause emitted');
  assert.ok(types.includes('seek'), 'seek emitted');
  assert.ok(types.includes('stop'), 'stop emitted');
  for (const e of events.filter((e) => e.deck === 'A')) {
    assert.equal(e.deck, 'A');
    assert.ok(e.state && typeof e.state === 'object', 'state present');
    assert.equal(typeof e.state.playing, 'boolean');
  }
});

test('natural media transitions emit canonical events', async () => {
  const { mixer, elements } = makeMixer();
  const events = [];
  mixer.on((e) => events.push(e));
  await mixer.play('A', DESC_A);
  elements[0]._emit('timeupdate');
  elements[0]._emit('durationchange');
  elements[0]._emit('ended');
  const types = events.map((e) => e.type);
  assert.ok(types.includes('timeupdate'), 'timeupdate emitted');
  assert.ok(types.includes('durationchange'), 'durationchange emitted');
  assert.ok(types.includes('ended'), 'ended emitted');
});

test('real context statechange updates both deck states', async () => {
  const { mixer, ctx } = makeMixer();
  const events = [];
  mixer.on((e) => events.push(e));
  await mixer.play('A', DESC_A);
  await mixer.play('B', DESC_B);
  // External suspend (e.g. OS interrupt) fires a real statechange.
  ctx.state = 'suspended';
  ctx._emitStateChange();
  const ctxEvents = events.filter((e) => e.type === 'contextstatechange');
  assert.ok(ctxEvents.length >= 1, 'statechange emitted');
  // Each deck's state reflects the suspended context.
  assert.equal(mixer.getDeck('A').playing, false);
  assert.equal(mixer.getDeck('B').playing, false);
  assert.equal(mixer.getDeck('A').contextState, 'suspended');
});

test('resume failure emits complete canonical state', async () => {
  const { mixer, ctx } = makeMixer();
  const events = [];
  mixer.on((e) => events.push(e));
  ctx._resumeReject = new Error('resume blocked');
  const result = await mixer.play('A', DESC_A);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'T_CONTEXT_RESUME_FAILED');
  const errEvents = events.filter((e) => e.type === 'error');
  assert.ok(errEvents.length >= 1, 'error emitted on resume failure');
  assert.equal(errEvents[0].state.error.code, 'T_CONTEXT_RESUME_FAILED');
});

test('media play rejection emits complete canonical state', async () => {
  const elA = new FakeMediaElement();
  elA._playImpl = () => Promise.reject(Object.assign(new Error('NotSupportedError'), { name: 'NotSupportedError' }));
  const { mixer } = makeMixer({ elements: [elA] });
  const events = [];
  mixer.on((e) => events.push(e));
  const result = await mixer.play('A', DESC_A);
  assert.equal(result.ok, false);
  const errEvents = events.filter((e) => e.type === 'error');
  assert.ok(errEvents.length >= 1, 'error emitted on media rejection');
  assert.equal(errEvents[0].state.error.code, 'T_MEDIA_UNAVAILABLE');
});

test('graph-construction failure is caught, table-backed, emitted, coherent', async () => {
  const ctx = new FakeAudioContext();
  ctx._throwOnCreateSource = true;
  const { mixer } = makeMixer({ ctx });
  const events = [];
  mixer.on((e) => events.push(e));
  const result = await mixer.play('A', DESC_A);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'T_MEDIA_UNAVAILABLE');
  assert.equal(mixer.getDeck('A').playing, false);
  assert.equal(mixer.getDeck('A').error.code, 'T_MEDIA_UNAVAILABLE');
  const errEvents = events.filter((e) => e.type === 'error');
  assert.ok(errEvents.length >= 1, 'error emitted on graph failure');
});

test('context closes while element.play() is pending: no false success', async () => {
  const ctx = new FakeAudioContext();
  const elA = new FakeMediaElement();
  let resolvePlay = null;
  let playCalled = false;
  elA._playImpl = () => new Promise((resolve) => {
    playCalled = true;
    resolvePlay = () => { elA.paused = false; resolve(); };
  });
  const { mixer } = makeMixer({ ctx, elements: [elA] });
  const events = [];
  mixer.on((e) => events.push(e));
  const playPromise = mixer.play('A', DESC_A);
  while (!playCalled) await new Promise((r) => setImmediate(r));
  // Context closes while media play is unresolved.
  ctx.state = 'closed';
  ctx._emitStateChange();
  resolvePlay();
  const result = await playPromise;
  assert.equal(result.ok, false, 'must not return ok:true');
  assert.equal(mixer.getDeck('A').playing, false);
  assert.equal(mixer.getDeck('A').contextState, 'closed');
  assert.ok(!events.some((e) => e.type === 'play'), 'no play emitted');
});

test('missing source has zero generation/context/audio side effects', async () => {
  const { mixer, ctx } = makeMixer();
  const before = mixer.getDeck('A').generation;
  const result = await mixer.play('A', { trackId: 'A', url: null });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'V_MISSING_SOURCE');
  assert.equal(mixer.getDeck('A').generation, before, 'generation unchanged');
  assert.equal(ctx._sources.length, 0, 'no element created');
  assert.equal(ctx.state, 'suspended', 'context not resumed');
});

test('invalid seek fails without emitting success', async () => {
  const { mixer } = makeMixer();
  const events = [];
  mixer.on((e) => events.push(e));
  await mixer.play('A', DESC_A);
  const result = mixer.seek('A', NaN);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'T_INVALID_TIME');
  assert.ok(!events.some((e) => e.type === 'seek'), 'no seek emitted');
});

test('pending replacement never reports playing', async () => {
  const elA2 = new FakeMediaElement();
  let resolvePlay = null;
  let playCalled = false;
  elA2._playImpl = () => new Promise((resolve) => {
    playCalled = true;
    resolvePlay = () => { elA2.paused = false; resolve(); };
  });
  // Inject the deferred element as the next one the factory returns.
  const { mixer: mixer2 } = makeMixer({ elements: [new FakeMediaElement(), elA2] });
  await mixer2.play('A', DESC_A);
  const replacement = mixer2.play('A', { ...DESC_A, trackId: 'A2', url: '/a2' });
  while (!playCalled) await new Promise((r) => setImmediate(r));
  // While the replacement play is pending, the deck must not report playing.
  assert.equal(mixer2.getDeck('A').playing, false, 'pending replacement not playing');
  resolvePlay();
  await replacement;
  assert.equal(mixer2.getDeck('A').playing, true);
  assert.equal(mixer2.getDeck('A').trackId, 'A2');
});

test('pause followed by late play resolution leaves the element paused', async () => {
  const elA = new FakeMediaElement();
  let resolvePlay = null;
  let playCalled = false;
  elA._playImpl = () => new Promise((resolve) => {
    playCalled = true;
    resolvePlay = () => { elA.paused = false; resolve(); };
  });
  const { mixer } = makeMixer({ elements: [elA] });
  const playPromise = mixer.play('A', DESC_A);
  while (!playCalled) await new Promise((r) => setImmediate(r));
  mixer.pause('A'); // pause lands after element.play() started
  resolvePlay(); // late play resolution
  await playPromise;
  assert.equal(elA.paused, true, 'physical element must be re-paused');
  assert.equal(mixer.getDeck('A').playing, false);
  assert.equal(mixer.getDeck('A').paused, true);
});

// ---------------------------------------------------------------------------
// Sol fourth-pass contract (replacement publication, transactional retire,
// partial-graph cleanup, terminal abort, table-backed messages, suspended≠closed)
// ---------------------------------------------------------------------------

test('subscriber sees pending replacement immediately', async () => {
  const elA2 = new FakeMediaElement();
  let resolvePlay = null;
  let playCalled = false;
  elA2._playImpl = () => new Promise((resolve) => {
    playCalled = true;
    resolvePlay = () => { elA2.paused = false; resolve(); };
  });
  const { mixer } = makeMixer({ elements: [new FakeMediaElement(), elA2] });
  const events = [];
  mixer.on((e) => events.push(e));
  await mixer.play('A', DESC_A);
  const replacement = mixer.play('A', { ...DESC_A, trackId: 'A2', url: '/a2' });
  while (!playCalled) await new Promise((r) => setImmediate(r));
  // Subscriber must already see the new pending source, not the old playing one.
  const loading = events.filter((e) => e.type === 'sourcechange' || e.type === 'loading');
  assert.ok(loading.length >= 1, 'sourcechange/loading emitted on replacement');
  const last = loading[loading.length - 1];
  assert.equal(last.state.trackId, 'A2', 'subscriber sees new track');
  assert.equal(last.state.playing, false, 'subscriber sees pending, not playing');
  resolvePlay();
  await replacement;
});

test('failed replacement cannot leave the old element active', async () => {
  const ctx = new FakeAudioContext();
  const elA = new FakeMediaElement();
  const { mixer } = makeMixer({ ctx, elements: [elA] });
  await mixer.play('A', DESC_A);
  assert.equal(elA.paused, false, 'old element playing');
  // Suspend the context, then force the next resume to fail.
  ctx.state = 'suspended';
  ctx._resumeReject = new Error('resume blocked');
  const result = await mixer.play('A', { ...DESC_A, trackId: 'A2', url: '/a2' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'T_CONTEXT_RESUME_FAILED');
  assert.equal(elA.paused, true, 'old element retired, cannot resume audibly');
  assert.equal(elA.src, '', 'old element source released');
  assert.equal(mixer.getDeck('A').playing, false);
});

test('current-generation AbortError publishes coherent terminal state', async () => {
  const elA = new FakeMediaElement();
  elA._playImpl = () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  const { mixer } = makeMixer({ elements: [elA] });
  const events = [];
  mixer.on((e) => events.push(e));
  const result = await mixer.play('A', DESC_A);
  assert.equal(result.ok, true);
  assert.equal(result.value.aborted, true);
  const terminal = events.filter((e) => e.type === 'abort' || e.type === 'pause');
  assert.ok(terminal.length >= 1, 'terminal abort/pause emitted');
  assert.equal(terminal[terminal.length - 1].state.playing, false);
});

test('context failure event message matches its returned failure', async () => {
  const { mixer, ctx } = makeMixer();
  const events = [];
  mixer.on((e) => events.push(e));
  ctx._resumeReject = new Error('resume blocked');
  const result = await mixer.play('A', DESC_A);
  assert.equal(result.code, 'T_CONTEXT_RESUME_FAILED');
  const errEvent = events.filter((e) => e.type === 'error').pop();
  assert.equal(errEvent.state.error.code, 'T_CONTEXT_RESUME_FAILED');
  assert.notEqual(errEvent.state.error.message, 'Audio is unavailable', 'message from frozen table');
});

test('suspended context after play is not labeled closed', async () => {
  const ctx = new FakeAudioContext();
  const elA = new FakeMediaElement();
  let resolvePlay = null;
  let playCalled = false;
  elA._playImpl = () => new Promise((resolve) => {
    playCalled = true;
    resolvePlay = () => { elA.paused = false; resolve(); };
  });
  const { mixer } = makeMixer({ ctx, elements: [elA] });
  const playPromise = mixer.play('A', DESC_A);
  while (!playCalled) await new Promise((r) => setImmediate(r));
  ctx.state = 'suspended';
  ctx._emitStateChange();
  resolvePlay();
  const result = await playPromise;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'T_CONTEXT_SUSPENDED', 'suspended is not closed');
});

test('partial graph failure disconnects every created node', async () => {
  const ctx = new FakeAudioContext();
  ctx._throwOnGainConnect = true;
  const { mixer } = makeMixer({ ctx });
  const result = await mixer.play('A', DESC_A);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'T_MEDIA_UNAVAILABLE');
  // Both the source and the gain created before the throw must be disconnected.
  for (const source of ctx._sources) assert.equal(source.disconnected, true, 'source disconnected');
  for (const gain of ctx._gains) assert.equal(gain.disconnected, true, 'gain disconnected');
});

test('shutdown publishes one close transition', async () => {
  const { mixer } = makeMixer();
  const events = [];
  mixer.on((e) => events.push(e));
  await mixer.play('A', DESC_A);
  await mixer.shutdown();
  const closeEvents = events.filter((e) => e.type === 'contextstatechange' && e.state.contextState === 'closed');
  assert.equal(closeEvents.length, 1, 'exactly one close transition');
});

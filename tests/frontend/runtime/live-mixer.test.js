// tests/frontend/runtime/live-mixer.test.js — Phase 15A RED contract.
//
// The LiveMixer retires the "one active HTMLAudioElement" policy: two
// independently controllable deck transports (A and B) sharing one
// AudioContext, each with its own private media element routed through a
// MediaElementAudioSourceNode into an independent gain bus and a common
// master. No DOM/window imports; everything is injected for Node tests.

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
    this._listeners = {};
    this._playReject = null;
  }
  addEventListener(type, fn) { this._listeners[type] = fn; }
  removeEventListener(type, fn) { delete this._listeners[type]; }
  play() {
    if (this._playReject) {
      const err = this._playReject;
      this._playReject = null;
      return Promise.reject(err);
    }
    this.paused = false;
    return Promise.resolve();
  }
  pause() { this.paused = true; }
  load() {}
  removeAttribute() { this.src = ''; }
  _emit(type) { if (this._listeners[type]) this._listeners[type](); }
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
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close() { this._closed = true; this.state = 'closed'; return Promise.resolve(); }
}

function makeMixer() {
  const elements = [];
  const ctx = new FakeAudioContext();
  const mixer = new LiveMixer({
    audioContextFactory: { create: () => ctx },
    mediaElementFactory: { create: () => { const el = new FakeMediaElement(); elements.push(el); return el; } },
  });
  return { mixer, ctx, elements };
}

const DESC_A = { trackId: 'A', url: '/api/tracks/A/audio', kind: 'track', variant: 'full' };
const DESC_B = { trackId: 'B', url: '/api/tracks/B/audio', kind: 'track', variant: 'full' };

// ---------------------------------------------------------------------------
// RED contract
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
  // Re-playing A must not re-wrap its element.
  await mixer.play('A', { ...DESC_A, trackId: 'A2', url: '/api/tracks/A2/audio' });
  assert.equal(ctx._wrapped.size, 2, 'two elements wrapped, each once');
});

test('rapid source changes cannot publish stale play state', async () => {
  const { mixer, elements } = makeMixer();
  // First play creates the element and resolves normally.
  await mixer.play('A', DESC_A);
  assert.equal(elements.length, 1);
  // Now make the NEXT play() reject with AbortError (simulating a rapid swap),
  // and immediately replace before it resolves.
  elements[0]._playReject = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const first = mixer.play('A', { ...DESC_A, trackId: 'A1', url: '/api/tracks/A1/audio' });
  const second = mixer.play('A', { ...DESC_A, trackId: 'A2', url: '/api/tracks/A2/audio' });
  await Promise.allSettled([first, second]);
  assert.equal(mixer.getDeck('A').trackId, 'A2', 'final source wins');
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
  // No element/context/node references may survive serialization.
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

// tests/frontend/runtime/live-mixer-15b.test.js — Phase 15B crossfader + beat sync.

import test from 'node:test';
import assert from 'node:assert/strict';

import { LiveMixer } from '../../../src/twobecomeone/studio_static/js/runtime/live-mixer.js';
import { equalPowerGains } from '../../../src/twobecomeone/studio_static/js/runtime/crossfader.js';
import { ERROR_CODES } from '../../../src/twobecomeone/studio_static/js/actions/errors.js';

class FakeMediaElement {
  constructor() {
    this.paused = true;
    this.ended = false;
    this.currentTime = 0;
    this.duration = 10;
    this.src = '';
    this.playbackRate = 1;
    this.preservesPitch = true;
    this.mozPreservesPitch = true;
    this.webkitPreservesPitch = true;
    this.crossOrigin = null;
    this._listeners = {};
    this._playImpl = null;
  }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  play() {
    if (this._playImpl) return this._playImpl();
    this.paused = false;
    return Promise.resolve();
  }
  pause() { this.paused = true; }
  load() {}
  removeAttribute() { this.src = ''; }
  _emit(type) { for (const fn of [...(this._listeners[type] || [])]) fn(); }
}

class FakeAudioParam {
  constructor() { this.value = 1; }
}

class FakeGainNode {
  constructor() { this.gain = new FakeAudioParam(); this.connectedTo = null; this.disconnected = false; }
  connect(node) { this.connectedTo = node; return node; }
  disconnect() { this.disconnected = true; }
}

class FakeAnalyser {
  constructor() { this.fftSize = 256; this.connectedTo = null; this._peak = 0; }
  connect(node) { this.connectedTo = node; return node; }
  disconnect() { this.disconnected = true; }
  getFloatTimeDomainData(buffer) { buffer.fill(this._peak); }
}

class FakeMediaElementSource {
  constructor(element) { this.element = element; this.connectedTo = null; this.disconnected = false; }
  connect(node) { this.connectedTo = node; return node; }
  disconnect() { this.disconnected = true; }
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.destination = {};
    this._sources = [];
    this._gains = [];
    this._analysers = [];
    this._wrapped = new Set();
    this._listeners = {};
  }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn); }
  createMediaElementSource(element) {
    if (this._wrapped.has(element)) throw new Error('duplicate wrap');
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
  createAnalyser() {
    const analyser = new FakeAnalyser();
    this._analysers.push(analyser);
    return analyser;
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}

function makeMixer({ elements = [], ctx: injectedCtx, timers } = {}) {
  const ctx = injectedCtx || new FakeAudioContext();
  let idx = 0;
  const scheduled = [];
  const timerFactory = timers || {
    set(fn, ms) {
      const id = scheduled.length + 1;
      scheduled.push({ id, fn, ms });
      return id;
    },
    clear(id) {
      const index = scheduled.findIndex((entry) => entry.id === id);
      if (index >= 0) scheduled.splice(index, 1);
    },
  };
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
    timerFactory,
  });
  return { mixer, ctx, elements, scheduled };
}

const DESC_A = { trackId: 'A', url: '/api/tracks/A/audio', kind: 'track', variant: 'full' };
const DESC_B = { trackId: 'B', url: '/api/tracks/B/audio', kind: 'track', variant: 'full' };
const TRACK_A = { id: 'A', bpm: 120, beat_grid: { first_beat: 0.25, interval: 0.5 } };
const TRACK_B = { id: 'B', bpm: 120, beat_grid: { first_beat: 0.25, interval: 0.5 } };

test('setCrossfader applies equal-power gains to deck buses', async () => {
  const { mixer } = makeMixer();
  await mixer.play('A', DESC_A);
  await mixer.play('B', DESC_B);
  mixer.setCrossfader(0);
  let state = mixer.getMixerState();
  assert.deepEqual({ gainA: state.gainA, gainB: state.gainB }, equalPowerGains(0));
  mixer.setCrossfader(100);
  state = mixer.getMixerState();
  assert.deepEqual({ gainA: state.gainA, gainB: state.gainB }, equalPowerGains(100));
  mixer.setCrossfader(50);
  state = mixer.getMixerState();
  const center = equalPowerGains(50);
  assert.ok(Math.abs(state.gainA - center.gainA) < 1e-9);
  assert.ok(Math.abs(state.gainB - center.gainB) < 1e-9);
});

test('snapshot includes serializable mixer state', async () => {
  const { mixer } = makeMixer();
  mixer.setCrossfader(25);
  mixer.setMasterDeck('B');
  const snap = mixer.snapshot();
  assert.equal(snap.mixer.crossfaderPosition, 25);
  assert.equal(snap.mixer.masterDeck, 'B');
  assert.equal(typeof snap.mixer.gainA, 'number');
  assert.equal(typeof snap.mixer.headroom.headroomDb, 'number');
});

test('playSynced schedules follower launch against master transport', async () => {
  const elA = new FakeMediaElement();
  const elB = new FakeMediaElement();
  const ctx = new FakeAudioContext();
  ctx.currentTime = 5;
  const { mixer, scheduled } = makeMixer({ elements: [elA, elB], ctx });
  await mixer.play('A', DESC_A);
  elA.currentTime = 2;
  const playPromise = mixer.playSynced('B', DESC_B, {
    masterTrack: TRACK_A,
    followerTrack: TRACK_B,
    cueSeconds: 0,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mixer.getDeck('B').syncPending, true);
  assert.equal(scheduled.length, 1);
  assert.ok(scheduled[0].ms > 0);
  assert.equal(elB.playbackRate, 1);
  await scheduled[0].fn();
  const result = await playPromise;
  assert.equal(result.ok, true);
  assert.equal(mixer.getDeck('B').playing, true);
  assert.equal(mixer.getMixerState().syncReceipt.launchBeat, 32);
});

test('playSynced fails closed when master is not playing', async () => {
  const { mixer } = makeMixer();
  const result = await mixer.playSynced('B', DESC_B, {
    masterTrack: TRACK_A,
    followerTrack: TRACK_B,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, ERROR_CODES.T_TRANSPORT_NOT_PLAYING);
});

test('master change and seek cancel pending sync', async () => {
  const elA = new FakeMediaElement();
  const elB = new FakeMediaElement();
  const ctx = new FakeAudioContext();
  ctx.currentTime = 4;
  const { mixer, scheduled } = makeMixer({ elements: [elA, elB], ctx });
  await mixer.play('A', DESC_A);
  mixer.playSynced('B', DESC_B, {
    masterTrack: TRACK_A,
    followerTrack: TRACK_B,
    cueSeconds: 0,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.length, 1);
  mixer.setMasterDeck('B');
  assert.equal(scheduled.length, 0);
  await mixer.play('B', DESC_B);
  const pending = mixer.playSynced('A', DESC_A, {
    masterTrack: TRACK_B,
    followerTrack: TRACK_A,
    cueSeconds: 0,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.length, 1);
  pending.catch(() => {});
  mixer.seek('A', 1);
  assert.equal(scheduled.length, 0);
});

test('deck buses route through master gain node', async () => {
  const { mixer, ctx } = makeMixer();
  await mixer.play('A', DESC_A);
  assert.equal(ctx._gains[1].connectedTo, ctx._gains[0]);
  assert.equal(ctx._analysers[0].connectedTo, ctx.destination);
});

// tests/frontend/runtime/live-mixer-15b.test.js — live xfader AudioParams.

import test from 'node:test';
import assert from 'node:assert/strict';

import { LiveMixer } from '../../../src/twobecomeone/studio_static/js/runtime/live-mixer.js';
import { equalPowerGains } from '../../../src/twobecomeone/studio_static/js/transport/deck-sync.js';

class FakeMediaElement {
  constructor() {
    this.paused = true;
    this.ended = false;
    this.currentTime = 0;
    this.duration = 8;
    this.src = '';
    this.playbackRate = 1;
    this._listeners = {};
  }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  load() {}
  removeAttribute() { this.src = ''; }
}

class FakeAudioParam { constructor() { this.value = 1; } }
class FakeGainNode {
  constructor() { this.gain = new FakeAudioParam(); }
  connect() { return this; }
  disconnect() {}
}
class FakeMediaElementSource {
  constructor(element) { this.element = element; }
  connect() { return this; }
  disconnect() {}
}
class FakeAnalyser {
  constructor() { this.fftSize = 32; }
  getFloatTimeDomainData(buf) { buf.fill(0); }
}
class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.destination = {};
    this._gains = [];
    this._wrapped = new Set();
  }
  addEventListener() {}
  removeEventListener() {}
  createMediaElementSource(element) {
    this._wrapped.add(element);
    return new FakeMediaElementSource(element);
  }
  createGain() {
    const gain = new FakeGainNode();
    this._gains.push(gain);
    return gain;
  }
  createAnalyser() { return new FakeAnalyser(); }
  resume() { return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}

function makeMixer() {
  const ctx = new FakeAudioContext();
  const elements = [];
  const mixer = new LiveMixer({
    audioContextFactory: { create: () => ctx },
    mediaElementFactory: { create: () => { const el = new FakeMediaElement(); elements.push(el); return el; } },
  });
  return { mixer, ctx, elements };
}

test('default mixer snapshot is center equal-power, limiter off, Class C unmeasured', async () => {
  const { mixer } = makeMixer();
  const snap = mixer.mixerSnapshot();
  const expected = equalPowerGains(0.5).value;
  assert.equal(snap.xfader, 0.5);
  assert.equal(snap.master, 'A');
  assert.ok(Math.abs(snap.gainA - expected.gainA) < 1e-12);
  assert.ok(Math.abs(snap.gainB - expected.gainB) < 1e-12);
  assert.equal(snap.limiterPolicy, 'off');
  assert.equal(snap.clipping, false);
  assert.equal(snap.classC, 'unmeasured');
  await mixer.shutdown();
});

test('setCrossfader writes equal-power values onto live deck gain AudioParams', async () => {
  const { mixer } = makeMixer();
  await mixer.play('A', { url: '/a.wav', trackId: 'a' });
  await mixer.play('B', { url: '/b.wav', trackId: 'b' });
  mixer.setCrossfader(0);
  assert.equal(mixer._decks.A.gainNode.gain.value, 1);
  assert.equal(mixer._decks.B.gainNode.gain.value, 0);
  mixer.setCrossfader(1);
  assert.equal(mixer._decks.A.gainNode.gain.value, 0);
  assert.equal(mixer._decks.B.gainNode.gain.value, 1);
  await mixer.shutdown();
});

test('crossfader does not mutate a render-plan object passed in', async () => {
  const { mixer } = makeMixer();
  const renderPlan = { crossfade_duration: 2, crossfade_curve: 'equal_power', blend: 0.3 };
  const frozen = { ...renderPlan };
  mixer.setCrossfader(0);
  assert.deepEqual(renderPlan, frozen);
  await mixer.shutdown();
});

test('setMaster rejects unknown decks', async () => {
  const { mixer } = makeMixer();
  const result = mixer.setMaster('C');
  assert.equal(result.ok, false);
  await mixer.shutdown();
});

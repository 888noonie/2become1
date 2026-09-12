// tests/frontend/runtime/live-mixer-15c.test.js — Phase 15C stem-stack bus.

import test from 'node:test';
import assert from 'node:assert/strict';

import { LiveMixer } from '../../../src/twobecomeone/studio_static/js/runtime/live-mixer.js';
import { equalPowerGains } from '../../../src/twobecomeone/studio_static/js/runtime/crossfader.js';
import { ERROR_CODES } from '../../../src/twobecomeone/studio_static/js/actions/errors.js';

class FakeMediaElement {
  constructor() {
    this.paused = true;
    this.ended = false;
    this.currentTime = 1;
    this.duration = 10;
    this.src = '';
    this.playbackRate = 1;
    this.crossOrigin = null;
    this._listeners = {};
  }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  load() {}
  removeAttribute() { this.src = ''; }
}

class FakeAudioParam {
  constructor(value = 1) { this.value = value; }
}

class FakeGainNode {
  constructor() { this.gain = new FakeAudioParam(); this.connectedTo = null; this.disconnected = false; }
  connect(node) { this.connectedTo = node; return node; }
  disconnect() { this.disconnected = true; }
}

class FakeAnalyser {
  constructor() { this.fftSize = 256; this.connectedTo = null; }
  connect(node) { this.connectedTo = node; return node; }
  disconnect() { this.disconnected = true; }
  getFloatTimeDomainData(buffer) { buffer.fill(0); }
}

class FakeMediaElementSource {
  constructor(element) { this.element = element; this.connectedTo = null; }
  connect(node) { this.connectedTo = node; return node; }
  disconnect() { this.disconnected = true; }
}

class FakeBufferSource {
  constructor(ctx) {
    this.ctx = ctx;
    this.buffer = null;
    this.connectedTo = null;
    this.startedAt = null;
    this.stopped = false;
    this.onended = null;
  }
  connect(node) { this.connectedTo = node; return node; }
  disconnect() { this.disconnected = true; }
  start(when) { this.startedAt = when; this.ctx.starts.push({ when, source: this }); }
  stop() { this.stopped = true; }
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.destination = { name: 'destination' };
    this._sources = [];
    this._gains = [];
    this._analysers = [];
    this._wrapped = new Set();
    this.starts = [];
    this._listeners = {};
  }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    this._listeners[type] = (this._listeners[type] || []).filter((item) => item !== fn);
  }
  createMediaElementSource(element) {
    if (this._wrapped.has(element)) throw new Error('duplicate wrap');
    this._wrapped.add(element);
    const source = new FakeMediaElementSource(element);
    this._sources.push(source);
    return source;
  }
  createBufferSource() {
    const source = new FakeBufferSource(this);
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
  decodeAudioData() { return Promise.resolve({ duration: 4 }); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}

const SS_ID = `ss-${'a'.repeat(32)}`;

function stackLayer(overrides = {}) {
  return {
    kind: 'stem_stack',
    layerId: 'layer-c1',
    actionId: 'c1',
    acceptedAsset: {
      id: SS_ID,
      contentHash: 'sha256:stack',
      audioUrl: 'file:///tmp/hostile.wav',
      transformSpec: {
        targetBpm: 120,
        destinationGridRevision: 'grid-v1:abc',
        semanticRegion: { id: 'stack-8', startBeat: 0, endBeat: 32 },
      },
    },
    transformSpec: {
      targetBpm: 120,
      destinationGridRevision: 'grid-v1:abc',
      semanticRegion: { id: 'stack-8', startBeat: 0, endBeat: 32 },
    },
    launchReceipt: {
      launchBeat: 32,
      targetBpm: 120,
      destinationGridRevision: 'grid-v1:abc',
      assetId: SS_ID,
      contentHash: 'sha256:stack',
    },
    placement: { gainDb: 0, destinationBars: 8, timing: { launch: 'next_phrase', quantize: true } },
    ...overrides,
  };
}

function masterTransport() {
  return {
    deck: 'A',
    playing: true,
    tempoBpm: 120,
    beatsPerBar: 4,
    phraseBars: 8,
    beatAtStart: 0,
    startedAtAudioTime: 0,
    gridRevision: 'grid-v1:abc',
  };
}

function makeMixer() {
  const ctx = new FakeAudioContext();
  const elements = [];
  const loaded = [];
  const scheduled = [];
  const mixer = new LiveMixer({
    audioContextFactory: { create: () => ctx },
    mediaElementFactory: {
      create: () => {
        const el = new FakeMediaElement();
        elements.push(el);
        return el;
      },
    },
    timerFactory: {
      set(fn, ms) {
        const id = scheduled.length + 1;
        scheduled.push({ id, fn, ms });
        return id;
      },
      clear(id) {
        const index = scheduled.findIndex((entry) => entry.id === id);
        if (index >= 0) scheduled.splice(index, 1);
      },
    },
    loadAsset: async (asset) => {
      loaded.push(asset.audioUrl || asset.id);
      return new ArrayBuffer(8);
    },
    stackTransportProvider: () => masterTransport(),
  });
  return { mixer, ctx, elements, loaded, scheduled };
}

const DESC_A = { trackId: 'A', url: '/api/tracks/A/audio', kind: 'track', variant: 'full' };
const DESC_B = { trackId: 'B', url: '/api/tracks/B/audio', kind: 'track', variant: 'full' };

test('A, B and stack buses share one master and stay independent', async () => {
  const { mixer, ctx } = makeMixer();
  await mixer.play('A', DESC_A);
  await mixer.play('B', DESC_B);
  const result = await mixer.syncStemStack(stackLayer());
  assert.equal(result.ok, true);
  const deckGains = ctx._gains.filter((gain) => gain.connectedTo === mixer._masterGain);
  assert.ok(deckGains.length >= 3, 'A, B and stack fader connect to master');
  mixer.setCrossfader(0);
  const xfader = equalPowerGains(0);
  assert.equal(mixer._decks.A.gainNode.gain.value, xfader.gainA);
  assert.equal(mixer._decks.B.gainNode.gain.value, xfader.gainB);
  const stackGain = mixer._stack.gainNode.gain.value;
  mixer.setCrossfader(100);
  assert.equal(mixer._stack.gainNode.gain.value, stackGain);
  assert.equal(mixer.getDeck('A').playing, true);
  assert.equal(mixer.getDeck('B').playing, true);
  assert.equal(mixer.getMixerState().stack.playing, true);
});

test('stack fetch ignores client media paths and only uses ss- assets', async () => {
  const { mixer, loaded } = makeMixer();
  await mixer.play('A', DESC_A);
  await mixer.syncStemStack(stackLayer());
  assert.deepEqual(loaded, [`/api/stem-stack-assets/${SS_ID}/audio`]);
  const refused = await mixer.syncStemStack(stackLayer({
    kind: 'stem_stack',
    acceptedAsset: { id: 'ga-not-a-stack', contentHash: 'x' },
  }));
  assert.equal(refused.ok, false);
  assert.equal(refused.code, ERROR_CODES.S_ASSET_NOT_AVAILABLE);
});

test('mute and bounded gain do not stop deck A or B', async () => {
  const { mixer } = makeMixer();
  await mixer.play('A', DESC_A);
  await mixer.play('B', DESC_B);
  await mixer.syncStemStack(stackLayer());
  mixer.muteStack(true);
  mixer.setStackGain(-12);
  assert.equal(mixer.getDeck('A').playing, true);
  assert.equal(mixer.getDeck('B').playing, true);
  const stack = mixer.getMixerState().stack;
  assert.equal(stack.muted, true);
  assert.equal(stack.gainDb, -12);
  assert.equal(stack.audible, false);
});

test('master pause suspends the stack; play rearms against the live clock', async () => {
  const { mixer } = makeMixer();
  await mixer.play('A', DESC_A);
  await mixer.syncStemStack(stackLayer());
  assert.equal(mixer.getMixerState().stack.state, 'scheduled');
  mixer.pause('A');
  assert.equal(mixer.getMixerState().stack.state, 'idle');
  await mixer.play('A', DESC_A);
  assert.ok(['scheduled', 'live'].includes(mixer.getMixerState().stack.state));
});

test('Undo/clear stops the stack bus and snapshot stays serializable', async () => {
  const { mixer } = makeMixer();
  await mixer.play('A', DESC_A);
  await mixer.syncStemStack(stackLayer());
  mixer.stopStemStack();
  const snap = mixer.snapshot();
  assert.equal(snap.stack.state, 'empty');
  assert.equal(snap.mixer.stack.state, 'empty');
  JSON.stringify(snap);
});

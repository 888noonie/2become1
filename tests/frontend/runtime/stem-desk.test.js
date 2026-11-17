import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STEM_DESK_LIMITS,
  StemDesk,
  StemDeskError,
} from '../../../src/twobecomeone/studio_static/js/runtime/stem-desk.js';

/** Minimal Web Audio stand-in: gain nodes, buffer sources, no hardware. */
class FakeGain {
  constructor() {
    this.gain = { value: 1 };
    this.connected = [];
    this.disconnected = false;
  }

  connect(node) {
    this.connected.push(node);
  }

  disconnect() {
    this.connected = [];
    this.disconnected = true;
  }
}

class FakeSource {
  constructor() {
    this.buffer = null;
    this.loop = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.started = null;
    this.stopped = false;
    this.disconnected = false;
  }

  connect(node) {
    this.node = node;
  }

  start(when, offset) {
    this.started = { when, offset };
  }

  stop() {
    this.stopped = true;
  }

  disconnect() {
    this.disconnected = true;
  }
}

class FakeContext {
  constructor({ duration = 30, channels = 2 } = {}) {
    this.currentTime = 10;
    this.state = 'running';
    this.resumeCalls = 0;
    this.destination = { name: 'destination' };
    this.created = [];
    this.closed = false;
    this.duration = duration;
    this.channels = channels;
    this.decodeCalls = 0;
  }

  createGain() {
    const node = new FakeGain();
    this.created.push(node);
    return node;
  }

  createBufferSource() {
    return new FakeSource();
  }

  async decodeAudioData() {
    this.decodeCalls += 1;
    return {
      duration: this.duration,
      length: Math.round(this.duration * 4000),
      numberOfChannels: this.channels,
    };
  }

  async resume() {
    this.resumeCalls += 1;
    this.state = 'running';
  }

  async close() {
    this.closed = true;
  }
}

function lane(name, overrides = {}) {
  return {
    name,
    label: name,
    audioUrl: `/api/stems/set-1/audio?name=${name}`,
    method: 'demucs',
    modelName: 'htdemucs@4.1.0',
    device: 'cpu',
    ...overrides,
  };
}

function fakeFetch(bytes = 64) {
  return async (url) => ({
    ok: true,
    status: 200,
    url,
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  });
}

test('four stems load into one desk and start on one shared clock instant', async () => {
  const ctx = new FakeContext();
  const desk = new StemDesk({ audioContext: ctx, fetchImpl: fakeFetch() });
  const loaded = await desk.load([lane('vocals'), lane('drums'), lane('bass'), lane('other')]);

  assert.equal(loaded.status, 'ready');
  assert.equal(loaded.lanes.length, 4);
  assert.deepEqual(loaded.lanes.map((entry) => entry.name), ['vocals', 'drums', 'bass', 'other']);

  const playing = desk.play({ loop: true });
  assert.equal(playing.status, 'playing');
  const whens = new Set();
  for (const laneState of playing.lanes) {
    const source = desk._lanes.find((entry) => entry.name === laneState.name).source;
    whens.add(source.started.when);
    assert.equal(source.loop, true);
    assert.equal(source.started.offset, 0);
  }
  assert.equal(whens.size, 1, 'every stem must start at the same context time');
  const onlyWhen = [...whens][0];
  assert.equal(onlyWhen, 10 + STEM_DESK_LIMITS.startLeadSeconds);

  ctx.currentTime = onlyWhen + 4;
  assert.equal(desk.position(), 4);
});

test('gain is per stem and never touches the others', async () => {
  const desk = new StemDesk({ audioContext: new FakeContext(), fetchImpl: fakeFetch() });
  await desk.load([lane('vocals'), lane('drums'), lane('bass'), lane('other')]);
  desk.play();

  const before = desk.state();
  const drumsBefore = before.lanes.find((entry) => entry.name === 'drums');
  desk.setGain('bass', -12);
  const after = desk.state();

  const bass = after.lanes.find((entry) => entry.name === 'bass');
  const drums = after.lanes.find((entry) => entry.name === 'drums');
  assert.equal(bass.gainDb, -12);
  assert.ok(Math.abs(bass.effectiveGain - 0.2512) < 0.002);
  assert.equal(drums.gainDb, 0);
  assert.equal(drums.effectiveGain, drumsBefore.effectiveGain);
  assert.equal(desk._lanes.find((entry) => entry.name === 'drums').node.gain.value, 1);
});

test('muting one stem leaves the rest audible', async () => {
  const desk = new StemDesk({ audioContext: new FakeContext(), fetchImpl: fakeFetch() });
  await desk.load([lane('vocals'), lane('drums'), lane('bass'), lane('other')]);
  desk.setMuted('drums', true);

  const state = desk.state();
  assert.equal(state.lanes.find((entry) => entry.name === 'drums').audible, false);
  assert.equal(state.lanes.find((entry) => entry.name === 'drums').effectiveGain, 0);
  for (const name of ['vocals', 'bass', 'other']) {
    assert.equal(state.lanes.find((entry) => entry.name === name).audible, true, name);
  }
});

test('solo suppresses the other stems and restores the prior mute when released', async () => {
  const desk = new StemDesk({ audioContext: new FakeContext(), fetchImpl: fakeFetch() });
  await desk.load([lane('vocals'), lane('drums'), lane('bass'), lane('other')]);
  desk.setMuted('vocals', true);

  desk.setSolo('bass', true);
  const soloed = desk.state();
  assert.equal(soloed.lanes.find((entry) => entry.name === 'bass').audible, true);
  for (const name of ['vocals', 'drums', 'other']) {
    assert.equal(soloed.lanes.find((entry) => entry.name === name).audible, false, name);
    assert.equal(soloed.lanes.find((entry) => entry.name === name).effectiveGain, 0, name);
  }

  desk.setSolo('bass', false);
  const restored = desk.state();
  assert.equal(restored.lanes.find((entry) => entry.name === 'vocals').audible, false, 'mute survives solo');
  assert.equal(restored.lanes.find((entry) => entry.name === 'drums').audible, true);
  assert.equal(restored.lanes.find((entry) => entry.name === 'other').audible, true);
});

test('two stems can be heard at independently chosen levels at the same time', async () => {
  const desk = new StemDesk({ audioContext: new FakeContext(), fetchImpl: fakeFetch() });
  await desk.load([lane('vocals'), lane('drums'), lane('bass'), lane('other')]);
  desk.setGain('vocals', -6);
  desk.setGain('drums', -18);
  desk.play();

  const state = desk.state();
  const vocals = state.lanes.find((entry) => entry.name === 'vocals');
  const drums = state.lanes.find((entry) => entry.name === 'drums');
  assert.equal(vocals.audible, true);
  assert.equal(drums.audible, true);
  assert.ok(vocals.effectiveGain > drums.effectiveGain);
  assert.equal(state.status, 'playing');
});

test('stop releases every source and returns the desk to ready', async () => {
  const ctx = new FakeContext();
  const desk = new StemDesk({ audioContext: ctx, fetchImpl: fakeFetch() });
  await desk.load([lane('vocals'), lane('drums'), lane('bass'), lane('other')]);
  desk.play();
  const sources = desk._sources.slice();
  const state = desk.stop();

  assert.equal(state.status, 'ready');
  assert.equal(state.positionSeconds, 0);
  assert.equal(desk._sources.length, 0);
  for (const source of sources) {
    assert.equal(source.stopped, true);
    assert.equal(source.disconnected, true);
  }
});

test('a failed stem load is a truthful unavailable/partial state, not silence', async () => {
  const ctx = new FakeContext();
  const failing = async (url) => (url.includes('bass')
    ? { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
    : { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(8).buffer });
  const desk = new StemDesk({ audioContext: ctx, fetchImpl: failing });
  const state = await desk.load([lane('vocals'), lane('drums'), lane('bass'), lane('other')]);

  assert.equal(state.status, 'ready');
  assert.equal(state.lanes.length, 3);
  assert.equal(state.error.code, 'S_STEM_PARTIAL');
  assert.equal(state.error.failures[0].name, 'bass');
});

test('a desk with no usable stem reports unavailable with the first reason', async () => {
  const desk = new StemDesk({
    audioContext: new FakeContext(),
    fetchImpl: async () => { throw new Error('offline'); },
  });
  const state = await desk.load([lane('vocals'), lane('drums')]);
  assert.equal(state.status, 'unavailable');
  assert.equal(state.lanes.length, 0);
  assert.equal(state.error.code, 'S_STEM_UNAVAILABLE');
});

test('oversized, over-long and undecodable media are refused with codes', async () => {
  const tooBig = new StemDesk({
    audioContext: new FakeContext(),
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(STEM_DESK_LIMITS.maxStemBytes + 1) }),
  });
  let state = await tooBig.load([lane('vocals')]);
  assert.equal(state.error.code, 'S_STEM_TOO_LARGE');

  const longCtx = new FakeContext({ duration: 3600 });
  const tooLong = new StemDesk({ audioContext: longCtx, fetchImpl: fakeFetch() });
  state = await tooLong.load([lane('vocals')]);
  assert.equal(state.error.code, 'S_STEM_TOO_LONG');

  const badCtx = new FakeContext();
  badCtx.decodeAudioData = async () => { throw new Error('bad wav'); };
  const undecodable = new StemDesk({ audioContext: badCtx, fetchImpl: fakeFetch() });
  state = await undecodable.load([lane('vocals')]);
  assert.equal(state.error.code, 'S_STEM_DECODE');
});

test('the desk refuses duplicates, more than four lanes and unknown names', async () => {
  const desk = new StemDesk({ audioContext: new FakeContext(), fetchImpl: fakeFetch() });
  await assert.rejects(() => desk.load([lane('vocals'), lane('vocals')]), (err) => err.code === 'S_DUPLICATE_STEM');
  await assert.rejects(
    () => desk.load([lane('a'), lane('b'), lane('c'), lane('d'), lane('e')]),
    (err) => err.code === 'S_TOO_MANY_STEMS',
  );
  await desk.load([lane('vocals')]);
  assert.throws(() => desk.setGain('nope', 0), (err) => err instanceof StemDeskError && err.code === 'S_UNKNOWN_STEM');
});

test('unload frees decoded audio and dispose never closes a shared context', async () => {
  const shared = new FakeContext();
  const desk = new StemDesk({ audioContext: shared, fetchImpl: fakeFetch() });
  await desk.load([lane('vocals'), lane('drums')]);
  assert.ok(desk._decodedBytes > 0);

  desk.unload();
  assert.equal(desk._decodedBytes, 0);
  assert.equal(desk.state().lanes.length, 0);
  assert.equal(desk.state().status, 'idle');

  desk.dispose();
  assert.equal(shared.closed, false, 'a shared AudioContext must survive the desk');
});

test('a context created by the desk is closed on dispose', async () => {
  const own = new FakeContext();
  const desk = new StemDesk({ audioContext: own, fetchImpl: fakeFetch(), ownsContext: true });
  desk.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(own.closed, true);
});

test('resume() asks a suspended context to start and reports the state', async () => {
  const ctx = new FakeContext();
  ctx.state = 'suspended';
  const desk = new StemDesk({ audioContext: ctx, fetchImpl: fakeFetch() });
  await desk.load([lane('vocals'), lane('drums')]);
  assert.equal(desk.state().contextState, 'suspended');
  const resumed = await desk.resume();
  assert.equal(ctx.resumeCalls, 1);
  assert.equal(resumed.contextState, 'running');
});

test('play refuses a still-suspended context rather than claiming sound', async () => {
  const ctx = new FakeContext();
  ctx.state = 'suspended';
  ctx.resume = async () => { throw new Error('autoplay blocked'); };
  const desk = new StemDesk({ audioContext: ctx, fetchImpl: fakeFetch() });
  await desk.load([lane('vocals'), lane('drums')]);

  const state = await desk.resume();
  assert.equal(state.contextState, 'suspended');
  assert.equal(state.error.code, 'S_CONTEXT_SUSPENDED');
  assert.throws(() => desk.play(), (err) => err.code === 'S_CONTEXT_SUSPENDED');
});

test('an offline render context is suspended by design and still plays', async () => {
  const ctx = new FakeContext();
  ctx.state = 'suspended';
  ctx.startRendering = async () => ({ getChannelData: () => new Float32Array(8) });
  const desk = new StemDesk({ audioContext: ctx, fetchImpl: fakeFetch() });
  await desk.load([lane('vocals'), lane('drums')]);
  const state = desk.play({ loop: false });
  assert.equal(state.status, 'playing');
  assert.equal(ctx.resumeCalls, 0, 'rendering must not be started by resume()');
});

test('an oversized Content-Length is refused before the body is read', async () => {
  let bodyRead = false;
  const desk = new StemDesk({
    audioContext: new FakeContext(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(STEM_DESK_LIMITS.maxStemBytes + 1) },
      arrayBuffer: async () => { bodyRead = true; return new ArrayBuffer(0); },
    }),
  });
  const state = await desk.load([lane('vocals')]);
  assert.equal(state.error.code, 'S_STEM_TOO_LARGE');
  assert.equal(bodyRead, false);
});

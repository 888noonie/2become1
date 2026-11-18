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
  constructor({ duration = 30, channels = 2, amplitude = 0.1, amplitudes = null, durations = null } = {}) {
    this.currentTime = 10;
    this.state = 'running';
    this.resumeCalls = 0;
    this.destination = { name: 'destination' };
    this.created = [];
    this.createdSources = [];
    this.closed = false;
    this.duration = duration;
    this.channels = channels;
    this.amplitude = amplitude;
    this.amplitudes = amplitudes;
    this.durations = durations;
    this.decodeCalls = 0;
  }

  createGain() {
    const node = new FakeGain();
    this.created.push(node);
    return node;
  }

  createBufferSource() {
    const source = new FakeSource();
    this.createdSources.push(source);
    return source;
  }

  /** Stand-in for the output soft-clip shaper. */
  createWaveShaper() {
    const node = {
      curve: null,
      oversample: 'none',
      connected: [],
      connect(target) { this.connected.push(target); },
      disconnect() { this.connected = []; },
    };
    this.created.push(node);
    return node;
  }

  async decodeAudioData() {
    const index = this.decodeCalls;
    this.decodeCalls += 1;
    const amplitude = this.amplitudes ? (this.amplitudes[index] ?? 0) : this.amplitude;
    const duration = this.durations ? (this.durations[index] ?? this.duration) : this.duration;
    const samples = Float32Array.from({ length: 64 }, () => amplitude);
    return {
      duration,
      length: Math.round(duration * 4000),
      numberOfChannels: this.channels,
      getChannelData: () => samples,
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

test('a near-silent stem is labelled honestly and still obeys solo without stopping', async () => {
  const ctx = new FakeContext({ amplitudes: [0.1, 0] });
  const desk = new StemDesk({ audioContext: ctx, fetchImpl: fakeFetch() });
  const loaded = await desk.load([lane('vocals'), lane('drums')]);
  const vocals = loaded.lanes.find((entry) => entry.name === 'vocals');
  const drums = loaded.lanes.find((entry) => entry.name === 'drums');
  assert.equal(vocals.silent, false);
  assert.equal(drums.silent, true);
  assert.ok(drums.rmsDb <= STEM_DESK_LIMITS.silentRmsDb);
  assert.ok(vocals.rmsDb > STEM_DESK_LIMITS.silentRmsDb);

  desk.play();
  const after = desk.setSolo('drums', true);
  assert.equal(after.status, 'playing', 'solo must not stop the transport');
  assert.equal(after.lanes.find((entry) => entry.name === 'drums').effectiveGain, 1);
  assert.equal(after.lanes.find((entry) => entry.name === 'vocals').effectiveGain, 0);
});

test('two groups load non-destructively with track:name keys and flat lane state', async () => {
  const desk = new StemDesk({ audioContext: new FakeContext(), fetchImpl: fakeFetch() });
  const first = await desk.loadGroups([{
    trackId: 'A',
    title: 'Set A',
    lanes: [lane('vocals'), lane('drums'), lane('bass'), lane('other')],
  }]);
  assert.equal(first.lanes.length, 4);
  assert.deepEqual(first.lanes.map((entry) => entry.key), [
    'A:vocals', 'A:drums', 'A:bass', 'A:other',
  ]);

  const both = await desk.loadGroups([{
    trackId: 'B',
    title: 'Set B',
    lanes: [lane('vocals'), lane('drums'), lane('bass'), lane('other')],
  }]);
  assert.equal(both.lanes.length, 8, 'loading B must not unload A');
  assert.deepEqual(both.groups.map((group) => group.trackId), ['A', 'B']);
  assert.deepEqual(both.groups.map((group) => group.laneCount), [4, 4]);
  assert.deepEqual(both.lanes.filter((entry) => entry.trackId === 'A').map((entry) => entry.key), [
    'A:vocals', 'A:drums', 'A:bass', 'A:other',
  ]);
  assert.deepEqual(both.lanes.filter((entry) => entry.trackId === 'B').map((entry) => entry.key), [
    'B:vocals', 'B:drums', 'B:bass', 'B:other',
  ]);
});

test('a group without a track id defaults to A and keys its lanes A:name', async () => {
  const desk = new StemDesk({ audioContext: new FakeContext(), fetchImpl: fakeFetch() });
  const state = await desk.loadGroups([{ lanes: [lane('vocals'), lane('drums')] }]);
  assert.equal(state.groups[0].trackId, 'A');
  assert.deepEqual(state.lanes.map((entry) => entry.key), ['A:vocals', 'A:drums']);
});

test('solo is evaluated across all eight lanes, not within one group', async () => {
  const desk = new StemDesk({ audioContext: new FakeContext(), fetchImpl: fakeFetch() });
  await desk.loadGroups([
    { trackId: 'A', lanes: [lane('vocals'), lane('drums')] },
    { trackId: 'B', lanes: [lane('vocals'), lane('drums')] },
  ]);
  desk.setMuted('A:vocals', true);

  const soloed = desk.setSolo('B:drums', true);
  assert.equal(soloed.lanes.find((entry) => entry.key === 'B:drums').audible, true);
  for (const key of ['A:vocals', 'A:drums', 'B:vocals']) {
    assert.equal(soloed.lanes.find((entry) => entry.key === key).audible, false, key);
    assert.equal(soloed.lanes.find((entry) => entry.key === key).effectiveGain, 0, key);
  }

  const restored = desk.setSolo('B:drums', false);
  assert.equal(restored.lanes.find((entry) => entry.key === 'A:vocals').audible, false, 'mute survives solo');
  assert.equal(restored.lanes.find((entry) => entry.key === 'A:drums').audible, true);
  assert.equal(restored.lanes.find((entry) => entry.key === 'B:vocals').audible, true);
});

test('the crossfader writes equal-power group gains into one master graph', async () => {
  const desk = new StemDesk({ audioContext: new FakeContext(), fetchImpl: fakeFetch() });
  await desk.loadGroups([
    { trackId: 'A', lanes: [lane('vocals')] },
    { trackId: 'B', lanes: [lane('vocals')] },
  ]);
  assert.equal(desk._master.connected.includes(desk._ceiling), true,
    'the master now feeds the output ceiling');
  assert.equal(desk._ceiling.connected.includes(desk._ctx.destination), true,
    'the ceiling is the last node before the destination');
  const groupA = desk._groups.find((group) => group.trackId === 'A');
  const groupB = desk._groups.find((group) => group.trackId === 'B');
  assert.equal(groupA.node.connected.includes(desk._master), true);
  assert.equal(groupB.node.connected.includes(desk._master), true);
  assert.equal(groupA.lanes[0].node.connected.includes(groupA.node), true);
  assert.equal(groupB.lanes[0].node.connected.includes(groupB.node), true);

  const near = (actual, expected) => Math.abs(actual - expected) < 1e-9;
  const left = desk.setCrossfader(0);
  assert.ok(near(left.crossfader.gainA, 1));
  assert.ok(near(left.crossfader.gainB, 0));
  assert.ok(near(left.groups.find((group) => group.trackId === 'A').gain, 1));
  assert.ok(near(left.groups.find((group) => group.trackId === 'B').gain, 0));
  assert.ok(near(groupA.node.gain.value, 1));
  assert.ok(near(groupB.node.gain.value, 0));

  const middle = desk.setCrossfader(50);
  assert.ok(Math.abs(middle.crossfader.gainA - Math.SQRT1_2) < 1e-9);
  assert.ok(Math.abs(middle.crossfader.gainB - Math.SQRT1_2) < 1e-9);
  assert.ok(Math.abs(groupA.node.gain.value - Math.SQRT1_2) < 1e-9);
  assert.ok(Math.abs(groupB.node.gain.value - Math.SQRT1_2) < 1e-9);

  const right = desk.setCrossfader(100);
  assert.ok(near(right.crossfader.gainA, 0));
  assert.ok(near(right.crossfader.gainB, 1));
  assert.ok(near(groupA.node.gain.value, 0));
  assert.ok(near(groupB.node.gain.value, 1));
});

test('one loaded track keeps its group gain at 1 and disables the crossfader', async () => {
  const desk = new StemDesk({ audioContext: new FakeContext(), fetchImpl: fakeFetch() });
  const state = await desk.loadGroups([{ trackId: 'A', lanes: [lane('vocals')] }]);
  assert.equal(state.crossfader.disabled, true);
  assert.equal(state.crossfader.gainA, 1);
  assert.equal(state.crossfader.gainB, 0);
  assert.equal(state.groups[0].gain, 1);
  const after = desk.setCrossfader(0);
  assert.equal(after.groups[0].gain, 1, 'a single track is never faded to silence');
});

test('play defaults to no loop, uses one when, has no per-lane loop end and skips short lanes', async () => {
  const ctx = new FakeContext({ durations: [30, 5] });
  const desk = new StemDesk({ audioContext: ctx, fetchImpl: fakeFetch() });
  await desk.load([lane('vocals'), lane('drums')]);
  const state = desk.play({ offset: 10 });

  assert.equal(state.loop, false, 'the desk does not wrap by default');
  const vocals = desk._lanes.find((entry) => entry.name === 'vocals');
  const drums = desk._lanes.find((entry) => entry.name === 'drums');
  assert.ok(vocals.source, 'a long lane starts at the requested offset');
  assert.equal(vocals.source.loop, false);
  assert.equal(vocals.source.loopEnd, 0, 'no per-lane loopEnd is written');
  assert.equal(vocals.source.started.offset, 10);
  assert.equal(drums.source, null, 'a lane shorter than the offset is not scheduled');
  const whens = new Set(desk._sources.map((source) => source.started.when));
  assert.equal(whens.size, 1, 'one shared when for every scheduled lane');
});

test('reaching the end of the programme stops sources and returns the desk to ready', async () => {
  const ctx = new FakeContext({ duration: 2 });
  const desk = new StemDesk({ audioContext: ctx, fetchImpl: fakeFetch() });
  await desk.load([lane('vocals'), lane('drums')]);
  const playing = desk.play({ loop: false });
  const when = playing.sync.startLeadSeconds + ctx.currentTime;
  const sources = desk._sources.slice();
  assert.equal(sources.length, 2);

  ctx.currentTime = when + 2.1;
  const ended = desk.state();
  assert.equal(ended.status, 'ready');
  assert.equal(ended.playing, false);
  assert.equal(ended.positionSeconds, 0);
  assert.equal(desk._sources.length, 0);
  for (const source of sources) {
    assert.equal(source.stopped, true);
    assert.equal(source.disconnected, true);
  }
});

test('unloadGroup frees one group while the other keeps its decoded audio', async () => {
  const desk = new StemDesk({ audioContext: new FakeContext(), fetchImpl: fakeFetch() });
  await desk.loadGroups([
    { trackId: 'A', title: 'Set A', lanes: [lane('vocals'), lane('drums')] },
    { trackId: 'B', title: 'Set B', lanes: [lane('vocals'), lane('drums')] },
  ]);
  const before = desk._decodedBytes;
  assert.ok(before > 0);

  const after = desk.unloadGroup('A');
  assert.deepEqual(after.groups.map((group) => group.trackId), ['B']);
  assert.deepEqual(after.lanes.map((entry) => entry.key), ['B:vocals', 'B:drums']);
  assert.ok(desk._decodedBytes < before);
  assert.equal(after.status, 'ready');

  const empty = desk.unloadGroup('B');
  assert.equal(empty.status, 'idle');
  assert.equal(empty.lanes.length, 0);
  assert.equal(desk._decodedBytes, 0);
});

test('an over-budget third group is refused with S_DESK_FULL and leaves A and B intact', async () => {
  const desk = new StemDesk({ audioContext: new FakeContext(), fetchImpl: fakeFetch() });
  await desk.loadGroups([
    { trackId: 'A', lanes: [lane('vocals'), lane('drums'), lane('bass'), lane('other')] },
    { trackId: 'B', lanes: [lane('vocals'), lane('drums'), lane('bass'), lane('other')] },
  ]);
  const refused = await desk.loadGroups([{
    trackId: 'C',
    lanes: [lane('vocals')],
  }]);
  assert.equal(refused.error.code, 'S_DESK_FULL');
  assert.equal(refused.status, 'ready');
  assert.deepEqual(refused.groups.map((group) => group.trackId), ['A', 'B']);
  assert.equal(refused.lanes.length, 8, 'the refused group did not displace loaded audio');
});

test('a track level is a second gain layer the crossfader cannot overwrite', async () => {
  const desk = new StemDesk({ audioContext: new FakeContext(), fetchImpl: fakeFetch() });
  const near = (actual, expected) => Math.abs(actual - expected) < 1e-9;
  const at = (state, trackId) => state.groups.find((group) => group.trackId === trackId);

  await desk.loadGroups([
    { trackId: 'A', lanes: [lane('vocals')] },
    { trackId: 'B', lanes: [lane('vocals', { stemSetId: 'set-b' })] },
  ]);
  const levelled = desk.setTrackLevel('B', -6);
  assert.ok(near(at(levelled, 'A').gain, Math.SQRT1_2), 'A keeps the crossfade value');
  assert.ok(near(at(levelled, 'B').gain, Math.SQRT1_2 * Math.pow(10, -6 / 20)));
  assert.equal(levelled.lanes.find((entry) => entry.key === 'B:vocals').stemSetId, 'set-b',
    'a lane carries the stem set that produced it');

  const crossed = desk.setCrossfader(100);
  assert.ok(near(at(crossed, 'B').levelDb, -6), 'the level survives a crossfade move');
  assert.ok(near(at(crossed, 'B').xfadeGain, 1));
  assert.ok(near(at(crossed, 'B').gain, Math.pow(10, -6 / 20)));

  const soloed = desk.setSolo('A:vocals', true);
  const a = soloed.lanes.find((entry) => entry.key === 'A:vocals');
  const b = soloed.lanes.find((entry) => entry.key === 'B:vocals');
  assert.equal(a.audible, true);
  assert.ok(near(a.effectiveGain, 0), 'A is crossfaded away, so its effective gain is 0');
  assert.equal(b.audible, false);
  assert.equal(b.effectiveGain, 0);

  const opened = desk.setCrossfader(0);
  const aOpen = opened.lanes.find((entry) => entry.key === 'A:vocals');
  assert.ok(near(aOpen.effectiveGain, 1), 'opening the track restores the soloed lane');
});

test('track level is clamped to the documented range', async () => {
  const desk = new StemDesk({ audioContext: new FakeContext(), fetchImpl: fakeFetch() });
  await desk.load([lane('vocals')]);
  assert.equal(desk.setTrackLevel('A', -400).groups[0].levelDb, STEM_DESK_LIMITS.minLevelDb);
  assert.equal(desk.setTrackLevel('A', 40).groups[0].levelDb, STEM_DESK_LIMITS.maxLevelDb);
  assert.throws(() => desk.setTrackLevel('A', 'loud'), /must be a number/);
  assert.throws(() => desk.setTrackLevel('Z', 0), /no stem group/);
});

test('a bare stem name is refused when two tracks both have it', async () => {
  const desk = new StemDesk({ audioContext: new FakeContext(), fetchImpl: fakeFetch() });
  await desk.loadGroups([
    { trackId: 'A', lanes: [lane('vocals')] },
    { trackId: 'B', lanes: [lane('vocals')] },
  ]);
  assert.throws(() => desk.setGain('vocals', -6), /more than one track/);
  const state = desk.setGain('B:vocals', -6);
  assert.equal(state.lanes.find((entry) => entry.key === 'B:vocals').gainDb, -6);
  // With one track the bare name is unambiguous and keeps working.
  const single = new StemDesk({ audioContext: new FakeContext(), fetchImpl: fakeFetch() });
  await single.load([lane('vocals')]);
  assert.equal(single.setGain('vocals', -3).lanes[0].gainDb, -3);
});

test('a load that completes during playback stops the old transport', async () => {
  const ctx = new FakeContext();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const desk = new StemDesk({
    audioContext: ctx,
    fetchImpl: async (url) => {
      if (url.includes('B')) await gate;
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(64).buffer };
    },
  });
  await desk.loadGroups([{ trackId: 'A', lanes: [lane('vocals')] }]);

  // The failing order: the load BEGINS before Play, then playback starts while
  // the fetch is still pending, then B completes. An implementation that read
  // the transport only at load entry would leave A's loop running.
  const pending = desk.loadGroups([{ trackId: 'B', lanes: [lane('vocals', { audioUrl: '/api/stems/B' })] }]);
  const playing = desk.play({ loop: true });
  assert.equal(playing.status, 'playing');
  assert.ok(desk._sources.length > 0, 'A is playing while B is pending');
  release();
  const loaded = await pending;

  assert.equal(loaded.status, 'ready', 'a completed load returns the desk to ready');
  assert.equal(desk._sources.length, 0, 'the pre-load transport is torn down');
  assert.equal(desk._sources.length, 0, 'no old source keeps running behind the new graph');
  for (const source of ctx.createdSources) {
    assert.equal(source.stopped, true, 'every source from the previous transport was stopped');
  }
});

test('the master output is limited so boosted lanes cannot hard clip', async () => {
  const ctx = new FakeContext();
  const desk = new StemDesk({ audioContext: ctx, fetchImpl: fakeFetch() });
  await desk.load([lane('vocals')]);
  assert.ok(desk._ceiling, 'an output ceiling node sits between master and destination');
  const curve = desk._ceiling.curve;
  assert.equal(curve.length, 4097);
  // Identity below the knee (0.8), saturating at full scale above it.
  const mid = Math.floor(curve.length / 2);
  const at = (amplitude) => curve[Math.round(((amplitude + 1) / 2) * (curve.length - 1))];
  assert.ok(Math.abs(at(0.5) - 0.5) < 1e-3, 'linear below the knee');
  assert.ok(Math.abs(at(-0.5) + 0.5) < 1e-3, 'linear below the knee, negative side');
  assert.ok(at(0.8) <= 0.8001, 'still linear at the knee');
  assert.ok(at(0.95) < 0.95 && at(0.95) > 0.8, 'compressed above the knee');
  assert.ok(Math.abs(at(1) - 1) < 1e-3, 'reaches full scale at the end point');
  assert.ok(Math.max(...curve) <= 1.0000001, 'never exceeds full scale');
  assert.ok(Math.min(...curve) >= -1.0000001, 'never below negative full scale');
  assert.equal(desk._master.connected.includes(desk._ceiling), true);
});

test('a stem with more than two channels is refused rather than downmixed', async () => {
  const ctx = new FakeContext({ channels: 4 });
  const desk = new StemDesk({ audioContext: ctx, fetchImpl: fakeFetch() });
  const state = await desk.load([lane('vocals')]);
  assert.equal(state.status, 'unavailable');
  assert.equal(state.error.code, 'S_STEM_LAYOUT');
  assert.match(state.error.message, /mono or stereo/);
});

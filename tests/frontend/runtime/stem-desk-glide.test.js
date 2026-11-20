import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyStemDeskMix,
  captureStemDeskMix,
  validateStemDeskProposal,
} from '../../../src/twobecomeone/studio_static/js/runtime/stem-desk-proposal.js';
import {
  STEM_DESK_GLIDE_SECONDS,
  StemDesk,
} from '../../../src/twobecomeone/studio_static/js/runtime/stem-desk.js';

// A gain param that records its automation, like the real AudioParam surface
// the desk uses: .value, setValueAtTime, cancelScheduledValues and
// linearRampToValueAtTime.
class FakeParam {
  constructor() {
    this._value = 1;
    this.assigned = [];
    this.ramps = [];
    this.holds = [];
    this.cancels = [];
  }

  get value() { return this._value; }
  set value(next) { this._value = next; this.assigned.push(next); }
  setValueAtTime(next, when) { this.holds.push([next, when]); }
  cancelScheduledValues(when) { this.cancels.push(when); }
  linearRampToValueAtTime(next, when) { this.ramps.push([next, when]); this._value = next; }
  reset() { this.assigned = []; this.ramps = []; this.holds = []; this.cancels = []; }
}

class FakeGain {
  constructor() { this.gain = new FakeParam(); }
  connect() {}
  disconnect() {}
}

class FakeSource {
  constructor() { this.starts = 0; }
  connect() {}
  start() { this.starts += 1; }
  stop() {}
  disconnect() {}
}

class FakeContext {
  constructor() {
    this.currentTime = 10;
    this.state = 'running';
    this.destination = {};
    this.gains = [];
    this.sources = [];
  }

  createGain() {
    const node = new FakeGain();
    this.gains.push(node);
    return node;
  }

  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }

  createWaveShaper() { return { curve: null, oversample: 'none', connect() {}, disconnect() {} }; }
  async decodeAudioData() {
    const samples = Float32Array.from({ length: 64 }, () => 0.1);
    return { duration: 30, length: 64, numberOfChannels: 1, getChannelData: () => samples };
  }
}

const NAMES = ['vocals', 'drums', 'bass', 'other'];
const lane = (trackId, name) => ({
  name, label: name, audioUrl: `/${trackId}/${name}.wav`, method: 'demucs',
  modelName: 'htdemucs@4.1.0', device: 'cpu', stemSetId: trackId === 'A' ? 'stem-set-a' : 'stem-set-b',
});

async function loadedDesk() {
  const ctx = new FakeContext();
  const desk = new StemDesk({
    audioContext: ctx,
    fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(64).buffer }),
  });
  await desk.loadGroups(['A', 'B'].map((trackId) => ({
    trackId, title: trackId, lanes: NAMES.map((name) => lane(trackId, name)),
  })));
  return { ctx, desk };
}

function proposal(state) {
  const evidence = (key) => {
    const found = state.lanes.find((entry) => entry.key === key);
    return { rmsDb: found.rmsDb, peakDb: found.peakDb, silent: found.silent };
  };
  return {
    schema: 'stem-desk-proposal/v1',
    tracks: { A: { stemSetId: 'stem-set-a' }, B: { stemSetId: 'stem-set-b' } },
    groups: { A: { levelDb: 0, entryOffsetMs: 0 }, B: { levelDb: 0, entryOffsetMs: 0 } },
    lanes: { 'A:vocals': { muted: true, gainDb: 0 }, 'B:drums': { muted: false, gainDb: -12 } },
    crossfader: 25,
    rationale: 'test',
    evidence: { 'A:vocals': evidence('A:vocals'), 'B:drums': evidence('B:drums') },
    caveats: { tempo: 'manual', key: 'none' },
    confidence: 0.5,
  };
}

const params = (ctx) => ctx.gains.map((node) => node.gain);
const resetAll = (ctx) => params(ctx).forEach((param) => param.reset());

test('the glide is a few milliseconds, far below a fade', () => {
  assert.equal(STEM_DESK_GLIDE_SECONDS, 0.04);
});

test('a flip on a playing desk ramps the gains instead of jumping', async () => {
  const { ctx, desk } = await loadedDesk();
  const mine = captureStemDeskMix(desk.state());
  const target = validateStemDeskProposal(proposal(desk.state()), desk.state()).proposal;
  desk.play();
  const started = ctx.sources.map((source) => source.starts);
  resetAll(ctx);

  desk.glide(() => applyStemDeskMix(target, desk));
  const ramped = params(ctx).filter((param) => param.ramps.length);
  assert.ok(ramped.length > 0, 'something was ramped');
  for (const param of params(ctx)) {
    assert.equal(param.assigned.length, 0, 'no gain jumps while gliding');
    for (const [, when] of param.ramps) {
      assert.ok(Math.abs(when - (10 + STEM_DESK_GLIDE_SECONDS)) < 1e-9, 'ends exactly one glide later');
    }
  }
  // The muted vocal lane ramps toward silence, not to a jump.
  assert.ok(params(ctx).some((param) => param.ramps.some(([value]) => value === 0)));
  assert.deepEqual(ctx.sources.map((source) => source.starts), started, 'no source restarted');
  assert.equal(desk.state().status, 'playing');
  assert.equal(desk.state().lanes.find((entry) => entry.key === 'A:vocals').muted, true);

  desk.glide(() => applyStemDeskMix(mine, desk));
  assert.equal(desk.state().lanes.find((entry) => entry.key === 'A:vocals').muted, false);
  assert.equal(desk.state().crossfader.position, mine.crossfader);
});

test('a stopped desk changes by plain assignment, as before', async () => {
  const { ctx, desk } = await loadedDesk();
  const target = validateStemDeskProposal(proposal(desk.state()), desk.state()).proposal;
  resetAll(ctx);
  desk.glide(() => applyStemDeskMix(target, desk));
  for (const param of params(ctx)) assert.equal(param.ramps.length, 0);
  assert.ok(params(ctx).some((param) => param.assigned.length > 0));
});

test('without the glide wrapper a running desk still assigns directly', async () => {
  const { ctx, desk } = await loadedDesk();
  desk.play();
  resetAll(ctx);
  desk.setGain('A:drums', -6);
  for (const param of params(ctx)) assert.equal(param.ramps.length, 0);
  assert.ok(params(ctx).some((param) => param.assigned.length > 0));
});

test('a manual move during a glide cancels the pending ramp so it cannot pull the control back', async () => {
  const { ctx, desk } = await loadedDesk();
  const target = validateStemDeskProposal(proposal(desk.state()), desk.state()).proposal;
  desk.play();
  desk.glide(() => applyStemDeskMix(target, desk));
  const drums = desk._lanes.find((entry) => entry.key === 'A:drums');
  drums.node.gain.reset();
  ctx.currentTime = 10.01; // still inside the glide
  desk.setGain('A:drums', -3);
  assert.ok(drums.node.gain.cancels.length > 0, 'the pending ramp is cancelled');
  assert.equal(drums.node.gain.assigned.at(-1), 10 ** (-3 / 20));
});

test('a gain already gliding to the same value is not interrupted by another move', async () => {
  const { ctx, desk } = await loadedDesk();
  const target = validateStemDeskProposal(proposal(desk.state()), desk.state()).proposal;
  desk.play();
  desk.glide(() => applyStemDeskMix(target, desk));
  const vocals = desk._lanes.find((entry) => entry.key === 'A:vocals');
  vocals.node.gain.reset();
  ctx.currentTime = 10.01;
  desk.setGain('B:bass', -2); // unrelated control, human move
  assert.equal(vocals.node.gain.cancels.length, 0, 'the muted vocal ramp finishes untouched');
  assert.equal(vocals.node.gain.assigned.length, 0);
});

test('the glide never leaks past its batch, even when the batch throws', async () => {
  const { ctx, desk } = await loadedDesk();
  desk.play();
  assert.throws(() => desk.glide(() => { throw new Error('boom'); }), /boom/);
  resetAll(ctx);
  desk.setGain('A:drums', -6);
  for (const param of params(ctx)) assert.equal(param.ramps.length, 0);
});

test('Stop after a glide stops the desk', async () => {
  const { desk } = await loadedDesk();
  const target = validateStemDeskProposal(proposal(desk.state()), desk.state()).proposal;
  desk.play();
  desk.glide(() => applyStemDeskMix(target, desk));
  assert.equal(desk.stop().status === 'playing', false);
});

const rampCount = (ctx) => params(ctx).reduce((sum, param) => sum + param.ramps.length, 0);

test('one flip schedules exactly one ramp per gain that changes, and none for the rest', async () => {
  const { ctx, desk } = await loadedDesk();
  const target = validateStemDeskProposal(proposal(desk.state()), desk.state()).proposal;
  desk.play();
  resetAll(ctx);
  desk.glide(() => applyStemDeskMix(target, desk));
  // A:vocals mutes, B:drums drops 12 dB, and the crossfader moves both groups.
  assert.equal(rampCount(ctx), 4);
  for (const param of params(ctx)) assert.ok(param.ramps.length <= 1);
  const vocals = desk._lanes.find((entry) => entry.key === 'A:vocals').node.gain;
  const drumsA = desk._lanes.find((entry) => entry.key === 'A:drums').node.gain;
  assert.deepEqual(vocals.ramps.map(([value]) => value), [0]);
  assert.equal(drumsA.ramps.length, 0, 'an unchanged lane is not touched');
});

test('rapid flipping while playing: each flip ramps from where the gain is, once per changed gain', async () => {
  const { ctx, desk } = await loadedDesk();
  const mine = captureStemDeskMix(desk.state());
  const target = validateStemDeskProposal(proposal(desk.state()), desk.state()).proposal;
  desk.play();
  const vocals = desk._lanes.find((entry) => entry.key === 'A:vocals').node.gain;
  for (let flip = 0; flip < 10; flip += 1) {
    resetAll(ctx);
    ctx.currentTime += 0.005; // far inside the previous 40 ms glide
    desk.glide(() => applyStemDeskMix(flip % 2 === 0 ? target : mine, desk));
    assert.equal(rampCount(ctx), 4, `flip ${flip}`);
    assert.equal(vocals.cancels.length, 1, 'the unfinished ramp is replaced, not stacked');
    assert.equal(vocals.holds.length, 1, 'and the new one starts from the current gain');
    assert.equal(vocals.ramps[0][0], flip % 2 === 0 ? 0 : 1);
  }
  assert.equal(desk.state().status, 'playing');
  assert.equal(desk.state().lanes.find((entry) => entry.key === 'A:vocals').muted, false);
});

test('Stop during a glide stops at once, and the next change lands without a ramp', async () => {
  const { ctx, desk } = await loadedDesk();
  const mine = captureStemDeskMix(desk.state());
  const target = validateStemDeskProposal(proposal(desk.state()), desk.state()).proposal;
  desk.play();
  desk.glide(() => applyStemDeskMix(target, desk));
  ctx.currentTime += 0.01;
  assert.equal(desk.stop().status, 'ready');
  resetAll(ctx);
  desk.glide(() => applyStemDeskMix(mine, desk));
  assert.equal(rampCount(ctx), 0, 'a stopped desk is not ramped');
  const vocals = desk._lanes.find((entry) => entry.key === 'A:vocals').node.gain;
  assert.ok(vocals.cancels.length > 0, 'the pending ramp is dropped');
  assert.equal(vocals.assigned.at(-1), 1);
});

test('a group reloaded during a glide gets fresh gains and the next flip still glides', async () => {
  const { ctx, desk } = await loadedDesk();
  const target = validateStemDeskProposal(proposal(desk.state()), desk.state()).proposal;
  desk.play();
  desk.glide(() => applyStemDeskMix(target, desk));
  ctx.currentTime += 0.01;
  await desk.loadGroups([{ trackId: 'A', title: 'A', lanes: NAMES.map((name) => lane('A', name)) }]);
  const reloaded = desk._lanes.find((entry) => entry.key === 'A:vocals');
  assert.equal(reloaded.node.gain.ramps.length, 0);
  assert.equal(desk.state().status, 'ready', 'a successful load stops playback, as accepted');
  desk.play();
  resetAll(ctx);
  desk.glide(() => desk.setMuted('A:vocals', true));
  assert.deepEqual(reloaded.node.gain.ramps.map(([value]) => value), [0]);
});

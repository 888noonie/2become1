import assert from 'node:assert/strict';
import test from 'node:test';

import { equalPowerGains } from '../../../src/twobecomeone/studio_static/js/runtime/crossfader.js';
import {
  approveStemDeskProposal,
  suggestStemDeskProposal,
  validateStemDeskProposal,
} from '../../../src/twobecomeone/studio_static/js/runtime/stem-desk-proposal.js';
import { STEM_DESK_LIMITS, StemDesk } from '../../../src/twobecomeone/studio_static/js/runtime/stem-desk.js';

class FakeGain {
  constructor() { this.gain = { value: 1 }; }
  connect() {}
  disconnect() {}
}

class FakeSource {
  constructor() { this.started = null; this.stopped = false; }
  connect() {}
  start(when, offset) { this.started = { when, offset }; }
  stop() { this.stopped = true; }
  disconnect() {}
}

class FakeContext {
  constructor() {
    this.currentTime = 10;
    this.state = 'running';
    this.destination = {};
    this.createdSources = [];
    this.duration = 30;
    this.channels = 1;
    this.amplitude = 0.1;
  }

  createGain() { return new FakeGain(); }
  createBufferSource() {
    const source = new FakeSource();
    this.createdSources.push(source);
    return source;
  }
  createWaveShaper() {
    return { curve: null, oversample: 'none', connect() {}, disconnect() {} };
  }
  async decodeAudioData() {
    const samples = Float32Array.from({ length: 64 }, () => this.amplitude);
    return {
      duration: this.duration,
      length: 64,
      numberOfChannels: 1,
      getChannelData: () => samples,
    };
  }
}

const NAMES = ['vocals', 'drums', 'bass', 'other'];

function lane(trackId, name) {
  return {
    name,
    label: name,
    audioUrl: `/${trackId}/${name}.wav`,
    method: 'demucs',
    modelName: 'htdemucs@4.1.0',
    device: 'cpu',
    stemSetId: trackId === 'A' ? 'stem-set-a' : 'stem-set-b',
  };
}

async function loadedDesk() {
  const ctx = new FakeContext();
  const desk = new StemDesk({
    audioContext: ctx,
    fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(64).buffer }),
  });
  await desk.loadGroups(['A', 'B'].map((trackId) => ({
    trackId,
    title: trackId,
    lanes: NAMES.map((name) => lane(trackId, name)),
  })));
  return { ctx, desk };
}

function snapshot(desk) {
  const state = desk.state();
  return {
    gains: state.lanes.map((lane) => [lane.key, lane.gainDb, lane.muted, lane.entryOffsetMs]),
    crossfader: state.crossfader.position,
    offsets: state.groups.map((group) => [group.trackId, group.entryOffsetMs, group.levelDb]),
  };
}

function evidenceFrom(state, keys) {
  return Object.fromEntries(keys.map((key) => {
    const lane = state.lanes.find((entry) => entry.key === key);
    return [key, { rmsDb: lane.rmsDb, peakDb: lane.peakDb, silent: lane.silent }];
  }));
}

function legalProposal(state) {
  const keys = ['A:vocals', 'B:drums'];
  return {
    schema: 'stem-desk-proposal/v1',
    tracks: { A: { stemSetId: 'stem-set-a' }, B: { stemSetId: 'stem-set-b' } },
    groups: {
      A: { levelDb: 0, entryOffsetMs: -40 },
      B: { levelDb: 0, entryOffsetMs: 80 },
    },
    lanes: {
      'A:vocals': { muted: true, gainDb: 0 },
      'B:drums': { muted: false, gainDb: -12 },
    },
    crossfader: 25,
    rationale: 'Mute A vocals and tuck B drums.',
    evidence: evidenceFrom(state, keys),
    caveats: {
      tempo: 'Entry offsets are manual milliseconds. The desk reports beatMatched false.',
      key: 'The desk has no pitch control.',
    },
    confidence: 0.62,
  };
}

test('malformed model JSON changes nothing', async () => {
  const { desk } = await loadedDesk();
  const before = snapshot(desk);
  for (const raw of ['{ops:', 'not json', '[1]']) {
    const result = approveStemDeskProposal(raw, desk);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID_PROPOSAL');
  }
  assert.deepEqual(snapshot(desk), before);
});

test('gain or offset outside desk limits changes nothing', async () => {
  const { ctx, desk } = await loadedDesk();
  const before = snapshot(desk);
  const state = desk.state();
  const proposal = legalProposal(state);
  proposal.lanes['B:drums'].gainDb = 7;
  assert.equal(approveStemDeskProposal(proposal, desk).code, 'GAIN_OUT_OF_RANGE');
  proposal.lanes['B:drums'].gainDb = -12;
  proposal.groups.B.entryOffsetMs = 4001;
  assert.equal(approveStemDeskProposal(proposal, desk).code, 'OFFSET_OUT_OF_RANGE');
  proposal.groups.B.entryOffsetMs = 80;
  proposal.playbackRate = 1.05;
  assert.equal(approveStemDeskProposal(proposal, desk).code, 'UNKNOWN_OP');
  assert.deepEqual(snapshot(desk), before);
  assert.equal(ctx.createdSources.length, 0);
});

test('an unapproved suggestion changes nothing', async () => {
  const { ctx, desk } = await loadedDesk();
  const before = snapshot(desk);
  const suggestion = suggestStemDeskProposal(desk.state());
  assert.equal(suggestion.ok, true);
  assert.equal(suggestion.proposal.lanes['A:drums'].muted, false);
  assert.equal(suggestion.proposal.lanes['A:bass'].muted, false);
  assert.equal(suggestion.proposal.lanes['A:vocals'].muted, true);
  assert.equal(suggestion.proposal.lanes['B:vocals'].muted, false);
  assert.equal(suggestion.proposal.lanes['B:other'].muted, false);
  assert.equal(suggestion.proposal.lanes['B:drums'].muted, true);
  assert.equal(suggestion.proposal.groups.A.entryOffsetMs, 0);
  assert.equal(suggestion.proposal.crossfader, 50);
  assert.equal(desk.state().sync.beatMatched, false);
  assert.deepEqual(snapshot(desk), before);
  assert.equal(ctx.createdSources.length, 0);
});

test('an approved proposal applies mute, gain, crossfader, and entry offset', async () => {
  const { ctx, desk } = await loadedDesk();
  const proposal = legalProposal(desk.state());
  const applied = approveStemDeskProposal(proposal, desk);
  assert.equal(applied.ok, true);
  assert.equal(ctx.createdSources.length, 0, 'approval does not start playback');
  const vocals = applied.state.lanes.find((lane) => lane.key === 'A:vocals');
  const drums = applied.state.lanes.find((lane) => lane.key === 'B:drums');
  assert.equal(vocals.muted, true);
  assert.equal(vocals.effectiveGain, 0);
  assert.equal(drums.gainDb, -12);
  assert.ok(Math.abs(drums.effectiveGain - (10 ** (-12 / 20)) * applied.state.crossfader.gainB) < 0.002);
  assert.deepEqual(
    { gainA: applied.state.crossfader.gainA, gainB: applied.state.crossfader.gainB },
    equalPowerGains(25),
  );
  const when0 = ctx.currentTime + STEM_DESK_LIMITS.startLeadSeconds;
  desk.play();
  const starts = (trackId) => desk._lanes
    .filter((lane) => lane.trackId === trackId)
    .map((lane) => lane.source.started);
  assert.ok(starts('A').every((start) => start.when === when0 && Math.abs(start.offset - 0.04) < 1e-9));
  assert.ok(starts('B').every((start) => Math.abs(start.when - (when0 + 0.08)) < 1e-9 && start.offset === 0));
  for (const source of ctx.createdSources) assert.equal(source.playbackRate, undefined);
});

test('a proposal for an unloaded track or a soloed lane is refused', async () => {
  const { desk } = await loadedDesk();
  const missing = legalProposal(desk.state());
  missing.tracks.B.stemSetId = 'not-the-loaded-set';
  assert.equal(validateStemDeskProposal(missing, desk.state()).code, 'TRACK_NOT_LOADED');
  desk.setSolo('A:vocals', true);
  const soloed = legalProposal(desk.state());
  assert.equal(approveStemDeskProposal(soloed, desk).code, 'SOLO_HELD');
  assert.equal(desk.state().lanes.find((lane) => lane.key === 'B:drums').gainDb, 0);
});

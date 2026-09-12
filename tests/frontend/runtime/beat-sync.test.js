// tests/frontend/runtime/beat-sync.test.js — Phase 15B beat-sync pure math.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BEAT_SYNC_MIN_TEMPO_RATIO,
  BEAT_SYNC_MAX_TEMPO_RATIO,
  beatsToSeconds,
  computeTempoRatio,
  extractTrackGridFacts,
  resolveSyncedFollowerLaunch,
} from '../../../src/twobecomeone/studio_static/js/runtime/beat-sync.js';
import { secondsToBeats } from '../../../src/twobecomeone/studio_static/js/runtime/transport-bridge.js';
import { beatAtTime, resolveNextPhrase } from '../../../src/twobecomeone/studio_static/js/transport/derive.js';
import { ERROR_CODES } from '../../../src/twobecomeone/studio_static/js/actions/errors.js';

function track(overrides = {}) {
  return {
    id: 'follower-1',
    bpm: 120,
    beat_grid: { first_beat: 0.25, interval: 0.5 },
    ...overrides,
  };
}

function masterTransport(overrides = {}) {
  return {
    deck: 'A',
    playing: true,
    tempoBpm: 120,
    beatsPerBar: 4,
    phraseBars: 8,
    beatAtStart: 0,
    startedAtAudioTime: 0,
    gridRevision: 'grid-test',
    ...overrides,
  };
}

function near(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}

test('beatsToSeconds inverts secondsToBeats', () => {
  const grid = { first_beat: 0.25, interval: 0.5 };
  for (const beat of [0, 4, 8, 16, 31.5]) {
    const seconds = beatsToSeconds(beat, grid, 120);
    const back = secondsToBeats(seconds, grid, 120);
    assert.ok(near(back, beat), `${back} != ${beat}`);
  }
});

test('extractTrackGridFacts fails closed on missing grid', () => {
  assert.equal(extractTrackGridFacts(null).ok, false);
  assert.equal(extractTrackGridFacts({ bpm: 120 }).ok, false);
  assert.equal(extractTrackGridFacts(track({ bpm: 0 })).code, ERROR_CODES.T_INVALID_TEMPO);
});

test('computeTempoRatio is bounded', () => {
  assert.equal(computeTempoRatio(120, 120).value, 1);
  assert.equal(computeTempoRatio(120, 60).value, 2);
  assert.equal(computeTempoRatio(60, 120).value, 0.5);
  const tooFast = computeTempoRatio(300, 60);
  assert.equal(tooFast.ok, false);
  assert.equal(tooFast.code, 'T_TEMPO_RATIO_OUT_OF_RANGE');
  assert.equal(BEAT_SYNC_MIN_TEMPO_RATIO, 0.25);
  assert.equal(BEAT_SYNC_MAX_TEMPO_RATIO, 4.0);
});

test('resolveSyncedFollowerLaunch matches independent phrase math at 120 BPM', () => {
  const transport = masterTransport();
  const now = 5;
  const phrase = resolveNextPhrase(transport, now);
  assert.equal(phrase.ok, true);

  const masterBeatNow = beatAtTime(transport, now);
  const expectedFollowerBeat = secondsToBeats(0, track().beat_grid, 120)
    + (phrase.value.launchBeat - masterBeatNow);
  const expectedElement = beatsToSeconds(expectedFollowerBeat, track().beat_grid, 120);

  const result = resolveSyncedFollowerLaunch({
    masterTransport: transport,
    followerTrack: track(),
    followerCueSeconds: 0,
    nowAudioTime: now,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.launchAudioTime, phrase.value.launchAudioTime);
  assert.equal(result.value.launchBeat, phrase.value.launchBeat);
  assert.equal(result.value.tempoRatio, 1);
  assert.ok(near(result.value.launchElementSeconds, expectedElement));
  assert.ok(near(result.value.followerBeatAtLaunch, expectedFollowerBeat));
});

test('resolveSyncedFollowerLaunch applies tempo ratio for mismatched BPM', () => {
  const transport = masterTransport({ tempoBpm: 100 });
  const follower = track({ bpm: 120 });
  const result = resolveSyncedFollowerLaunch({
    masterTransport: transport,
    followerTrack: follower,
    followerCueSeconds: 1.0,
    nowAudioTime: 4,
  });
  assert.equal(result.ok, true);
  assert.ok(near(result.value.tempoRatio, 100 / 120));
});

test('resolveSyncedFollowerLaunch rejects stopped master and bad grids', () => {
  const stopped = resolveSyncedFollowerLaunch({
    masterTransport: masterTransport({ playing: false }),
    followerTrack: track(),
    nowAudioTime: 1,
  });
  assert.equal(stopped.code, ERROR_CODES.T_TRANSPORT_NOT_PLAYING);

  const noGrid = resolveSyncedFollowerLaunch({
    masterTransport: masterTransport(),
    followerTrack: { id: 'x', bpm: 120 },
    nowAudioTime: 1,
  });
  assert.equal(noGrid.ok, false);
});

test('multiple BPM/grid/cue fixtures derive independent launch expectations', () => {
  const cases = [
    { masterBpm: 100, followerBpm: 120, cue: 0, now: 2 },
    { masterBpm: 128, followerBpm: 128, cue: 0.5, now: 7 },
    { masterBpm: 90, followerBpm: 100, cue: 1.25, now: 11 },
    { masterBpm: 140, followerBpm: 70, cue: 0, now: 3.5 },
  ];
  for (const { masterBpm, followerBpm, cue, now } of cases) {
    const grid = { first_beat: 0.25, interval: 60 / masterBpm };
    const transport = masterTransport({
      tempoBpm: masterBpm,
      beatAtStart: secondsToBeats(1, grid, masterBpm),
      startedAtAudioTime: 1,
    });
    const follower = track({ bpm: followerBpm, beat_grid: { first_beat: 0.25, interval: 60 / followerBpm } });
    const phrase = resolveNextPhrase(transport, now);
    const masterBeatNow = beatAtTime(transport, now);
    const expectedFollowerBeat = secondsToBeats(cue, follower.beat_grid, followerBpm)
      + (phrase.value.launchBeat - masterBeatNow);
    const result = resolveSyncedFollowerLaunch({
      masterTransport: transport,
      followerTrack: follower,
      followerCueSeconds: cue,
      nowAudioTime: now,
    });
    assert.equal(result.ok, true, JSON.stringify({ masterBpm, followerBpm, cue, now }));
    assert.equal(result.value.launchAudioTime, phrase.value.launchAudioTime);
    assert.ok(near(result.value.followerBeatAtLaunch, expectedFollowerBeat));
    assert.ok(near(result.value.tempoRatio, masterBpm / followerBpm));
  }
});

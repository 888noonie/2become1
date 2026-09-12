// tests/frontend/transport/deck-sync.test.js — Phase 15B pure math.
// Expected launch/media offsets are computed here from the public formulas,
// not by reading LiveMixer receipts.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDeckTransport, secondsToBeats } from '../../../src/twobecomeone/studio_static/js/runtime/transport-bridge.js';
import {
  equalPowerGains,
  tempoMatchRate,
  clampPlaybackRate,
  pitchPreservationState,
  beatsToSeconds,
  planFollowerStart,
  nextBeatLaunch,
  MIN_LEAD_SECONDS,
} from '../../../src/twobecomeone/studio_static/js/transport/deck-sync.js';

function track(id, bpm, firstBeat = 0, interval = 0.5) {
  return { id, bpm, beat_grid: { first_beat: firstBeat, interval } };
}

test('equal-power: hard left is A only, hard right is B only', () => {
  const left = equalPowerGains(0);
  assert.equal(left.ok, true);
  assert.equal(left.value.gainA, 1);
  assert.equal(left.value.gainB, 0);
  const right = equalPowerGains(1);
  assert.equal(right.value.gainA, 0);
  assert.equal(right.value.gainB, 1);
});

test('equal-power: center is both at cos(pi/4)', () => {
  const mid = equalPowerGains(0.5);
  const expected = Math.cos(Math.PI / 4);
  assert.ok(Math.abs(mid.value.gainA - expected) < 1e-12);
  assert.ok(Math.abs(mid.value.gainB - expected) < 1e-12);
});

test('equal-power rejects non-finite xfader', () => {
  assert.equal(equalPowerGains(NaN).ok, false);
  assert.equal(equalPowerGains(Infinity).ok, false);
});

test('tempo match is master/follower BPM, clamped', () => {
  assert.equal(tempoMatchRate(120, 120), 1);
  assert.ok(Math.abs(tempoMatchRate(120, 140) - 120 / 140) < 1e-12);
  assert.equal(tempoMatchRate(240, 60), 2);
  assert.equal(tempoMatchRate(60, 240), 0.5);
  assert.equal(tempoMatchRate(0, 120), null);
});

test('pitch preservation never claims preserved because a flag was set', () => {
  assert.equal(pitchPreservationState({}), 'unsupported');
  assert.equal(pitchPreservationState({ preservesPitch: true }), 'requested');
  assert.equal(pitchPreservationState({ preservesPitch: false }), 'off');
  assert.equal(pitchPreservationState(null), 'unknown');
});

test('planFollowerStart matches independent nextBeatLaunch + beatsToSeconds', () => {
  const master = track('m', 120, 0, 0.5);
  const follower = track('f', 140, 0, 0.5);
  const now = 0;
  const elementSeconds = 0;

  const transport = buildDeckTransport({
    deck: 'A',
    track: master,
    elementSeconds,
    playing: true,
    audioClockNow: now,
  });
  assert.equal(transport.ok, true);
  const beatPlan = nextBeatLaunch(transport.value, now);
  assert.equal(beatPlan.ok, true);
  const expectedLaunch = beatPlan.value.launchAudioTime;
  const expectedBeat = beatPlan.value.launchBeat;
  const expectedMedia = beatsToSeconds(expectedBeat, follower.beat_grid, follower.bpm);
  const expectedRate = 120 / 140;

  assert.ok(expectedLaunch - now >= MIN_LEAD_SECONDS);
  assert.ok(Math.abs(expectedLaunch - now - 0.5) < 1e-9 || expectedLaunch - now >= 0.5);

  const plan = planFollowerStart({
    masterTrack: master,
    masterDeck: 'A',
    masterElementSeconds: elementSeconds,
    masterPlaying: true,
    followerTrack: follower,
    followerDeck: 'B',
    nowAudioTime: now,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.value.launchAudioTime, expectedLaunch);
  assert.equal(plan.value.launchBeat, expectedBeat);
  assert.equal(plan.value.mediaOffsetSeconds, expectedMedia);
  assert.ok(Math.abs(plan.value.playbackRate - expectedRate) < 1e-12);
});

test('planFollowerStart fails closed without a playing master grid', () => {
  const plan = planFollowerStart({
    masterTrack: { id: 'm', bpm: 120 },
    masterDeck: 'A',
    masterElementSeconds: 0,
    masterPlaying: true,
    followerTrack: track('f', 140),
    followerDeck: 'B',
    nowAudioTime: 0,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'T_GRID_MISSING');
});

test('planFollowerStart fails closed when master is not playing', () => {
  const plan = planFollowerStart({
    masterTrack: track('m', 120),
    masterDeck: 'A',
    masterElementSeconds: 0,
    masterPlaying: false,
    followerTrack: track('f', 140),
    followerDeck: 'B',
    nowAudioTime: 0,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'T_TRANSPORT_NOT_PLAYING');
});

test('beatsToSeconds is the inverse of secondsToBeats', () => {
  const grid = { first_beat: 0.2 };
  const bpm = 128;
  const beat = 16;
  const seconds = beatsToSeconds(beat, grid, bpm);
  assert.ok(Math.abs(secondsToBeats(seconds, grid, bpm) - beat) < 1e-12);
});

test('clampPlaybackRate rejects non-positive rates', () => {
  assert.equal(clampPlaybackRate(0), null);
  assert.equal(clampPlaybackRate(-1), null);
  assert.equal(clampPlaybackRate(1.25), 1.25);
});

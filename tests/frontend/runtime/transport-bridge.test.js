// tests/frontend/runtime/transport-bridge.test.js — Phase 10B bridge tests.
//
// Proves: secondsToBeats is the exact inverse of the server slice formula
// (including override BPM where grid interval != 60/bpm); transport facts
// carry the SERVER grid revision (A3); ownership proof gates (A7); and
// grid-parity checks against the server's destinationGrid facts.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRIDGE_LANGUAGE_TOLERANCE_SECONDS,
  buildDeckTransport,
  checkGridParity,
  localGridRevision,
  secondsToBeats,
} from '../../../src/twobecomeone/studio_static/js/runtime/transport-bridge.js';

function track(overrides = {}) {
  return {
    id: 'track-lead',
    bpm: 120,
    beat_grid: { first_beat: 0.25, interval: 0.5 },
    ...overrides,
  };
}

function serverGrid(overrides = {}) {
  // Mirrors the real server destinationGrid: interval/origin only (bpm is
  // passed separately as targetBpm).
  return {
    originSeconds: 0.25,
    intervalSeconds: 0.5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// secondsToBeats parity with the server formula
// ---------------------------------------------------------------------------

test('secondsToBeats inverts the server slice formula', () => {
  const t = track();
  // Server: offsetSeconds = first_beat + beat * 60 / bpm
  const serverOffset = (beat) => 0.25 + beat * 60 / 120;
  for (const beat of [0, 1, 4, 8, 32, 63.5]) {
    const seconds = serverOffset(beat);
    const derived = secondsToBeats(seconds, t.beat_grid, 120);
    // Six-decimal ffmpeg argument tolerance (Sol amendment 3).
    assert.ok(
      Math.abs(derived - beat) < BRIDGE_LANGUAGE_TOLERANCE_SECONDS * 120 / 60 + 1e-9,
      `${derived} != ${beat}`,
    );
  }
});

test('secondsToBeats preserves override-BPM mismatch with grid interval', () => {
  // Effective BPM 100 (override) but grid interval still reflects 120 BPM.
  const t = track({ bpm: 100, beat_grid: { first_beat: 0.5, interval: 0.5 } });
  const seconds = 0.5 + (4 * 60) / 100; // 4 beats at effective BPM
  const beats = secondsToBeats(seconds, t.beat_grid, 100);
  assert.ok(Math.abs(beats - 4) < 1e-9);
});

test('secondsToBeats handles nonzero origin', () => {
  const t = track({ beat_grid: { first_beat: 2.4, interval: 0.4615 } });
  const bpm = 130.4;
  const seconds = 2.4 + (16 * 60) / bpm;
  assert.ok(Math.abs(secondsToBeats(seconds, t.beat_grid, bpm) - 16) < 1e-9);
});

// ---------------------------------------------------------------------------
// Transport shape
// ---------------------------------------------------------------------------

test('buildDeckTransport anchors on audio clock with derived beats', () => {
  const t = track();
  const result = buildDeckTransport({
    deck: 'B',
    track: t,
    elementSeconds: 10.25,
    playing: true,
    audioClockNow: 55.5,
    serverGridRevision: 'grid-v1:abc',
  });
  assert.ok(result.ok);
  assert.equal(result.value.tempoBpm, 120);
  assert.equal(result.value.beatsPerBar, 4);
  assert.equal(result.value.phraseBars, 8);
  assert.equal(result.value.startedAtAudioTime, 55.5);
  assert.ok(Math.abs(result.value.beatAtStart - (10.25 - 0.25) * 2) < 1e-9);
  assert.equal(result.value.gridRevision, 'grid-v1:abc');
});

test('buildDeckTransport falls back to local revision without server one', () => {
  const t = track();
  const result = buildDeckTransport({
    deck: 'B',
    track: t,
    elementSeconds: 0,
    playing: true,
    audioClockNow: 0,
  });
  assert.ok(result.ok);
  assert.equal(result.value.gridRevision, localGridRevision(t, 120));
  // Deterministic across reads.
  const again = buildDeckTransport({
    deck: 'B', track: t, elementSeconds: 5, playing: true, audioClockNow: 9,
  });
  assert.equal(again.value.gridRevision, result.value.gridRevision);
});

test('buildDeckTransport refuses non-playing / wrong track / bad facts', () => {
  const good = track();
  const cases = [
    { deck: 'B', track: good, elementSeconds: 0, playing: false, audioClockNow: 0 },
    { deck: 'B', track: good, elementSeconds: 0, playing: true, audioClockNow: 0, expectTrackId: 'other' },
    { deck: 'B', track: null, elementSeconds: 0, playing: true, audioClockNow: 0 },
    { deck: 'B', track: { ...good, bpm: 0 }, elementSeconds: 0, playing: true, audioClockNow: 0 },
    { deck: 'B', track: { ...good, beat_grid: null }, elementSeconds: 0, playing: true, audioClockNow: 0 },
    { deck: 'B', track: good, elementSeconds: -1, playing: true, audioClockNow: 0 },
  ];
  for (const args of cases) {
    const result = buildDeckTransport(args);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.match(result.code, /^T_/);
  }
});

// ---------------------------------------------------------------------------
// A3 grid parity against server destinationGrid
// ---------------------------------------------------------------------------

test('grid parity passes when live facts equal server facts', () => {
  assert.equal(checkGridParity(track(), serverGrid(), 120), null);
});

test('grid parity fails on BPM/origin/interval drift', () => {
  assert.equal(checkGridParity(track({ bpm: 124 }), serverGrid(), 120), 'GRID_STALE');
  assert.equal(
    checkGridParity(track({ beat_grid: { first_beat: 0.3, interval: 0.5 } }), serverGrid(), 120),
    'GRID_STALE',
  );
  assert.equal(
    checkGridParity(track({ beat_grid: { first_beat: 0.25, interval: 0.52 } }), serverGrid(), 120),
    'GRID_STALE',
  );
});

test('grid parity tolerates only sub-six-decimal drift', () => {
  const drifted = track({ beat_grid: { first_beat: 0.25 + 4e-7, interval: 0.5 } });
  assert.equal(checkGridParity(drifted, serverGrid(), 120), null);
  const wayOff = track({ beat_grid: { first_beat: 0.25 + 1e-3, interval: 0.5 } });
  assert.equal(checkGridParity(wayOff, serverGrid(), 120), 'GRID_STALE');
});

test('grid parity rejects missing facts', () => {
  assert.equal(checkGridParity(null, serverGrid(), 120), 'GRID_STALE');
  assert.equal(checkGridParity(track(), null, 120), 'GRID_STALE');
  assert.equal(checkGridParity(track(), serverGrid(), null), 'GRID_STALE');
  // A grid with valid origin/interval and a matching targetBpm passes.
  assert.equal(
    checkGridParity(track(), { originSeconds: 0.25, intervalSeconds: 0.5 }, 120),
    null,
  );
});
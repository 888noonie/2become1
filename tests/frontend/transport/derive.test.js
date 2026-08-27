// tests/frontend/transport/derive.test.js — deterministic DeckTransport maths.
//
// Phase 8B acceptance: derivedPosition and resolveNextPhrase return pure,
// structured facts; invalid/stopped transports return structured failures;
// boundary selection is deterministic and following-only.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  beatsPerSecond,
  phraseBeats,
  beatAtTime,
  derivedPosition,
  resolveNextPhrase,
  PHRASE_EPSILON,
} from '../../../src/twobecomeone/studio_static/js/transport/derive.js';
import {
  normalizeTransport,
  TRANSPORT_DEFAULTS,
} from '../../../src/twobecomeone/studio_static/js/transport/normalize.js';
import { ERROR_CODES } from '../../../src/twobecomeone/studio_static/js/actions/errors.js';

function transport(overrides = {}) {
  return {
    deck: 'B',
    playing: true,
    tempoBpm: 120,
    beatsPerBar: 4,
    phraseBars: 8,
    beatAtStart: 0,
    startedAtAudioTime: 0,
    gridRevision: 'g-1',
    ...overrides,
  };
}

function isNear(a, b, epsilon = 1e-9) {
  return Math.abs(a - b) <= epsilon;
}

test('beatsPerSecond and phraseBeats are pure helpers', () => {
  assert.equal(beatsPerSecond(120), 2);
  assert.equal(beatsPerSecond(60), 1);
  assert.equal(phraseBeats(4, 8), 32);
  assert.equal(phraseBeats(3, 4), 12);
});

test('beatAtTime is linear and respects origin', () => {
  const t = transport({ tempoBpm: 60, beatAtStart: 10, startedAtAudioTime: 5 });
  assert.equal(beatAtTime(t, 5), 10);
  assert.equal(beatAtTime(t, 6), 11);
  assert.equal(beatAtTime(t, 15), 20);
});

test('derivedPosition reports phrase index and phase', () => {
  const t = transport({ tempoBpm: 60, beatsPerBar: 4, phraseBars: 8 });
  // 8-bar phrase = 32 beats. At 1 bps, t=20s gives beat 20.
  const pos = derivedPosition(t, 20);
  assert.equal(pos.beat, 20);
  assert.equal(pos.phraseBeats, 32);
  assert.equal(pos.phraseIndex, 0);
  assert.equal(pos.phrasePosition, 20);
  assert.equal(pos.beatPhase, 0); // 20 % 4 == 0
  assert.equal(pos.gridRevision, 'g-1');

  const pos2 = derivedPosition(t, 40);
  assert.equal(pos2.beat, 40);
  assert.equal(pos2.phraseIndex, 1); // 40 / 32 = 1.25 -> floor 1
  assert.equal(pos2.phrasePosition, 8);
  assert.equal(pos2.beatPhase, 0);
});

test('normalizeTransport rejects invalid inputs', () => {
  const r = normalizeTransport({ deck: 'C' });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERROR_CODES.T_INVALID_DECK);

  const r2 = normalizeTransport(transport({ tempoBpm: 10 }));
  assert.equal(r2.ok, false);
  assert.equal(r2.code, ERROR_CODES.T_INVALID_TEMPO);

  const r3 = normalizeTransport(transport({ beatsPerBar: 17 }));
  assert.equal(r3.ok, false);
  assert.equal(r3.code, ERROR_CODES.T_INVALID_SIGNATURE);
});

test('resolveNextPhrase returns the following boundary', () => {
  // 120 BPM -> 2 bps. 4/4, 8 bars -> 32-beat phrase.
  // At t=5s, beat=10. Next phrase starts at beat 32 -> t=(32-0)/2=16s.
  const r = resolveNextPhrase(transport(), 5);
  assert.equal(r.ok, true);
  assert.equal(r.value.launchBeat, 32);
  assert.equal(r.value.phraseIndex, 1);
  assert.equal(r.value.phraseBeats, 32);
  assert.equal(r.value.launchAudioTime, 16);
  assert.equal(r.value.gridRevision, 'g-1');
  assert.equal(r.value.deck, 'B');
});

test('boundary case: before phrase boundary returns that boundary', () => {
  const t = transport({ tempoBpm: 120, beatAtStart: 0, startedAtAudioTime: 0 });
  // t=15.9s -> beat=31.8. Next boundary is still beat 32 -> t=16s.
  const r = resolveNextPhrase(t, 15.9);
  assert.equal(r.value.launchBeat, 32);
  assert.ok(isNear(r.value.launchAudioTime, 16));
});

test('boundary case: exactly on phrase boundary returns next boundary', () => {
  const t = transport({ tempoBpm: 120, beatAtStart: 0, startedAtAudioTime: 0 });
  // t=16s -> beat=32 exactly. The following boundary is beat 64 -> t=32s.
  const r = resolveNextPhrase(t, 16);
  assert.equal(r.value.launchBeat, 64);
  assert.equal(r.value.phraseIndex, 2);
  assert.ok(isNear(r.value.launchAudioTime, 32));
});

test('canonical proof: Deck B at beat 16 on 4/4 8-bar phrases', () => {
  // The plan explicitly asks to prove: Deck B at beat 16 on 4/4 and 8-bar
  // phrases gives beat 32; exactly beat 32 gives beat 64.
  const t = transport({ tempoBpm: 120, beatAtStart: 16, startedAtAudioTime: 0 });
  // NowAudioTime 0 -> current beat 16, which is the start of the second half
  // of a 32-beat phrase. Next boundary is beat 32.
  const r1 = resolveNextPhrase(t, 0);
  assert.equal(r1.value.launchBeat, 32);

  // Exactly at beat 32 -> next boundary is beat 64.
  // At 120 BPM beatAtStart=16, the time for beat 32 is (32-16)/2 = 8s.
  const r2 = resolveNextPhrase(t, 8);
  assert.equal(r2.value.launchBeat, 64);
});

test('60, 120, and 137.5 BPM produce deterministic following boundaries', () => {
  for (const [bpm, t, expectedBeat] of [
    [60, 10, 32], // 1 bps, beat 10 -> next boundary 32
    [120, 10, 32], // 2 bps, beat 20 -> next boundary 32
    [137.5, 10, 32], // 137.5/60 bps, beat ~22.917 -> next boundary 32
  ]) {
    const r = resolveNextPhrase(transport({ tempoBpm: bpm }), t);
    assert.equal(r.value.launchBeat, expectedBeat);
  }
});

test('varied signatures: 3/4 4-bar and 7/8 2-bar', () => {
  // 3/4, 4 bars -> 12-beat phrase.
  const r1 = resolveNextPhrase(transport({ beatsPerBar: 3, phraseBars: 4, tempoBpm: 60 }), 5);
  assert.equal(r1.value.phraseBeats, 12);
  assert.equal(r1.value.launchBeat, 12);

  // 7/8, 2 bars -> 14-beat phrase.
  const r2 = resolveNextPhrase(transport({ beatsPerBar: 7, phraseBars: 2, tempoBpm: 60 }), 10);
  assert.equal(r2.value.phraseBeats, 14);
  assert.equal(r2.value.launchBeat, 14);
});

test('nonzero origin and non-zero startAudioTime', () => {
  // beatAtStart=7, startedAt=3s, 120 BPM (2 bps).
  // nowAudioTime=8s -> beat = 7 + (8-3)*2 = 17.
  const t = transport({ beatAtStart: 7, startedAtAudioTime: 3 });
  const r = resolveNextPhrase(t, 8);
  assert.equal(r.value.launchBeat, 32);
  // launchTime: 3 + (32 - 7)/2 = 15.5s
  assert.ok(isNear(r.value.launchAudioTime, 15.5));
});

test('stopped transport fails with TRANSPORT_NOT_PLAYING', () => {
  const r = resolveNextPhrase(transport({ playing: false }), 5);
  assert.equal(r.ok, false);
  assert.equal(r.code, ERROR_CODES.T_TRANSPORT_NOT_PLAYING);
});

test('invalid nowAudioTime fails with structured code', () => {
  const r = resolveNextPhrase(transport(), NaN);
  assert.equal(r.ok, false);
  assert.equal(r.code, ERROR_CODES.T_INVALID_TIME);
});

test('epsilon determinism: tiny jitter around boundary is deterministic', () => {
  const t = transport({ tempoBpm: 120 });
  const boundaryTime = 16; // beat 32
  // Just before the boundary: the upcoming boundary (32) is returned.
  const r1 = resolveNextPhrase(t, boundaryTime - PHRASE_EPSILON * 100);
  assert.equal(r1.value.launchBeat, 32);

  // Exactly on the boundary and just past it: the following boundary (64).
  for (const offset of [0, PHRASE_EPSILON * 100]) {
    const r = resolveNextPhrase(t, boundaryTime + offset);
    assert.equal(r.value.launchBeat, 64);
    assert.ok(isNear(r.value.launchAudioTime, 32));
  }
});

test('gridRevision is preserved in launch facts', () => {
  const r = resolveNextPhrase(transport({ gridRevision: 'grid-aug-27-v3' }), 1);
  assert.equal(r.value.gridRevision, 'grid-aug-27-v3');
});

test('normalized transport is frozen and serializable', () => {
  const input = transport();
  const r = normalizeTransport(input);
  assert.equal(r.ok, true);
  assert.equal(Object.isFrozen(r.value), true);
  assert.deepEqual(JSON.parse(JSON.stringify(r.value)), JSON.parse(JSON.stringify(input)));
});

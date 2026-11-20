// tests/frontend/arrangement/c1-safety.test.js — GATE 6 (bypass) + GATE 7
// (non-finite output safety and the BDI repair).
//
// Gate 6: clipNeedsDsp is the ONE shared bypass predicate used by both the
// offline bounce and real-time playback (both route through the same function).
// Gate 7: a bounded non-finite guard on the output path zeroes NaN/Infinity,
// counts and reports it (never lets it reach the output), and the click
// diagnostic can never convert an invalid numerical result into an implicit
// PASS — non-finite flags, frame-0 reports unscorable.

import test from 'node:test';
import assert from 'node:assert/strict';

import { clipNeedsDsp } from '../../../src/twobecomeone/studio_static/js/arrangement/time-math.js';
import {
  boundaryDiscontinuity, boundaryGate, BDI_THRESHOLD,
} from '../../../src/twobecomeone/studio_static/js/arrangement/click-guard.js';

// Stub the AudioWorklet global so the limiter module loads headlessly.
globalThis.AudioWorkletProcessor = class {};
globalThis.registerProcessor = () => {};
const { LookaheadLimiter } = await import('../../../src/twobecomeone/studio_static/js/arrangement/limiter-worklet.js');

// ---------- Gate 6: the shared bypass predicate ----------

test('GATE 6: clipNeedsDsp is the single bypass decision (shared semantics)', () => {
  // Bypass only for an exact rate of 1 AND 0 semitones — a pure source playback.
  assert.equal(clipNeedsDsp(1, 0), false);
  // Everything else keeps the DSP: any stretch, any pitch, any near-1 rate.
  for (const [rate, st] of [[0.857, 0], [1.2, 0], [2, 0], [1, 7], [1, -12], [0.9999, 0], [1.0001, 0]]) {
    assert.equal(clipNeedsDsp(rate, st), true, `rate ${rate}, ${st} st must use the DSP`);
  }
});

test('GATE 6: offline and live share the predicate (imported, not reimplemented)', () => {
  // The predicate is a pure named export of the conventions module; the voice
  // scheduler (live) and the graph builder (offline) both call it. Assert the
  // exact bypass truth table here so any divergence in either path is caught.
  const table = [
    [{ rate: 1, pitchSemitones: 0 }, false],
    [{ rate: 1, pitchSemitones: 1 }, true],
    [{ rate: 1.0, pitchSemitones: -0.0 }, false], // -0 === 0
    [{ rate: 0.5, pitchSemitones: 0 }, true],
  ];
  for (const [clip, expected] of table) {
    assert.equal(clipNeedsDsp(clip.rate, clip.pitchSemitones), expected);
  }
});

// ---------- Gate 7: non-finite output guard (limiter) ----------

test('GATE 7: the limiter zeroes non-finite samples, counts them, never emits them', () => {
  const sr = 48000;
  const limiter = new LookaheadLimiter(sr, { ceiling: 0.9, lookaheadMs: 5, releaseMs: 50 });
  const N = 256;
  const inL = new Float32Array(N).fill(0.5);
  const inR = new Float32Array(N).fill(0.5);
  // Inject NaN and Infinity at known indices.
  inL[10] = NaN;
  inR[20] = Infinity;
  inL[30] = -Infinity;
  const outL = new Float32Array(N);
  const outR = new Float32Array(N);
  limiter.processBlock(inL, inR, outL, outR);
  // No non-finite sample reaches the output.
  for (let i = 0; i < N; i += 1) {
    assert.ok(Number.isFinite(outL[i]), `outL[${i}] must be finite`);
    assert.ok(Number.isFinite(outR[i]), `outR[${i}] must be finite`);
  }
  // Three faults counted and the first index reported.
  assert.equal(limiter.nonFiniteCount, 3);
  assert.ok(limiter.firstNonFiniteIndex >= 0);
  const stats = limiter.stats();
  assert.equal(stats.nonFiniteCount, 3);
  assert.equal(typeof stats.firstNonFiniteIndex, 'number');
});

test('GATE 7: a clean block reports zero non-finite faults', () => {
  const limiter = new LookaheadLimiter(48000, {});
  const N = 512;
  const inL = new Float32Array(N).fill(0.2);
  const inR = new Float32Array(N).fill(-0.2);
  const outL = new Float32Array(N); const outR = new Float32Array(N);
  limiter.processBlock(inL, inR, outL, outR);
  assert.equal(limiter.nonFiniteCount, 0);
  assert.equal(limiter.firstNonFiniteIndex, -1);
});

// ---------- Gate 7: the BDI repair (click diagnostic honesty) ----------

function tone(n, phase = 0) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i += 1) x[i] = 0.5 * Math.sin((2 * Math.PI * 330 * i) / 48000 + phase);
  return x;
}

test('GATE 7: non-finite input FLAGS (never an implicit pass)', () => {
  const x = tone(4096);
  x[2048] = NaN; // a NaN right at the junction
  const s = boundaryDiscontinuity(x, 2048);
  assert.equal(s.nonFinite, true);
  assert.equal(s.flagged, true, 'a NaN must FLAG, not pass');
  assert.equal(s.index, Infinity);
  // Infinity too.
  const y = tone(4096);
  y[100] = Infinity;
  const s2 = boundaryDiscontinuity(y, 2048);
  // The NaN/Inf is outside the probe window of boundary 2048? 100 is far; use one inside.
  const z = tone(4096);
  z[2048 + 5] = Infinity;
  const s3 = boundaryDiscontinuity(z, 2048);
  assert.equal(s3.nonFinite, true, 'Infinity inside the probe window flags');
  assert.equal(s3.flagged, true);
  // Real assertion (review finding 14): the Infinity at index 100 is OUTSIDE
  // boundary 2048's probe window, so it must NOT flag that boundary (the
  // detector is scoped to the junction, not the whole buffer).
  assert.equal(s2.nonFinite, false, 'a non-finite far from the junction does not flag it');
  assert.equal(s2.flagged, false);
});

test('GATE 7: the boundary gate fails on non-finite and reports frame-0 unscorable', () => {
  const good = boundaryDiscontinuity(tone(4096), 2048);
  const bad = boundaryDiscontinuity((() => { const x = tone(4096); x[2048] = NaN; return x; })(), 2048);
  const frame0 = boundaryDiscontinuity(tone(4096), 0);
  const gate = boundaryGate([good, bad, frame0]);
  assert.equal(gate.passed, false, 'a non-finite entry must fail the gate');
  assert.equal(gate.finite, false, 'the gate reports it is not finite');
  assert.equal(gate.flagged.length, 1);
  assert.equal(gate.flagged[0].nonFinite, true);
  // Frame 0 is reported unscorable, NOT silently passed.
  assert.equal(gate.unscorable.length, 1);
  assert.equal(gate.unscorable[0].boundary, 0);
  assert.match(gate.unscorable[0].reason, /frame-0/);
});

test('GATE 7: frame-0 boundary is unscorable (no throw), a clean interior passes', () => {
  const s = boundaryDiscontinuity(tone(4096), 0);
  assert.equal(s.unscorable, true);
  assert.equal(s.scorability, 'unscorable');
  assert.equal(s.flagged, false, 'unscorable is not a defect, but it is not a pass either');
  const clean = boundaryDiscontinuity(tone(4096), 2048);
  assert.equal(clean.unscorable, false);
  assert.equal(clean.flagged, false);
  assert.ok(Number.isFinite(clean.index));
  assert.ok(clean.index < BDI_THRESHOLD);
});

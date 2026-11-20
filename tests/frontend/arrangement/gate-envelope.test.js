// tests/frontend/arrangement/gate-envelope.test.js — GATE 5 / Gate 8 T4.
//
// Transport anti-click envelope arithmetic, verified exactly without audio: for
// every seam type the gate is 0 or 1 at its ends, its per-sample step never
// exceeds 1/ramp, and every complementary (crossfade) pair sums to exactly 1.
// Also the frame-zero start property: the first output sample after a start at
// frame 0 is exactly 0. Transport gates are kept distinct from musical fades.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  START_RAMP_FRAMES, STOP_RAMP_FRAMES, SEEK_RAMP_FRAMES, LOOP_XFADE_FRAMES,
  linearUp, linearDown, startGateAt, stopGateAt,
  crossfadeUpAt, crossfadeDownAt, loopSeamWindow, seamGate, sampleGate,
} from '../../../src/twobecomeone/studio_static/js/arrangement/gate-envelope.js';

test('T4: linear ramps are exact at the ends and bounded per-sample', () => {
  const N = 120;
  assert.equal(linearUp(0, N), 0);
  assert.equal(linearUp(N, N), 1);
  assert.equal(linearDown(0, N), 1);
  assert.equal(linearDown(N, N), 0);
  for (let i = 0; i < N; i += 1) {
    assert.ok(Math.abs(linearUp(i + 1, N) - linearUp(i, N)) <= 1 / N + 1e-12, 'step <= 1/ramp');
  }
});

test('T4: start gate — 0 before/at the seam, 1 at the end, first sample 0', () => {
  const Ts = 48000; const N = START_RAMP_FRAMES;
  assert.equal(startGateAt(Ts - 1, Ts, N), 0, 'silent before Play');
  assert.equal(startGateAt(Ts, Ts, N), 0, 'frame-0 start yields an exact 0 first sample');
  assert.equal(startGateAt(Ts + N, Ts, N), 1);
  assert.equal(startGateAt(Ts + N + 100, Ts, N), 1);
  // Per-sample step bounded by 1/N.
  for (let t = Ts; t < Ts + N; t += 1) {
    assert.ok(Math.abs(startGateAt(t + 1, Ts, N) - startGateAt(t, Ts, N)) <= 1 / N + 1e-12);
  }
});

test('T4: stop gate — 1 before the fade, 0 at/past the end, step bounded', () => {
  const Te = 48000; const N = STOP_RAMP_FRAMES;
  assert.equal(stopGateAt(Te - N - 10, Te, N), 1);
  assert.equal(stopGateAt(Te - N, Te, N), 1, 'full level at the fade start');
  assert.equal(stopGateAt(Te, Te, N), 0, 'silence at the stop end');
  assert.equal(stopGateAt(Te + 5, Te, N), 0);
  for (let t = Te - N; t < Te; t += 1) {
    assert.ok(Math.abs(stopGateAt(t + 1, Te, N) - stopGateAt(t, Te, N)) <= 1 / N + 1e-12);
  }
});

test('T4: crossfade pairs sum to exactly 1 at every sample (handover + loop)', () => {
  for (const N of [SEEK_RAMP_FRAMES, LOOP_XFADE_FRAMES]) {
    const seam = 48000;
    const W0 = loopSeamWindow(seam, N);
    for (let t = W0 - 5; t <= W0 + N + 5; t += 1) {
      const sum = crossfadeUpAt(t, W0, N) + crossfadeDownAt(t, W0, N);
      assert.ok(Math.abs(sum - 1) <= 1e-9, `complementary pair must sum to 1 (got ${sum}) at t=${t}`);
    }
    // Ends: exactly 0/1 at the window edges.
    assert.equal(crossfadeUpAt(W0, W0, N), 0);
    assert.equal(crossfadeUpAt(W0 + N, W0, N), 1);
    assert.equal(crossfadeDownAt(W0, W0, N), 1);
    assert.equal(crossfadeDownAt(W0 + N, W0, N), 0);
  }
});

test('T4: seamGate covers every seam kind and returns null for unknown', () => {
  assert.equal(seamGate('start', { Ts: 0, N: 120 })(0), 0);
  assert.equal(seamGate('stop', { Te: 100, N: 480 })(100), 0);
  assert.equal(seamGate('handover-in', { W0: 0, N: 240 })(240), 1);
  assert.equal(seamGate('handover-out', { W0: 0, N: 240 })(0), 1);
  assert.equal(seamGate('open', {})(12345), 1);
  assert.equal(seamGate('nonsense', {}), null);
});

test('T4: sampleGate produces the exact shape over a range (continuity oracle)', () => {
  const N = 120; const Ts = 1000;
  const g = sampleGate((t) => startGateAt(t, Ts, N), Ts - 2, Ts + N + 2);
  assert.equal(g[2], 0, 'first sample at the seam is 0');
  assert.equal(g[g.length - 1], 1);
  // Monotonic non-decreasing over the ramp (a start never dips).
  for (let i = 2; i < 2 + N; i += 1) assert.ok(g[i] >= g[i - 1] - 1e-12);
});

test('T4: a transport start gate attenuates but never time-shifts (timing preserved)', () => {
  // The gate multiplies content; it must not move where content sits. The ramp
  // reaches 1 at Ts+N and is a pure scalar — content sample index is unchanged.
  const Ts = 500; const N = START_RAMP_FRAMES;
  const content = new Float32Array(1000).fill(1);
  for (let t = 0; t < 1000; t += 1) content[t] *= startGateAt(t, Ts, N);
  // The peak (index of max) is still at/after Ts (no shift earlier).
  let peakAt = 0;
  for (let t = 0; t < 1000; t += 1) if (content[t] > content[peakAt]) peakAt = t;
  assert.ok(peakAt >= Ts + N - 1, 'the ramped region peaks at the end of the ramp (no time shift)');
});

// tests/frontend/arrangement/time-math.test.js — the normative time, stretch
// and pitch conventions. These numbers are the contract every later milestone
// reuses, so they are pinned here first.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MICRO_FADE_BEATS,
  MAX_STRETCH_RATIO,
  MIN_STRETCH_RATIO,
  beatsToSourceSeconds,
  clampMicroFades,
  compareClips,
  defaultMicroFades,
  outputDurationMultiplier,
  secPerBeat,
  semitoneFactor,
  sourceAdvanceRate,
} from '../../../src/twobecomeone/studio_static/js/arrangement/time-math.js';

test('beat and second conversion uses the master tempo', () => {
  assert.equal(secPerBeat(120), 0.5);
  assert.equal(secPerBeat(60), 1);
});

test('beat_sync source-advance rate is masterBpm / asset.nativeBpm', () => {
  const clip = { stretchMode: 'beat_sync', customStretchRatio: null };
  const asset = { nativeBpm: 120 };
  assert.equal(sourceAdvanceRate(clip, asset, 60), 0.5);
  assert.equal(sourceAdvanceRate(clip, asset, 120), 1);
  assert.equal(sourceAdvanceRate(clip, asset, 240), 2);
});

test('the output-duration multiplication is the reciprocal of the rate', () => {
  const clip = { stretchMode: 'beat_sync', customStretchRatio: null };
  const asset = { nativeBpm: 120 };
  for (const bpm of [40, 60, 90, 123.456, 240]) {
    const rate = sourceAdvanceRate(clip, asset, bpm);
    assert.ok(Math.abs(outputDurationMultiplier(clip, asset, bpm) - 1 / rate) < 1e-12);
    assert.ok(Math.abs(outputDurationMultiplier(clip, asset, bpm) * rate - 1) < 1e-12);
  }
});

test('manual mode uses customStretchRatio with the same convention', () => {
  const clip = { stretchMode: 'manual', customStretchRatio: 0.75 };
  assert.equal(sourceAdvanceRate(clip, { nativeBpm: null }, 120), 0.75);
});

test('beat_sync on an unmeasured BPM is unavailable, never invented', () => {
  const clip = { stretchMode: 'beat_sync', customStretchRatio: null };
  assert.throws(() => sourceAdvanceRate(clip, { nativeBpm: null }, 120), RangeError);
});

test('beats to source seconds applies both tempo mapping and rate', () => {
  // 8 beats at masterBpm 60 is 8 output seconds; rate 0.5 consumes 4 source s.
  const clip = { stretchMode: 'beat_sync', customStretchRatio: null, durationBeats: 8 };
  const asset = { nativeBpm: 120 };
  assert.equal(beatsToSourceSeconds(8, clip, asset, 60), 4);
  // Equivalently 8 beats at the native 120 BPM = 4 source seconds.
});

test('pitch factor is the standard 2^(s/12) and never touches time', () => {
  assert.equal(semitoneFactor(0), 1);
  assert.equal(semitoneFactor(12), 2);
  assert.equal(semitoneFactor(-12), 0.5);
  assert.ok(Math.abs(semitoneFactor(7) - 1.4983070768766815) < 1e-12);
});

test('the default micro-fade is 0.015 beats', () => {
  assert.equal(DEFAULT_MICRO_FADE_BEATS, 0.015);
  const fades = defaultMicroFades(4);
  assert.deepEqual(fades, { fadeInBeats: 0.015, fadeOutBeats: 0.015 });
});

test('very short clips get proportionally shorter fades', () => {
  // A 0.02-beat clip cannot hold 0.015 + 0.015 beats of fade.
  const fades = defaultMicroFades(0.02);
  assert.equal(fades.fadeInBeats, 0.01);
  assert.equal(fades.fadeOutBeats, 0.01);
  const tiny = defaultMicroFades(0.004);
  assert.ok(tiny.fadeInBeats + tiny.fadeOutBeats <= 0.004 + 1e-12);
});

test('clampMicroFades scales an oversized pair down to the clip', () => {
  // Each fade is first capped at half the clip, then the pair is scaled if it
  // still exceeds the clip. (3, 1) on a 2-beat clip becomes (1, 1).
  const fades = clampMicroFades(3, 1, 2);
  assert.deepEqual(fades, { fadeInBeats: 1, fadeOutBeats: 1 });
  const scaled = clampMicroFades(3, 2, 2);
  assert.ok(scaled.fadeInBeats + scaled.fadeOutBeats <= 2 + 1e-12);
  assert.ok(scaled.fadeInBeats >= scaled.fadeOutBeats, 'relative fade balance is kept');
});

test('clip order is (timelineStartBeat, id) and deterministic', () => {
  const a = { id: 'clip-2', timelineStartBeat: 4 };
  const b = { id: 'clip-1', timelineStartBeat: 4 };
  const c = { id: 'clip-3', timelineStartBeat: 1 };
  const sorted = [a, b, c].sort(compareClips);
  assert.deepEqual(sorted.map((x) => x.id), ['clip-3', 'clip-1', 'clip-2']);
});

test('stretch ratio bounds are documented constants', () => {
  assert.equal(MIN_STRETCH_RATIO, 0.05);
  assert.equal(MAX_STRETCH_RATIO, 20);
});

test('Golden Ear II: one routing decision with two declared host policies', async () => {
  const { clipRoute, HOST_ROUTING } = await import('../../../src/twobecomeone/studio_static/js/arrangement/time-math.js');
  assert.deepEqual({ ...HOST_ROUTING }, { offline: 'stretch-all', live: 'bypass-unity' });
  // Live: only an exact unity clip bypasses.
  assert.equal(clipRoute(1, 0, 'live'), 'bypass');
  assert.equal(clipRoute(0.9999, 0, 'live'), 'stretch');
  assert.equal(clipRoute(1, 1, 'live'), 'stretch');
  // Offline (accepted bounce, unchanged): everything through the stretch path.
  assert.equal(clipRoute(1, 0, 'offline'), 'stretch');
  assert.equal(clipRoute(1.2, 0, 'offline'), 'stretch');
  assert.throws(() => clipRoute(1, 0, 'speaker'), RangeError);
});

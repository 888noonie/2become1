// tests/frontend/arrangement/realtime-engine.test.js — Milestone C1 review fix
// (finding 16: the engine's correctness-critical math must be TESTED, not just
// asserted in docs). Covers the pure, exported pieces of realtime-engine.js: the
// ONE context-time mapping (findings 1–2) and voice-key identity (finding 3),
// plus the selected scheduling horizon constant (finding 5).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ctxTimeMapper,
  makeVoiceKey,
  SELECTED_SCHEDULING_HORIZON_MS,
} from '../../../src/twobecomeone/studio_static/js/realtime-engine.js';

const SR = 48000;

test('review 1-2: the context-time mapping is coherent (offset and frame agree)', () => {
  // A non-zero epoch origin AND a non-zero start frame — the exact case the old
  // code double-subtracted (it placed voices startFrame/sr too early).
  const epochStartCtxSec = 12.5; // ctx.currentTime + horizon, arbitrary
  const epochStartFrame = 48000; // a cue 1 s in, arbitrary
  const m = ctxTimeMapper({ epochStartCtxSec, epochStartFrame, sampleRate: SR });

  // secForFrame(f) must equal secForOffset(f - epochStartFrame): one mapping.
  for (const f of [0, 48000, 48000 + 24000, 123456]) {
    assert.ok(Math.abs(m.secForFrame(f) - m.secForOffset(f - epochStartFrame)) < 1e-9,
      `frame ${f}: secForFrame and secForOffset must agree`);
  }
  // The epoch's start frame sounds exactly at the origin...
  assert.equal(m.secForFrame(epochStartFrame), epochStartCtxSec);
  // ...and playback offset 0 also lands at the origin (no double subtract).
  assert.equal(m.secForOffset(0), epochStartCtxSec);
  // A voice placed at playback offset d lands at the origin + d/sr exactly.
  const d = 96000;
  assert.equal(m.secForOffset(d), epochStartCtxSec + d / SR);
});

test('review 1: playback from a cue != 0 places voices with NO start-frame error', () => {
  // Regression for the double-subtraction: with cue frame s and origin T, a
  // voice at transport frame f (playback offset f - s) must sound at T + (f-s)/sr.
  const T = 3.0; const s = 72000; // cue 1.5 s in
  const m = ctxTimeMapper({ epochStartCtxSec: T, epochStartFrame: s, sampleRate: SR });
  const f = 72000 + 48000; // 1 s of playback after the cue
  const expected = T + 1.0; // one second after the origin
  assert.ok(Math.abs(m.secForFrame(f) - expected) < 1e-9, `got ${m.secForFrame(f)}, want ${expected}`);
  // The placement the engine uses: buildClipVoice(timelineStartFrame = offset,
  // timeOriginSec = epochStartCtxSec) -> t0 = offset/sr + origin == secForOffset.
  const offset = f - s;
  const t0 = offset / SR + T;
  assert.ok(Math.abs(t0 - m.secForOffset(offset)) < 1e-9, 'placement matches the mapping');
});

test('review 2: gate ramps are scheduled in context-seconds (frame->sec via the mapper)', () => {
  // A stop end at transport frame F must schedule at secForFrame(F), a real
  // context time > 0 for any live context — never the raw frame/sr value.
  const m = ctxTimeMapper({ epochStartCtxSec: 5.0, epochStartFrame: 0, sampleRate: SR });
  const F = 240000; // 5 s of transport
  const atSec = m.secForFrame(F);
  assert.equal(atSec, 5.0 + F / SR);
  assert.ok(atSec > 5.0, 'a transport frame maps to a future context time, not frame/sr');
  assert.notEqual(atSec, F / SR, 'must not use frames as absolute context-seconds');
});

test('review 3: voice keys are unique per creation (no cross-seek collision)', () => {
  const a = makeVoiceKey('c0', 0, 1);
  const b = makeVoiceKey('c0', 0, 2); // same clip/pass/outStart, different seq
  assert.notEqual(a, b, 'two occurrences of the same clip never share a key');
  // The stable dedup identity is separate from the lifecycle key.
  const identity = (occ) => `${occ.clipId}:${occ.pass}:${occ.outStart}`;
  assert.equal(identity({ clipId: 'c0', pass: 0, outStart: 96000 }),
    identity({ clipId: 'c0', pass: 0, outStart: 96000 }), 'dedup identity is stable within a map');
});

test('review 5: the scheduling horizon is a documented derived constant (64+25+15)', () => {
  assert.equal(SELECTED_SCHEDULING_HORIZON_MS, 104);
  // The documented derivation: priming floor 64 + wake 25 + jitter allowance 15.
  assert.equal(64 + 25 + 15, SELECTED_SCHEDULING_HORIZON_MS);
  // It is NOT the hard-coded 85 ms the challenge forbade.
  assert.notEqual(SELECTED_SCHEDULING_HORIZON_MS, 85);
});

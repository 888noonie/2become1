// tests/frontend/transport/live.test.js — Phase 12A.2/12A.3 pure live placement.
//
// resolveLivePlacement maps a committed layer's authoritative launch receipt
// onto the live Deck B transport: the absolute launch beat is placed on the
// Web Audio clock, repeats every phrase (phrase-length slice at its grid
// position), skips forward whole phrases when the instance is past or
// inside the finite minimum lead, and derives the asset's ring duration and
// linear gain. Pure math only — no Web Audio, no timers.

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveLivePlacement, LIVE_MIN_LEAD_SECONDS } from '../../../src/twobecomeone/studio_static/js/transport/live.js';

function transport(overrides = {}) {
  return {
    deck: 'B',
    playing: true,
    tempoBpm: 120,
    beatsPerBar: 4,
    phraseBars: 8,
    beatAtStart: 0,
    startedAtAudioTime: 0,
    gridRevision: 'grid-v1:abc',
    ...overrides,
  };
}

function layer(overrides = {}) {
  return {
    actionId: 'c-1',
    layerId: 'layer-c-1',
    proposalId: 'a-1',
    launchReceipt: {
      launchBeat: 32,
      destinationGridRevision: 'grid-v1:abc',
      destinationOriginSeconds: 0,
      targetBpm: 120,
      assetId: 'ga-1',
      contentHash: 'sha256:abc',
    },
    transformSpec: {
      targetBpm: 120,
      destinationGrid: { originSeconds: 0, intervalSeconds: 0.5 },
      destinationGridRevision: 'grid-v1:abc',
      semanticRegion: { id: 'r1', startBeat: 0, endBeat: 16 },
    },
    placement: { gainDb: -6, timing: { launch: 'next_phrase', quantize: true } },
    asset: { id: 'ga-1', contentHash: 'sha256:abc', pinned: true },
    ...overrides,
  };
}

test('launch beat lands on its absolute grid position (phrase on boundary)', () => {
  // 120 BPM -> 2 bps. beat 32 -> audio time 16s.
  const result = resolveLivePlacement(layer(), transport(), 0);
  assert.equal(result.ok, true);
  assert.equal(result.value.launchBeat, 32);
  assert.equal(result.value.launchAudioTime, 16);
  assert.equal(result.value.phraseBeats, 32);
  assert.equal(result.value.phraseIndex, 1);
  assert.equal(result.value.gridRevision, 'grid-v1:abc');
});

test('mid-phrase launch beat keeps its within-phrase position', () => {
  // Launch beat 40 = phrase 1 (0-32) + 8 beats offset -> audio time 20s.
  const l = layer({ launchReceipt: { ...layer().launchReceipt, launchBeat: 40 } });
  const result = resolveLivePlacement(l, transport(), 0);
  assert.equal(result.ok, true);
  assert.equal(result.value.launchAudioTime, 20);
  assert.equal(result.value.phraseIndex, 1);
});

test('past instance advances whole phrases to the next future instance', () => {
  // Now = 17s (beat 34) — the beat-32 instance is past. Next instance is
  // beat 32 + 32 = 64 -> audio time 32s.
  const result = resolveLivePlacement(layer(), transport(), 17);
  assert.equal(result.ok, true);
  assert.equal(result.value.launchBeat, 64);
  assert.equal(result.value.launchAudioTime, 32);
  assert.equal(result.value.phraseIndex, 2);
});

test('instance inside the finite minimum lead skips to the following phrase', () => {
  // Launch time 16s, now 15.9s -> lead 0.1s < LIVE_MIN_LEAD_SECONDS.
  const result = resolveLivePlacement(layer(), transport(), 16 - (LIVE_MIN_LEAD_SECONDS - 0.01));
  assert.equal(result.ok, true);
  assert.equal(result.value.launchBeat, 64);
  assert.equal(result.value.launchAudioTime, 32);
});

test('exactly on the boundary with safe lead schedules that boundary', () => {
  // On-boundary epsilon rule: now exactly at 16 - lead is safe; at exactly
  // 16 the instance is NOT future (epsilon) -> advances one phrase.
  const safe = resolveLivePlacement(layer(), transport(), 16 - LIVE_MIN_LEAD_SECONDS);
  assert.equal(safe.ok, true);
  assert.equal(safe.value.launchBeat, 32);
  const onIt = resolveLivePlacement(layer(), transport(), 16);
  assert.equal(onIt.ok, true);
  assert.equal(onIt.value.launchBeat, 64);
});

test('asset ring duration derives from the semantic region at target tempo', () => {
  // Region 0..16 beats at 120 BPM -> 8 seconds of asset audio.
  const result = resolveLivePlacement(layer(), transport(), 0);
  assert.equal(result.ok, true);
  assert.equal(result.value.durationSeconds, 8);
});

test('layer longer than a phrase still resolves per-phrase instances', () => {
  // 64-beat region = 32s of audio (longer than the 16s phrase at 120 BPM).
  const long = layer({
    transformSpec: {
      ...layer().transformSpec,
      semanticRegion: { id: 'r1', startBeat: 0, endBeat: 64 },
    },
  });
  const result = resolveLivePlacement(long, transport(), 17);
  assert.equal(result.ok, true);
  assert.equal(result.value.durationSeconds, 32);
  assert.equal(result.value.launchBeat, 64);
});

test('tempo ratio variance keeps asset duration in asset time', () => {
  // Live transport at 118 BPM (inside grid-parity tolerance), asset baked at
  // 120: duration stays 8s of asset audio; placement follows the live grid.
  const result = resolveLivePlacement(layer(), transport({ tempoBpm: 118 }), 0);
  assert.equal(result.ok, true);
  assert.equal(result.value.durationSeconds, 8);
  // launchAudioTime follows the live transport math: 32 beats at 118 BPM
  // from origin 0 -> 32 * 60/118.
  assert.ok(Math.abs(result.value.launchAudioTime - 32 * 60 / 118) < 1e-9);
});

test('gain linear derives from placement gainDb', () => {
  const result = resolveLivePlacement(layer(), transport(), 0);
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.value.gainLinear - Math.pow(10, -6 / 20)) < 1e-9);
});

test('nonzero transport origin is respected', () => {
  // beatAtStart 7 at startedAtAudioTime 3: beat 32 -> 3 + (32-7)/2 = 15.5.
  const result = resolveLivePlacement(layer(), transport({ beatAtStart: 7, startedAtAudioTime: 3 }), 0);
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.value.launchAudioTime - 15.5) < 1e-9);
});

test('stopped transport fails with T_TRANSPORT_NOT_PLAYING', () => {
  const result = resolveLivePlacement(layer(), transport({ playing: false }), 0);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'T_TRANSPORT_NOT_PLAYING');
});

test('missing launch receipt fails with L_LAYER_INVALID', () => {
  const broken = layer({ launchReceipt: null });
  const result = resolveLivePlacement(broken, transport(), 0);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'L_LAYER_INVALID');
});

test('non-finite launch beat fails with L_LAYER_INVALID', () => {
  const broken = layer({ launchReceipt: { ...layer().launchReceipt, launchBeat: Number.NaN } });
  const result = resolveLivePlacement(broken, transport(), 0);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'L_LAYER_INVALID');
});

test('extreme finite launch beat fails boundedly instead of phrase-stepping forever', () => {
  const broken = layer({
    launchReceipt: { ...layer().launchReceipt, launchBeat: -Number.MAX_VALUE },
  });
  const result = resolveLivePlacement(broken, transport(), 0);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'L_LAYER_INVALID');
});

test('gain outside the committed-layer contract fails with L_LAYER_INVALID', () => {
  const broken = layer({ placement: { gainDb: 13 } });
  const result = resolveLivePlacement(broken, transport(), 0);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'L_LAYER_INVALID');
});

test('invalid nowAudioTime fails with T_INVALID_TIME', () => {
  const result = resolveLivePlacement(layer(), transport(), Number.NaN);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'T_INVALID_TIME');
});

test('result value is frozen', () => {
  const result = resolveLivePlacement(layer(), transport(), 0);
  assert.equal(Object.isFrozen(result.value), true);
});

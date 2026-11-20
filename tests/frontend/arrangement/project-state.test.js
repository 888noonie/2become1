// tests/frontend/arrangement/project-state.test.js — ProjectState schema,
// validation and schema-versioned persistence.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OVERLAP_POLICY,
  SCHEMA_VERSION,
  TRACK_COUNT,
  cloneState,
  createProject,
  deserializeProject,
  findOverlaps,
  makeAsset,
  makeClip,
  serializeProject,
  validateProject,
  InvalidStateError,
  SchemaVersionError,
} from '../../../src/twobecomeone/studio_static/js/arrangement/project-state.js';

function baseProject() {
  const state = createProject({ masterBpm: 120 });
  state.assets['asset-1'] = makeAsset({
    id: 'asset-1',
    name: 'vocals.wav',
    durationSec: 30,
    bufferReference: 'cache:sha256:abc123',
    nativeBpm: 120,
    detectedKey: null,
  });
  state.clips.push(makeClip({
    id: 'clip-1',
    trackIndex: 0,
    assetId: 'asset-1',
    timelineStartBeat: 0,
    durationBeats: 60,
    sourceOffsetSec: 0,
    stretchMode: 'beat_sync',
  }));
  return state;
}

test('a fresh project has exactly eight tracks 0..7 and an empty arrangement', () => {
  const state = createProject();
  assert.equal(state.schemaVersion, SCHEMA_VERSION);
  assert.equal(state.tracks.length, TRACK_COUNT);
  assert.deepEqual(state.tracks.map((t) => t.trackIndex), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(state.clips, []);
  assert.deepEqual(state.assets, {});
  assert.deepEqual(state.transport, {
    masterBpm: 120,
    timeSignature: [4, 4],
    sampleRate: 48000,
    playheadBeat: 0,
    isPlaying: false,
    loopRange: null,
  });
  assert.equal(validateProject(state).ok, true);
});

test('track ranges are enforced: volumeDb, pan, eq', () => {
  const state = baseProject();
  state.tracks[0].volumeDb = 6.1;
  state.tracks[1].volumeDb = -60.1;
  state.tracks[2].pan = 1.2;
  state.tracks[3].eq.lowGainDb = -12.5;
  const { ok, errors } = validateProject(state);
  assert.equal(ok, false);
  const paths = errors.map((e) => e.path);
  assert.ok(paths.includes('tracks.0.volumeDb'));
  assert.ok(paths.includes('tracks.1.volumeDb'));
  assert.ok(paths.includes('tracks.2.pan'));
  assert.ok(paths.includes('tracks.3.eq'));
  for (const err of errors) assert.equal(err.code, 'OUT_OF_RANGE');
});

test('clip ranges are enforced: pitch, gain, fades', () => {
  const state = baseProject();
  state.clips[0].pitchSemitones = 12.5;
  state.clips[0].clipGainDb = -24.5;
  const { ok, errors } = validateProject(state);
  assert.equal(ok, false);
  const codes = errors.map((e) => `${e.path}:${e.code}`);
  assert.ok(codes.includes('clips.0.pitchSemitones:OUT_OF_RANGE'));
  assert.ok(codes.includes('clips.0.clipGainDb:OUT_OF_RANGE'));

  const fades = baseProject();
  fades.clips[0].fadeInBeats = 40;
  fades.clips[0].fadeOutBeats = 40;
  const f = validateProject(fades);
  assert.equal(f.ok, false);
  assert.ok(f.errors.some((e) => e.code === 'FADES_EXCEED_CLIP'));
});

test('exactly eight tracks are required and indices must line up', () => {
  const seven = baseProject();
  seven.tracks = seven.tracks.slice(0, 7);
  assert.ok(validateProject(seven).errors.some((e) => e.path === 'tracks'));

  const swapped = baseProject();
  swapped.tracks[2].trackIndex = 3;
  assert.ok(validateProject(swapped).errors.some((e) => e.code === 'INDEX_MISMATCH'));
});

test('unmeasured BPM and key stay explicitly unknown', () => {
  const state = createProject();
  state.assets['asset-1'] = makeAsset({
    id: 'asset-1', name: 'mystery.wav', durationSec: 10,
    bufferReference: 'cache:sha256:def456', nativeBpm: null, detectedKey: null,
  });
  assert.equal(validateProject(state).ok, true);
  state.assets['asset-1'].nativeBpm = 0;
  assert.ok(validateProject(state).errors.some((e) => e.path === 'assets.asset-1.nativeBpm'));
});

test('bufferReference must be a serializable persistent identifier', () => {
  const state = baseProject();
  state.assets['asset-1'].bufferReference = { not: 'serializable-as-id' };
  assert.ok(validateProject(state).errors.some((e) => e.path === 'assets.asset-1.bufferReference'));
});

test('beat_sync on an asset with unknown BPM is a validation error', () => {
  const state = baseProject();
  state.assets['asset-1'].nativeBpm = null;
  const { errors } = validateProject(state);
  assert.ok(errors.some((e) => e.code === 'BEAT_SYNC_UNAVAILABLE'));
});

test('a clip source region must stay inside its asset', () => {
  const state = baseProject();
  // 60 beats at 120 BPM = 30 output seconds; rate 1 consumes 30 source seconds.
  state.clips[0].durationBeats = 61;
  const { errors } = validateProject(state);
  assert.ok(errors.some((e) => e.code === 'BEYOND_ASSET_END'));
});

test('overlaps are legal, deterministic and reported as warnings', () => {
  const state = baseProject();
  state.clips.push(makeClip({
    id: 'clip-2',
    trackIndex: 0,
    assetId: 'asset-1',
    timelineStartBeat: 30,
    durationBeats: 20,
    sourceOffsetSec: 5,
    stretchMode: 'beat_sync',
  }));
  const { ok, warnings } = validateProject(state);
  assert.equal(ok, true);
  assert.equal(OVERLAP_POLICY, 'sum');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'OVERLAP');
  const pairs = findOverlaps(state);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].map((c) => c.id), ['clip-1', 'clip-2']);
});

test('JSON round-trip fidelity: serialize then deserialize is lossless', () => {
  const state = baseProject();
  state.transport.loopRange = [4, 12];
  const restored = deserializeProject(serializeProject(state));
  assert.deepEqual(restored, state);
  // Second round trip is stable too (key order and numbers preserved).
  assert.equal(serializeProject(restored), serializeProject(state));
});

test('schema-version handling: newer, missing and unmigratable versions are refused', () => {
  const state = baseProject();
  const tooNew = JSON.parse(serializeProject(state));
  tooNew.schemaVersion = SCHEMA_VERSION + 1;
  assert.throws(
    () => deserializeProject(JSON.stringify(tooNew)),
    (err) => err instanceof SchemaVersionError && err.code === 'SCHEMA_VERSION_TOO_NEW',
  );

  const missing = JSON.parse(serializeProject(state));
  delete missing.schemaVersion;
  assert.throws(
    () => deserializeProject(JSON.stringify(missing)),
    (err) => err instanceof SchemaVersionError && err.code === 'SCHEMA_VERSION_MISSING',
  );

  const ancient = JSON.parse(serializeProject(state));
  ancient.schemaVersion = 0;
  assert.throws(
    () => deserializeProject(JSON.stringify(ancient)),
    (err) => err instanceof SchemaVersionError && err.code === 'SCHEMA_VERSION_UNMIGRATABLE',
  );

  assert.throws(() => deserializeProject('{not json'), InvalidStateError);
});

test('a restored project must pass full validation', () => {
  const state = baseProject();
  const broken = JSON.parse(serializeProject(state));
  broken.clips[0].durationBeats = 5000;
  assert.throws(
    () => deserializeProject(JSON.stringify(broken)),
    (err) => err instanceof InvalidStateError && err.errors.some((e) => e.code === 'BEYOND_ASSET_END'),
  );
});

test('cloneState detaches the copy from the original', () => {
  const state = baseProject();
  const copy = cloneState(state);
  copy.clips[0].durationBeats = 1;
  assert.equal(state.clips[0].durationBeats, 60);
});

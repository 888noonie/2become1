// tests/frontend/arrangement/edit-api.test.js — atomic edit primitives:
// load, move, trim, split, stretch, pitch, gain and track/transport controls.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EditEngine,
  ExportNotReadyError,
  InvalidEditError,
} from '../../../src/twobecomeone/studio_static/js/arrangement/edit-api.js';
import {
  clipSourceSpanSec,
  sourceAdvanceRate,
} from '../../../src/twobecomeone/studio_static/js/arrangement/time-math.js';
import { checkSourceCorrespondence } from './fixtures/correspondence.js';

/** A 60-second stem measured at 60 BPM, loaded into a 120 BPM project. */
function engineWithStem(options = {}) {
  const engine = new EditEngine();
  const { assetId, clipId } = engine.loadStemToTrack(0, {
    name: 'vocals.wav',
    durationSec: 60,
    bufferReference: 'cache:sha256:aaa111',
    detectedKey: 'Am',
  }, options.nativeBpm === undefined ? 60 : options.nativeBpm);
  return { engine, assetId, clipId };
}

test('loadStemToTrack registers an immutable asset and a full-length clip', () => {
  const { engine, assetId, clipId } = engineWithStem();
  const clip = engine.state.clips.find((c) => c.id === clipId);
  const asset = engine.state.assets[assetId];
  assert.equal(clip.trackIndex, 0);
  assert.equal(clip.timelineStartBeat, 0);
  assert.equal(clip.sourceOffsetSec, 0);
  // beat_sync at native 60 BPM: 60 source seconds = 60 beats of music.
  assert.equal(clip.stretchMode, 'beat_sync');
  assert.equal(clip.durationBeats, 60);
  assert.equal(clip.fadeInBeats, 0.015);
  assert.equal(clip.fadeOutBeats, 0.015);
  assert.equal(clip.clipGainDb, 0);
  assert.equal(clip.pitchSemitones, 0);
  assert.equal(asset.nativeBpm, 60);
  assert.equal(asset.detectedKey, 'Am');
  assert.equal(asset.bufferReference, 'cache:sha256:aaa111');
  assert.ok(Object.isFrozen(asset));
});

test('an unmeasured BPM loads in manual mode and beat_sync stays unavailable', () => {
  const { engine, clipId } = engineWithStem({ nativeBpm: null });
  const clip = engine.state.clips.find((c) => c.id === clipId);
  assert.equal(clip.stretchMode, 'manual');
  assert.equal(clip.customStretchRatio, 1);
  // 60 seconds at 120 BPM master = 120 beats.
  assert.equal(clip.durationBeats, 120);
  assert.throws(() => engine.setClipStretch(clipId, 'auto'), (err) => err.code === 'BEAT_SYNC_UNAVAILABLE');
});

test('very short clips get clamped micro-fades on load', () => {
  const engine = new EditEngine({ project: undefined });
  const { clipId } = engine.loadStemToTrack(0, {
    name: 'click.wav', durationSec: 0.02, bufferReference: 'cache:sha256:ccc',
  }, 60);
  const clip = engine.state.clips.find((c) => c.id === clipId);
  // 0.02 s at 60 BPM = 0.02 beats; fades clamp to 0.01 each.
  assert.equal(clip.durationBeats, 0.02);
  assert.equal(clip.fadeInBeats, 0.01);
  assert.equal(clip.fadeOutBeats, 0.01);
});

test('ids are stable and deterministic across loads and splits', () => {
  const engine = new EditEngine();
  const first = engine.loadStemToTrack(0, { name: 'a.wav', durationSec: 30, bufferReference: 'r:a' }, 120);
  const second = engine.loadStemToTrack(1, { name: 'b.wav', durationSec: 30, bufferReference: 'r:b' }, 120);
  assert.deepEqual([first.assetId, first.clipId], ['asset-1', 'clip-1']);
  assert.deepEqual([second.assetId, second.clipId], ['asset-2', 'clip-2']);
  const split = engine.splitClipAtBeat('clip-1', 15);
  assert.equal(split.leftId, 'clip-1');
  assert.equal(split.rightId, 'clip-3');
});

test('multiple clips per track are legal and each keeps its asset reference', () => {
  const engine = new EditEngine();
  const a = engine.loadStemToTrack(0, { name: 'a.wav', durationSec: 20, bufferReference: 'r:a' }, 120);
  const b = engine.loadStemToTrack(0, { name: 'b.wav', durationSec: 20, bufferReference: 'r:b' }, 120);
  assert.equal(engine.state.clips.length, 2);
  const assets = engine.state.clips.map((c) => c.assetId);
  assert.deepEqual(assets, [a.assetId, b.assetId]);
});

test('moveClip repositions without touching identity or duration', () => {
  const { engine, clipId, assetId } = engineWithStem();
  const before = engine.state.clips[0];
  engine.moveClip(clipId, 3, 16.5);
  const after = engine.state.clips[0];
  assert.equal(after.trackIndex, 3);
  assert.equal(after.timelineStartBeat, 16.5);
  assert.equal(after.id, before.id);
  assert.equal(after.assetId, assetId);
  assert.equal(after.durationBeats, before.durationBeats);
  assert.equal(after.sourceOffsetSec, before.sourceOffsetSec);
});

test('trimClip start advances the source offset at the clip rate', () => {
  // masterBpm 120, nativeBpm 60 -> rate 2; 4 beats = 2 output s = 4 source s.
  const { engine, clipId } = engineWithStem();
  engine.trimClip(clipId, 'start', 4);
  let clip = engine.state.clips[0];
  assert.equal(clip.timelineStartBeat, 4);
  assert.equal(clip.durationBeats, 56);
  assert.equal(clip.sourceOffsetSec, 4);
  engine.trimClip(clipId, 'end', -6);
  clip = engine.state.clips[0];
  assert.equal(clip.durationBeats, 50);
  assert.equal(clip.sourceOffsetSec, 4);
});

test('trim boundaries: exactly at the asset end is legal, past it is refused', () => {
  const { engine, clipId } = engineWithStem();
  engine.trimClip(clipId, 'end', -10); // source 0..50 s
  engine.trimClip(clipId, 'end', 10);  // back to exactly the asset end
  const clip = engine.state.clips[0];
  assert.equal(clip.durationBeats, 60);
  assert.throws(() => engine.trimClip(clipId, 'end', 0.001), (err) => err.code === 'BEYOND_ASSET_END');
});

test('trim refuses to cross beat 0 or shrink below the minimum length', () => {
  const { engine, clipId } = engineWithStem();
  engine.moveClip(clipId, 0, 2);
  assert.throws(() => engine.trimClip(clipId, 'start', -3), (err) => err.code === 'OUT_OF_RANGE');
  assert.throws(() => engine.trimClip(clipId, 'end', -59.99), (err) => err.code === 'OUT_OF_RANGE');
  assert.throws(() => engine.trimClip(clipId, 'middle', 1), (err) => err.code === 'INVALID_ARGUMENT');
});

test('splitClipAtBeat keeps the asset and continues the source exactly', () => {
  const { engine, clipId, assetId } = engineWithStem();
  // rate 2 at masterBpm 120: 24 beats = 12 output s = 24 source s.
  const { leftId, rightId } = engine.splitClipAtBeat(clipId, 24);
  const [left, right] = [leftId, rightId].map((id) => engine.state.clips.find((c) => c.id === id));
  assert.equal(left.id, clipId);
  assert.equal(left.durationBeats, 24);
  assert.equal(right.assetId, assetId);
  assert.equal(right.timelineStartBeat, 24);
  assert.equal(right.durationBeats, 36);
  assert.equal(right.sourceOffsetSec, 24);
  assert.equal(left.sourceOffsetSec, 0);
  // Outer fades are kept; inner edges get the default micro-fade.
  assert.equal(left.fadeInBeats, 0.015);
  assert.equal(left.fadeOutBeats, 0.015);
  assert.equal(right.fadeInBeats, 0.015);
  assert.equal(right.fadeOutBeats, 0.015);
});

test('split keeps pitch, stretch and gain metadata on both halves', () => {
  const { engine, clipId } = engineWithStem();
  engine.setClipPitch(clipId, -5, true);
  engine.setClipGain(clipId, -3.5);
  const { rightId } = engine.splitClipAtBeat(clipId, 30);
  const right = engine.state.clips.find((c) => c.id === rightId);
  assert.equal(right.pitchSemitones, -5);
  assert.equal(right.preserveFormants, true);
  assert.equal(right.clipGainDb, -3.5);
  assert.equal(right.stretchMode, 'beat_sync');
});

test('split outside the clip is refused and leaves the state untouched', () => {
  const { engine, clipId } = engineWithStem();
  const before = engine.state;
  for (const beat of [0, 60, 61, -1]) {
    assert.throws(() => engine.splitClipAtBeat(clipId, beat), (err) => err.code === 'SPLIT_OUTSIDE_CLIP');
  }
  assert.strictEqual(engine.state, before);
  assert.equal(engine.state.clips.length, 1);
});

test('repeated splits and trims maintain timeline/source correspondence', () => {
  const { engine, clipId } = engineWithStem();
  const log = [{ op: 'load', clipId, durationBeats: 60, mode: 'beat_sync', nativeBpm: 60, durationSec: 60 }];
  // clip-1 covers beats 0..60 (source 0..60 s at rate 2).
  const s1 = engine.splitClipAtBeat('clip-1', 30);   // clip-2: 30..60
  log.push({ op: 'split', clipId: 'clip-1', at: 30, rightId: s1.rightId });
  const s2 = engine.splitClipAtBeat('clip-2', 45);   // clip-3: 45..60
  log.push({ op: 'split', clipId: 'clip-2', at: 45, rightId: s2.rightId });
  const s3 = engine.splitClipAtBeat('clip-1', 15);   // clip-4: 15..30
  log.push({ op: 'split', clipId: 'clip-1', at: 15, rightId: s3.rightId });
  engine.trimClip('clip-1', 'end', -3);
  log.push({ op: 'trimEnd', clipId: 'clip-1', deltaBeats: -3 });
  engine.trimClip(s3.rightId, 'start', 2);
  log.push({ op: 'trimStart', clipId: s3.rightId, deltaBeats: 2 });
  const check = checkSourceCorrespondence(engine, log);
  assert.deepEqual(check, { ok: true, mismatches: [] });
});

test('setClipStretch: auto is beat_sync at masterBpm/nativeBpm, manual uses the ratio', () => {
  const { engine, clipId } = engineWithStem();
  const clip = engine.state.clips[0];
  // beat_sync at masterBpm 120 / nativeBpm 60 -> rate 2.
  assert.equal(sourceAdvanceRate(clip, engine.state.assets['asset-1'], 120), 2);
  engine.setClipStretch(clipId, 1.5);
  assert.equal(engine.state.clips[0].stretchMode, 'manual');
  assert.equal(engine.state.clips[0].customStretchRatio, 1.5);
  assert.equal(sourceAdvanceRate(engine.state.clips[0], engine.state.assets['asset-1'], 120), 1.5);
  engine.setClipStretch(clipId, 'auto');
  assert.equal(engine.state.clips[0].stretchMode, 'beat_sync');
  assert.equal(engine.state.clips[0].customStretchRatio, null);
});

test('stretch keeps the timeline duration and refuses to run past the asset', () => {
  const { engine, clipId } = engineWithStem();
  const before = engine.state.clips[0];
  engine.setClipStretch(clipId, 0.5); // slower source advance: 60 beats * 0.5 s * 0.5 = 15 s
  const after = engine.state.clips[0];
  assert.equal(after.durationBeats, before.durationBeats);
  assert.equal(clipSourceSpanSec(after, engine.state.assets['asset-1'], 120), 15);
  // A ratio that would consume more than the asset has is refused.
  assert.throws(() => engine.setClipStretch(clipId, 4), (err) => err.code === 'BEYOND_ASSET_END');
  assert.throws(() => engine.setClipStretch(clipId, 0.01), (err) => err.code === 'OUT_OF_RANGE');
  assert.throws(() => engine.setClipStretch(clipId, 21), (err) => err.code === 'OUT_OF_RANGE');
});

test('beat_sync source consumption is invariant under a tempo change', () => {
  const { engine, clipId } = engineWithStem();
  const asset = engine.state.assets['asset-1'];
  const spanBefore = clipSourceSpanSec(engine.state.clips[0], asset, 120);
  engine.setMasterBpm(90);
  const spanAfter = clipSourceSpanSec(engine.state.clips[0], asset, 90);
  assert.ok(Math.abs(spanBefore - spanAfter) < 1e-9);
  // A manual clip does scale with the tempo mapping: span per beat follows
  // secPerBeat * customStretchRatio.
  const engine2 = new EditEngine();
  const { clipId: manualId } = engine2.loadStemToTrack(0, {
    name: 'm.wav', durationSec: 200, bufferReference: 'r:m',
  }, null); // manual ratio 1, 400 beats at masterBpm 120
  engine2.setClipStretch(manualId, 1);
  const manual = engine2.state.clips[0];
  const s120 = clipSourceSpanSec(manual, engine2.state.assets['asset-1'], 120);
  engine2.setMasterBpm(240);
  const s240 = clipSourceSpanSec(engine2.state.clips[0], engine2.state.assets['asset-1'], 240);
  assert.equal(s120, 200); // 400 beats at 120 BPM = 200 s * ratio 1
  assert.equal(s240, 100); // 400 beats at 240 BPM = 100 s * ratio 1
});

test('setClipPitch changes pitch metadata without changing duration', () => {
  const { engine, clipId } = engineWithStem();
  const before = engine.state.clips[0];
  const result = engine.setClipPitch(clipId, 7, true);
  const after = engine.state.clips[0];
  assert.equal(after.pitchSemitones, 7);
  assert.equal(after.preserveFormants, true);
  assert.equal(after.durationBeats, before.durationBeats);
  assert.equal(after.sourceOffsetSec, before.sourceOffsetSec);
  assert.equal(result.durationBeats, before.durationBeats);
  assert.throws(() => engine.setClipPitch(clipId, 12.5, false), (err) => err.code === 'OUT_OF_RANGE');
  assert.throws(() => engine.setClipPitch(clipId, -12.5, false), (err) => err.code === 'OUT_OF_RANGE');
  assert.throws(() => engine.setClipPitch(clipId, 3, 'yes'), (err) => err.code === 'INVALID_ARGUMENT');
});

test('setClipGain and track controls validate their ranges', () => {
  const { engine, clipId } = engineWithStem();
  engine.setClipGain(clipId, -24);
  assert.equal(engine.state.clips[0].clipGainDb, -24);
  assert.throws(() => engine.setClipGain(clipId, 24.5), (err) => err.code === 'OUT_OF_RANGE');

  engine.setTrackVolume(1, 6);
  engine.setTrackPan(1, -1);
  engine.setTrackMute(1, true);
  engine.setTrackSolo(2, true);
  engine.setTrackEq(1, { midGainDb: -3 });
  const t1 = engine.state.tracks[1];
  assert.equal(t1.volumeDb, 6);
  assert.equal(t1.pan, -1);
  assert.equal(t1.mute, true);
  assert.deepEqual(t1.eq, { lowGainDb: 0, midGainDb: -3, highGainDb: 0 });
  assert.throws(() => engine.setTrackVolume(1, 6.5), (err) => err.code === 'OUT_OF_RANGE');
  assert.throws(() => engine.setTrackPan(8, 0), (err) => err.code === 'OUT_OF_RANGE');
  assert.throws(() => engine.setTrackMute(0, 'yes'), (err) => err.code === 'INVALID_ARGUMENT');
  assert.throws(() => engine.setTrackEq(0, { lowGainDb: 13 }), (err) => err.code === 'OUT_OF_RANGE');
});

test('loop range and playhead behave at their boundaries', () => {
  const engine = new EditEngine();
  engine.setLoopRange(4, 12);
  assert.deepEqual(engine.state.transport.loopRange, [4, 12]);
  engine.setLoopRange(null, null);
  assert.equal(engine.state.transport.loopRange, null);
  assert.throws(() => engine.setLoopRange(12, 4), (err) => err.code === 'OUT_OF_RANGE');
  assert.throws(() => engine.setLoopRange(-1, 4), (err) => err.code === 'OUT_OF_RANGE');

  engine.setPlayhead(33.25);
  assert.equal(engine.state.transport.playheadBeat, 33.25);
  assert.throws(() => engine.setPlayhead(-0.5), (err) => err.code === 'OUT_OF_RANGE');
  engine.setPlaying(true);
  assert.equal(engine.state.transport.isPlaying, true);
  assert.throws(() => engine.setPlaying('yes'), (err) => err.code === 'INVALID_ARGUMENT');
});

test('an invalid edit leaves the original ProjectState object unchanged', () => {
  const { engine, clipId } = engineWithStem();
  const before = engine.state;
  const json = JSON.stringify(before);
  const failures = [
    () => engine.trimClip('nope', 'end', 1),
    () => engine.moveClip(clipId, 9, 0),
    () => engine.moveClip(clipId, 0, -1),
    () => engine.splitClipAtBeat(clipId, 1000),
    () => engine.setClipStretch(clipId, 0.001),
    () => engine.setClipPitch(clipId, 30, false),
    () => engine.loadStemToTrack(0, { name: 'x', durationSec: 1, bufferReference: { raw: 'buffer' } }),
    () => engine.loadStemToTrack(0, { name: 'x', durationSec: -1, bufferReference: 'r:x' }),
  ];
  for (const fail of failures) {
    assert.throws(fail, InvalidEditError);
    assert.strictEqual(engine.state, before, 'state identity must survive a failed edit');
  }
  assert.equal(JSON.stringify(engine.state), json);
  assert.equal(
    engine.historyDepth.past, 1,
    'failed edits must not enter history (only the initial load is undoable)',
  );
});

test('source assets are never destructively edited', () => {
  const { engine, clipId, assetId } = engineWithStem();
  const assetJson = JSON.stringify(engine.state.assets[assetId]);
  engine.trimClip(clipId, 'start', 5);
  engine.splitClipAtBeat(clipId, 20);
  engine.setClipGain(clipId, 3);
  assert.equal(JSON.stringify(engine.state.assets[assetId]), assetJson);
});

test('exportMasterMix encodes renderer PCM and refuses to invent audio', () => {
  const engine = new EditEngine();
  // Without renderer output it still fails loudly.
  assert.throws(() => engine.exportMasterMix(), ExportNotReadyError);
  const wav = engine.exportMasterMix({
    channels: [Float32Array.from([0, 0.5, -0.5]), Float32Array.from([0, -0.5, 0.5])],
    sampleRate: 48000,
  });
  assert.equal(wav.byteLength, 44 + 3 * 2 * 3);
});

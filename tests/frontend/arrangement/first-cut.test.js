// tests/frontend/arrangement/first-cut.test.js — OPERATION FIRST CUT.
//
// Slip (source in-point), clip gain and fades through the ONE edit API, with
// the source-offset arithmetic checked at non-unity stretch rates and nonzero
// offsets. A zero-offset, rate-1 case alone would hide the bugs these catch.

import test from 'node:test';
import assert from 'node:assert/strict';

import { EditEngine, InvalidEditError } from '../../../src/twobecomeone/studio_static/js/arrangement/edit-api.js';
import { compileRenderPlan } from '../../../src/twobecomeone/studio_static/js/arrangement/render-plan.js';
import { deserializeProject, validateProject } from '../../../src/twobecomeone/studio_static/js/arrangement/project-state.js';
import { beatsToSourceSeconds, slipLimitsSec, sourceAdvanceRate } from '../../../src/twobecomeone/studio_static/js/arrangement/time-math.js';
import { DawSession } from '../../../src/twobecomeone/studio_static/js/arrangement/daw-session.js';
import { FakeAudioContext, installFakeWorkletGlobal } from './helpers/fake-audio.js';
import { suggestClipIdea, phraseStarts } from '../../../src/twobecomeone/studio_static/js/components/arrangement-producer.js';

const SR = 48000;
const stem = (durationSec = 30, nativeBpm = 84.3) => ({
  name: 'B Vocals', durationSec, nativeBpm, bufferReference: '/api/stems/set/audio?name=vocals',
});

/** A B-vocals clip at project 96.8 BPM, tempo-fitted (rate != 1), then trimmed to leave slip room. */
function fitted() {
  const e = new EditEngine();
  e.setMasterBpm(96.8);
  const { clipId } = e.loadStemToTrack(4, stem(), undefined);
  e.trimClip(clipId, 'end', -(e.state.clips[0].durationBeats - 16)); // 16 beats of a 30 s stem
  return { e, clipId };
}
const clipOf = (e, id) => e.state.clips.find((c) => c.id === id);
const planClip = (e, id) => compileRenderPlan(e.state).clips.find((c) => c.clipId === id);

// ------------------------------------------------------------------ slip

test('slip changes only the source in-point: position, length, rate, fades, gain and pitch stay', () => {
  const { e, clipId } = fitted();
  e.setClipGain(clipId, -3);
  e.setClipFades(clipId, 1, 0.5);
  e.setClipPitch(clipId, 2, true);
  e.moveClip(clipId, 4, 32);
  const before = structuredClone(clipOf(e, clipId));
  e.slipClip(clipId, 7.25);
  const after = clipOf(e, clipId);
  assert.equal(after.sourceOffsetSec, 7.25);
  for (const k of Object.keys(before)) if (k !== 'sourceOffsetSec') assert.deepEqual(after[k], before[k], `${k} must not change`);
});

test('slip is sample accurate at a non-unity rate and a nonzero offset, and undo restores the old in-point', () => {
  const { e, clipId } = fitted();
  const c = clipOf(e, clipId);
  assert.notEqual(sourceAdvanceRate(c, e.state.assets[c.assetId], 96.8), 1, 'the fixture really is stretched');
  e.slipClip(clipId, 3.141);
  e.slipClip(clipId, 9.0625);
  const p = planClip(e, clipId);
  assert.equal(p.sourceStartFrame, Math.round(9.0625 * SR));
  const spanSec = beatsToSourceSeconds(c.durationBeats, c, e.state.assets[c.assetId], 96.8);
  assert.equal(p.sourceEndFrame, Math.round((9.0625 + spanSec) * SR));
  assert.equal(p.sourceSpanFrames, p.sourceEndFrame - p.sourceStartFrame);
  e.undo();
  assert.equal(planClip(e, clipId).sourceStartFrame, Math.round(3.141 * SR));
  e.undo();
  assert.equal(planClip(e, clipId).sourceStartFrame, 0);
  e.redo();
  assert.equal(clipOf(e, clipId).sourceOffsetSec, 3.141);
});

test('slip stays inside the stem: refused before the start and past the end, state untouched', () => {
  const { e, clipId } = fitted();
  const c = clipOf(e, clipId);
  const lim = slipLimitsSec(c, e.state.assets[c.assetId], 96.8);
  assert.equal(lim.min, 0);
  assert.ok(lim.max > 0 && lim.max < 30);
  e.slipClip(clipId, lim.max); // exactly the last legal in-point
  const snapshot = e.serialize();
  assert.throws(() => e.slipClip(clipId, lim.max + 0.01), (err) => err instanceof InvalidEditError && err.code === 'BEYOND_ASSET_END');
  assert.throws(() => e.slipClip(clipId, Number.NaN), (err) => err.code === 'INVALID_ARGUMENT');
  assert.equal(e.serialize(), snapshot);
  assert.equal(validateProject(e.snapshot()).ok, true);
});

test('a clip that already uses the whole stem has no slip room until it is trimmed', () => {
  const e = new EditEngine();
  e.setMasterBpm(96.8);
  const { clipId } = e.loadStemToTrack(4, stem(), undefined);
  const c = clipOf(e, clipId);
  assert.ok(slipLimitsSec(c, e.state.assets[c.assetId], 96.8).max < 1e-6);
  assert.throws(() => e.slipClip(clipId, 1), (err) => err.code === 'BEYOND_ASSET_END');
  e.trimClip(clipId, 'end', -8);
  e.slipClip(clipId, 1);
});

test('NEGATIVE CONTROL: a slip that moves the clip is caught by the position check', () => {
  const positionStaysPut = (before, after) => before.timelineStartBeat === after.timelineStartBeat
    && before.durationBeats === after.durationBeats && before.trackIndex === after.trackIndex;
  const good = fitted();
  const goodBefore = structuredClone(clipOf(good.e, good.clipId));
  good.e.slipClip(good.clipId, 5);
  assert.ok(positionStaysPut(goodBefore, clipOf(good.e, good.clipId)), 'the real slip keeps the arrangement position');
  // A plausible wrong implementation: "slip" realised as a move by the same musical time.
  const bad = fitted();
  const badBefore = structuredClone(clipOf(bad.e, bad.clipId));
  bad.e.moveClip(bad.clipId, 4, badBefore.timelineStartBeat + 4);
  assert.equal(positionStaysPut(badBefore, clipOf(bad.e, bad.clipId)), false, 'the detector sees the moved clip');
});

// ------------------------------------------------------- source-offset maths

test('trim, split and duplicate of a slipped, stretched clip continue the source exactly', () => {
  const { e, clipId } = fitted();
  e.slipClip(clipId, 4.5);
  e.setClipPitch(clipId, -3, false);
  const asset = e.state.assets[clipOf(e, clipId).assetId];
  const start = clipOf(e, clipId).timelineStartBeat;
  e.trimClip(clipId, 'start', 2);
  const trimmed = clipOf(e, clipId);
  assert.ok(Math.abs(trimmed.sourceOffsetSec - (4.5 + beatsToSourceSeconds(2, trimmed, asset, 96.8))) < 1e-9, 'trim advances the in-point at the clip rate');
  const { rightId } = e.splitClipAtBeat(clipId, start + 2 + 5);
  const left = planClip(e, clipId);
  const right = planClip(e, rightId);
  assert.equal(right.sourceStartFrame, left.sourceEndFrame, 'the right half starts where the left half stops');
  assert.equal(right.timelineStartFrame, left.timelineEndFrame);
  const { clipId: copyId } = e.duplicateClip(rightId);
  assert.equal(clipOf(e, copyId).sourceOffsetSec, clipOf(e, rightId).sourceOffsetSec, 'a duplicate plays the same source');
  assert.equal(clipOf(e, copyId).pitchSemitones, -3);
});

test('NEGATIVE CONTROL: a split that converts beats to source seconds without the stretch rate is caught', () => {
  const { e, clipId } = fitted();
  e.slipClip(clipId, 4.5);
  const start = clipOf(e, clipId).timelineStartBeat;
  const rel = 6;
  const c = clipOf(e, clipId);
  const rate = sourceAdvanceRate(c, e.state.assets[c.assetId], 96.8);
  assert.ok(Math.abs(rate - 1) > 0.05, 'the check is only meaningful when the rate is not 1');
  const { rightId } = e.splitClipAtBeat(clipId, start + rel);
  const contiguous = (a, b) => b.sourceStartFrame === a.sourceEndFrame;
  assert.ok(contiguous(planClip(e, clipId), planClip(e, rightId)), 'the real split is contiguous in source frames');
  // The naive formula: output seconds used directly as source seconds.
  const naiveRight = Math.round((4.5 + rel * (60 / 96.8)) * SR);
  const realRight = planClip(e, rightId).sourceStartFrame;
  assert.ok(Math.abs(naiveRight - realRight) > 1000, `the wrong conversion lands ${Math.abs(naiveRight - realRight)} frames away`);
  assert.equal(contiguous(planClip(e, clipId), { sourceStartFrame: naiveRight }), false, 'and the contiguity check rejects it');
});

test('fit to tempo and speed changes keep the in-point; the stretched span follows the rate', () => {
  const { e, clipId } = fitted();
  e.slipClip(clipId, 6);
  const beforeSpan = beatsToSourceSeconds(clipOf(e, clipId).durationBeats, clipOf(e, clipId), e.state.assets[clipOf(e, clipId).assetId], 96.8);
  e.stretchClipKeepingSource(clipId, 0.9);
  const c = clipOf(e, clipId);
  assert.equal(c.sourceOffsetSec, 6, 'the in-point does not move when the speed changes');
  const afterSpan = beatsToSourceSeconds(c.durationBeats, c, e.state.assets[c.assetId], 96.8);
  assert.ok(Math.abs(afterSpan - beforeSpan) < 1e-6, 'same source material, different length');
  assert.equal(planClip(e, clipId).sourceStartFrame, 6 * SR);
});

test('a saved arrangement reopens with the same in-point, gain and fades, and compiles the identical plan', () => {
  const { e, clipId } = fitted();
  e.moveClip(clipId, 4, 32);
  e.slipClip(clipId, 8.125);
  e.setClipGain(clipId, -3);
  e.setClipFades(clipId, 1, 0);
  const reopened = deserializeProject(e.serialize());
  assert.deepEqual(compileRenderPlan(reopened), compileRenderPlan(e.state));
  const p = compileRenderPlan(reopened).clips[0];
  assert.equal(p.timelineStartFrame, Math.round(32 * (60 / 96.8) * SR));
  assert.equal(p.sourceStartFrame, Math.round(8.125 * SR));
  assert.ok(Math.abs(p.clipGainLinear - 10 ** (-3 / 20)) < 1e-12);
  assert.equal(p.fadeInFrames, Math.round((60 / 96.8) * SR), 'a one-beat fade-in is one beat of frames');
});

// ------------------------------------------------------------ gain and fades

test('an edit that changes nothing adds no undo step and keeps Redo', () => {
  const { e, clipId } = fitted();
  e.setClipGain(clipId, -3);
  e.setClipGain(clipId, -4);
  e.undo();
  const depth = e.historyDepth;
  e.setClipGain(clipId, -3); // already -3
  e.slipClip(clipId, clipOf(e, clipId).sourceOffsetSec);
  assert.deepEqual(e.historyDepth, depth);
  assert.equal(e.canRedo, true, 'a no-op does not discard the redo history');
});

test('a gain or fade drag is one undo step; redo reapplies it; gain is independent of track level', () => {
  const { e, clipId } = fitted();
  const depth = e.historyDepth.past;
  for (const db of [-1, -2, -3]) e.runGesture({ name: 'setClipGain', args: { clipId, gainDb: db } }, `gain:${clipId}`);
  e.endGesture();
  assert.equal(e.historyDepth.past, depth + 1);
  assert.equal(e.state.tracks[4].volumeDb, 0, 'track level untouched');
  e.undo();
  assert.equal(clipOf(e, clipId).clipGainDb, 0);
  e.redo();
  assert.equal(clipOf(e, clipId).clipGainDb, -3);
  assert.throws(() => e.setClipFades(clipId, 100, 100), (err) => err.code === 'FADES_EXCEED_CLIP');
  assert.throws(() => e.setClipGain(clipId, 99), (err) => err.code === 'OUT_OF_RANGE');
});

// ------------------------------------------------------------------ Producer

/** Peaks for a stem with sound at 0–1.5 s, 3–4.5 s and 6–7.5 s (256-frame buckets). */
function pulsePeaks() {
  const bucketFrames = 256;
  const buckets = Math.ceil((10 * SR) / bucketFrames);
  const max = new Float32Array(buckets);
  const min = new Float32Array(buckets);
  for (let i = 0; i < buckets; i += 1) {
    const t = (i * bucketFrames) / SR;
    const on = (t % 3) < 1.5;
    max[i] = on ? 0.6 : 0.001;
    min[i] = on ? -0.6 : -0.001;
  }
  return { bucketFrames, min, max };
}

test('phraseStarts finds where sound returns after silence (a loudness heuristic)', () => {
  const starts = phraseStarts(pulsePeaks());
  assert.equal(starts.length, 4);
  assert.deepEqual(starts.slice(0, 3).map((s) => Math.round(s * 10) / 10), [0, 3, 6]);
});

test('a Producer clip idea is the same typed edits the musician would make, applied as one batch', () => {
  const e = new EditEngine();
  e.setMasterBpm(96.8);
  const { clipId } = e.loadStemToTrack(4, { ...stem(10, null) }, undefined);
  e.setClipStretch(clipId, 1);
  const hand = structuredClone(e.snapshot());
  const idea = suggestClipIdea(e.state, { clipId, startBar: 9, phrase: 2, fadeInBeats: 1, gainDb: -3 }, { peaks: pulsePeaks() });
  assert.deepEqual(idea.fields.map((f) => f.key.split(':')[1]), ['length', 'slip', 'position', 'gain', 'fades'],
    'a later in-point leaves less stem, so the idea says it shortens the clip');
  const commands = idea.fields.map((f) => f.command(e.state, f.value));
  assert.ok(commands.every((c) => ['trimClip', 'slipClip', 'moveClip', 'setClipGain', 'setClipFades'].includes(c.name)));
  const proposal = e.propose({ name: 'batch', args: { commands } });
  assert.equal(proposal.status, 'pending');
  assert.deepEqual(e.snapshot(), hand, 'proposing changes nothing');
  e.run({ name: 'batch', args: { commands } });
  const c = clipOf(e, clipId);
  assert.equal(c.timelineStartBeat, 32, 'bar 9 in 4/4');
  assert.ok(Math.abs(c.sourceOffsetSec - 3) < 0.006, 'the second phrase, to the 256-frame bucket');
  assert.equal(c.clipGainDb, -3);
  assert.equal(c.fadeInBeats, 1);
  assert.ok(c.sourceOffsetSec + beatsToSourceSeconds(c.durationBeats, c, e.state.assets[c.assetId], 96.8) <= 10 + 1e-9);
  // The same result by hand, one command at a time.
  const byHand = new EditEngine();
  byHand.setMasterBpm(96.8);
  const { clipId: hid } = byHand.loadStemToTrack(4, { ...stem(10, null) }, undefined);
  byHand.setClipStretch(hid, 1);
  for (const command of commands) byHand.run({ ...command, args: { ...command.args, clipId: hid } });
  assert.deepEqual(clipOf(byHand, hid), { ...c, id: hid });
  e.undo();
  assert.deepEqual(e.snapshot(), hand, 'one undo returns to before the idea');
});

test('a Producer clip idea names what it cannot do instead of guessing', () => {
  const e = new EditEngine();
  const { clipId } = e.loadStemToTrack(4, stem(10, null), undefined);
  assert.match(suggestClipIdea(e.state, { clipId, phrase: 9 }, { peaks: pulsePeaks() }).refusal, /no phrase 9/);
  assert.match(suggestClipIdea(e.state, { clipId: 'nope', phrase: 1 }).refusal, /not on the lanes/);
});

// ------------------------------------------------------- transport cue (Play from here)

installFakeWorkletGlobal();

test('a cue chosen before the first Play is where Play starts (a new engine parking at 0 must not reset it)', async () => {
  const calls = [];
  class ParkingEngine {
    constructor(ctx, plan, buffers, options) { this.options = options; }
    async prepare() { this.options.onParked(0); } // what the real engine does on prepare
    state() { return { phase: 'stopped', loop: null, epoch: 0 }; }
    play(frame) { calls.push(['play', frame]); }
    seek(frame) { calls.push(['seek', frame]); }
    setLoop() {}
    async replacePlan() { return { reseeked: false }; }
    dispose() {}
  }
  const s = new DawSession({
    fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }),
    decodeAudio: async () => ({ sampleRate: SR, numberOfChannels: 1, length: 10 * SR, getChannelData: () => new Float32Array(10 * SR) }),
    createContext: () => new FakeAudioContext(),
    RealtimeEngine: ParkingEngine, renderOffline: async () => { throw new Error('unused'); },
    StretchFactory: () => null, modules: {},
  });
  await s.importGroup('B', { trackId: 't', title: 'T', bpm: 96.8, section: { startSec: 0, seconds: 10 },
    stems: ['vocals', 'drums', 'bass', 'other'].map((role) => ({ role, url: `/api/stems/x/audio?name=${role}&start=0&duration=10` })) });
  s.seek(24);
  const cue = s.cueFrame;
  assert.equal(cue, Math.round(24 * (60 / 96.8) * SR));
  await s.play();
  assert.deepEqual(calls.filter((c) => c[0] === 'play'), [['play', cue]], 'Play starts at the chosen cue');
  assert.equal(s.cueBeat, 24, 'the cue is still bar 7');
});

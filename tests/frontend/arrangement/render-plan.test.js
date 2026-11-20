// tests/frontend/arrangement/render-plan.test.js — GATE 2: the pure render-plan
// compiler is deterministic, sample-accurate, read-only over ProjectState, and
// independently checkable. Negative controls: deliberately defective plans
// (wrong source offsets, ignored latency, pitch as playback speed, broken
// fades) must be caught.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIMITER_CEILING_DB,
  compileRenderPlan,
  dbToLinear,
  renderPlanEqual,
  trackAudible,
} from '../../../src/twobecomeone/studio_static/js/arrangement/render-plan.js';
import { EditEngine } from '../../../src/twobecomeone/studio_static/js/arrangement/edit-api.js';
import { checkRenderPlan } from './fixtures/plan-checker.js';

function arrangement() {
  const engine = new EditEngine();
  // beat_sync clip: 30 s measured at 60 BPM in a 120 BPM project (rate 2).
  const a = engine.loadStemToTrack(0, {
    name: 'vocals.wav', durationSec: 30, bufferReference: 'cache:vocals',
  }, 60);
  // manual clip: unmeasured BPM, ratio 1.
  const b = engine.loadStemToTrack(3, {
    name: 'drums.wav', durationSec: 20, bufferReference: 'cache:drums',
  }, null);
  engine.moveClip(b.clipId, 3, 8);
  engine.trimClip(a.clipId, 'end', -10);   // clip-1: 0..20 beats
  engine.splitClipAtBeat(a.clipId, 12);    // clip-1: 0..12, clip-3: 12..20
  engine.setClipPitch(a.clipId, 7, true);
  engine.setClipGain(b.clipId, -6);
  return { engine, a, b };
}

test('the plan compiler is deterministic and never mutates the state', () => {
  const { engine } = arrangement();
  const before = JSON.stringify(engine.state);
  const p1 = compileRenderPlan(engine.state, { tailFrames: 1024 });
  const p2 = compileRenderPlan(engine.state, { tailFrames: 1024 });
  assert.ok(renderPlanEqual(p1, p2), 'same state must compile to an identical plan');
  assert.equal(JSON.stringify(engine.state), before, 'compilation must not touch ProjectState');
});

test('plan frames match the documented conventions (independent checker)', () => {
  const { engine } = arrangement();
  const plan = compileRenderPlan(engine.state);
  assert.deepEqual(checkRenderPlan(engine.state, plan), { ok: true, mismatches: [] });
});

test('latency compensation shifts every clip placement, nothing else', () => {
  const { engine } = arrangement();
  const zero = compileRenderPlan(engine.state, { latencyCompensationFrames: 0 });
  const shifted = compileRenderPlan(engine.state, { latencyCompensationFrames: 480 });
  for (const [i, clip] of shifted.clips.entries()) {
    assert.equal(clip.timelineStartFrame, zero.clips[i].timelineStartFrame + 480);
    assert.equal(clip.sourceStartFrame, zero.clips[i].sourceStartFrame, 'source side is untouched');
    assert.equal(clip.timelineDurationFrames, zero.clips[i].timelineDurationFrames);
  }
  assert.equal(shifted.output.arrangementEndFrame, zero.output.arrangementEndFrame + 480);
  assert.deepEqual(checkRenderPlan(engine.state, shifted, { latencyCompensationFrames: 480 }),
    { ok: true, mismatches: [] });
});

test('sample-accurate clip placement and source ranges', () => {
  const { engine } = arrangement();
  const plan = compileRenderPlan(engine.state);
  const right = plan.clips.find((c) => c.clipId === 'clip-3'); // split child at beat 12
  // masterBpm 120: 12 beats = 6 s = 288000 frames at 48 kHz.
  assert.equal(right.timelineStartFrame, 12 * 0.5 * 48000);
  // beat_sync rate 2: 12 beats = 6 output s consume 12 source s from offset 0.
  assert.equal(right.sourceStartFrame, 12 * 48000);
  assert.equal(right.timelineDurationFrames, right.sourceSpanFrames / right.rate);
});

test('pitch is a frequency factor, never a playback-speed change', () => {
  const { engine, a } = arrangement();
  const plan = compileRenderPlan(engine.state);
  const clip = plan.clips.find((c) => c.clipId === a.clipId);
  assert.equal(clip.pitchSemitones, 7);
  assert.ok(Math.abs(clip.pitchFactor - 2 ** (7 / 12)) < 1e-12);
  assert.equal(clip.rate, 2, 'the stretch rate is the tempo mapping, not the pitch');
});

test('mute/solo law matches the accepted desk and lands in the plan', () => {
  const { engine } = arrangement();
  engine.setTrackMute(0, true);
  let plan = compileRenderPlan(engine.state);
  assert.equal(plan.tracks[0].audible, false);
  assert.equal(plan.tracks[3].audible, true);
  engine.setTrackSolo(5, true);
  plan = compileRenderPlan(engine.state);
  assert.equal(plan.anySolo, true);
  assert.equal(plan.tracks[0].audible, false, 'mute plus non-solo stays silent');
  assert.equal(plan.tracks[3].audible, false, 'a solo elsewhere silences this track');
  assert.equal(plan.tracks[5].audible, true);
  // The law itself, pinned.
  assert.equal(trackAudible({ solo: false, mute: true }, true), false);
  assert.equal(trackAudible({ solo: true, mute: true }, true), true);
});

test('clip gain and fades are expressed in frames and linear gain', () => {
  const { engine, b } = arrangement();
  const plan = compileRenderPlan(engine.state);
  const clip = plan.clips.find((c) => c.clipId === b.clipId);
  assert.equal(clip.clipGainDb, -6);
  assert.ok(Math.abs(clip.clipGainLinear - dbToLinear(-6)) < 1e-12);
  assert.equal(clip.fadeInFrames, Math.round(0.015 * 0.5 * 48000)); // 0.015 beats at 120 BPM
  assert.equal(clip.fadeOutFrames, clip.fadeInFrames);
});

test('master, limiter and output envelopes are explicit', () => {
  const { engine } = arrangement();
  const plan = compileRenderPlan(engine.state, { tailFrames: 4096 });
  assert.equal(plan.limiter.type, 'lookahead-brickwall');
  assert.equal(plan.limiter.ceilingDb, LIMITER_CEILING_DB);
  assert.equal(plan.limiter.truePeakClaimed, false, 'true-peak must never be claimed unmeasured');
  assert.ok(Math.abs(plan.limiter.ceilingLinear - dbToLinear(-0.3)) < 1e-12);
  assert.equal(plan.output.channels, 2);
  assert.equal(plan.output.totalFrames, plan.output.arrangementEndFrame + 4096);
  assert.equal(plan.dsp.tailFrames, 4096);
});

test('invalid state cannot produce a plan', () => {
  const { engine } = arrangement();
  const broken = JSON.parse(JSON.stringify(engine.state));
  broken.clips[0].durationBeats = 100000;
  assert.throws(() => compileRenderPlan(broken), RangeError);
  assert.throws(() => compileRenderPlan(engine.state, { latencyCompensationFrames: -1 }), RangeError);
});

test('adjacent regions share boundary frames exactly (Sol B2 regression)', () => {
  // Off-grid trims and splits used to round start and duration independently,
  // letting split children overlap by one frame.
  const engine = new EditEngine();
  const { clipId } = engine.loadStemToTrack(0, {
    name: 'a.wav', durationSec: 4, bufferReference: 'r:a',
  }, null); // manual ratio 1, 8 beats at 120 BPM
  engine.trimClip(clipId, 'start', 0.100025);
  const { rightId } = engine.splitClipAtBeat(clipId, 0.20005);
  const plan = compileRenderPlan(engine.state);
  const left = plan.clips.find((c) => c.clipId === clipId);
  const right = plan.clips.find((c) => c.clipId === rightId);
  assert.equal(left.timelineEndFrame, right.timelineStartFrame,
    'timeline children must abut without overlap or gap');
  assert.equal(left.sourceEndFrame, right.sourceStartFrame,
    'source children must abut without overlap or gap');
  assert.equal(left.timelineEndFrame - left.timelineStartFrame, left.timelineDurationFrames);
});

// ---------- negative controls (GATE 4 mandate) ----------

test('negative control: wrong source-offset math is caught', () => {
  const { engine } = arrangement();
  const plan = compileRenderPlan(engine.state);
  // Classic defect: split offsets computed without the stretch rate.
  const defective = JSON.parse(JSON.stringify(plan));
  defective.clips[1].sourceStartFrame += 5 * 48000;
  assert.equal(checkRenderPlan(engine.state, defective).ok, false);
});

test('negative control: ignored latency compensation is caught', () => {
  const { engine } = arrangement();
  const plan = compileRenderPlan(engine.state, { latencyCompensationFrames: 480 });
  const defective = JSON.parse(JSON.stringify(plan));
  defective.clips.forEach((c) => { c.timelineStartFrame -= 480; });
  assert.equal(checkRenderPlan(engine.state, defective, { latencyCompensationFrames: 480 }).ok, false);
});

test('negative control: pitch applied as playback speed is caught', () => {
  const { engine } = arrangement();
  const plan = compileRenderPlan(engine.state);
  const defective = JSON.parse(JSON.stringify(plan));
  // Classic defect: transposing by changing the rate (duration then changes).
  const victim = defective.clips.find((c) => c.pitchSemitones === 7);
  victim.rate = victim.rate * victim.pitchFactor;
  victim.pitchFactor = 1;
  assert.equal(checkRenderPlan(engine.state, defective).ok, false);
});

test('negative control: broken clip fades are caught', () => {
  const { engine } = arrangement();
  const plan = compileRenderPlan(engine.state);
  const defective = JSON.parse(JSON.stringify(plan));
  defective.clips[0].fadeInFrames = -1;
  assert.equal(checkRenderPlan(engine.state, defective).ok, false);
});

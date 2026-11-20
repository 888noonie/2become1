// tests/frontend/arrangement/voice-scheduler.test.js — GATE 3 / Gate 8 T3.
//
// Exact source-frame selection (including frame zero and source end) against an
// independent formula written here with NO engine imports; the wrong-stretch-rate
// negative control; occurrence planning over loop passes; and the verified
// Signalsmith scheduling rule (a second future schedule() discards a pending
// future arm, while the legal arm-then-one-stop sequence does not).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sourceFrameAt,
  sourceFrameAtWrongRate,
  occurrencesInWindow,
  signalsmithScheduleSequence,
  SignalsmithTimeMapModel,
} from '../../../src/twobecomeone/studio_static/js/arrangement/voice-scheduler.js';
import { clipNeedsDsp } from '../../../src/twobecomeone/studio_static/js/arrangement/time-math.js';
import { createTransportMap } from '../../../src/twobecomeone/studio_static/js/arrangement/transport.js';

// A deterministic PRNG so the seeded sweep is reproducible (Gate 8: "200 seeded").
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mkClip(over = {}) {
  const timelineStartFrame = over.timelineStartFrame ?? 0;
  const timelineDurationFrames = over.timelineDurationFrames ?? 48000;
  const rate = over.rate ?? 1;
  const sourceSpanFrames = over.sourceSpanFrames ?? Math.round(timelineDurationFrames * rate);
  const sourceStartFrame = over.sourceStartFrame ?? 0;
  return {
    clipId: over.clipId ?? 'clip-1',
    assetId: over.assetId ?? 'asset-1',
    trackIndex: over.trackIndex ?? 0,
    bufferReference: over.bufferReference ?? 'synth:x',
    timelineStartFrame,
    timelineDurationFrames,
    timelineEndFrame: timelineStartFrame + timelineDurationFrames,
    sourceStartFrame,
    sourceSpanFrames,
    sourceEndFrame: sourceStartFrame + sourceSpanFrames,
    rate,
    pitchSemitones: over.pitchSemitones ?? 0,
    preserveFormants: over.preserveFormants ?? false,
    clipGainLinear: 1,
    fadeInFrames: over.fadeInFrames ?? 360,
    fadeOutFrames: over.fadeOutFrames ?? 360,
  };
}

function mkPlan(clips) {
  const arrangementEndFrame = Math.max(...clips.map((c) => c.timelineEndFrame));
  return { clips, output: { arrangementEndFrame, channels: 2, totalFrames: arrangementEndFrame } };
}

test('T3: exact source-frame selection across rates and 200 seeded positions', () => {
  const rates = [1, 0.857, 1.2, 2];
  for (const rate of rates) {
    const clip = mkClip({
      timelineStartFrame: 24000,
      timelineDurationFrames: 48000,
      sourceStartFrame: 1000,
      sourceSpanFrames: Math.round(48000 * rate),
      rate,
    });
    // Independent formula checker (no engine import): the Milestone A convention.
    const expected = (f) => {
      const raw = clip.sourceStartFrame + Math.round((f - clip.timelineStartFrame) * rate);
      return Math.max(clip.sourceStartFrame, Math.min(clip.sourceEndFrame, raw));
    };
    const rnd = mulberry32(0xC10C + Math.round(rate * 1000));
    // 200 seeded positions: edges, frame zero, source end, past the end, interior.
    const positions = [
      clip.timelineStartFrame, clip.timelineEndFrame, 0,
      clip.timelineEndFrame + 48000,
    ];
    while (positions.length < 200) {
      positions.push(clip.timelineStartFrame + Math.floor(rnd() * (clip.timelineDurationFrames + 1)));
    }
    for (const f of positions) {
      assert.equal(sourceFrameAt(clip, f), expected(f), `rate ${rate} at f=${f}`);
    }
    // Frame zero of the clip selects the source start exactly (source end too).
    assert.equal(sourceFrameAt(clip, clip.timelineStartFrame), clip.sourceStartFrame);
    assert.equal(sourceFrameAt(clip, clip.timelineEndFrame), clip.sourceEndFrame);
  }
});

test('T3: the wrong-stretch-rate negative control DISAGREES (fails) for rate != 1', () => {
  for (const rate of [0.857, 1.2, 2]) {
    const clip = mkClip({
      timelineStartFrame: 0,
      timelineDurationFrames: 48000,
      sourceStartFrame: 0,
      sourceSpanFrames: Math.round(48000 * rate),
      rate,
    });
    let disagree = 0;
    for (let f = 0; f <= clip.timelineEndFrame; f += 480) {
      if (sourceFrameAtWrongRate(clip, f) !== sourceFrameAt(clip, f)) disagree += 1;
    }
    assert.ok(disagree > 0, `the timeline-rate formula must fail to match at rate ${rate}`);
  }
  // At rate 1 the two agree (the NC is only wrong when stretching).
  const unity = mkClip({ timelineDurationFrames: 48000, rate: 1, sourceSpanFrames: 48000 });
  assert.equal(sourceFrameAtWrongRate(unity, 24000), sourceFrameAt(unity, 24000));
});

test('T3: the shared bypass predicate is the single decision (rate 1 & 0 semitones)', () => {
  assert.equal(clipNeedsDsp(1, 0), false, 'rate 1, 0 st bypasses the DSP');
  assert.equal(clipNeedsDsp(0.857, 0), true);
  assert.equal(clipNeedsDsp(1, 7), true, 'pitch keeps the clip in the DSP');
  assert.equal(clipNeedsDsp(1.2, 0), true);
  assert.equal(clipNeedsDsp(0.9999, 0), true, 'anything not exactly 1 stays in the DSP');
});

test('T3: occurrences cover a clip exactly across loop passes with correct source', () => {
  const a = 48000; const b = 144000;
  // A clip spanning the whole loop, rate 1 for easy source math.
  const clip = mkClip({ clipId: 'c', timelineStartFrame: 0, timelineDurationFrames: 144000, rate: 1, sourceSpanFrames: 144000 });
  const plan = mkPlan([clip]);
  const map = createTransportMap({ startFrame: a, loop: [a, b] });
  // Window covering passes 0..3.
  const occs = occurrencesInWindow(plan, map, 0, 4 * (b - a) + 10);
  assert.ok(occs.length >= 4, `expected one occurrence per pass, got ${occs.length}`);
  for (const occ of occs) {
    // source at the occurrence start matches the exact formula.
    assert.equal(occ.sourceStart, sourceFrameAt(clip, occ.outStart));
    assert.equal(occ.sourceEnd, sourceFrameAt(clip, occ.outEnd));
    assert.equal(occ.outLenFrames, occ.outEnd - occ.outStart);
    assert.equal(occ.needsDsp, false, 'rate 1, 0 st is a bypass occurrence');
    // The playback window length equals the output length (1:1 at rate 1).
    assert.equal(occ.ctxEnd - occ.ctxStart, occ.outLenFrames);
  }
});

test('GATE 3: two future schedule() calls LOSE the pending arm (the hazard)', () => {
  const tm = new SignalsmithTimeMapModel(0);
  // Arm in the FUTURE (output 0.5) then a future stop (output 1.0) — both with
  // `output`, exactly as a naive scheduler would queue two clip transitions.
  tm.schedule({ active: true, input: 0, output: 0.5, rate: 1 });
  const armAt = tm.timeMap.length;
  assert.equal(armAt, 1, 'one pending segment after the arm');
  tm.schedule({ active: false, output: 1.0 });
  // The stop's pop anchors at currentTime (0) and discards the future arm.
  const hasArm = tm.timeMap.some((s) => s.active === true && Math.abs(s.output - 0.5) < 1e-9);
  assert.equal(hasArm, false, 'the pending future arm was discarded by the second future call');
  assert.equal(tm.pendingFuture().length, 1, 'only the stop remains pending');
});

test('GATE 3: the legal arm-then-one-stop sequence PRESERVES the arm', () => {
  const tm = new SignalsmithTimeMapModel(0);
  // Arm at-or-before current processing time (output -0.001 <= now) …
  tm.schedule({ active: true, input: 0, output: -0.001, rate: 1 });
  const arm = tm.timeMap[tm.timeMap.length - 1];
  // … then advance the clock and issue exactly ONE future stop.
  tm.advance(0.1);
  tm.schedule({ active: false, output: 1.0 });
  const hasArm = tm.timeMap.some((s) => s === arm);
  assert.equal(hasArm, true, 'the arm at/before now is not discarded by the one future stop');
  // The arm still sounds between now and the stop.
  const seg = tm.segmentAt(0.5);
  assert.equal(seg.active, true, 'the arm is the active segment at t=0.5');
  const after = tm.segmentAt(1.5);
  assert.equal(after.active, false, 'the stop deactivates at its output time');
});

test('GATE 3: signalsmithScheduleSequence emits the legal arm<=now < stop shape', () => {
  const occ = {
    ctxStart: 48000, ctxEnd: 96000,
    sourceStart: 1000, sourceEnd: 49000,
    rate: 1, semitones: 0, preserveFormants: false,
  };
  const sampleRate = 48000;
  const nowSec = 48000 / sampleRate + 0.05; // 50 ms after the occurrence start
  const seq = signalsmithScheduleSequence(occ, { nowSec, sampleRate, armLeadSec: 0.002 });
  assert.ok(seq.arm.output <= nowSec, 'the arm is placed at or before the current time');
  assert.ok(seq.stop.output > nowSec, 'the stop is the single future call');
  assert.equal(seq.arm.active, true);
  assert.equal(seq.stop.active, false);
  assert.equal(seq.arm.rate, 1);
  // Feeding this exact sequence into the time-map model keeps the arm.
  const tm = new SignalsmithTimeMapModel(nowSec);
  tm.schedule(seq.arm);
  const arm = tm.timeMap[tm.timeMap.length - 1];
  tm.schedule(seq.stop);
  assert.ok(tm.timeMap.includes(arm), 'the legal sequence does not lose the arm');
});

test('Golden Ear II: originSec places the legal pair on the context clock (no offset/clock mixing)', () => {
  const SR = 48000;
  const occ = { ctxStart: 0, ctxEnd: SR, sourceStart: 0, rate: 1.2, semitones: 0, preserveFormants: false };
  const originSec = 7.5; // the voice's t0 on the device clock
  const nowSec = 7.4; // 100 ms of lead
  const { arm, stop } = signalsmithScheduleSequence(occ, { nowSec, sampleRate: SR, originSec });
  assert.ok(arm.output < nowSec, 'arm strictly before now');
  assert.ok(Math.abs(stop.output - (originSec + 1)) < 1e-12, 'stop at the context-time end');
  // At t0 the compensated arm reads exactly source frame 0 (input seconds).
  const inputAtT0 = arm.input + (originSec - arm.output) * arm.rate;
  assert.ok(Math.abs(inputAtT0) < 1e-12, `input at t0 = ${inputAtT0}`);
  // Against the faithful pop model, the stop never discards the arm.
  const m = new SignalsmithTimeMapModel(nowSec);
  m.schedule(arm);
  m.schedule(stop);
  assert.equal(m.segmentAt(originSec).active, true);
  assert.equal(m.segmentAt(originSec + 1).active, false);
});

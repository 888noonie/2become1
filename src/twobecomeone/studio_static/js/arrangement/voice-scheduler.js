// js/arrangement/voice-scheduler.js — pure occurrence planning and source math.
//
// OPERATION CLOCKWORK, Milestone C1, GATE 3. Turns a render plan and a
// TransportMap into *occurrences*: (clip, pass, output window, source frame at
// the window start, end, gates). Pure and testable in Node with a fake clock.
// No AudioContext, no Signalsmith node, no DOM.
//
// Signalsmith occurrence scheduling rule (verified in the vendored wrapper,
// SignalsmithStretch.mjs:91-94): every schedule() call pops all pending future
// segments before pushing the new one, so a SECOND future call discards a
// pending future arm. The LEGAL sequence for one voice is therefore:
//
//     ARM  : schedule({active:true, input:<compensated>, output:<= now, ...})
//     STOP : schedule({active:false, output: tEnd })     // at most ONE future
//
// The arm is placed at or before the current processing time with a correctly
// compensated source position (it extrapolates forward by rate), so the later
// stop cannot pop it. Two future calls (arm in the future then a stop) DO lose
// the arm — proven in the tests against a faithful model of the pop rule.
//
// Exact source-frame selection (Milestone A convention, Gate 8 T3): the source
// frame playing at timeline frame f within a clip is
//
//     sourceFrameAt(f) = clip.sourceStartFrame + round((f - timelineStartFrame) * rate)
//
// where rate is the SOURCE-ADVANCE rate (source frames per output frame). Using
// the timeline rate (1/rate) instead is the negative control that must fail.

import { clipNeedsDsp } from './time-math.js';

/**
 * Source frame at a timeline frame `f` for a plan clip. Clamped to the clip's
 * source span so frame-zero and source-end selection are exact and never read
 * outside the region. `rate` is the source-advance rate (source/out).
 */
export function sourceFrameAt(clip, f) {
  const raw = clip.sourceStartFrame + Math.round((f - clip.timelineStartFrame) * clip.rate);
  const lo = clip.sourceStartFrame;
  const hi = clip.sourceEndFrame;
  return raw < lo ? lo : raw > hi ? hi : raw;
}

/**
 * The NEGATIVE-control variant: advances the source by the TIMELINE rate
 * (1/rate) instead of the source-advance rate. This is deliberately wrong and
 * exists so Gate 8 can prove the correct formula is what makes source selection
 * exact. It must NOT agree with sourceFrameAt except at rate 1.
 */
export function sourceFrameAtWrongRate(clip, f) {
  const timelineRate = 1 / clip.rate;
  const raw = clip.sourceStartFrame + Math.round((f - clip.timelineStartFrame) * timelineRate);
  const lo = clip.sourceStartFrame;
  const hi = clip.sourceEndFrame;
  return raw < lo ? lo : raw > hi ? hi : raw;
}

/**
 * Build the pass segment boundaries for a TransportMap in TRANSPORT frames.
 * Returns an iterator-like list of { pass, segStart, segEnd } clipped to
 * [0, arrangementEndFrame]. Pass 0 is the first segment [startFrame, b); pass
 * k>=1 is the k-th [a, b) repeat. With no loop there is a single open segment.
 */
function passSegments(map, arrangementEndFrame, minPass, maxPass) {
  const segs = [];
  const end = arrangementEndFrame;
  if (!map.hasLoop) {
    segs.push({ pass: 0, segStart: map.startFrame, segEnd: Math.max(map.startFrame, end) });
    return segs;
  }
  const a = map.loopStart;
  const b = map.loopEnd;
  // pass 0: [startFrame, b)
  if (0 >= minPass && 0 <= maxPass) {
    segs.push({ pass: 0, segStart: map.startFrame, segEnd: Math.min(b, end) });
  }
  for (let p = Math.max(1, minPass); p <= maxPass; p += 1) {
    segs.push({ pass: p, segStart: a, segEnd: Math.min(b, end) });
  }
  return segs;
}

/**
 * Occurrences of every clip inside a playback window [ctxFrom, ctxTo).
 *
 * An occurrence is a maximal run of one clip on one loop pass whose output
 * overlaps the window. Fields (all integer frames unless noted):
 *   clipId, trackIndex, pass
 *   ctxStart, ctxEnd        playback-line frames (context clock, epoch-relative)
 *   outStart, outEnd        transport frames, half-open [outStart, outEnd)
 *   sourceStart, sourceEnd  source frames at outStart / outEnd (exact)
 *   rate, semitones, needsDsp
 *   outLenFrames, sourceLenFrames
 *
 * @param {object} plan from compileRenderPlan
 * @param {object} map from createTransportMap
 * @param {number} ctxFrom inclusive playback start
 * @param {number} ctxTo exclusive playback end
 * @param {{minPass?: number, maxPass?: number}} options pass bounds (defaults
 *   derive from the window so a loop yields the passes that overlap it)
 */
export function occurrencesInWindow(plan, map, ctxFrom, ctxTo, options = {}) {
  const arrangementEndFrame = plan.output.arrangementEndFrame;
  // Pass bounds: without a loop there is one pass. With a loop, derive the range
  // of passes whose ctx span intersects [ctxFrom, ctxTo).
  let minPass = options.minPass;
  let maxPass = options.maxPass;
  if (!map.hasLoop) {
    minPass = 0; maxPass = 0;
  } else {
    const L = map.loopLength;
    if (minPass === undefined) minPass = Math.max(0, Math.floor((ctxFrom - map.firstSegmentLength) / L) - 1);
    if (maxPass === undefined) maxPass = Math.max(0, Math.ceil((ctxTo - map.firstSegmentLength) / L) + 1);
  }

  const segs = passSegments(map, arrangementEndFrame, minPass, maxPass);
  const occurrences = [];
  for (const clip of plan.clips) {
    for (const seg of segs) {
      const oStart = Math.max(clip.timelineStartFrame, seg.segStart);
      const oEnd = Math.min(clip.timelineEndFrame, seg.segEnd);
      if (oEnd <= oStart) continue;
      const ctxStart = map.toCtx(oStart, seg.pass);
      const ctxEnd = ctxStart + (oEnd - oStart); // half-open; avoids the loop-end boundary
      if (ctxEnd <= ctxFrom || ctxStart >= ctxTo) continue;
      occurrences.push({
        clipId: clip.clipId,
        assetId: clip.assetId,
        trackIndex: clip.trackIndex,
        bufferReference: clip.bufferReference,
        pass: seg.pass,
        ctxStart,
        ctxEnd,
        outStart: oStart,
        outEnd: oEnd,
        outLenFrames: oEnd - oStart,
        sourceStart: sourceFrameAt(clip, oStart),
        sourceEnd: sourceFrameAt(clip, oEnd),
        rate: clip.rate,
        semitones: clip.pitchSemitones,
        preserveFormants: clip.preserveFormants,
        needsDsp: clipNeedsDsp(clip.rate, clip.pitchSemitones),
        clipGainLinear: clip.clipGainLinear,
        fadeInFrames: clip.fadeInFrames,
        fadeOutFrames: clip.fadeOutFrames,
        timelineStartFrame: clip.timelineStartFrame,
        timelineEndFrame: clip.timelineEndFrame,
      });
    }
  }
  // Deterministic order: playback position, then track, then clip id.
  occurrences.sort((x, y) => (x.ctxStart - y.ctxStart)
    || (x.trackIndex - y.trackIndex)
    || (x.clipId < y.clipId ? -1 : x.clipId > y.clipId ? 1 : 0));
  return occurrences;
}

/**
 * The LEGAL Signalsmith schedule sequence for one occurrence/voice (Gate 3).
 *
 * Returns { arm, stop } call descriptors (to be sent through the node's
 * schedule()) such that the arm is never discarded by the stop:
 *
 *   arm  = { active:true, input:<source SEC at arm>, output: < nowSec, rate, semitones }
 *   stop = { active:false, output: occEndSec }
 *
 * `nowSec` is the current processing time; the arm is placed STRICTLY before it
 * (nowSec - armLeadSec, armLeadSec > 0) with the source position compensated
 * BACKWARD by rate. The wrapper pops segments with `output >= anchor`, so an arm
 * at output == nowSec WOULD be discarded by a later stop; the strict lead
 * (arm.output < nowSec) is required and is the default here.
 */
export function signalsmithScheduleSequence(occ, { nowSec, sampleRate, armLeadSec = 0.002 } = {}) {
  const spf = 1 / sampleRate;
  const occStartSec = occ.ctxStart * spf;
  const occEndSec = occ.ctxEnd * spf;
  const armOutputSec = nowSec - Math.max(armLeadSec, 1e-6); // STRICTLY < nowSec (the pop drops output >= anchor)
  // Source position at the arm's output time, extrapolated from the occurrence's
  // source start at its ctx start (rate = source frames per output frame).
  const framesSinceOccStart = (armOutputSec - occStartSec) * sampleRate;
  const armInputFrame = occ.sourceStart + framesSinceOccStart * occ.rate;
  return {
    arm: {
      active: true,
      input: armInputFrame / sampleRate, // SECONDS (the wrapper's unit), not frames
      output: armOutputSec,
      rate: occ.rate,
      semitones: occ.semitones,
      formantCompensation: occ.preserveFormants,
      formantBaseHz: 0,
    },
    stop: { active: false, output: occEndSec },
  };
}

/**
 * A faithful model of the vendored Signalsmith timeMap pop rule
 * (SignalsmithStretch.mjs:91-94), used to PROVE the scheduling behaviour in
 * Node without a WASM instance. It reproduces exactly how a schedule() call
 * discards pending future segments:
 *
 *     while (timeMap.length && timeMap[last].output >= outputTime) pop();
 *     push(newSegment)
 *
 * where `outputTime` is `objIn.outputTime` if present, else the context
 * `currentTime`. NOTE the vendored wrapper reads `objIn.outputTime` for the pop
 * but stores `objIn.output` on the segment; calls that pass `output` (as the
 * renderer does) therefore anchor the pop at `currentTime`. This model mirrors
 * that faithfully so the tests prove the real behaviour.
 */
export class SignalsmithTimeMapModel {
  constructor(currentTime = 0) {
    this.currentTime = currentTime;
    this.timeMap = [{ active: false, input: 0, output: 0, rate: 0 }];
  }

  schedule(objIn) {
    const outputTime = ('outputTime' in objIn) ? objIn.outputTime : this.currentTime;
    while (this.timeMap.length && this.timeMap[this.timeMap.length - 1].output >= outputTime) {
      this.timeMap.pop();
    }
    // NOTE (review finding 7): the wrapper extrapolates from the LAST POPPED
    // segment; this model uses the topmost SURVIVING one. The pop CONDITION is
    // mirrored exactly (the pass/fail outcomes below hold either way) but the
    // extrapolated `input` of a pushed segment may differ. Guard `latest` so the
    // model stays total even when the pop empties the map.
    const latest = this.timeMap[this.timeMap.length - 1]
      ?? { active: false, input: 0, output: outputTime, rate: 0 };
    const obj = Object.assign({}, latest, { input: null, output: outputTime }, objIn);
    if (obj.input === null) {
      const rate = latest.active ? latest.rate : 0;
      obj.input = latest.input + (obj.output - latest.output) * rate;
    }
    this.timeMap.push(obj);
    return obj;
  }

  /** Advance the processing clock (stand-in for the audio thread's passing time). */
  advance(sec) { this.currentTime += sec; }

  /** Pending future segments (output > currentTime) — what a new call can discard. */
  pendingFuture() { return this.timeMap.filter((s) => s.output > this.currentTime); }

  /** The segment that would sound at `t`. */
  segmentAt(t) {
    let cur = this.timeMap[0];
    for (const s of this.timeMap) {
      if (s.output <= t) cur = s; else break;
    }
    return cur;
  }
}

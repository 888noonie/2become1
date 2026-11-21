// js/arrangement/automation.js — track gain automation on the audio clock.
//
// OPERATION THE ORCHESTRA. Points live on the track, in beats. Slip, stretch,
// source offset, and moving a clip do not move them. The heard curve is linear
// in amplitude: db is an offset from volumeDb, clamped, then converted, and
// the span between two points lerps those linear values. gainLinearAtBeat is
// the musical curve and ignores mute. Mute and solo are applied by the
// scheduler (0 for the whole future when the track is not audible).
//
// One GainNode per track, the node buildBackbone already builds. Loop wraps
// crossfade the voice gates over LOOP_XFADE_FRAMES (120 samples, 2.5 ms at
// 48 kHz) and both voices share this gain, so a seam step is heard through
// that crossfade. A second gain node is not added.
//
// The live window is 120 s or 8 loop passes, whichever comes first. That is
// not RealtimeEngine.horizonFrames (the ~104 ms start lead that lets stretch
// voices prime). The engine's wake loop may append later AudioParam events
// past this window. An append must not write the gain at `now`: no
// cancelScheduledValues of the sounding value, and no setValueAtTime of it.
// Offline scheduling ignores plan.loopRange and does not shift events by the
// limiter lookahead. The limiter trims its own delay so arrangement frame 0
// stays sample 0.

import { MAX_VOLUME_DB, MIN_VOLUME_DB } from './project-state.js';
import { dbToLinear } from './render-plan.js';

export const AUTOMATION_HORIZON_SEC = 120;
export const AUTOMATION_HORIZON_PASSES = 8;

export function absoluteGainDb(track, point) {
  const db = (track?.volumeDb ?? 0) + point.db;
  return Math.min(MAX_VOLUME_DB, Math.max(MIN_VOLUME_DB, db));
}

function pointList(points) {
  return Array.isArray(points) ? points : [];
}

function orderedPoints(points) {
  return points.map((point, index) => ({ point, index }))
    .sort((a, b) => (a.point.beat - b.point.beat) || (a.index - b.index))
    .map((row) => row.point);
}

function sampleCurve(points, beat, valueOf) {
  const ordered = orderedPoints(points);
  if (beat < ordered[0].beat) return valueOf(ordered[0]);
  let last = 0;
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].beat <= beat) last = i;
    else break;
  }
  const here = ordered[last];
  if (here.beat === beat || last === ordered.length - 1) return valueOf(here);
  const next = ordered[last + 1];
  const span = next.beat - here.beat;
  if (!(span > 0)) return valueOf(next);
  const t = (beat - here.beat) / span;
  const a = valueOf(here);
  const b = valueOf(next);
  return a + t * (b - a);
}

/** Constant pan when there are no points. Points replace track.pan; they are not added to it. */
export function panAtBeat(track, beat) {
  const points = pointList(track?.panPoints);
  if (!points.length) return track?.pan ?? 0;
  return sampleCurve(points, beat, (point) => point.pan);
}

/** Musical linear gain at `beat`. Mute is ignored. No points: the fader. */
export function gainLinearAtBeat(track, beat) {
  const points = pointList(track?.gainPoints);
  if (!points.length) return dbToLinear(track?.volumeDb ?? 0);
  return sampleCurve(points, beat, (point) => dbToLinear(absoluteGainDb(track, point)));
}

/**
 * Defective control: lerp absolute dB, then convert. The midpoint of −60 dB
 * and 0 dB is about −30 dB, not the amplitude midpoint. The renderer must
 * not follow this.
 */
export function gainLinearAtBeatDbLerp(track, beat) {
  const points = pointList(track?.gainPoints);
  if (!points.length) return dbToLinear(track?.volumeDb ?? 0);
  const db = sampleCurve(points, beat, (point) => absoluteGainDb(track, point));
  return dbToLinear(db);
}

function frameToBeat(frame, sampleRate, bpm) {
  return (frame / sampleRate) * (bpm / 60);
}

function beatToFrame(beat, sampleRate, bpm) {
  return Math.round(beat * (60 / bpm) * sampleRate);
}

/** Beat heard at context time `t` through this epoch's origin and map. */
export function beatAtContextTime(t, { originSec, map, sampleRate, bpm }) {
  if (!(t > originSec)) return frameToBeat(map.startFrame, sampleRate, bpm);
  const d = Math.max(0, Math.round((t - originSec) * sampleRate));
  return frameToBeat(map.toTransport(d).frame, sampleRate, bpm);
}

function groupsOf(points) {
  const groups = [];
  for (const point of orderedPoints(points)) {
    const group = groups[groups.length - 1];
    if (group && group.beat === point.beat) group.items.push(point);
    else groups.push({ beat: point.beat, items: [point] });
  }
  return groups;
}

/**
 * Write the curve onto `param`. `valueAtBeat(beat)` is the parameter value.
 * `linOf(point)` is one breakpoint's value (the first of a shared beat is the
 * ramp target; the later point is a set). Returns the context time up to
 * which events were written. Infinity means nothing further is due.
 */
function writeCurve(param, points, valueAtBeat, linOf, options) {
  const {
    originSec, map, sampleRate, bpm,
    now = originSec,
    append = false,
    appendFromSec = null,
    fullTimeline = false,
    horizonSec = AUTOMATION_HORIZON_SEC,
  } = options;
  const sample = 1 / sampleRate;
  const horizonEnd = fullTimeline || !map.hasLoop ? Infinity : now + horizonSec;
  const passLimit = fullTimeline || !map.hasLoop ? 1 : AUTOMATION_HORIZON_PASSES;
  const after = append ? Math.max(appendFromSec - 1e-8, now + sample) : now;

  const emitRamp = (value, time, state) => {
    if (!(time > state.lastT + 0.5 * sample)) return state;
    if (Math.abs(value - state.lastV) < 1e-12) return state;
    param.linearRampToValueAtTime(value, time);
    return { lastT: time, lastV: value };
  };
  const emitSet = (value, time, state) => {
    if (append && !(time > now + 0.5 * sample)) return state;
    if (time < after - 1e-8 && append) return state;
    param.setValueAtTime(value, time);
    return { lastT: time, lastV: value };
  };

  let state = { lastT: append ? appendFromSec : now, lastV: valueAtBeat(beatAtContextTime(now, options)) };

  const timeOfFrame = (frame, pass) => {
    if (pass > 0 && (frame < map.loopStart || frame >= map.loopEnd)) return null;
    if (pass === 0 && frame < map.startFrame) return null;
    return originSec + map.toCtx(frame, pass) / sampleRate;
  };
  const timeOf = (beat, pass) => timeOfFrame(beatToFrame(beat, sampleRate, bpm), pass);

  const writeGroup = (group, time, passState) => {
    if (!(time >= after - 1e-8) || (append && !(time > now + 0.5 * sample))) return passState;
    const first = linOf(group.items[0]);
    const last = linOf(group.items[group.items.length - 1]);
    let next = emitRamp(first, time, passState);
    if (group.items.length > 1) next = emitSet(last, time, next);
    else if (!(time > passState.lastT + 0.5 * sample)) next = emitSet(first, time, next);
    return next;
  };

  if (!map.hasLoop) {
    for (const group of groupsOf(points)) {
      const time = timeOf(group.beat, 0);
      if (time == null || time <= now + 1e-9) continue;
      state = writeGroup(group, time, state);
    }
    return Infinity;
  }

  let startPass = 0;
  const cursor = append ? appendFromSec : now;
  if (cursor > originSec) {
    const d = Math.max(0, Math.round((cursor - originSec) * sampleRate));
    startPass = map.toTransport(Math.min(d, Number.MAX_SAFE_INTEGER)).pass;
  }
  const loopStartBeat = frameToBeat(map.loopStart, sampleRate, bpm);
  let boundary = now;
  let scheduledPasses = 0;

  for (let n = 0; n < passLimit; n += 1) {
    const pass = startPass + n;
    const seam = originSec + map.passStartCtx(pass) / sampleRate;
    const passEnd = originSec + map.passStartCtx(pass + 1) / sampleRate;
    if (n > 0 && seam >= horizonEnd - 1e-9) break;
    scheduledPasses += 1;
    boundary = Math.min(passEnd, horizonEnd);

    if (n > 0 || (append && seam >= after - 1e-8 && seam > now + 0.5 * sample)) {
      // The loop-start gain wins when a breakpoint lands on this same frame.
      // The ramp into the seam was written on the previous pass, one sample early.
      state = emitSet(valueAtBeat(loopStartBeat), seam, state);
    }

    const frameLo = pass === 0 ? map.startFrame : map.loopStart;
    const beatLo = frameToBeat(frameLo, sampleRate, bpm);
    const beatHi = frameToBeat(map.loopEnd, sampleRate, bpm);
    const approach = Math.min(passEnd, horizonEnd) - sample;
    for (const group of groupsOf(points)) {
      if (!(group.beat > beatLo) || !(group.beat < beatHi)) continue;
      const time = timeOf(group.beat, pass);
      // A breakpoint that shares the loop-end frame is not written. The seam
      // set above owns that sample. timeOf returns null for that frame.
      if (time == null || !(time < passEnd - 0.5 * sample)) continue;
      if (time > horizonEnd + 1e-9) continue;
      state = writeGroup(group, time, state);
    }
    if (approach > state.lastT + 0.5 * sample && approach > seam && approach > now + 0.5 * sample && approach < passEnd) {
      const endBeat = frameToBeat(map.loopEnd - 1, sampleRate, bpm);
      state = emitRamp(valueAtBeat(endBeat), approach, state);
    }
  }

  if (!scheduledPasses) return append ? appendFromSec : now;
  return Number.isFinite(boundary) ? boundary : Infinity;
}

/**
 * Schedule `track.gainPoints` on the track GainNode. `now` is the context
 * time the new curve takes over. The value written there is gainLinearAtBeat
 * at the beat `originSec` + `map` give for `now`, not transport.playheadBeat.
 *
 * `append: true` extends a curve the wake loop has already started. It does
 * not cancel events and does not write the value at `now`.
 */
export function scheduleGainEnvelope(param, track, options) {
  const now = options.now ?? options.originSec;
  const append = options.append === true;
  const audible = options.audible !== false;
  if (!append) {
    param.cancelScheduledValues(now);
    const beat = beatAtContextTime(now, { ...options, now });
    const value = audible ? gainLinearAtBeat(track, beat) : 0;
    param.setValueAtTime(value, now);
  }
  if (!audible) return { untilSec: Infinity };
  const points = pointList(track?.gainPoints);
  if (!points.length) return { untilSec: Infinity };
  const untilSec = writeCurve(
    param,
    points,
    (beat) => gainLinearAtBeat(track, beat),
    (point) => dbToLinear(absoluteGainDb(track, point)),
    options,
  );
  return { untilSec };
}

/**
 * Same scheduler as gain, on the StereoPanner only. Does not cancel or write
 * the track GainNode. Empty points are not passed here: the caller keeps
 * today's constant pan.
 */
export function schedulePanEnvelope(param, track, options) {
  const now = options.now ?? options.originSec;
  if (!options.append) {
    param.cancelScheduledValues(now);
    param.setValueAtTime(panAtBeat(track, beatAtContextTime(now, { ...options, now })), now);
  }
  const points = pointList(track?.panPoints);
  if (!points.length) return { untilSec: Infinity };
  const untilSec = writeCurve(
    param,
    points,
    (beat) => panAtBeat(track, beat),
    (point) => point.pan,
    options,
  );
  return { untilSec };
}

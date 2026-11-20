// js/arrangement/render-plan.js — pure render-plan compiler.
//
// OPERATION THE LIVING DAYLIGHTS, GATE 2. Maps an immutable ProjectState
// snapshot to ordered, sample-accurate rendering instructions. Pure and
// deterministic: same state in, identical plan out; the ProjectState is never
// mutated and never receives anything back from rendering.
//
// The plan is the contract between the state half (Milestone A) and any
// renderer — offline bounce (GATE 3) and real-time playback (Milestone C).
// Both must consume the same plan shape so their signal flow cannot diverge.
//
// Signal-flow order per active clip (mandatory, unchanged from the spec):
//   Source Slice -> Stretch/Pitch DSP -> Clip Gain + Micro-Fade -> 3-Band EQ
//   -> Track Volume/Pan/Mute-Solo -> Master Sum -> Lookahead Brickwall Limiter
//   -> Output
//
// Time conventions continue time-math.js exactly: a clip's source-advance rate
// is source seconds per output second, and sample ranges are expressed in the
// project's sample-rate domain (decoded buffers live at transport.sampleRate).

import {
  MAX_EQ_GAIN_DB,
  MIN_EQ_GAIN_DB,
  cloneState,
  clipsOnTrack,
  validateProject,
} from './project-state.js';
import {
  EPSILON,
  beatsToSeconds,
  clipSourceSpanSec,
  outputDurationMultiplier,
  secPerBeat,
  semitoneFactor,
  sourceAdvanceRate,
} from './time-math.js';

export const RENDER_PLAN_VERSION = 1;
export const LIMITER_CEILING_DB = -0.3;

/** db -> linear gain. */
export function dbToLinear(db) {
  return 10 ** (db / 20);
}

/**
 * Mute/Solo law (identical to the accepted Stem Performance Desk):
 * any solo silences every non-soloed track; solo overrides mute on a soloed
 * track only in the sense that the solo set is what sounds.
 */
export function trackAudible(track, anySolo) {
  return anySolo ? track.solo : !track.mute;
}

/**
 * Compile a render plan.
 *
 * @param {object} state ProjectState (read-only; never mutated)
 * @param {{latencyCompensationFrames?: number, tailFrames?: number,
 *          lookaheadMs?: number, releaseMs?: number}} options
 *   latencyCompensationFrames: measured DSP latency offset applied to every
 *     clip's placement (0 when the DSP compensates itself; the renderer
 *     measures and documents the residual).
 *   tailFrames: DSP tail allowance appended past the arrangement end.
 */
export function compileRenderPlan(state, options = {}) {
  const {
    latencyCompensationFrames = 0,
    tailFrames = 0,
    lookaheadMs = 5,
    releaseMs = 50,
  } = options;
  if (!Number.isInteger(latencyCompensationFrames) || latencyCompensationFrames < 0) {
    throw new RangeError('latencyCompensationFrames must be a non-negative integer');
  }
  if (!Number.isInteger(tailFrames) || tailFrames < 0) {
    throw new RangeError('tailFrames must be a non-negative integer');
  }

  // Defensive copy + validation: rendering must never see invalid state, and
  // the caller's object is never touched.
  const snapshot = cloneState(state);
  const { ok, errors } = validateProject(snapshot);
  if (!ok) {
    throw new RangeError(`cannot render an invalid ProjectState: ${JSON.stringify(errors[0])}`);
  }

  const { transport } = snapshot;
  const sampleRate = transport.sampleRate;
  const spb = secPerBeat(transport.masterBpm);
  const anySolo = snapshot.tracks.some((t) => t.solo);

  const clips = [];
  for (let trackIndex = 0; trackIndex < snapshot.tracks.length; trackIndex += 1) {
    for (const clip of clipsOnTrack(snapshot, trackIndex)) {
      const asset = snapshot.assets[clip.assetId];
      const rate = sourceAdvanceRate(clip, asset, transport.masterBpm);
      const spanSec = clipSourceSpanSec(clip, asset, transport.masterBpm);
      // Frame boundaries are quantised ONCE at each region edge, so adjacent
      // regions share boundary frames exactly (no 1-frame overlap or gap from
      // independent rounding of start and duration).
      const placeShiftSec = latencyCompensationFrames / sampleRate;
      const startFrame = Math.round((clip.timelineStartBeat * spb + placeShiftSec) * sampleRate);
      const endFrame = Math.round(((clip.timelineStartBeat + clip.durationBeats) * spb + placeShiftSec) * sampleRate);
      const sourceStartFrame = Math.round(clip.sourceOffsetSec * sampleRate);
      const sourceEndFrame = Math.round((clip.sourceOffsetSec + spanSec) * sampleRate);
      const fadeInSec = clip.fadeInBeats * spb;
      const fadeOutSec = clip.fadeOutBeats * spb;
      clips.push({
        clipId: clip.id,
        trackIndex,
        assetId: clip.assetId,
        bufferReference: asset.bufferReference,
        timelineStartFrame: startFrame,
        timelineDurationFrames: endFrame - startFrame,
        timelineEndFrame: endFrame,
        sourceStartFrame,
        sourceSpanFrames: sourceEndFrame - sourceStartFrame,
        sourceEndFrame,
        rate,
        outputDurationMultiplier: outputDurationMultiplier(clip, asset, transport.masterBpm),
        pitchSemitones: clip.pitchSemitones,
        pitchFactor: semitoneFactor(clip.pitchSemitones),
        preserveFormants: clip.preserveFormants,
        clipGainDb: clip.clipGainDb,
        clipGainLinear: dbToLinear(clip.clipGainDb),
        fadeInFrames: Math.round(fadeInSec * sampleRate),
        fadeOutFrames: Math.round(fadeOutSec * sampleRate),
      });
    }
  }

  const tracks = snapshot.tracks.map((t) => ({
    trackIndex: t.trackIndex,
    name: t.name,
    volumeDb: t.volumeDb,
    volumeLinear: dbToLinear(t.volumeDb),
    pan: t.pan,
    mute: t.mute,
    solo: t.solo,
    audible: trackAudible(t, anySolo),
    eq: {
      lowGainDb: t.eq.lowGainDb,
      midGainDb: t.eq.midGainDb,
      highGainDb: t.eq.highGainDb,
    },
  }));

  let arrangementEndFrame = 0;
  for (const c of clips) {
    arrangementEndFrame = Math.max(arrangementEndFrame, c.timelineEndFrame);
  }

  return {
    renderPlanVersion: RENDER_PLAN_VERSION,
    projectSchemaVersion: snapshot.schemaVersion,
    sampleRate,
    masterBpm: transport.masterBpm,
    timeSignature: [...transport.timeSignature],
    loopRange: transport.loopRange ? [...transport.loopRange] : null,
    clips,
    tracks,
    anySolo,
    master: {
      order: 'track-then-clip (deterministic; overlapping regions sum)',
      volumeDb: snapshot.master?.volumeDb ?? 0,
      gainLinear: dbToLinear(snapshot.master?.volumeDb ?? 0),
    },
    limiter: {
      type: 'lookahead-brickwall',
      ceilingDb: LIMITER_CEILING_DB,
      ceilingLinear: dbToLinear(LIMITER_CEILING_DB),
      lookaheadMs,
      releaseMs,
      truePeakClaimed: false,
    },
    dsp: {
      latencyCompensationFrames,
      tailFrames,
      convention: 'source-advance rate = source seconds per output second',
    },
    output: {
      channels: 2,
      arrangementEndFrame,
      totalFrames: arrangementEndFrame + tailFrames,
    },
  };
}

/**
 * The frames of output a clip's DSP tail may legally ring past its region.
 * Used by renderers to allow tails without letting them run unbounded, and by
 * tests to assert silence outside regions except for tails.
 */
export function clipTailAllowanceFrames(plan) {
  return plan.dsp.tailFrames;
}

/** Strict comparison helper for determinism tests and parity checks. */
export function renderPlanEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Guard used by renderers: plans describe regions, never mutate state. */
export function assertPlanCoversOnlyKnownAssets(plan, state) {
  for (const clip of plan.clips) {
    const asset = state.assets[clip.assetId];
    if (!asset || asset.bufferReference !== clip.bufferReference) {
      throw new RangeError(`plan clip ${clip.clipId} disagrees with the state asset`);
    }
    if (clip.sourceStartFrame < -EPSILON || clip.sourceEndFrame > asset.durationSec * plan.sampleRate + 1) {
      throw new RangeError(`plan clip ${clip.clipId} leaves its asset`);
    }
    if (clip.fadingIn && (clip.fadeInFrames < 0 || clip.fadeOutFrames < 0)) {
      throw new RangeError(`plan clip ${clip.clipId} has negative fades`);
    }
  }
}

// js/arrangement/time-math.js — the single definition of time, stretch and
// pitch conventions for the arrangement engine.
//
// OPERATION ALL THE TIME IN THE WORLD, Milestone A. These helpers are the
// contract every later stage must reuse: the edit engine (Milestone A), the
// shared WASM DSP graph and offline bounce (Milestone B), real-time AudioWorklet
// playback (Milestone C) and the timeline UI (Milestone D). Nothing here touches
// the DOM or an AudioContext, so the same numbers can be tested headlessly.
//
// Conventions (normative — see docs/all-the-time-milestone-a.md §2):
//
//   secPerBeat        = 60 / masterBpm
//   beats -> seconds  = beats * secPerBeat
//
//   sourceAdvanceRate = SOURCE SECONDS consumed per OUTPUT SECOND.
//     beat_sync: rate = masterBpm / asset.nativeBpm
//     manual:    rate = clip.customStretchRatio
//   The output-duration multiplication is the reciprocal, 1/rate. A clip that
//   advances through its source slowly (rate < 1) lasts longer on the timeline.
//
//   Pitch transposition factor = 2^(semitones/12), applied by the DSP only.
//   It never changes a source offset, a duration or a playback rate here.

export const DEFAULT_MICRO_FADE_BEATS = 0.015;
export const MIN_CLIP_DURATION_BEATS = 1 / 64;
export const MIN_STRETCH_RATIO = 0.05;
export const MAX_STRETCH_RATIO = 20;
/** Floating-point slack for source-bound comparisons (seconds and beats). */
export const EPSILON = 1e-9;

/** Seconds per beat at the project's master tempo. */
export function secPerBeat(masterBpm) {
  return 60 / masterBpm;
}

/** Convert timeline beats to timeline seconds at the master tempo. */
export function beatsToSeconds(beats, masterBpm) {
  return beats * secPerBeat(masterBpm);
}

/** Convert timeline seconds to timeline beats at the master tempo. */
export function secondsToBeats(seconds, masterBpm) {
  return seconds * (masterBpm / 60);
}

/**
 * Source-advance rate for a clip: source seconds consumed per output second.
 *
 * `beat_sync` derives it from the tempos and is unavailable while the asset's
 * native BPM is unknown — a missing tempo must stay unknown, never invented.
 * `manual` uses the clip's customStretchRatio with the same convention.
 */
export function sourceAdvanceRate(clip, asset, masterBpm) {
  if (clip.stretchMode === 'beat_sync') {
    if (asset.nativeBpm == null) {
      throw new RangeError('beat_sync is unavailable while asset.nativeBpm is unknown');
    }
    return masterBpm / asset.nativeBpm;
  }
  return clip.customStretchRatio;
}

/** Output-duration multiplication for a clip (the reciprocal of the rate). */
export function outputDurationMultiplier(clip, asset, masterBpm) {
  return 1 / sourceAdvanceRate(clip, asset, masterBpm);
}

/**
 * Convert a span of timeline beats into the source seconds a clip consumes
 * over that span. This is the only sanctioned way to move between timeline and
 * source time; split, trim and stretch all route through it.
 */
export function beatsToSourceSeconds(beats, clip, asset, masterBpm) {
  return beats * secPerBeat(masterBpm) * sourceAdvanceRate(clip, asset, masterBpm);
}

/** Source seconds the whole clip consumes at its current stretch settings. */
export function clipSourceSpanSec(clip, asset, masterBpm) {
  return beatsToSourceSeconds(clip.durationBeats, clip, asset, masterBpm);
}

/** Output seconds the clip occupies on the timeline. */
export function clipTimelineDurationSec(clip, masterBpm) {
  return beatsToSeconds(clip.durationBeats, masterBpm);
}

/** Standard pitch-frequency factor for a semitone shift (DSP-side only). */
export function semitoneFactor(semitones) {
  return 2 ** (semitones / 12);
}

/**
 * The ONE shared bypass predicate (Milestone C1, GATE 6). A clip needs the
 * Signalsmith stretch/pitch DSP iff it is time-stretched (source-advance rate
 * not exactly 1) OR pitch-shifted (semitones not exactly 0). A clip with rate 1
 * and 0 semitones is a pure playback of its source and BYPASSES the DSP so it
 * stays sample-exact with no algorithmic latency or priming.
 *
 * This predicate and its semantics are used identically by the offline bounce
 * and real-time playback (both route through buildArrangementGraph); there is
 * deliberately no second implementation. Waveform equality is claimed only for
 * bypass clips (<= 1e-6). Stretched clips are judged by onset timing and
 * envelope tolerances, never by waveform equality (the phase vocoder's analysis
 * grid is anchored to processor state, not content).
 */
export function clipNeedsDsp(rate, pitchSemitones) {
  // Exact comparisons: rate 1 and 0 semitones are the only bypass cases. Any
  // other rate (including 0.9999) or any pitch keeps the clip in the DSP path.
  return !(rate === 1 && pitchSemitones === 0);
}

/**
 * Clamp the default micro-fade pair for a clip of `durationBeats`.
 * Short clips get proportionally shorter fades so fade-in + fade-out never
 * exceeds the clip. Deterministic and side-effect free.
 */
export function clampMicroFades(fadeInBeats, fadeOutBeats, durationBeats) {
  let fadeIn = Math.min(fadeInBeats, durationBeats / 2);
  let fadeOut = Math.min(fadeOutBeats, durationBeats / 2);
  const total = fadeIn + fadeOut;
  if (total > durationBeats && total > 0) {
    const scale = durationBeats / total;
    fadeIn *= scale;
    fadeOut *= scale;
  }
  return { fadeInBeats: fadeIn, fadeOutBeats: fadeOut };
}

/** The default micro-fade pair for a freshly created clip. */
export function defaultMicroFades(durationBeats) {
  return clampMicroFades(DEFAULT_MICRO_FADE_BEATS, DEFAULT_MICRO_FADE_BEATS, durationBeats);
}

/**
 * Deterministic clip order for one track: timeline position first, then clip
 * id. Rendering, hit-testing and overlap reporting all use this order, so
 * overlapping regions can never change result between runs.
 */
export function compareClips(a, b) {
  if (a.timelineStartBeat !== b.timelineStartBeat) return a.timelineStartBeat - b.timelineStartBeat;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

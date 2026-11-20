// js/arrangement/click-guard.js — boundary-local discontinuity detector.
//
// OPERATION THE LIVING DAYLIGHTS, GATE 6 corrective action. This is the
// acceptance instrument for "no click at clip boundaries". It replaces the old
// global gate (boundary slope < 4 x one steady slope) which conflated musical
// transients with clicks: a hi-hat noise burst's own sample slope raised the
// threshold until a half-full-scale hard cut passed as clean.
//
// Design — Boundary Discontinuity Index (BDI)
// -------------------------------------------
// A missing micro-fade leaves three simultaneous discontinuity signatures at
// the region edge: an envelope step (amplitude drops/rises in one sample), a
// waveform step (value jump), and a slope break. Musical transients — however
// steep — are locally continuous: their waveform is predictable from its own
// neighbourhood and their envelope moves at the rate the surrounding content
// already moves. So each signature is scored against the LOCAL continuity
// roughness of the content it interrupts (a few ms either side), not against a
// global steady reference:
//
//   envelope term  TE = |RMS(after window) - RMS(before window)|
//                      / max(local envelope roughness, floor)
//   waveform term  TW = |x[b] - x[b-1]| (the junction's sample step)
//                      / max(local per-sample slope scale, floor)
//
//   BDI = max(TE, TW);  a boundary is flagged when BDI > threshold.
//
// The reference is per-side and near-junction: the quadratic mean of the
// adjacent-window envelope changes over the 4 nearest window pairs on each
// side (max of the two sides), and the worst per-sample slope over the same
// span. This makes the detector scale-invariant (a step is judged as a
// fraction of the content it interrupts) and transient-aware (an onset or fade
// ramp near the boundary raises the local bar exactly as the ear's masking
// does).
//
// The waveform term deliberately compares the junction against the content's
// own PER-SAMPLE slope, not its curvature: a correct micro-fade leaves a small
// slope corner at the edge (the ramp meets silence) that is the same order as
// a slow tone's curvature, so a curvature-normalized term reads 2.4 on
// perfectly clean pad edges — a phase-lucky near-threshold result. Against the
// per-sample slope scale a clean faded edge scores < 0.1 while any real value
// step (>= ~12% of the content amplitude on a sustained tone) scores > 2.5.
//
// Honest scope of the claim:
//   - A flagged boundary IS an unfaded discontinuity (contract defect).
//   - Audibility scales with step size and falls where the content masks it:
//     cutting uncorrelated noise at a low point is masked by the noise itself.
//   - Content onsets INSIDE a region are musical transients and are never
//     probed; only region edges are.
//   - The waveform term is masked by uncorrelated noise (noise is unpredictable
//     sample to sample) and the envelope term is masked when BOTH sides carry
//     equal-RMS uncorrelated noise; each term covers the other's blind spot
//     (tone steps -> waveform term; noise steps to/from silence -> envelope
//     term). A noise-to-noise junction at equal RMS is genuinely masked and is
//     reported as such rather than claimed detected.

/** Envelope/RMS window, 128 samples = 2.67 ms at 48 kHz. */
export const BDI_WINDOW = 128;
/** Near-junction context, 4 window pairs per side (~13 ms). */
export const BDI_CONTEXT_PAIRS = 4;
/** Flag threshold: the junction breaks continuity 2.5x worse than the roughest
 *  behaviour the surrounding ~13 ms already exhibits. */
export const BDI_THRESHOLD = 2.5;

function rms(samples, from, to) {
  let sum = 0;
  const lo = Math.max(0, from);
  const hi = Math.min(samples.length, to);
  const n = hi - lo;
  if (n <= 0) return 0;
  for (let i = lo; i < hi; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / n);
}

function unscorable(boundary, threshold, reason) {
  return {
    boundary,
    threshold,
    scorability: 'unscorable',
    unscorable: true,
    unscorableReason: reason,
    nonFinite: false,
    envelope: null,
    waveform: null,
    index: null,
    flagged: false,
  };
}

/** True if any sample in [from, to) is NaN or Infinity. */
function hasNonFinite(samples, from, to) {
  const lo = Math.max(0, from);
  const hi = Math.min(samples.length, to);
  for (let i = lo; i < hi; i += 1) {
    if (!Number.isFinite(samples[i])) return true;
  }
  return false;
}

/**
 * Score one boundary. `boundary` is the first sample of the incoming side,
 * i.e. the region's exclusive end / inclusive start frame in render-plan
 * terms. Clip-gain automation is sample-accurate, so a missing fade steps
 * exactly here; no search is needed or performed.
 *
 * Result contract (Gate 7):
 *   - A boundary at frame 0 (or one with no before/after context) is
 *     SCORABILITY 'unscorable' — this detector needs a neighbouring sample on
 *     each side. It is reported, never silently treated as a pass.
 *   - Non-finite input (NaN/Infinity) in the probe window is an INVALID
 *     numerical result, not audio: it is FLAGGED (a defect), never converted
 *     into an implicit pass. `index` is +Infinity and `nonFinite` is true.
 *   - Otherwise a finite `index` compares the junction against local continuity.
 *
 * @param {Float32Array} samples mono render
 * @param {number} boundary junction sample
 * @param {{window?: number, contextPairs?: number, threshold?: number}} options
 */
export function boundaryDiscontinuity(samples, boundary, options = {}) {
  const W = options.window ?? BDI_WINDOW;
  const K = options.contextPairs ?? BDI_CONTEXT_PAIRS;
  const threshold = options.threshold ?? BDI_THRESHOLD;
  if (!Number.isInteger(boundary)) {
    throw new RangeError(`boundary ${boundary} must be an integer sample`);
  }
  // Frame 0 has no before-sample; a boundary at/after the penultimate sample has
  // no after-sample. Both are unscorable rather than an error (Gate 7 / §G).
  if (boundary < 1) return unscorable(boundary, threshold, 'frame-0 boundary has no before-sample');
  if (boundary > samples.length - 2) {
    return unscorable(boundary, threshold, 'boundary has no after-sample in the buffer');
  }

  // Non-finite probe window: any NaN/Infinity near the junction is a defect that
  // must FLAG, never pass (Gate 7 — the click diagnostic must not convert an
  // invalid numerical result into an implicit PASS).
  const probeFrom = boundary - (K + 1) * W;
  const probeTo = boundary + (K + 1) * W + 1;
  if (hasNonFinite(samples, probeFrom, probeTo)) {
    return {
      boundary,
      threshold,
      scorability: 'scorable',
      unscorable: false,
      unscorableReason: null,
      nonFinite: true,
      envelope: null,
      waveform: null,
      index: Infinity,
      flagged: true,
    };
  }

  // Envelope windows: k = -1 is the last window before the junction, k = 0 the
  // first after it. Window k covers [boundary + k*W, boundary + (k+1)*W).
  const env = (k) => rms(samples, boundary + k * W, boundary + (k + 1) * W);
  const envBefore = env(-1);
  const envAfter = env(0);
  const envStep = Math.abs(envAfter - envBefore);

  // Local envelope roughness: the quadratic mean (an RMS magnitude, not an
  // average and not a single outlier) of the adjacent-window envelope changes
  // over the K nearest pairs on each side (the junction pair excluded); the
  // larger side wins. The quadratic mean is what makes the gate trustworthy:
  // a plain mean dilutes the reference with quiet pairs (a clean pad fade read
  // 2.38 against a 2.5 threshold), while a plain max lets one rough pair mask
  // a broken edge (a broken pad cut read 1.29). With the quadratic mean a
  // clean micro-fade is geometrically bounded near 1 (its own ramp is always
  // in context) and every broken class measured 3.5-30.
  const sideRoughness = (from, to) => {
    let sumSq = 0;
    let count = 0;
    for (let k = from; k < to; k += 1) {
      const d = Math.abs(env(k + 1) - env(k));
      sumSq += d * d;
      count += 1;
    }
    return count ? Math.sqrt(sumSq / count) : 0;
  };
  const roughBefore = sideRoughness(-K - 1, -1);
  const roughAfter = sideRoughness(0, K);
  const envRoughness = Math.max(roughBefore, roughAfter);
  const envRatio = envStep / Math.max(envRoughness, 1e-7);

  // Waveform term: the junction's sample step (both sides meet in exactly one
  // sample-to-sample difference) against the worst per-sample slope the local
  // waveform already shows. A real value step exceeds anything the content
  // does per sample; a correct micro-fade's ramp corner does not.
  const junctionBreak = Math.abs(samples[boundary] - samples[boundary - 1]);
  let waveRoughness = 0;
  for (let n = Math.max(1, boundary - K * W); n <= Math.min(samples.length - 1, boundary + K * W); n += 1) {
    if (n === boundary) continue;
    waveRoughness = Math.max(waveRoughness, Math.abs(samples[n] - samples[n - 1]));
  }
  const waveRatio = junctionBreak / Math.max(waveRoughness, 1e-7);

  const index = Math.max(envRatio, waveRatio);
  // The floors keep the ratios finite for finite input; belt-and-braces guard so
  // a numerical surprise can never become an implicit pass (Gate 7).
  const finite = Number.isFinite(index);
  return {
    boundary,
    threshold,
    scorability: 'scorable',
    unscorable: false,
    unscorableReason: null,
    nonFinite: !finite,
    envelope: {
      before: envBefore,
      after: envAfter,
      step: envStep,
      roughness: envRoughness,
      roughnessBefore: roughBefore,
      roughnessAfter: roughAfter,
      ratio: envRatio,
    },
    waveform: {
      junctionBreak,
      roughness: waveRoughness,
      ratio: waveRatio,
    },
    index: finite ? index : Infinity,
    flagged: !finite || index > threshold,
  };
}

/**
 * The ordinary acceptance gate: every SCORABLE boundary must be unflagged and
 * finite. This same gate runs on deliberately broken renders as the negative
 * control that proves the detector remains effective.
 *
 * Gate 7 contract: a non-finite boundary is always flagged (never an implicit
 * pass). A frame-0 / no-context boundary is reported as `unscorable` and is NOT
 * silently counted as a pass — the caller sees it in `unscorable` and can decide.
 * `passed` is true only when there are no flagged (incl. non-finite) entries.
 *
 * @param {Array<ReturnType<typeof boundaryDiscontinuity>>} entries
 */
export function boundaryGate(entries, threshold = BDI_THRESHOLD) {
  const nonFinite = entries.filter((e) => e.nonFinite);
  const unscorable = entries.filter((e) => e.unscorable);
  const flagged = entries.filter((e) => e.flagged || e.nonFinite);
  const scorable = entries.filter((e) => !e.unscorable);
  const worst = scorable.reduce(
    (w, e) => (Number.isFinite(e.index) && e.index > (w?.index ?? -Infinity) ? e : w),
    null,
  );
  return {
    // A verdict of "pass" requires at least one SCORABLE boundary that passed;
    // an all-unscorable set is not a silent pass (review finding 15).
    passed: flagged.length === 0 && scorable.length > 0,
    finite: nonFinite.length === 0,
    threshold,
    worstIndex: worst ? worst.index : 0,
    worstBoundary: worst ? worst.boundary : null,
    scorableCount: scorable.length,
    flagged: flagged.map((e) => ({
      boundary: e.boundary,
      index: e.index,
      envelopeStep: e.envelope ? e.envelope.step : null,
      waveBreak: e.waveform ? e.waveform.junctionBreak : null,
      nonFinite: !!e.nonFinite,
    })),
    unscorable: unscorable.map((e) => ({ boundary: e.boundary, reason: e.unscorableReason })),
  };
}

/** Score a set of region edges (plan frames) on one mono render. */
export function gateBoundaries(samples, boundaries, options = {}) {
  return boundaryGate(
    boundaries.map((b) => boundaryDiscontinuity(samples, b, options)),
    options.threshold ?? BDI_THRESHOLD,
  );
}

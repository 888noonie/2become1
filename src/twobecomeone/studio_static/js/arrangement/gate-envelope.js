// js/arrangement/gate-envelope.js — pure transport anti-click envelopes.
//
// OPERATION CLOCKWORK, Milestone C1, GATE 5. These are the runtime TRANSPORT
// gates: sample-accurate gain shapes that make play / stop / seek / pause / loop
// wrap / voice handover inaudible as clicks. They are deliberately SEPARATE from
// the musical clipGain (ProjectState fades, owned by the renderer's plan): a
// transport gate never changes an edit, and an edit never depends on transport
// history. The two multiply in the graph (transportGate * clipGain).
//
// Everything here is pure scalar arithmetic over sample indices so it can be
// verified exactly (Gate 8 T4) without any audio: for every seam type the gate
// is exactly 0 or 1 at its ends, its per-sample step never exceeds 1/ramp, and
// every complementary (crossfade) pair sums to exactly 1.
//
// All shapes are LINEAR ramps. A linear ramp's per-sample step is 1/N for an
// N-frame ramp; that bounds the discontinuity a seam can introduce to the
// content's own slope scaled by 1/N, which is the click-safety argument.

/** Play/start: 0 -> 1 over this many frames (2.5 ms at 48 kHz). */
export const START_RAMP_FRAMES = 120;
/** Stop/pause: 1 -> 0 over this many frames (10 ms at 48 kHz). */
export const STOP_RAMP_FRAMES = 480;
/** Seek seam: old out / new in over this many frames (5 ms at 48 kHz). */
export const SEEK_RAMP_FRAMES = 240;
/** Loop wrap / voice handover crossfade length (both sides), 2.5 ms at 48 kHz. */
export const LOOP_XFADE_FRAMES = 120;

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Linear 0 -> 1 ramp value at sample i of an N-frame ramp. Exact at the ends. */
export function linearUp(i, N) {
  if (N <= 0) return i >= 0 ? 1 : 0;
  return clamp01(i / N);
}

/** Linear 1 -> 0 ramp value at sample i of an N-frame ramp (exact complement). */
export function linearDown(i, N) {
  return 1 - linearUp(i, N);
}

/**
 * Start (Play) gate value at absolute frame `t` for a start seam at `Ts` over N
 * frames. The frame exactly at Ts is 0 (a frame-0 start therefore outputs an
 * exact 0 first sample), reaching 1 at Ts+N. Before Ts it is 0 (nothing sounds
 * before Play).
 */
export function startGateAt(t, Ts, N = START_RAMP_FRAMES) {
  if (t < Ts) return 0;
  return linearUp(t - Ts, N);
}

/**
 * Stop/pause gate value at absolute frame `t` for a stop that ENDS at `Te` over
 * N frames (the ramp occupies [Te-N, Te)). At and after Te it is 0 (silence);
 * at Te-N and before it is 1.
 */
export function stopGateAt(t, Te, N = STOP_RAMP_FRAMES) {
  if (t >= Te) return 0;
  return linearUp(Te - t, N); // 0 at t=Te, 1 at t=Te-N
}

/**
 * Crossfade pair for a seam (seek, loop wrap, voice handover). The pair is
 * defined over an N-frame window beginning at `W0`: `up` ramps 0->1 (incoming
 * voice), `down` ramps 1->0 (outgoing voice), and up(t) + down(t) == 1 at EVERY
 * sample. For a loop wrap the window is centred on the seam (W0 = seam - N/2)
 * so the crossfade does not move the musical boundary.
 */
export function crossfadeUpAt(t, W0, N) {
  return linearUp(t - W0, N);
}
export function crossfadeDownAt(t, W0, N) {
  return linearDown(t - W0, N);
}

/**
 * The seam window for a loop wrap centred on `seam` (integer frame). Returns the
 * window start so both voices crossfade symmetrically without moving timing.
 */
export function loopSeamWindow(seam, N = LOOP_XFADE_FRAMES) {
  return Math.round(seam - N / 2);
}

/**
 * Full transport-gain shape for one voice across a seam, as a value function of
 * absolute frame. `kind` selects the shape; returns `null` for an unknown kind.
 *   'start'   : { Ts, N }              0 -> 1 from Ts
 *   'stop'    : { Te, N }              1 -> 0 into Te
 *   'handover-in'  : { W0, N }         0 -> 1 over [W0, W0+N]
 *   'handover-out' : { W0, N }         1 -> 0 over [W0, W0+N]
 *   'open'    : constant 1 (a bypass voice away from any seam)
 */
export function seamGate(kind, params) {
  switch (kind) {
    case 'start': {
      const { Ts, N = START_RAMP_FRAMES } = params;
      return (t) => startGateAt(t, Ts, N);
    }
    case 'stop': {
      const { Te, N = STOP_RAMP_FRAMES } = params;
      return (t) => stopGateAt(t, Te, N);
    }
    case 'handover-in': {
      const { W0, N = SEEK_RAMP_FRAMES } = params;
      return (t) => crossfadeUpAt(t, W0, N);
    }
    case 'handover-out': {
      const { W0, N = SEEK_RAMP_FRAMES } = params;
      return (t) => crossfadeDownAt(t, W0, N);
    }
    case 'open':
      return () => 1;
    default:
      return null;
  }
}

/**
 * Sample a value function over [from, to] into a Float32Array (for arithmetic
 * tests and continuity probes).
 */
export function sampleGate(valueAt, from, to) {
  const n = to - from;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = valueAt(from + i);
  return out;
}

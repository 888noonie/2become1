// js/arrangement/transport.js — pure transport command/state model and clock map.
//
// OPERATION CLOCKWORK, Milestone C1, GATE 1. This is the transport state machine
// and the transport<->context clock map, implemented WITHOUT any graphical
// component, AudioContext, wall-clock timer or device dependency so it is
// testable headlessly with a fake clock (Gate 8 T1/T2).
//
// Musical authority vs runtime (the reconciliation contract, Gate 1):
//
//   * ProjectState stays the ONLY source of musical truth. This module never
//     mutates ProjectState. It emits a `writeParked` effect carrying a parked
//     frame; the runtime (realtime-engine.js) is the only thing that may turn
//     that into a ProjectState update (via EditEngine), and only on Stop, Pause,
//     or a seek while stopped. Nothing is written per frame.
//
//   * The runtime owns the device clock (AudioContext), the active voices and
//     transient processor state. Those live in frames of the context clock and
//     are NEVER serialised.
//
//   * `state.isPlaying` here is a LOGICAL flag (do we believe playback is
//     running), not an audio clock. The parked playhead (`state.parkedFrame`) is
//     a static bookkeeping value, not a clock. The only moving clock is
//     ctxFrame -> TransportMap -> transportFrame, computed from integer frames.
//     Neither isPlaying nor parkedFrame may be advanced by a wall-clock timer to
//     produce audible musical events: audibility is decided by sample-accurate
//     gain automation scheduled against the context clock.
//
//   * Every command that starts or re-targets audio begins a new playback EPOCH
//     (state.epoch). Every command that changes what should sound bumps
//     state.generation. Any async completion, voice order or feeder fill tagged
//     with a stale (epoch, generation) is discarded by the runtime. This is how
//     "Play during a stop fade supersedes the pending stop": Play bumps the epoch
//     and the runtime drops every order from the old epoch, cancelling the fade.
//
// Owner UX (recorded, Gate 1): Space toggles Play/Stop and Stop returns to the
// cue (the last Play or seek origin). Pause is a DISTINCT command that parks at
// the heard position. `stop()` therefore restores `cueFrame`; `pause()` parks at
// the position passed in the event (the runtime supplies the heard frame).

import { EPSILON } from './time-math.js';

/** Transport phases. Anything not in this set is unreachable. */
export const Phase = Object.freeze({
  UNPREPARED: 'unprepared',
  PREPARING: 'preparing',
  STOPPED: 'stopped',
  STARTING: 'starting',
  PLAYING: 'playing',
  SEEKING: 'seeking',
  STOPPING: 'stopping',
  FAILED: 'failed',
});

/** Legal transition table: from-phase -> set of reachable phases. Kept explicit
 *  so a test can assert every row and reject anything not listed. */
export const LEGAL_TRANSITIONS = Object.freeze({
  [Phase.UNPREPARED]: [Phase.PREPARING, Phase.FAILED],
  [Phase.PREPARING]: [Phase.STOPPED, Phase.FAILED],
  [Phase.STOPPED]: [Phase.STARTING, Phase.STOPPED, Phase.FAILED, Phase.PREPARING],
  [Phase.STARTING]: [Phase.PLAYING, Phase.SEEKING, Phase.STOPPING, Phase.STOPPED, Phase.FAILED],
  [Phase.PLAYING]: [Phase.SEEKING, Phase.STOPPING, Phase.STOPPED, Phase.FAILED],
  [Phase.SEEKING]: [Phase.PLAYING, Phase.SEEKING, Phase.STOPPING, Phase.STOPPED, Phase.FAILED],
  [Phase.STOPPING]: [Phase.STOPPED, Phase.STARTING, Phase.FAILED],
  [Phase.FAILED]: [Phase.PREPARING],
});

export class InvalidTransitionError extends Error {
  constructor(from, command) {
    super(`transport command "${command}" is not legal from phase "${from}"`);
    this.name = 'InvalidTransitionError';
    this.code = 'INVALID_TRANSITION';
    this.from = from;
    this.command = command;
  }
}

/**
 * Create the initial transport state. Frames are integers in the project's
 * sample-rate domain (the timeline frame of the musical position). `arrangement`
 * is the timeline end frame and `loop` is [startFrame, endFrame) or null.
 */
export function createTransportState({
  arrangementEndFrame = 0,
  loop = null,
  sampleRate = 48000,
} = {}) {
  return {
    phase: Phase.UNPREPARED,
    epoch: 0,
    generation: 0,
    sampleRate,
    arrangementEndFrame,
    /** The cue: the last Play or seek origin. Stop returns here (owner UX). */
    cueFrame: 0,
    /** The parked playhead: a static bookkeeping value, never a running clock. */
    parkedFrame: 0,
    /** Logical playback belief (not a clock). */
    isPlaying: false,
    /** [startFrame, endFrame) or null. */
    loop: loop ? [loop[0], loop[1]] : null,
    /** Frame of the active seek seam while SEEKING (else null). */
    seamFrame: null,
    /** Monotonic reason for the last entered FAILED/STOPPED-with-error. */
    fault: null,
  };
}

function clone(s) {
  return { ...s, loop: s.loop ? [s.loop[0], s.loop[1]] : null };
}

function legal(from, to) {
  return (LEGAL_TRANSITIONS[from] || []).includes(to);
}

/**
 * Pure reducer. Returns { state, effects }. Never throws for a no-op (an
 * illegal command in the current phase returns a `noop` effect and the same
 * state, EXCEPT where a command is unambiguous enough to supersede — see
 * `play` during STOPPING, which is legal and cancels the pending stop).
 *
 * Effects are descriptors for the runtime to execute against the audio clock:
 *   { type: 'prepare', plan, epoch, generation }
 *   { type: 'start', epoch, generation, startFrame, fromFrame }
 *   { type: 'seek', epoch, generation, seamFrame, toFrame }
 *   { type: 'stop', epoch, generation, fadeOutFrames, atFrame, park: 'cue'|'heard' }
 *   { type: 'writeParked', frame }        // the ONLY path to ProjectState
 *   { type: 'setLoop', loop }
 *   { type: 'capacityError', code, message }
 *   { type: 'fail', code, message }
 */
export function transportReduce(state, event) {
  const s = clone(state);
  const effects = [];
  const cmd = event && event.type;
  const noOp = () => ({ state, effects: [{ type: 'noop', command: cmd, phase: state.phase }] });

  switch (cmd) {
    case 'prepare': {
      // Legal when not actively playing (unprepared / stopped / failed, or a
      // re-prepare). Active playback must Stop first — this matches
      // LEGAL_TRANSITIONS, which has no PLAYING->PREPARING edge (review 13).
      if (s.phase === Phase.PREPARING) return noOp();
      if (s.phase === Phase.STARTING || s.phase === Phase.PLAYING
        || s.phase === Phase.SEEKING || s.phase === Phase.STOPPING) return noOp();
      s.phase = Phase.PREPARING;
      s.isPlaying = false;
      s.fault = null;
      s.generation += 1;
      effects.push({ type: 'prepare', generation: s.generation, plan: event.plan ?? null });
      return { state: s, effects };
    }

    case 'ready': {
      if (s.phase !== Phase.PREPARING) return noOp();
      if (!legal(s.phase, Phase.STOPPED)) return noOp();
      s.phase = Phase.STOPPED;
      s.isPlaying = false;
      // Park where ProjectState says, unless a concrete park was requested.
      s.parkedFrame = Number.isFinite(event.parkedFrame) ? event.parkedFrame : s.parkedFrame;
      s.cueFrame = s.parkedFrame;
      effects.push({ type: 'writeParked', frame: s.parkedFrame });
      return { state: s, effects };
    }

    case 'play': {
      // Legal from STOPPED. From STARTING it is a no-op (already starting). From
      // PLAYING it is a no-op. From STOPPING it SUPERSEDES the pending stop:
      // cancel the fade and begin a new playback epoch (owner requirement).
      const fromStopping = s.phase === Phase.STOPPING;
      if (s.phase === Phase.STARTING || s.phase === Phase.PLAYING) return noOp();
      if (s.phase !== Phase.STOPPED && !fromStopping) return noOp();
      if (!legal(s.phase, Phase.STARTING)) return noOp();
      s.phase = Phase.STARTING;
      s.isPlaying = true; // logical; audible only once heard >= T_s
      s.epoch += 1;
      s.generation += 1;
      // Play starts from the cue (owner UX: Stop returns to the cue, and Play
      // from the cue). A `fromFrame` override supports resume-from-parked.
      const fromFrame = Number.isFinite(event.fromFrame) ? event.fromFrame : s.cueFrame;
      s.cueFrame = fromFrame;
      s.parkedFrame = fromFrame;
      s.seamFrame = null;
      effects.push({
        type: 'start',
        epoch: s.epoch,
        generation: s.generation,
        startFrame: fromFrame,
        supersededStop: fromStopping,
      });
      return { state: s, effects };
    }

    case 'resume': {
      // Resume == play from the parked (heard) position. Distinct command so the
      // UX can bind Pause/Resume separately from Space's Play/Stop toggle.
      if (s.phase !== Phase.STOPPED) return noOp();
      if (!legal(s.phase, Phase.STARTING)) return noOp();
      return transportReduce(s, { type: 'play', fromFrame: s.parkedFrame });
    }

    case 'stop': {
      // Owner UX: Stop returns to the cue. Legal from STARTING/PLAYING/SEEKING.
      if (s.phase === Phase.STOPPED || s.phase === Phase.STOPPING) return noOp();
      if (s.phase !== Phase.STARTING && s.phase !== Phase.PLAYING && s.phase !== Phase.SEEKING) {
        return noOp();
      }
      s.phase = Phase.STOPPING;
      s.generation += 1;
      effects.push({
        type: 'stop',
        epoch: s.epoch,
        generation: s.generation,
        fadeOutFrames: event.fadeOutFrames ?? 0,
        atFrame: event.atFrame ?? null,
        park: 'cue',
        parkFrame: s.cueFrame,
      });
      // The stop completes when the fade lands -> 'stopped' event.
      return { state: s, effects };
    }

    case 'pause': {
      // Pause parks at the heard position (distinct from Stop's return-to-cue).
      if (s.phase === Phase.STOPPED || s.phase === Phase.STOPPING) return noOp();
      if (s.phase !== Phase.STARTING && s.phase !== Phase.PLAYING && s.phase !== Phase.SEEKING) {
        return noOp();
      }
      const heardFrame = Number.isFinite(event.heardFrame) ? event.heardFrame : s.parkedFrame;
      s.phase = Phase.STOPPING;
      s.generation += 1;
      effects.push({
        type: 'stop',
        epoch: s.epoch,
        generation: s.generation,
        fadeOutFrames: event.fadeOutFrames ?? 0,
        atFrame: event.atFrame ?? null,
        park: 'heard',
        parkFrame: heardFrame,
      });
      return { state: s, effects };
    }

    case 'stopped': {
      // Internal completion of a stop/pause fade (the runtime confirms silence).
      if (s.phase !== Phase.STOPPING) return noOp();
      if (!legal(s.phase, Phase.STOPPED)) return noOp();
      s.phase = Phase.STOPPED;
      s.isPlaying = false;
      s.parkedFrame = Number.isFinite(event.parkedFrame) ? event.parkedFrame : s.parkedFrame;
      s.seamFrame = null;
      effects.push({ type: 'writeParked', frame: s.parkedFrame });
      return { state: s, effects };
    }

    case 'seek': {
      // Legal while stopped (park) and while starting/playing/seeking (seam).
      const beat = event.frame;
      if (!Number.isFinite(beat)) return noOp();
      const frame = Math.max(0, Math.round(beat));
      if (s.phase === Phase.STOPPED) {
        // Seek while stopped: just move the cue and parked position.
        s.cueFrame = frame;
        s.parkedFrame = frame;
        s.generation += 1;
        effects.push({ type: 'writeParked', frame });
        return { state: s, effects };
      }
      if (s.phase !== Phase.STARTING && s.phase !== Phase.PLAYING && s.phase !== Phase.SEEKING) {
        return noOp();
      }
      if (!legal(s.phase, Phase.SEEKING)) return noOp();
      s.phase = Phase.SEEKING;
      s.epoch += 1; // a retarget begins a new audio epoch
      s.generation += 1;
      s.seamFrame = frame;
      // A retarget that is not an owner seek (a live loop change re-anchors the
      // map at the heard position) keeps the Stop cue where the owner left it.
      if (event.keepCue !== true) s.cueFrame = frame;
      effects.push({
        type: 'seek',
        epoch: s.epoch,
        generation: s.generation,
        seamFrame: frame,
        toFrame: frame,
        // A seek while already seeking simply retargets (supersede).
        retarget: event.retarget === true,
        keepCue: event.keepCue === true,
      });
      return { state: s, effects };
    }

    case 'seekDone': {
      if (s.phase !== Phase.SEEKING) return noOp();
      if (!legal(s.phase, Phase.PLAYING)) return noOp();
      s.phase = Phase.PLAYING;
      s.seamFrame = null;
      s.isPlaying = true;
      return { state: s, effects };
    }

    case 'started': {
      // heard >= T_s.
      if (s.phase !== Phase.STARTING) return noOp();
      if (!legal(s.phase, Phase.PLAYING)) return noOp();
      s.phase = Phase.PLAYING;
      s.isPlaying = true;
      return { state: s, effects };
    }

    case 'arrangementEnd': {
      // End reached with no loop: stop and return to the cue.
      if (s.phase !== Phase.PLAYING && s.phase !== Phase.STARTING) return noOp();
      return transportReduce(s, { type: 'stop', fadeOutFrames: event.fadeOutFrames ?? 0 });
    }

    case 'setLoop': {
      // Loop can change at any time (affects future scheduling only).
      const loop = event.loop == null ? null : [Math.round(event.loop[0]), Math.round(event.loop[1])];
      if (loop && !(loop[1] > loop[0])) {
        effects.push({ type: 'capacityError', code: 'LOOP_TOO_SHORT', message: 'loop end must be after start' });
        return { state, effects };
      }
      s.loop = loop;
      s.generation += 1;
      effects.push({ type: 'setLoop', loop, generation: s.generation });
      return { state: s, effects };
    }

    case 'contextSuspended': {
      // The system stopped audio output: honest parking, never a fake success.
      if (s.phase === Phase.FAILED || s.phase === Phase.UNPREPARED) return noOp();
      s.phase = Phase.STOPPED;
      s.isPlaying = false;
      s.parkedFrame = Number.isFinite(event.heardFrame) ? event.heardFrame : s.parkedFrame;
      s.fault = { code: 'CONTEXT_SUSPENDED', message: event.message ?? 'Audio output stopped by the system' };
      effects.push({ type: 'writeParked', frame: s.parkedFrame });
      effects.push({ type: 'fail', code: 'CONTEXT_SUSPENDED', message: s.fault.message, fatal: false });
      return { state: s, effects };
    }

    case 'deadlineMiss': {
      // The scheduler could not keep up: fade out and stop at the heard frame.
      if (s.phase !== Phase.STARTING && s.phase !== Phase.PLAYING && s.phase !== Phase.SEEKING) return noOp();
      const heardFrame = Number.isFinite(event.heardFrame) ? event.heardFrame : s.parkedFrame;
      s.phase = Phase.STOPPING;
      s.generation += 1;
      s.fault = { code: 'DEADLINE_MISS', message: 'Playback could not keep up and stopped' };
      effects.push({
        type: 'stop', epoch: s.epoch, generation: s.generation,
        fadeOutFrames: event.fadeOutFrames ?? 0, atFrame: event.atFrame ?? null,
        park: 'heard', parkFrame: heardFrame,
      });
      effects.push({ type: 'fail', code: 'DEADLINE_MISS', message: s.fault.message, fatal: false });
      return { state: s, effects };
    }

    case 'fail': {
      // Unrecoverable: worklet processorerror, closed context, decode failure.
      s.phase = Phase.FAILED;
      s.isPlaying = false;
      s.generation += 1;
      s.fault = { code: event.code ?? 'FAILED', message: event.message ?? 'transport failed' };
      effects.push({ type: 'fail', code: s.fault.code, message: s.fault.message, fatal: true });
      return { state: s, effects };
    }

    case 'capacityError': {
      // The runtime could not allocate a voice: refuse WITHOUT disturbing audio.
      effects.push({ type: 'capacityError', code: event.code ?? 'POOL_EXHAUSTED', message: event.message ?? 'voice pool exhausted' });
      return { state, effects };
    }

    default:
      return noOp();
  }
}

/** True when `to` is a reachable phase from `from` (used by the transition test). */
export function isLegalTransition(from, to) {
  return legal(from, to);
}

// ---------------------------------------------------------------------------
// TransportMap: exact integer clock arithmetic (ctxFrame <-> transportFrame).
// ---------------------------------------------------------------------------

/**
 * A TransportMap translates between the playback line (context frames since the
 * epoch's musical start, `d >= 0`) and the musical timeline (transport frames),
 * unrolling loop passes with EXACT integer arithmetic so there is no drift after
 * any number of passes (Gate 8 T2: 10,000 passes, exact round trips).
 *
 * Loop semantics (the DAW convention): playback advances 1:1 and wraps ONLY at
 * the loop end `b` back to the loop start `a`, and only while `startFrame < b`:
 *
 *   * startFrame < a  : lead-in [startFrame, a) then infinite passes of [a, b).
 *   * a <= startFrame < b : a partial first pass [startFrame, b) then [a, b).
 *   * startFrame >= b : the loop is behind us; play linear (no wrap).
 *
 * `pass` counts wraps + 1 for the segment a transport frame lives in: pass 0 is
 * the first segment (which may be partial or include a lead-in), pass k>=1 is the
 * k-th full [a, b) repeat.
 */
export function createTransportMap({ startFrame = 0, loop = null, sampleRate = 48000 } = {}) {
  const s0 = Math.round(startFrame);
  const hasLoop = Array.isArray(loop) && loop[1] > loop[0] && s0 < loop[1];
  const a = hasLoop ? Math.round(loop[0]) : 0;
  const b = hasLoop ? Math.round(loop[1]) : 0;
  const L = hasLoop ? b - a : 0;
  // Length of the first segment on the playback line before full [a,b) repeats:
  //   startFrame < a   -> [startFrame, b) is the first segment (includes lead-in)
  //   startFrame >= a  -> [startFrame, b) is the first (partial) segment
  // Either way the first segment is [startFrame, b) and has length P0 = b - startFrame.
  const P0 = hasLoop ? b - s0 : 0;

  function toTransport(d) {
    if (!Number.isInteger(d) || d < 0) throw new RangeError(`playback offset ${d} must be a non-negative integer`);
    if (!hasLoop) return { frame: s0 + d, pass: 0 };
    if (d < P0) return { frame: s0 + d, pass: 0 };
    const rem = d - P0;
    const pass = 1 + Math.floor(rem / L);
    const off = rem - (pass - 1) * L; // rem mod L
    return { frame: a + off, pass };
  }

  function toCtx(frame, pass = 0) {
    const f = Math.round(frame);
    if (!hasLoop) return f - s0;
    if (pass === 0) return f - s0; // first segment [startFrame, b)
    const off = f - a; // [0, L)
    if (off < 0 || off >= L) throw new RangeError(`frame ${f} is outside loop pass ${pass}`);
    return P0 + (pass - 1) * L + off;
  }

  /** Playback-line offset where pass `p` (p>=1) begins. */
  function passStartCtx(p) {
    if (!hasLoop) return 0;
    if (p <= 0) return 0;
    return P0 + (p - 1) * L;
  }

  return {
    sampleRate,
    startFrame: s0,
    hasLoop,
    loopStart: hasLoop ? a : null,
    loopEnd: hasLoop ? b : null,
    loopLength: L,
    firstSegmentLength: P0,
    toTransport,
    toCtx,
    passStartCtx,
    /** transportFrame of a playback offset (convenience). */
    frameAt(d) { return toTransport(d).frame; },
  };
}

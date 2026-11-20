// js/realtime-engine.js — bounded real-time AudioWorklet transport engine.
//
// OPERATION CLOCKWORK (Milestone C1), repaired by OPERATION THE GOLDEN EAR II
// (Grok's independent C1 audit: N1-N6 plus lifecycle findings). The engine plays,
// stops, pauses, seeks and loops a non-destructive ProjectState arrangement over
// a BOUNDED voice pool, composing the pure, independently tested modules:
//
//   transport.js        command/state machine + TransportMap (exact loop unrolling)
//   voice-scheduler.js  occurrence planning, exact source frames, and the legal
//                       Signalsmith arm-now + one-future-stop pair
//   gate-envelope.js    transport anti-click ramp lengths and the loop seam window
//   voice-pool.js       strict voice ledger (allocated -> prepared -> sounding ->
//                       fading -> disconnected -> released)
//   offline-render.js   the SHARED downstream (EQ/pan/sum/limiter) and clip voice
//
// ONE clock authority: the AudioContext. Every audible event is a context time
// computed from integer frames through one epoch mapping. `setTimeout` only WAKES
// the scheduler; it never decides when anything sounds.
//
// Contracts (each is covered by an engine-level test instantiating this class):
//
//  * Play / Seek / loop change begin a new EPOCH record. Every async completion
//    carries the record it was started for; a completion for a record that is no
//    longer `this.active` (superseded or cancelled) is discarded and its nodes
//    are disconnected without ever being armed (no stale generation can sound).
//  * Seek: incoming voices are reserved, built and armed first. Only when they
//    are armed are the outgoing voices faded — over the SAME window the incoming
//    fade in, starting at the new epoch origin `now + startLead` (N1). If the
//    pool cannot hold both sides, the seek is refused with POOL_EXHAUSTED and
//    the current audible epoch is untouched (N5).
//  * Stop: every connected voice is faded from the CURRENT context time; the
//    scheduler services the pending stop on its own wake (even with no clip
//    events left), disconnects and releases the voices, then delivers `stopped`
//    which writes the parked cue exactly once (N2).
//  * Signalsmith: a DSP voice is built unarmed; just before arming, the engine
//    measures the real lead `t0 - currentTime`. A lead below the measured
//    priming floor is a DEADLINE MISS: the voice is never armed and the
//    transport stops explicitly (no silently attenuated start). Otherwise it
//    sends exactly two schedule() calls: an arm in the past with a compensated
//    (negative, zero-padded) input, and ONE future stop (N4).
//  * Loop wraps: a clip that crosses the loop end is played by two voices whose
//    sources are extended by half the seam window past b / before a, gated by
//    complementary linear ramps over [seam - N/2, seam + N/2] (N6).
//  * The pool slot is freed only after the voice's nodes are disconnected; the
//    count of connected processors can never exceed the pool capacity (N5).
//
// Non-finite safety: the limiter zeroes and counts non-finite samples and reports
// the first one immediately; the engine moves to FAILED, silences and releases
// every voice and calls `onFail`.

import { buildBackbone, buildClipVoice, applyClipEnvelope, MAX_CLIPS_PER_GRAPH } from './arrangement/offline-render.js';
import { createTransportState, transportReduce, createTransportMap, Phase } from './arrangement/transport.js';
import { occurrencesInWindow, sourceFrameAt, signalsmithScheduleSequence } from './arrangement/voice-scheduler.js';
import { VoicePool, VoiceState, deriveVoiceCapacity } from './voice-pool.js';
import {
  START_RAMP_FRAMES, STOP_RAMP_FRAMES, SEEK_RAMP_FRAMES, LOOP_XFADE_FRAMES, loopSeamWindow,
} from './arrangement/gate-envelope.js';

// ---------------------------------------------------------------------------
// Timing budget. Each term is kept separate and labelled with its provenance
// (Grok N4): measured, configured, or assumed. None of the assumed terms is a
// measurement and none is reported as one.
// ---------------------------------------------------------------------------

/** MEASURED: Signalsmith priming floor. A voice armed less than this before it is
 *  heard starts under-primed (C1 sweep: tonal + transient, rates 0.857/1.0/1.2,
 *  DEFAULT preset only; 21 ms reads ~-24 dB, 64 ms is within ~1 dB). */
export const MEASURED_PRIMING_FLOOR_MS = 64;
/** CONFIGURED: scheduler wake interval. Wakes the scheduler; never times audio. */
export const DEFAULT_WAKE_MS = 25;
/** ASSUMED (not measured): main-thread wake jitter allowance. */
export const ASSUMED_JITTER_ALLOWANCE_MS = 15;
/** ASSUMED (E1 measured 2.6-12.2 ms per live node; the batch budget is chosen):
 *  time allowed to construct and load a batch of voices before arming. */
export const ASSUMED_BUILD_BUDGET_MS = 40;
/**
 * Play/Seek START LEAD: a new epoch is heard this long after the command, so a
 * voice built inside the build budget still receives the measured priming lead.
 * 64 (measured) + 40 (assumed) = 104 ms. Historically called the "scheduling
 * horizon"; that name is kept for compatibility. It is NOT fully measured.
 */
export const SELECTED_SCHEDULING_HORIZON_MS = MEASURED_PRIMING_FLOOR_MS + ASSUMED_BUILD_BUDGET_MS;
/** ADMISSION window: occurrences starting within this of the heard position are
 *  built on this wake, so the NEXT wake (wake + jitter later) is never too late. */
export const ADMISSION_WINDOW_MS = SELECTED_SCHEDULING_HORIZON_MS + DEFAULT_WAKE_MS + ASSUMED_JITTER_ALLOWANCE_MS;
/** A bypass (AudioBufferSourceNode) start needs only to be ahead of the render
 *  cursor; two render quanta of lead are required. */
export const BYPASS_MIN_LEAD_FRAMES = 256;
/** Frames after a voice's gain reaches 0 before its nodes are disconnected. */
export const RELEASE_MARGIN_FRAMES = 1024;
/** Stretch range the priming floor was measured over (default preset). A rate
 *  outside it, or any pitch shift, plays but is reported as UNQUALIFIED. */
export const QUALIFIED_STRETCH_RATES = Object.freeze([0.857, 1.2]);

/** Kept for API compatibility (C1): one coherent context-time mapping. */
export function ctxTimeMapper({ epochStartCtxSec, epochStartFrame, sampleRate }) {
  return {
    epochStartCtxSec,
    epochStartFrame,
    sampleRate,
    secForOffset: (d) => epochStartCtxSec + d / sampleRate,
    secForFrame: (f) => epochStartCtxSec + (f - epochStartFrame) / sampleRate,
  };
}

/** Kept for API compatibility (C1): a unique voice key per creation. */
export function makeVoiceKey(clipId, pass, seq) {
  return `${clipId}:${pass}:${seq}`;
}

const ACTIVE_PHASES = new Set([Phase.STARTING, Phase.PLAYING, Phase.SEEKING]);

export class RealtimeEngine {
  /**
   * @param {BaseAudioContext} ctx live AudioContext (or OfflineAudioContext for
   *   suspend-driven verification)
   * @param {object} plan from compileRenderPlan
   * @param {Record<string,{channels:Float32Array[]}>} buffers decoded PCM by bufferReference
   * @param {object} options {StretchFactory, limiterModuleUrl, captureModuleUrl?,
   *   capture?, destination?, startLeadFrames?, wakeMs?, capacity?,
   *   onParked?, onCapacityError?, onFail?, onWarn?, onStateChange?,
   *   watchContextState?, timers?, horizonFrames? (alias of startLeadFrames)}
   */
  constructor(ctx, plan, buffers, options = {}) {
    this.ctx = ctx;
    this.plan = plan;
    this.buffers = buffers;
    this.options = options;
    this.sr = plan.sampleRate;
    const ms = (v) => Math.round((v / 1000) * this.sr);
    this._offline = 'startRendering' in ctx;
    this.primingLeadFrames = options.primingLeadFrames ?? ms(MEASURED_PRIMING_FLOOR_MS);
    // Clock granularity (REPORTED by the browser as baseLatency). A live
    // context renders in output-callback bursts (live Chromium here: steps of
    // 5.3-10.7 ms, baseLatency 10.0 ms), so a whole burst of context time can
    // pass while a batch is being armed (observed). The first-batch plan and the
    // default start lead reserve one burst for that; the per-voice check uses
    // the reading itself plus one render quantum. Offline clocks: 0.
    this.granularityFrames = options.clockGranularityFrames
      ?? (this._offline ? 0 : Math.round((ctx.baseLatency || 0) * this.sr));
    this.startLeadFrames = options.startLeadFrames ?? options.horizonFrames
      ?? (ms(SELECTED_SCHEDULING_HORIZON_MS) + this.granularityFrames);
    this.wakeMs = options.wakeMs ?? DEFAULT_WAKE_MS;
    this.admissionFrames = options.admissionFrames
      ?? (this.startLeadFrames + ms(this.wakeMs) + ms(ASSUMED_JITTER_ALLOWANCE_MS));
    this.horizonFrames = this.startLeadFrames; // compatibility alias
    this.releaseMarginFrames = options.releaseMarginFrames ?? RELEASE_MARGIN_FRAMES;
    this.minLoopFrames = Math.max(2 * this.admissionFrames, Math.round((60 / plan.masterBpm) * this.sr));

    const cap = deriveVoiceCapacity({
      // One handover partner per track: a seek next to a loop seam holds the old
      // pass, its loop-in partner and the new epoch at once (independent review
      // finding 3: 22 refused ordinary 8-track use). 8 tracks -> 28 <= 32.
      trackCount: plan.tracks.length, maxOverlappingPerTrack: 2, seamPartners: plan.tracks.length, tailReserve: 4,
    });
    this.capacityDerivation = cap;
    this.capacity = Math.min(options.capacity ?? cap.capacity, MAX_CLIPS_PER_GRAPH);
    this.pool = new VoicePool(this.capacity, { strict: true });

    this.transport = createTransportState({
      arrangementEndFrame: plan.output.arrangementEndFrame,
      loop: plan.loopRange ? this.#beatsToFrames(plan.loopRange) : null,
      sampleRate: this.sr,
    });

    this.backbone = null;
    this.active = null; // the current epoch record (null while stopped)
    this.voices = new Map(); // voice key -> voice record (every voice that holds a pool slot)
    this.pendingStop = null; // { parkFrame, endSec }
    this._seq = 0;
    this._epochSeq = 0;
    this._wakeTimer = null;
    // Wake-timer functions are injectable (tests drive them by hand); they only
    // ever wake the scheduler.
    this._timers = options.timers ?? {
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (id) => globalThis.clearTimeout(id),
    };
    this._inflight = new Set();
    this._disposed = false;

    this.deadlineMisses = 0;
    this.lateVoices = [];
    this.startDelays = [];
    this.clockCatchUpMaxSec = 0;
    this.armCosts = [];
    this.armBatches = [];
    this.nonFiniteSeen = 0;
    this.suppliedLeads = { dsp: [], bypass: [] };
    this.unqualified = new Map();
    this.peakConnected = 0;
    this.lifecycleLog = []; // completed voice histories (bounded)
    this.events = []; // bounded engine event log (diagnostics)

    this._onStateChange = () => this.#contextStateChanged();
    const watch = options.watchContextState ?? !this._offline;
    if (watch && typeof ctx.addEventListener === 'function') {
      ctx.addEventListener('statechange', this._onStateChange);
      this._watching = true;
    }
  }

  #beatsToFrames([a, b]) {
    const spb = (60 / this.plan.masterBpm) * this.sr;
    return [Math.round(a * spb), Math.round(b * spb)];
  }

  #log(type, detail = {}) {
    this.events.push({ type, at: this.ctx.currentTime, ...detail });
    if (this.events.length > 200) this.events.shift();
  }

  // ------------------------------------------------------------------ setup

  /** Prepare: build the shared backbone and load worklets. Silent. Idempotent. */
  async prepare() {
    this.#reduce({ type: 'prepare', plan: this.plan });
    if (!this.backbone) {
      try {
        this.backbone = await buildBackbone(this.ctx, this.plan, {
          ...this.options, capture: this.options.capture ?? false,
        });
      } catch (err) {
        this.#reduce({ type: 'fail', code: 'PREPARE_FAILED', message: String(err?.message ?? err) });
        throw err;
      }
    }
    await this.#warmStretch();
    await this.#probeClock();
    this.#reduce({ type: 'ready', parkedFrame: Math.round(this.transport.parkedFrame) });
    return this.state();
  }

  /**
   * Measured on live Chromium (Golden Ear II): the FIRST Signalsmith node in a
   * context costs ~61-67 ms (worklet module load + WASM compile), which made the
   * first Play miss its 64 ms priming lead. Prepare pays that once, silently:
   * one throwaway node is built, never connected to the output, and dropped.
   */
  /** Silent clock probe (live only): sample the clock for `clockProbeMs`. */
  async #probeClock() {
    const dur = this.options.clockProbeMs ?? (this._offline ? 0 : 150);
    if (!dur || this.ctx.state !== 'running') return;
    const end = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + dur;
    while ((typeof performance !== 'undefined' ? performance.now() : Date.now()) < end) {
      this.#observeClock();
      await new Promise((r) => globalThis.setTimeout(r, 2));
    }
  }

  async #warmStretch() {
    if (this._warmed || !this.options.StretchFactory) return;
    if (!this.plan.clips.some((c) => !(c.rate === 1 && c.pitchSemitones === 0))) return;
    const t = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const node = await this.options.StretchFactory(this.ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    node.disconnect?.();
    node.dropBuffers?.();
    this.warmupMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t;
    this._warmed = true;
  }

  state() {
    return {
      phase: this.transport.phase,
      epoch: this.transport.epoch,
      generation: this.transport.generation,
      isPlaying: this.transport.isPlaying,
      parkedFrame: this.transport.parkedFrame,
      cueFrame: this.transport.cueFrame,
      loop: this.transport.loop ? [...this.transport.loop] : null,
      fault: this.transport.fault,
    };
  }

  #reduce(event) {
    const before = this.transport.phase;
    const { state, effects } = transportReduce(this.transport, event);
    this.transport = state;
    for (const eff of effects) this.#execute(eff);
    if (this.transport.phase !== before) this.options.onStateChange?.(this.state());
    return this.transport;
  }

  #execute(eff) {
    switch (eff.type) {
      case 'start': this.#beginEpoch(eff.startFrame, 'start'); break;
      case 'seek': this.#beginEpoch(eff.seamFrame, 'seek'); break;
      case 'stop': this.#doStop(eff.parkFrame, eff.fadeOutFrames); break;
      case 'writeParked': this.options.onParked?.(eff.frame); break;
      case 'capacityError': this.options.onCapacityError?.(eff); break;
      case 'fail':
        if (eff.fatal) this.#doFail();
        if (eff.fatal) this.options.onFail?.(eff);
        else this.options.onWarn?.(eff);
        break;
      default: break;
    }
  }

  // ------------------------------------------------------------- commands

  /** Play from the cue (or `fromFrame`). Starts the scheduler explicitly. */
  play(fromFrame) {
    // A real-time context must be running for its clock to advance. An
    // OfflineAudioContext reports 'suspended' until (and between) render
    // quanta by design, so the check does not apply to it.
    if (!this._offline && this.ctx.state && this.ctx.state !== 'running') {
      this.#warn('CONTEXT_NOT_RUNNING', `audio context is ${this.ctx.state}; resume it before Play`);
      return this.transport;
    }
    const p = this.transport.phase;
    if (p !== Phase.STOPPED && p !== Phase.STOPPING) return this.#reduce({ type: 'play', fromFrame });
    const startFrame = Number.isFinite(fromFrame) ? Math.max(0, Math.round(fromFrame)) : this.transport.cueFrame;
    const refusal = this.#admissionCheck(startFrame, this.transport.loop);
    if (refusal) return this.#refuse(refusal);
    this.#reduce({ type: 'play', fromFrame: startFrame });
    this.#kick();
    return this.transport;
  }

  /** Stop: fade from now, return to the cue once the fade and cleanup complete. */
  stop(fadeOutFrames) {
    this.#reduce({ type: 'stop', fadeOutFrames });
    this.#kick();
    return this.transport;
  }

  /** Pause: like Stop but parks at the heard position. */
  pause(fadeOutFrames) {
    this.#reduce({ type: 'pause', heardFrame: Math.round(this.playhead()), fadeOutFrames });
    this.#kick();
    return this.transport;
  }

  /** Seek: while stopped moves the cue; while playing, a two-voice handover. */
  seek(frame) {
    if (!Number.isFinite(frame)) return this.transport;
    const target = Math.max(0, Math.round(frame));
    if (ACTIVE_PHASES.has(this.transport.phase)) {
      const refusal = this.#admissionCheck(target, this.transport.loop);
      if (refusal) return this.#refuse(refusal);
    }
    this.#reduce({ type: 'seek', frame: target });
    this.#kick();
    return this.transport;
  }

  /**
   * Set or clear the loop (transport frames [a, b) or null). While playing, the
   * active mapping is re-anchored at the position heard at `now + startLead`
   * through the normal two-voice handover, keeping the Stop cue.
   */
  setLoop(range) {
    const loop = range == null ? null : [Math.round(range[0]), Math.round(range[1])];
    if (loop && !(loop[1] - loop[0] >= this.minLoopFrames)) {
      return this.#refuse({
        code: 'LOOP_TOO_SHORT',
        message: `loop of ${loop ? loop[1] - loop[0] : 0} frames is shorter than the ${this.minLoopFrames}-frame minimum (one beat and twice the admission window)`,
      });
    }
    const playing = ACTIVE_PHASES.has(this.transport.phase) && this.active;
    let seam = null;
    if (playing) {
      seam = this.#frameAtCtx(this.ctx.currentTime + this.startLeadFrames / this.sr);
      const refusal = this.#admissionCheck(seam, loop);
      if (refusal) return this.#refuse(refusal);
    }
    this.#reduce({ type: 'setLoop', loop });
    if (playing) {
      this.#reduce({ type: 'seek', frame: seam, keepCue: true });
      this.#kick();
    }
    return this.transport;
  }

  // Reducer passthroughs (C1 API). The engine delivers these itself; calling
  // them by hand is only meaningful in the matching phase.
  started() { return this.#reduce({ type: 'started' }); }

  seekDone() { return this.#reduce({ type: 'seekDone' }); }

  stopped(parkedFrame) { return this.#reduce({ type: 'stopped', parkedFrame }); }

  #refuse({ code, message }) {
    this.#log('refused', { code });
    return this.#reduce({ type: 'capacityError', code, message });
  }

  #warn(code, message) {
    this.#log('warn', { code });
    this.options.onWarn?.({ type: 'fail', code, message, fatal: false });
  }

  // --------------------------------------------------------- epoch / map

  /** Context time -> transport frame heard then, through the active epoch. */
  #frameAtCtx(sec) {
    const rec = this.active;
    if (!rec) return this.transport.parkedFrame;
    const off = Math.max(0, Math.floor((sec - rec.originSec) * this.sr));
    return rec.map.toTransport(off).frame;
  }

  /** Transport frame being rendered now (display/pause; not the speaker time). */
  playhead() {
    if (!this.active || !ACTIVE_PHASES.has(this.transport.phase)) return this.transport.parkedFrame;
    return this.#frameAtCtx(this.ctx.currentTime);
  }

  /**
   * Capacity reservation BEFORE anything destructive (N5): the voices the new
   * epoch needs in its first admission window must fit beside every voice that
   * still holds a slot (the outgoing side keeps sounding until the handover).
   */
  #admissionCheck(startFrame, loop) {
    if (loop && loop[1] - loop[0] < this.minLoopFrames && startFrame < loop[1]) {
      return { code: 'LOOP_TOO_SHORT', message: `loop shorter than ${this.minLoopFrames} frames` };
    }
    const map = createTransportMap({ startFrame, loop, sampleRate: this.sr });
    const need = occurrencesInWindow(this.plan, map, 0, this.admissionFrames).length;
    if (!this.pool.canAcquire(need)) {
      this.pool.refusals += 1;
      return {
        code: 'POOL_EXHAUSTED',
        message: `voice pool exhausted: ${this.pool.stats().live} voices hold slots and the new position needs ${need} more (capacity ${this.capacity})`,
      };
    }
    return null;
  }

  #beginEpoch(startFrame, kind) {
    const prev = this.active;
    if (prev) prev.cancelled = true;
    this.pendingStop = null; // Play during a stop fade supersedes it (no writeParked)
    const now = this.ctx.currentTime;
    const originSec = now + this.startLeadFrames / this.sr;
    const map = createTransportMap({ startFrame, loop: this.transport.loop, sampleRate: this.sr });
    if (kind === 'seek') {
      for (const v of this.voices.values()) {
        if (!v.armed) continue; // in-flight builds of a superseded epoch are discarded on completion
        const epochUnheard = v.rec.originSec > now; // a superseded seek not yet heard
        const afterHandover = v.t0 >= originSec; // would only start after this handover
        if ((epochUnheard || afterHandover) && !(v.fadeScheduled && v.fadeAtSec <= now)) {
          // Never to be heard: cancel outright (gate stays 0). Upcoming voices of
          // the AUDIBLE epoch (a loop-in partner, the next clip) keep playing
          // until this handover — independent review finding 1 (dropout).
          this.#fadeVoice(v, now, 0);
        } else if (v.fadeScheduled && v.fadeByRec && v.fadeAtSec > now) {
          // Its handover to a superseded seek has not begun: retract it, so the
          // audio that is actually sounding keeps sounding until THIS handover.
          this.#rebaseGate(v, now);
        }
      }
    }
    const rec = {
      id: (this._epochSeq += 1),
      epoch: this.transport.epoch,
      generation: this.transport.generation,
      kind,
      startFrame,
      originSec,
      map,
      identities: new Set(),
      firstBatchDone: false,
      // Seek / loop retarget: the voices to hand over FROM, faded only once this
      // epoch's first batch is armed. Play: old voices are already fading.
      outgoing: kind === 'seek'
        ? [...this.voices.values()].filter((v) => v.armed && !v.fadeScheduled)
        : [],
      cancelled: false,
      deliveredStart: false,
    };
    if (kind === 'start') {
      // Defensive: a Play while voices are still audible (not reachable via the
      // reducer except Play-during-Stop, whose voices are already fading).
      for (const v of this.voices.values()) if (!v.fadeScheduled) this.#fadeVoice(v, this.ctx.currentTime, STOP_RAMP_FRAMES);
    }
    this.active = rec;
    this.#log('epoch', { id: rec.id, kind, startFrame, originSec });
  }

  // ----------------------------------------------------------- scheduler

  /** Start the wake loop (if not running) and run one service pass now. */
  #kick() {
    this.#ensureScheduler();
    void this.tick();
  }

  #ensureScheduler() {
    if (this._wakeTimer || this._disposed) return;
    const step = async () => {
      this._wakeTimer = null;
      if (this._disposed) return;
      const pass = this.tick();
      // Re-arm BEFORE awaiting: a fill that hangs must never stop the wakes
      // (independent review finding 2).
      if (this.#needsService()) this.#ensureScheduler();
      await pass;
      if (this.#needsService()) this.#ensureScheduler();
    };
    this._wakeTimer = this._timers.setTimeout(step, this.wakeMs);
  }

  #needsService() {
    return !this._disposed && (ACTIVE_PHASES.has(this.transport.phase)
      || this.pendingStop !== null || this.voices.size > 0);
  }

  /** True while the wake loop is scheduled. */
  schedulerRunning() { return this._wakeTimer !== null; }

  /** Host control (C1 API): start the wake loop explicitly. */
  startSchedulerLoop() { this.#ensureScheduler(); }

  /** Host control (C1 API): stop the wake loop (dispose also does this). */
  stopSchedulerLoop() {
    if (this._wakeTimer) this._timers.clearTimeout(this._wakeTimer);
    this._wakeTimer = null;
  }

  /**
   * One scheduler pass: service lifecycle + pending stop + reducer deliveries,
   * then fill the active epoch's admission window. Each epoch fills on its own
   * (a new seek never queues behind a superseded epoch's builds, which would eat
   * its priming lead). Never times audio.
   */
  tick() {
    this.#service();
    const rec = this.active;
    const fill = rec && ACTIVE_PHASES.has(this.transport.phase) ? this.#fillLoop(rec) : Promise.resolve();
    return fill.then(() => this.#service());
  }

  #fillLoop(rec) {
    if (rec.filling) { rec.fillAgain = true; return rec.filling; }
    rec.filling = (async () => {
      try {
        do {
          rec.fillAgain = false;
          await this.#fill(rec);
        } while (rec.fillAgain && rec === this.active && !rec.cancelled && !this._disposed);
      } finally {
        rec.filling = null;
      }
    })();
    this._inflight.add(rec.filling);
    const done = rec.filling;
    done.finally(() => this._inflight.delete(done));
    return done;
  }

  /** Await every in-flight fill and build (test / harness convenience). */
  async settle() {
    for (let i = 0; i < 50 && this._inflight.size; i += 1) {
      await Promise.allSettled([...this._inflight]);
    }
  }

  /** Observe how far the context clock jumps relative to wall time (measured
   *  catch-up), so the first-batch reserve reflects THIS device's behaviour. */
  #observeClock() {
    if (this._offline) return;
    const wall = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    const c = this.ctx.currentTime;
    if (this._clockPrev && wall - this._clockPrev.wall < 0.2) {
      const excess = (c - this._clockPrev.c) - (wall - this._clockPrev.wall);
      if (excess > this.clockCatchUpMaxSec) this.clockCatchUpMaxSec = excess;
    }
    this._clockPrev = { c, wall };
  }

  #service() {
    if (this._disposed) return;
    this.#observeClock();
    const now = this.ctx.currentTime;
    this.#checkNonFinite();
    for (const v of [...this.voices.values()]) {
      if (v.armed && v.fadeScheduled && v.fadeAtSec != null && now >= v.fadeAtSec
        && (v.state === VoiceState.PREPARED || v.state === VoiceState.SOUNDING)) {
        this.#advance(v, VoiceState.FADING);
      }
      if (v.armed && v.state === VoiceState.PREPARED && now >= v.t0) this.#advance(v, VoiceState.SOUNDING);
      if (v.armed && !v.fadeScheduled && now >= v.t1) {
        // Natural end: clip gain is already 0 at t1; the voice is its tail now.
        v.fadeScheduled = true;
        v.fadeAtSec = v.t1;
        v.releaseAtSec = v.t1 + this.releaseMarginFrames / this.sr;
        if (v.state === VoiceState.PREPARED || v.state === VoiceState.SOUNDING) this.#advance(v, VoiceState.FADING);
      }
      if (v.releaseAtSec != null && now >= v.releaseAtSec) this.#releaseVoice(v);
    }
    this.#trackPeak();

    const rec = this.active;
    const phase = this.transport.phase;
    if (rec && rec.firstBatchDone) {
      if (phase === Phase.STARTING && now >= rec.originSec) this.#reduce({ type: 'started' });
      else if (phase === Phase.SEEKING && now >= rec.originSec + SEEK_RAMP_FRAMES / this.sr) this.#reduce({ type: 'seekDone' });
    }
    if (rec && this.transport.phase === Phase.PLAYING && !rec.map.hasLoop) {
      const heardOffset = (now - rec.originSec) * this.sr;
      if (heardOffset >= this.plan.output.arrangementEndFrame - rec.startFrame) {
        this.#log('arrangementEnd');
        this.#reduce({ type: 'arrangementEnd' });
      }
    }
    if (this.pendingStop && now >= this.pendingStop.endSec + this.releaseMarginFrames / this.sr) {
      // Every connected voice was faded by the stop; release any still holding nodes.
      for (const v of [...this.voices.values()]) if (v.nodesConnected) this.#releaseVoice(v);
      if (![...this.voices.values()].some((v) => v.nodesConnected)) {
        const { parkFrame } = this.pendingStop;
        this.pendingStop = null;
        this.#reduce({ type: 'stopped', parkedFrame: parkFrame }); // writeParked -> onParked, once
      }
    }
  }

  // ----------------------------------------------------------- fill

  /** Voice geometry for an occurrence: loop-seam extensions and gate kinds. */
  #voicePlan(rec, occ) {
    const clip = this.plan.clips.find((c) => c.clipId === occ.clipId);
    const { map } = rec;
    const half = Math.floor(LOOP_XFADE_FRAMES / 2);
    let pre = 0; let post = 0;
    const loopIn = map.hasLoop && occ.pass >= 1 && occ.outStart === map.loopStart
      && clip.timelineStartFrame < map.loopStart;
    // A crossfade PAIR needs material on both sides of the seam: the clip must
    // start before a (its next pass pre-rolls) AND end after b (this pass
    // post-rolls). A clip that crosses b but not a has no partner (its next pass
    // starts naturally at a): it fades out over [b - N, b] with no post-roll, so
    // the track's gain never exceeds 1 at the seam (review re-check: a clip
    // starting exactly at a summed to 1.5).
    const crossesB = map.hasLoop && occ.outEnd === map.loopEnd && clip.timelineEndFrame > map.loopEnd;
    const loopOut = crossesB && clip.timelineStartFrame < map.loopStart;
    const loopEnd = crossesB && !loopOut;
    if (loopIn) pre = Math.min(half, map.loopStart - clip.timelineStartFrame, occ.ctxStart);
    if (loopOut) post = Math.min(half, clip.timelineEndFrame - map.loopEnd);
    const epochIn = occ.ctxStart === 0;
    const startOffset = occ.ctxStart - pre;
    const endOffset = occ.ctxEnd + post;
    return {
      clip,
      startOffset,
      endOffset,
      sourceStart: sourceFrameAt(clip, occ.outStart - pre),
      sourceEnd: sourceFrameAt(clip, occ.outEnd + post),
      inKind: epochIn ? (rec.kind === 'seek' ? 'handover-in' : 'start') : (loopIn ? 'loop-in' : 'open'),
      outKind: loopOut ? 'loop-out' : (loopEnd ? 'loop-end' : 'natural'),
      // A seam extension that reaches the clip's own edge keeps the clip's
      // musical fade there (review finding 4: a hard onset at up to 0.5 gain).
      naturalStart: occ.outStart - pre === clip.timelineStartFrame,
      naturalEnd: occ.outEnd + post === clip.timelineEndFrame,
      seamInCtxFrame: loopIn ? occ.ctxStart : null,
      seamOutCtxFrame: (loopOut || loopEnd) ? occ.ctxEnd : null,
    };
  }

  async #fill(rec) {
    const now = this.ctx.currentTime;
    const heard = Math.max(0, Math.floor((now - rec.originSec) * this.sr));
    const occs = occurrencesInWindow(this.plan, rec.map, heard, heard + this.admissionFrames);
    const batch = [];
    for (const occ of occs) {
      const identity = `${occ.clipId}:${occ.pass}:${occ.outStart}`;
      if (rec.identities.has(identity)) continue;
      const vp = this.#voicePlan(rec, occ);
      const alloc = this.pool.acquire({
        epoch: rec.epoch, generation: rec.generation,
        bytes: (vp.sourceEnd - vp.sourceStart) * 8, clipId: occ.clipId,
      });
      if (!alloc.ok) {
        // NOT marked scheduled: the occurrence is retried on the next wake, and
        // reported as a deadline miss if it can no longer be armed in time.
        if (!rec.refusalReported) {
          rec.refusalReported = true;
          this.#reduce({ type: 'capacityError', code: alloc.code, message: alloc.error.message });
        }
        break;
      }
      rec.identities.add(identity); // marked only after a successful allocation
      const key = makeVoiceKey(occ.clipId, occ.pass, (this._seq += 1));
      const v = {
        key, poolId: alloc.voice.id, rec, identity, clipId: occ.clipId, pass: occ.pass,
        trackIndex: occ.trackIndex, occ, vp, state: VoiceState.ALLOCATED,
        t0: rec.originSec + vp.startOffset / this.sr,
        t1: rec.originSec + vp.endOffset / this.sr,
        armed: false, nodesConnected: false, fadeScheduled: false, releaseAtSec: null,
        history: [VoiceState.ALLOCATED],
      };
      this.voices.set(key, v);
      batch.push(v);
    }
    // A build that does not finish within the timeout is a failure, reported
    // explicitly (never a silent skip); its node is disconnected if it arrives.
    const timeoutMs = this.options.buildTimeoutMs ?? 1000;
    const builds = batch.map((v) => new Promise((resolve) => {
      const t = globalThis.setTimeout(() => { v.buildTimedOut = true; resolve(false); }, timeoutMs);
      this.#build(v).then((ok) => { globalThis.clearTimeout(t); resolve(ok && !v.buildTimedOut); });
    }));
    const settled = await Promise.all(builds);
    if (rec !== this.active || rec.cancelled || this._disposed) {
      for (const v of batch) if (!v.armed) this.#discard(v, 'stale');
      return;
    }
    if (!this.backbone) return;
    if (settled.some((ok) => !ok)) {
      // A voice that cannot be built is never skipped silently: fail explicitly.
      for (const v of batch) if (!v.armed) this.#discard(v, 'build-failed');
      const timedOut = batch.some((v) => v.buildTimedOut);
      this.#reduce({ type: 'fail', code: timedOut ? 'VOICE_BUILD_TIMEOUT' : 'VOICE_BUILD_FAILED', message: timedOut ? `a clip voice was not built within ${timeoutMs} ms` : 'a clip voice could not be constructed' });
      return;
    }
    if (!rec.firstBatchDone && batch.length) this.#reanchorIfLate(rec, batch);
    // Arm in order; a late voice in a sounding epoch stops the transport explicitly.
    const wall = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const armStart = wall();
    const ctxStart = this.ctx.currentTime;
    for (let i = 0; i < batch.length; i += 1) {
      const v = batch[i];
      const t = wall();
      this.#observeClock();
      const ok = this.#arm(v);
      this.armCosts.push({ wallMs: wall() - t, dsp: !!v.needsDsp });
      if (this.armCosts.length > 256) this.armCosts.shift();
      if (!ok) {
        for (const w of batch.slice(i)) if (!w.armed) this.#discard(w, 'late');
        this.#deadlineMiss(rec);
        return;
      }
    }
    if (batch.length) this.armBatches.push({ n: batch.length, wallMs: wall() - armStart, ctxAdvancedMs: (this.ctx.currentTime - ctxStart) * 1000 });
    if (this.armBatches.length > 64) this.armBatches.shift();
    if (!rec.firstBatchDone) {
      rec.firstBatchDone = true;
      // Seek handover (N1): fade the outgoing side over the SAME window the
      // incoming voices fade in, from the new origin — now + startLead.
      for (const v of rec.outgoing) {
        if (this.voices.has(v.key) && !v.fadeScheduled) this.#fadeVoice(v, rec.originSec, SEEK_RAMP_FRAMES, rec);
      }
      rec.outgoing = [];
    }
  }

  /** Build a voice's nodes (unarmed). Resolves true on success. */
  #build(v) {
    const { vp, occ } = v;
    const source = this.buffers[occ.bufferReference];
    const p = (async () => {
      try {
        if (!source) throw new Error(`no buffer for ${occ.bufferReference}`);
        v.clipSpec = {
          clipGainLinear: occ.clipGainLinear,
          fadeInFrames: vp.naturalStart ? occ.fadeInFrames : 0,
          fadeOutFrames: vp.naturalEnd ? occ.fadeOutFrames : 0,
        };
        const voice = await buildClipVoice(this.ctx, {
          clipId: occ.clipId,
          sourceStartFrame: vp.sourceStart,
          sourceEndFrame: vp.sourceEnd,
          timelineStartFrame: vp.startOffset,
          timelineDurationFrames: vp.endOffset - vp.startOffset,
          rate: occ.rate,
          pitchSemitones: occ.semitones,
          preserveFormants: occ.preserveFormants,
          clipGainLinear: occ.clipGainLinear,
          fadeInFrames: vp.naturalStart ? occ.fadeInFrames : 0,
          fadeOutFrames: vp.naturalEnd ? occ.fadeOutFrames : 0,
          sampleRate: this.sr,
        }, { channels: source.channels }, {
          StretchFactory: this.options.StretchFactory,
          dspBypass: true,
          arm: false,
          timeOriginSec: v.rec.originSec,
          sampleRate: this.sr,
        });
        if (!this.voices.has(v.key) || v.buildTimedOut) {
          // Released while building (dispose): never leave the node connected.
          voice.head?.disconnect?.();
          voice.clipGain?.disconnect?.();
          voice.stretch?.dropBuffers?.();
          return false;
        }
        v.head = voice.head;
        v.stretch = voice.stretch;
        v.clipGain = voice.clipGain;
        v.needsDsp = voice.needsDsp;
        v.nodesConnected = true; // head -> clipGain exists from here on
        return true;
      } catch (err) {
        this.#log('buildFailed', { clipId: occ.clipId, message: String(err?.message ?? err) });
        return false;
      }
    })();
    this._inflight.add(p);
    p.finally(() => this._inflight.delete(p));
    return p;
  }

  /**
   * Explicit recovery for a slow FIRST batch (measured on live Chromium: eight
   * Signalsmith nodes built together take up to ~47 ms, more than the assumed
   * 40 ms budget). Nothing of this epoch is time-bound yet — no gate, envelope
   * or schedule() call exists — so its origin can move later as a whole. The
   * origin is shifted by the shortfall plus one clock-granularity margin, the
   * delay is recorded and reported as START_DELAYED. A late voice in an epoch
   * that is already sounding cannot be shifted; that stays a deadline miss.
   */
  #reanchorIfLate(rec, batch) {
    const now = this.ctx.currentTime;
    // Plan against the per-voice requirement (priming + one quantum) plus a
    // CLOCK RESERVE: the larger of two reported bursts (baseLatency) and the
    // MEASURED largest catch-up of this context's clock (probed in prepare and
    // observed on every wake; headless Chromium measured 17.6-22.8 ms). Context
    // time can advance that much while a batch is being armed.
    const reserve = this.#clockReserveFrames();
    let shortfall = 0;
    for (const v of batch) {
      const need = ((v.needsDsp ? this.primingLeadFrames : BYPASS_MIN_LEAD_FRAMES) + 128 + reserve) / this.sr;
      shortfall = Math.max(shortfall, need - (v.t0 - now));
    }
    if (shortfall <= 0) return;
    const shift = shortfall + 128 / this.sr;
    rec.originSec += shift;
    for (const v of this.voices.values()) {
      if (v.rec !== rec) continue;
      v.t0 += shift;
      v.t1 += shift;
    }
    rec.startDelayedMs = (rec.startDelayedMs ?? 0) + shift * 1000;
    this.startDelays.push(rec.startDelayedMs);
    if (this.startDelays.length > 64) this.startDelays.shift();
    this.#warn('START_DELAYED', `first voices were built late; this ${rec.kind} is heard ${(shift * 1000).toFixed(1)} ms later than the ${((this.startLeadFrames / this.sr) * 1000).toFixed(0)} ms target so every voice keeps its priming lead`);
  }

  #clockReserveFrames() {
    return Math.max(2 * this.granularityFrames, Math.ceil(this.clockCatchUpMaxSec * this.sr));
  }

  /**
   * Measure the real lead and arm, or refuse a late voice (N4). DSP voices get
   * the legal Signalsmith pair: arm in the past (input compensated, so the
   * region's first source frame lands exactly at t0) + ONE future stop.
   */
  #arm(v) {
    const now = this.ctx.currentTime;
    const leadFrames = (v.t0 - now) * this.sr;
    // The reading is the render position; a message posted now is handled
    // before later frames are rendered, so it can overstate the lead by at most
    // one render quantum (128 frames).
    const requiredFrames = (v.needsDsp ? this.primingLeadFrames : BYPASS_MIN_LEAD_FRAMES) + 128;
    if (leadFrames < requiredFrames) {
      this.deadlineMisses += 1;
      this.lateVoices.push({
        clipId: v.clipId, pass: v.pass, needsDsp: v.needsDsp,
        leadMs: (leadFrames / this.sr) * 1000, requiredMs: (requiredFrames / this.sr) * 1000,
      });
      this.#log('late', { clipId: v.clipId, leadMs: (leadFrames / this.sr) * 1000 });
      return false;
    }
    applyClipEnvelope(v.clipGain.gain, v.clipSpec, v.t0, v.t1, this.sr);
    const gate = this.ctx.createGain();
    gate.gain.value = 0; // a fresh, unconnected node: not a write on a running graph
    v.gate = gate;
    v.gateEvents = [];
    this.#applyGatePlan(v);
    v.clipGain.connect(gate);
    gate.connect(this.backbone.trackInputs[v.trackIndex]);
    if (v.stretch) {
      const seq = signalsmithScheduleSequence(
        {
          ctxStart: 0, ctxEnd: v.vp.endOffset - v.vp.startOffset, sourceStart: 0,
          rate: v.occ.rate, semitones: v.occ.semitones, preserveFormants: v.occ.preserveFormants,
        },
        { nowSec: now, sampleRate: this.sr, originSec: v.t0 },
      );
      v.stretch.schedule(seq.arm);
      v.stretch.schedule(seq.stop);
      v.scheduleCalls = 2;
      this.suppliedLeads.dsp.push((leadFrames / this.sr) * 1000);
      this.#noteQualification(v);
    } else {
      v.head.start(v.t0, 0);
      v.head.stop(v.t1 + this.releaseMarginFrames / this.sr);
      this.suppliedLeads.bypass.push((leadFrames / this.sr) * 1000);
    }
    if (this.suppliedLeads.dsp.length > 512) this.suppliedLeads.dsp.shift();
    if (this.suppliedLeads.bypass.length > 512) this.suppliedLeads.bypass.shift();
    v.armed = true;
    this.#advance(v, VoiceState.PREPARED);
    return true;
  }

  #noteQualification(v) {
    const r = v.occ.rate;
    const ok = r >= QUALIFIED_STRETCH_RATES[0] && r <= QUALIFIED_STRETCH_RATES[1] && v.occ.semitones === 0;
    if (!ok && !this.unqualified.has(v.clipId)) {
      this.unqualified.set(v.clipId, { rate: r, semitones: v.occ.semitones });
      this.#warn('STRETCH_UNQUALIFIED', `clip ${v.clipId}: rate ${r} / ${v.occ.semitones} st is outside the measured priming range (rates ${QUALIFIED_STRETCH_RATES.join('-')}, 0 st, default preset)`);
    }
  }

  // Gate automation goes through these helpers, which mirror every event in JS.
  // Reason (found on real Chromium worklets, not in the simulation):
  // cancelAndHoldAtTime(t) with no event after t does not insert a hold point
  // at t, so a following linearRampToValueAtTime would ramp from the PREVIOUS
  // event (e.g. a start ramp ending seconds earlier) — a one-second fade where a
  // 5 ms handover was intended. The mirror gives the exact held value, and an
  // explicit setValueAtTime(held, t) anchors the ramp in every implementation.
  #gateSet(v, val, t) { v.gate.gain.setValueAtTime(val, t); v.gateEvents.push({ type: 'set', v: val, t }); }

  #gateRamp(v, val, t) { v.gate.gain.linearRampToValueAtTime(val, t); v.gateEvents.push({ type: 'linear', v: val, t }); }

  #gateValueAt(v, t) {
    let prevV = 0; let prevT = 0;
    for (const e of v.gateEvents) {
      if (e.t > t) {
        if (e.type === 'linear') return e.t - prevT <= 0 ? e.v : prevV + ((e.v - prevV) * (t - prevT)) / (e.t - prevT);
        return prevV;
      }
      prevV = e.v; prevT = e.t;
    }
    return prevV;
  }

  #gateHold(v, t) {
    const held = this.#gateValueAt(v, t);
    v.gate.gain.cancelAndHoldAtTime(t);
    v.gateEvents = v.gateEvents.filter((e) => e.t < t);
    // A ramp in progress across t is truncated to end at t with `held`.
    this.#gateSet(v, held, t);
    return held;
  }

  /** The voice's own transport-gate automation (in-ramp, loop-out ramp). */
  #gatePlan(v) {
    const { rec, vp } = v;
    const sr = this.sr;
    const ev = [];
    const ramp = (from, to, t, frames) => {
      ev.push({ type: 'set', v: from, t });
      ev.push({ type: 'linear', v: to, t: t + frames / sr });
    };
    if (vp.inKind === 'start') ramp(0, 1, v.t0, START_RAMP_FRAMES);
    else if (vp.inKind === 'handover-in') ramp(0, 1, v.t0, SEEK_RAMP_FRAMES);
    else if (vp.inKind === 'loop-in') ramp(0, 1, rec.originSec + loopSeamWindow(vp.seamInCtxFrame) / sr, LOOP_XFADE_FRAMES);
    else ev.push({ type: 'set', v: 1, t: v.t0 }); // interior natural start: the clip fade shapes it
    if (vp.outKind === 'loop-out') ramp(1, 0, rec.originSec + loopSeamWindow(vp.seamOutCtxFrame) / sr, LOOP_XFADE_FRAMES);
    else if (vp.outKind === 'loop-end') ramp(1, 0, rec.originSec + (vp.seamOutCtxFrame - LOOP_XFADE_FRAMES) / sr, LOOP_XFADE_FRAMES);
    return ev;
  }

  #applyGatePlan(v, fromSec = -Infinity) {
    for (const e of this.#gatePlan(v)) {
      if (e.t <= fromSec) continue;
      if (e.type === 'set') this.#gateSet(v, e.v, e.t);
      else this.#gateRamp(v, e.v, e.t);
    }
  }

  /** Retract a not-yet-begun fade: hold the current value, re-apply the voice's
   *  own remaining automation (continuous: ramps resume from the held value). */
  #rebaseGate(v, now) {
    this.#gateHold(v, now);
    this.#applyGatePlan(v, now);
    v.fadeScheduled = false;
    v.fadeAtSec = null;
    v.fadeByRec = null;
    v.releaseAtSec = null;
  }

  /** Fade a voice's transport gate to 0 from `atSec` (held value, linear). */
  #fadeVoice(v, atSec, frames, byRec = null) {
    v.fadeScheduled = true;
    v.fadeAtSec = atSec;
    v.fadeByRec = byRec;
    const end = atSec + frames / this.sr;
    if (v.gate) {
      this.#gateHold(v, atSec);
      this.#gateRamp(v, 0, end);
    }
    v.releaseAtSec = Math.min(v.releaseAtSec ?? Infinity, end + this.releaseMarginFrames / this.sr);
  }

  #advance(v, to) {
    this.pool.advance(v.poolId, to);
    v.state = to;
    v.history.push(to);
  }

  /** Disconnect a voice's nodes, then (and only then) free its slot. */
  #releaseVoice(v) {
    if (!this.voices.has(v.key)) return;
    v.head?.disconnect?.();
    v.clipGain?.disconnect?.();
    v.gate?.disconnect?.();
    v.stretch?.dropBuffers?.();
    v.nodesConnected = false;
    this.#advance(v, VoiceState.DISCONNECTED);
    const history = this.pool.releaseDisconnected(v.poolId);
    this.voices.delete(v.key);
    this.lifecycleLog.push({ key: v.key, history });
    if (this.lifecycleLog.length > 256) this.lifecycleLog.shift();
  }

  /** A voice that must never sound (stale / late / failed): drop it now. */
  #discard(v, reason) {
    this.#log('discard', { clipId: v.clipId, reason });
    this.#releaseVoice(v);
  }

  #deadlineMiss(rec) {
    if (rec !== this.active || !ACTIVE_PHASES.has(this.transport.phase)) return;
    this.#reduce({ type: 'deadlineMiss', heardFrame: Math.round(this.playhead()) });
  }

  #doStop(parkFrame, fadeOutFrames) {
    if (this.active) this.active.cancelled = true;
    this.active = null;
    const now = this.ctx.currentTime;
    const frames = fadeOutFrames || STOP_RAMP_FRAMES;
    for (const v of this.voices.values()) {
      if (v.nodesConnected || v.armed) this.#fadeVoice(v, now, frames);
    }
    this.pendingStop = { parkFrame, endSec: now + frames / this.sr };
    this.#log('stop', { parkFrame });
  }

  #doFail() {
    if (this.active) this.active.cancelled = true;
    this.active = null;
    this.pendingStop = null;
    const now = this.ctx.currentTime;
    for (const v of this.voices.values()) if (v.nodesConnected || v.armed) this.#fadeVoice(v, now, START_RAMP_FRAMES);
    this.#ensureScheduler(); // keep servicing until every voice is released
  }

  #trackPeak() {
    let n = 0;
    for (const v of this.voices.values()) if (v.nodesConnected) n += 1;
    if (n > this.peakConnected) this.peakConnected = n;
    this.connectedNow = n;
  }

  #checkNonFinite() {
    if (!this.backbone) return;
    for (const s of this.backbone.limiterStats) {
      if (s.nonFiniteCount && s.nonFiniteCount > this.nonFiniteSeen) {
        this.nonFiniteSeen = s.nonFiniteCount;
        if (this.transport.phase !== Phase.FAILED) {
          this.#reduce({ type: 'fail', code: 'NON_FINITE', message: `non-finite sample at output index ${s.firstNonFiniteIndex}` });
        }
      }
    }
    this.backbone.limiterStats.length = 0; // consumed (bounded)
  }

  #contextStateChanged() {
    const st = this.ctx.state;
    if (st === 'closed') {
      this.#hardSilence();
      if (this.transport.phase !== Phase.FAILED) this.#reduce({ type: 'fail', code: 'CONTEXT_CLOSED', message: 'audio context closed' });
      return;
    }
    if (st === 'suspended' || st === 'interrupted') {
      const p = this.transport.phase;
      if (!ACTIVE_PHASES.has(p) && p !== Phase.STOPPING) return;
      const heard = Math.round(this.playhead());
      const park = p === Phase.STOPPING && this.pendingStop ? this.pendingStop.parkFrame : heard;
      this.#hardSilence();
      this.#reduce({ type: 'contextSuspended', heardFrame: park, message: `audio output ${st} by the system` });
    }
  }

  /** Rendering is halted (suspended/closed): disconnecting cannot click. */
  #hardSilence() {
    if (this.active) this.active.cancelled = true;
    this.active = null;
    this.pendingStop = null;
    for (const v of [...this.voices.values()]) {
      if (v.state !== VoiceState.ALLOCATED || v.nodesConnected) {
        v.fadeScheduled = true;
        this.#releaseVoice(v);
      }
    }
  }

  // ----------------------------------------------------------- reporting

  diagnostics() {
    const dsp = this.suppliedLeads.dsp;
    const byp = this.suppliedLeads.bypass;
    const ms = (f) => (f / this.sr) * 1000;
    const outMs = Number.isFinite(this.ctx.outputLatency) ? this.ctx.outputLatency * 1000 : null;
    const limiterMs = this.backbone ? ms(this.backbone.limiterLatencyFrames) : null;
    return {
      state: this.state(),
      pool: this.pool.stats(),
      capacity: this.capacity,
      capacityDerivation: this.capacityDerivation,
      graphLimit: MAX_CLIPS_PER_GRAPH,
      connectedProcessors: this.connectedNow ?? 0,
      peakConnectedProcessors: this.peakConnected,
      voices: [...this.voices.values()].map((v) => ({ key: v.key, clipId: v.clipId, pass: v.pass, state: v.state, epoch: v.rec.id })),
      timing: {
        primingLeadMs: { value: ms(this.primingLeadFrames), provenance: 'measured (default preset, rates 0.857-1.2, 0 st)' },
        buildBudgetMs: { value: ASSUMED_BUILD_BUDGET_MS, provenance: 'assumed' },
        clockGranularityMs: { value: ms(this.granularityFrames), provenance: 'reported by the browser (baseLatency); 0 offline' },
        clockCatchUpMaxMs: { value: this.clockCatchUpMaxSec * 1000, provenance: 'measured on this context (prepare probe + every wake)' },
        firstBatchReserveMs: { value: ms(this.#clockReserveFrames()), provenance: 'max(2 x reported burst, measured catch-up)' },
        startLeadMs: { value: ms(this.startLeadFrames), provenance: 'derived: priming (measured) + build budget (assumed) + one clock burst (reported)' },
        requiredDspLeadMs: { value: ms(this.primingLeadFrames + 128), provenance: 'priming floor (measured) + one render quantum' },
        wakeIntervalMs: { value: this.wakeMs, provenance: 'configured' },
        jitterAllowanceMs: { value: ASSUMED_JITTER_ALLOWANCE_MS, provenance: 'assumed, not measured' },
        admissionWindowMs: { value: ms(this.admissionFrames), provenance: 'derived' },
        deviceOutputLatencyMs: { value: outMs, provenance: 'reported by the browser, not measured' },
        limiterLatencyMs: { value: limiterMs, provenance: 'configured lookahead' },
        audiblePlayResponseMs: { value: outMs == null ? null : ms(this.startLeadFrames) + outMs + (limiterMs ?? 0), provenance: 'estimate: start lead + output + limiter; not measured at the speaker' },
        audibleStopResponseMs: { value: outMs == null ? null : ms(STOP_RAMP_FRAMES) + outMs + (limiterMs ?? 0), provenance: 'estimate: stop ramp + output + limiter; not measured at the speaker' },
        suppliedDspLeadMs: dsp.length ? { min: Math.min(...dsp), max: Math.max(...dsp), count: dsp.length } : null,
        suppliedBypassLeadMs: byp.length ? { min: Math.min(...byp), max: Math.max(...byp), count: byp.length } : null,
      },
      deadlineMisses: this.deadlineMisses,
      lateVoices: this.lateVoices.slice(-16),
      stretchWarmupMs: this.warmupMs ?? null,
      startDelaysMs: this.startDelays.slice(-16),
      clockCatchUpMaxMs: this.clockCatchUpMaxSec * 1000,
      armCosts: this.armCosts.slice(-16),
      armBatches: this.armBatches.slice(-8),
      unqualifiedStretch: [...this.unqualified.entries()].map(([clipId, d]) => ({ clipId, ...d })),
      nonFiniteSeen: this.nonFiniteSeen,
      schedulerRunning: this.schedulerRunning(),
      minLoopFrames: this.minLoopFrames,
      lifecycleLog: this.lifecycleLog.slice(-32),
      events: this.events.slice(-32),
      // C1 compatibility fields
      horizonFrames: this.horizonFrames,
      selectedHorizonMs: SELECTED_SCHEDULING_HORIZON_MS,
      wakeMs: this.wakeMs,
      maxClipsPerGraph: MAX_CLIPS_PER_GRAPH,
    };
  }

  dispose() {
    this._disposed = true;
    this.stopSchedulerLoop();
    if (this._watching) this.ctx.removeEventListener?.('statechange', this._onStateChange);
    if (this.active) this.active.cancelled = true;
    this.active = null;
    this.pendingStop = null;
    for (const v of [...this.voices.values()]) {
      v.fadeScheduled = true;
      this.#releaseVoice(v);
    }
    this.backbone?.dispose();
  }
}

// js/realtime-engine.js — bounded real-time AudioWorklet transport engine.
//
// OPERATION CLOCKWORK, Milestone C1. This is the "small, verifiable real-time
// transport that plays, stops, pauses, seeks and loops a non-destructive
// ProjectState arrangement" over a BOUNDED voice pool. It composes the pure,
// independently-tested modules:
//
//   transport.js        command/state machine + TransportMap (epoch, generation)
//   voice-scheduler.js  occurrence planning + exact source offsets + legal
//                       Signalsmith arm-then-one-stop sequence
//   gate-envelope.js    sample-accurate transport anti-click envelopes
//   voice-pool.js       bounded pool, capacity refusal, resource accounting
//   time-math.js        clipNeedsDsp — the ONE shared bypass predicate
//   offline-render.js   the SHARED downstream (EQ/pan/sum/limiter) backbone
//
// Contracts honoured here (Gate 1):
//   * ProjectState stays the musical authority. The engine never mutates it; it
//     calls `onParked(frame)` so the host can write the parked position on Stop,
//     Pause or a seek-while-stopped — never per frame.
//   * The device clock is the AudioContext. Audible events are context-time
//     values computed from integer frames. `setTimeout` only WAKES the scheduler
//     to fill the look-ahead window; it never decides when anything sounds.
//   * `isPlaying` and the parked playhead are reconciliation values fed from the
//     transport machine — neither is advanced by a timer to produce audio.
//
// Click safety (Gate 5): each voice has a clipGain (musical fades, shared with
// offline) AND a transportGate (runtime anti-click: start/stop/seek/loop/handover
// seams). The two multiply. No `.value` is ever written on a running graph; all
// transport changes are linear AudioParam ramps.
//
// Bounded resources (Gate 4): one voice per active occurrence, two-voice
// handovers at seeks and loop wraps, capacity derived from concurrency. When the
// pool cannot allocate, the engine REFUSES the new transport epoch with
// `POOL_EXHAUSTED`, preserves the current audible arrangement, and never steals
// or drops an audible clip.
//
// Non-finite safety (Gate 7): the limiter zeroes and counts non-finite samples;
// the engine polls its stats and moves to a defined `failed` safe state on the
// first fault, preserving ProjectState and source assets.

import { buildBackbone, buildClipVoice, MAX_CLIPS_PER_GRAPH } from './arrangement/offline-render.js';
import { createTransportState, transportReduce, createTransportMap, Phase } from './arrangement/transport.js';
import { occurrencesInWindow } from './arrangement/voice-scheduler.js';
import { VoicePool, deriveVoiceCapacity } from './voice-pool.js';
import {
  START_RAMP_FRAMES, STOP_RAMP_FRAMES, SEEK_RAMP_FRAMES, LOOP_XFADE_FRAMES,
  loopSeamWindow,
} from './arrangement/gate-envelope.js';

/** Default scheduler wake interval (ms). Only wakes the scheduler; never times audio. */
export const DEFAULT_WAKE_MS = 25;

/**
 * SELECTED scheduling horizon (ms) — a chosen engineering constant INFORMED by
 * measurement, not a hard-coded magic number and not claimed as measured jitter.
 * Derivation (docs §3): the Signalsmith E7 priming floor is ≈64 ms (a start
 * activated less than ~64 ms before it is heard begins under-primed). The live
 * scheduler must therefore fill the window at least (priming + wake + jitter)
 * ahead. Wake = 25 ms (this constant). The jitter term is a DESIGN ALLOWANCE of
 * 15 ms (NOT a measured value — see docs §3 limitation). So
 *   horizon = 64 + 25 + 15 = 104 ms.
 * A caller may override via `options.horizonFrames`. The stricter ±0.8 dB tonal
 * bound would use 85 ms priming → 125 ms (docs §3).
 */
export const SELECTED_SCHEDULING_HORIZON_MS = 104;

/**
 * ONE coherent context-time mapping (Milestone C1, review fix for findings 1–2).
 * A transport frame `f` (project timeline) and a playback-line offset `d`
 * (frames since the epoch's musical start) both map to a context time on the
 * device clock. Every voice placement and every transport-gain ramp uses THIS —
 * there is a single source of truth, so placement and gates cannot disagree.
 *
 *   secForOffset(d) = epochStartCtxSec + d / sampleRate
 *   secForFrame(f)  = epochStartCtxSec + (f - epochStartFrame) / sampleRate
 *
 * `occ.ctxStart` from voice-scheduler is a playback-line offset (map.toCtx ==
 * f - startFrame), so voices place with secForOffset; transport-frame seams
 * (stop end, seek frame) use secForFrame.
 */
export function ctxTimeMapper({ epochStartCtxSec, epochStartFrame, sampleRate }) {
  return {
    epochStartCtxSec,
    epochStartFrame,
    sampleRate,
    secForOffset: (d) => epochStartCtxSec + d / sampleRate,
    secForFrame: (f) => epochStartCtxSec + (f - epochStartFrame) / sampleRate,
  };
}

/**
 * Voice identity. Includes a monotonic `seq` so two occurrences of the same clip
 * on the same pass at the same transport start (e.g. before/after a seek) never
 * collide (review fix for finding 3: a transport-domain key collided after a
 * seek and blocked the incoming handover voice).
 */
export function makeVoiceKey(clipId, pass, seq) {
  return `${clipId}:${pass}:${seq}`;
}

/**
 * Schedule a transport-gain ramp on an AudioParam from a pure gate shape, at a
 * CONTEXT time in seconds (never raw frames — review fix for finding 2). The
 * ramp is linear and sample-accurate. No `.value` writes on a running graph.
 */
function rampGateAtSec(param, kind, atSec, sr) {
  const N = kind === 'stop' ? STOP_RAMP_FRAMES : kind === 'start' ? START_RAMP_FRAMES : SEEK_RAMP_FRAMES;
  const spanSec = N / sr;
  param.cancelScheduledValues(Math.max(0, atSec - spanSec));
  if (kind === 'start' || kind === 'handover-in' || kind === 'loop-in') {
    param.setValueAtTime(0, atSec);
    param.linearRampToValueAtTime(1, atSec + spanSec);
  } else if (kind === 'stop' || kind === 'handover-out' || kind === 'loop-out') {
    param.setValueAtTime(1, Math.max(0, atSec - spanSec));
    param.linearRampToValueAtTime(0, atSec);
  }
}

export class RealtimeEngine {
  /**
   * @param {BaseAudioContext} ctx live AudioContext (or OfflineAudioContext for
   *   deterministic suspend-driven verification)
   * @param {object} plan from compileRenderPlan
   * @param {Record<string,{channels:Float32Array[]}>} buffers decoded PCM by bufferReference
   * @param {object} options {StretchFactory, limiterModuleUrl, captureModuleUrl,
   *   capture?, horizonFrames?, wakeMs?, onParked?, tailFrames?}
   */
  constructor(ctx, plan, buffers, options) {
    this.ctx = ctx;
    this.plan = plan;
    this.buffers = buffers;
    this.options = options;
    this.sr = plan.sampleRate;
    this.horizonFrames = options.horizonFrames
      ?? Math.round((SELECTED_SCHEDULING_HORIZON_MS / 1000) * this.sr); // derived const, not a magic 85
    this.wakeMs = options.wakeMs ?? DEFAULT_WAKE_MS;
    this.tailFrames = options.tailFrames ?? Math.round(0.12 * this.sr);

    const cap = deriveVoiceCapacity({
      trackCount: plan.tracks.length,
      maxOverlappingPerTrack: 2,
      seamPartners: 2,
      tailReserve: 4,
    });
    this.capacity = cap.capacity;
    this.pool = new VoicePool(this.capacity);
    this.capacityDerivation = cap;

    this.transport = createTransportState({
      arrangementEndFrame: plan.output.arrangementEndFrame,
      loop: plan.loopRange
        ? [Math.round(plan.loopRange[0] * (60 / plan.masterBpm) * this.sr),
          Math.round(plan.loopRange[1] * (60 / plan.masterBpm) * this.sr)]
        : null,
      sampleRate: this.sr,
    });
    this.map = null; // built per epoch
    this.backbone = null;
    this.voices = new Map(); // unique voice key -> live voice record
    this.retiring = []; // voices fading out / ringing to tail, awaiting release
    this.scheduledKeys = new Set(); // occurrence identities already scheduled on this map
    this._seq = 0; // monotonic voice-key sequence
    this._seamInKind = 'start';
    this.mapper = null;
    this.pendingStop = null;
    this.scheduledUntil = 0; // playback offset filled so far (frames)
    this.deadlineMisses = 0;
    this.nonFiniteSeen = 0;
    this._wakeTimer = null;
    this._disposed = false;
  }

  /** Prepare: build the shared backbone and load worklets. Silent. */
  async prepare() {
    this.#reduce({ type: 'prepare', plan: this.plan });
    this.backbone = await buildBackbone(this.ctx, this.plan, {
      ...this.options, capture: this.options.capture ?? false,
    });
    this.#reduce({ type: 'ready', parkedFrame: Math.round(this.transport.parkedFrame) });
    return this.state();
  }

  /** Current transport state (phase, epoch, isPlaying, parkedFrame, loop). */
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
    const { state, effects } = transportReduce(this.transport, event);
    this.transport = state;
    for (const eff of effects) this.#execute(eff);
    return this.transport;
  }

  #execute(eff) {
    switch (eff.type) {
      case 'start':
        this.#beginEpoch(eff.startFrame);
        break;
      case 'seek':
        this.#doSeek(eff.seamFrame);
        break;
      case 'stop':
        this.#doStop(eff.parkFrame, eff.fadeOutFrames);
        break;
      case 'writeParked':
        this.options.onParked?.(eff.frame);
        break;
      case 'setLoop':
        this.#rebuildMap();
        break;
      case 'capacityError':
        this.options.onCapacityError?.(eff);
        break;
      case 'fail':
        if (eff.fatal) this.options.onFail?.(eff);
        else this.options.onWarn?.(eff);
        break;
      default:
        break;
    }
  }

  #rebuildMap() {
    this.scheduledUntil = 0;
  }

  /**
   * Establish the ONE context-time mapping (findings 1–2). Transport frame
   * `atFrame` is heard at ctx time `ctxStartSec`. Everything (voice placement and
   * transport-gate ramps) derives from `this.mapper`, so they cannot disagree.
   */
  #startMapping(atFrame, ctxStartSec, seamInKind) {
    this.map = createTransportMap({ startFrame: atFrame, loop: this.transport.loop, sampleRate: this.sr });
    this.epochStartFrame = atFrame;
    this.epochStartCtxSec = ctxStartSec;
    this.mapper = ctxTimeMapper({ epochStartCtxSec: ctxStartSec, epochStartFrame: atFrame, sampleRate: this.sr });
    this._seamInKind = seamInKind;
    this.scheduledUntil = 0;
    this.scheduledKeys.clear(); // a fresh map re-schedules its occurrences (finding 3)
  }

  /** A Play/seek start is heard `horizon` ahead so stretched material is primed. */
  #soundingOriginSec() {
    return this.ctx.currentTime + this.horizonFrames / this.sr;
  }

  #beginEpoch(startFrame) {
    this.#retireVoices(this.ctx.currentTime, 'handover-out'); // never an instant cut
    this.#startMapping(startFrame, this.#soundingOriginSec(), 'start');
  }

  #doSeek(seamFrame) {
    // Two-voice handover: old voices fade out; fresh incoming voices (filled by
    // fillWindow) fade in from the seam. Retiring frees the old keys so a
    // transport-domain collision cannot block the incoming voice (finding 3).
    const seamSec = this.mapper ? this.mapper.secForFrame(seamFrame) : this.ctx.currentTime;
    this.#retireVoices(Math.max(this.ctx.currentTime, seamSec), 'handover-out');
    this.#startMapping(seamFrame, this.#soundingOriginSec(), 'handover-in');
  }

  #doStop(parkFrame, fadeOutFrames) {
    const fadeSec = (fadeOutFrames || STOP_RAMP_FRAMES) / this.sr;
    const endSec = this.ctx.currentTime + fadeSec;
    for (const v of this.voices.values()) rampGateAtSec(v.gate.gain, 'stop', endSec, this.sr);
    // Completion (finding 8): once the fade lands, drive `stopped` so the parked
    // position reaches the host via writeParked -> onParked.
    this.pendingStop = { parkFrame, endSec };
  }

  /** Retire live voices: fade out at `atSec`, free their keys, schedule release. */
  #retireVoices(atSec, kind) {
    for (const [k, v] of [...this.voices]) {
      rampGateAtSec(v.gate.gain, kind, atSec, this.sr);
      const releaseAtSec = atSec + this.tailFrames / this.sr;
      this.pool.markTail(v.poolId, this.#frameAtSec(releaseAtSec));
      this.retiring.push({ ...v, releaseAtSec });
      this.voices.delete(k); // free the key for incoming voices
    }
  }

  #frameAtSec(ctxSec) {
    return this.mapper
      ? Math.round(this.mapper.epochStartFrame + (ctxSec - this.mapper.epochStartCtxSec) * this.sr)
      : 0;
  }

  /** Release retiring / finished voices after their fade + tail (findings 4, 10). */
  #reap() {
    const nowSec = this.ctx.currentTime;
    for (const v of [...this.retiring]) {
      if (nowSec >= v.releaseAtSec) {
        this.#releaseVoice(v);
        this.retiring.splice(this.retiring.indexOf(v), 1);
      }
    }
  }

  #heardFrame() {
    // The transport's current playback frame, from the device clock via the ONE
    // mapping (not a competing timer). Clamped to the epoch's scheduled frontier.
    if (!this.mapper) return this.epochStartFrame;
    const heardOffset = (this.ctx.currentTime - this.mapper.epochStartCtxSec) * this.sr;
    return this.mapper.epochStartFrame + Math.max(0, Math.min(heardOffset, this.scheduledUntil));
  }

  #releaseVoice(v) {
    v.head?.disconnect?.();
    v.clipGain?.disconnect?.();
    v.gate?.disconnect?.();
    v.stretch?.dropBuffers?.();
    this.pool.release(v.poolId);
  }

  /**
   * Fill the look-ahead window with occurrence voices. `playbackOffset` is the
   * epoch-relative frame (playback-line offset) to schedule from.
   */
  async fillWindow(playbackOffset) {
    if (!this.map || this._disposed) return;
    const from = playbackOffset;
    const to = playbackOffset + this.horizonFrames;
    if (to <= this.scheduledUntil) return;
    const occs = occurrencesInWindow(this.plan, this.map, from, to);
    for (const occ of occs) {
      // Dedup on a STABLE occurrence identity within this map (so overlapping
      // fill windows never double-schedule); the voice KEY is unique per creation
      // (so a re-scheduled occurrence after a seek never collides — finding 3).
      const identity = `${occ.clipId}:${occ.pass}:${occ.outStart}`;
      if (this.scheduledKeys.has(identity)) continue;
      this.scheduledKeys.add(identity);
      const key = makeVoiceKey(occ.clipId, occ.pass, (this._seq += 1));
      const epochAtRequest = this.transport.epoch; // capture BEFORE the await (finding 11)
      const alloc = this.pool.acquire({
        epoch: epochAtRequest,
        generation: this.transport.generation,
        bytes: (occ.sourceEnd - occ.sourceStart) * 8,
        clipId: occ.clipId,
        nowFrame: occ.ctxStart,
        tailFrames: this.tailFrames,
      });
      if (!alloc.ok) {
        this.#reduce({ type: 'capacityError', code: alloc.code, message: alloc.error.message });
        return; // preserve the current audible arrangement; never steal
      }
      const source = this.buffers[occ.bufferReference];
      // Natural region edges keep the clip's MUSICAL fade; a mid-clip slice (a
      // seek into a clip) does NOT — its seam is governed by the transport gate
      // (finding 9: never conflate musical fades with transport seams).
      const naturalStart = occ.outStart === occ.timelineStartFrame;
      const naturalEnd = occ.outEnd === occ.timelineEndFrame;
      // ONE coherent placement (finding 1): playback offset + the epoch origin.
      let voice;
      try {
        voice = await buildClipVoice(this.ctx, {
          clipId: occ.clipId,
          sourceStartFrame: occ.sourceStart,
          sourceEndFrame: occ.sourceEnd,
          timelineStartFrame: occ.ctxStart, // playback-line offset
          timelineDurationFrames: occ.outLenFrames,
          rate: occ.rate,
          pitchSemitones: occ.semitones,
          preserveFormants: occ.preserveFormants,
          clipGainLinear: occ.clipGainLinear,
          fadeInFrames: naturalStart ? occ.fadeInFrames : 0,
          fadeOutFrames: naturalEnd ? occ.fadeOutFrames : 0,
          sampleRate: this.sr,
        }, { channels: source.channels }, {
          StretchFactory: this.options.StretchFactory,
          dspBypass: true,
          startDelaySec: 0,
          timeOriginSec: this.epochStartCtxSec, // the ONE mapping (no double subtract)
          sampleRate: this.sr,
        });
      } catch (err) {
        this.pool.release(alloc.voice.id);
        continue;
      }
      // Stale-completion discard (finding 11): a Play/seek during the await makes
      // this voice obsolete — release it, do not sound it.
      if (this._disposed || epochAtRequest !== this.transport.epoch) {
        voice.head?.disconnect?.();
        voice.clipGain?.disconnect?.();
        voice.stretch?.dropBuffers?.();
        this.pool.release(alloc.voice.id);
        continue;
      }
      const gate = this.ctx.createGain();
      // Transport seam gate (finding 9): ramp in at the epoch/seam start; open
      // (1) for interior occurrences whose edges are the clip's musical fades.
      if (occ.ctxStart <= 1) {
        gate.gain.value = 0;
        rampGateAtSec(gate.gain, this._seamInKind || 'start', this.mapper.secForOffset(occ.ctxStart), this.sr);
      } else {
        gate.gain.value = 1;
      }
      voice.clipGain.connect(gate);
      gate.connect(this.backbone.trackInputs[occ.trackIndex]);
      this.voices.set(key, {
        poolId: alloc.voice.id, epoch: epochAtRequest, head: voice.head,
        stretch: voice.stretch, clipGain: voice.clipGain, gate,
      });
      this.pool.markSounding(alloc.voice.id);
      // Release at the occurrence end + tail (finding 4): frees the pool slot so
      // the bound tracks CONCURRENT voices, not total occurrences.
      const releaseAtSec = this.mapper.secForOffset(occ.ctxEnd) + this.tailFrames / this.sr;
      this.pool.markTail(alloc.voice.id, this.#frameAtSec(releaseAtSec));
      this.retiring.push({
        poolId: alloc.voice.id, head: voice.head, stretch: voice.stretch,
        clipGain: voice.clipGain, gate, epoch: epochAtRequest, releaseAtSec,
      });
    }
    this.scheduledUntil = Math.max(this.scheduledUntil, to);
    this.#reap();
    this.pool.sweep(this.#frameAtSec(this.ctx.currentTime), this.transport.epoch);
    this.#checkNonFinite();
    // Stop completion (finding 8): once the stop fade lands, park + notify.
    if (this.pendingStop && this.ctx.currentTime >= this.pendingStop.endSec) {
      const { parkFrame } = this.pendingStop;
      this.pendingStop = null;
      this.#reduce({ type: 'stopped', parkedFrame: parkFrame }); // emits writeParked -> onParked
    }
  }

  #checkNonFinite() {
    const stats = this.backbone.limiterStats;
    for (const s of stats) {
      if (s.nonFiniteCount && s.nonFiniteCount > this.nonFiniteSeen) {
        this.nonFiniteSeen = s.nonFiniteCount;
        this.#reduce({ type: 'fail', code: 'NON_FINITE', message: `non-finite sample at ${s.firstNonFiniteIndex}` });
        return;
      }
    }
  }

  // ---- transport commands (owner API) ----
  play(fromFrame) { return this.#reduce({ type: 'play', fromFrame }); }
  stop(fadeOutFrames) { return this.#reduce({ type: 'stop', fadeOutFrames }); }
  pause(heardFrame, fadeOutFrames) { return this.#reduce({ type: 'pause', heardFrame, fadeOutFrames }); }
  seek(frame) { return this.#reduce({ type: 'seek', frame }); }
  setLoop(range) { return this.#reduce({ type: 'setLoop', loop: range }); }
  started() { return this.#reduce({ type: 'started' }); }
  seekDone() { return this.#reduce({ type: 'seekDone' }); }
  stopped(parkedFrame) { return this.#reduce({ type: 'stopped', parkedFrame }); }

  /** Current playback-line offset heard now (frames since the epoch's start). */
  #heardPlaybackOffset() {
    if (!this.mapper) return 0;
    return Math.max(0, (this.ctx.currentTime - this.mapper.epochStartCtxSec) * this.sr);
  }

  /** One scheduler wake: fill the window [heard, heard + horizon]. Never times audio (Gate 1). */
  async tick() {
    if (this.transport.phase !== Phase.STARTING && this.transport.phase !== Phase.PLAYING
      && this.transport.phase !== Phase.SEEKING) return;
    await this.fillWindow(this.#heardPlaybackOffset());
  }

  /** Live scheduler loop: setTimeout only WAKES this; audio timing is the clock. */
  startSchedulerLoop() {
    const step = async () => {
      if (this._disposed) return;
      await this.tick();
      this._wakeTimer = setTimeout(step, this.wakeMs);
    };
    this._wakeTimer = setTimeout(step, this.wakeMs);
  }

  stopSchedulerLoop() {
    if (this._wakeTimer) clearTimeout(this._wakeTimer);
    this._wakeTimer = null;
  }

  /** Instrumentation (Gate 8 / §G): pool, ticks, deadline misses, non-finite. */
  diagnostics() {
    return {
      state: this.state(),
      pool: this.pool.stats(),
      capacityDerivation: this.capacityDerivation,
      horizonFrames: this.horizonFrames,
      selectedHorizonMs: SELECTED_SCHEDULING_HORIZON_MS,
      wakeMs: this.wakeMs,
      deadlineMisses: this.deadlineMisses,
      nonFiniteSeen: this.nonFiniteSeen,
      limiterStats: this.backbone ? this.backbone.limiterStats : [],
      maxClipsPerGraph: MAX_CLIPS_PER_GRAPH,
    };
  }

  dispose() {
    this._disposed = true;
    this.stopSchedulerLoop();
    for (const [, v] of [...this.voices]) this.#releaseVoice(v);
    for (const v of this.retiring) this.#releaseVoice(v);
    this.retiring = [];
    this.voices.clear();
    this.backbone?.dispose();
  }
}

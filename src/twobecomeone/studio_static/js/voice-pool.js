// js/voice-pool.js — bounded voice pool with explicit capacity accounting.
//
// OPERATION CLOCKWORK, Milestone C1, GATE 4. A voice is one clip OCCURRENCE's
// sounding unit (a Signalsmith node for a DSP clip, or an AudioBufferSourceNode
// for a bypass clip) plus its clip-gain and transport-gain stages. The pool is
// sized by CONCURRENCY (worst-case simultaneously-live voices), never by clip
// count, and is bounded. This module is the pure bookkeeping: allocation,
// lifecycle (pending -> sounding -> tail -> free), high-water marks, byte
// accounting and the capacity refusal path. It touches no audio.
//
// Lifecycle:
//   pending : allocated and pre-rolled, transport gate closed (a handover
//             partner waiting for its seam).
//   sounding: gate open / audible.
//   tail    : gate closed after its occurrence ended; the DSP tail rings out and
//             the voice awaits a sweep at tailEndFrame.
//   (freed) : returned to the free list; bytes released.
//
// Capacity policy (Gate 4): when a NEW transport epoch needs a voice and the
// pool cannot free one (every voice is sounding or still in tail), the pool
// REFUSES with an explicit, testable `POOL_EXHAUSTED` result. The caller must
// preserve the current audible arrangement and never steal or silently drop an
// audible clip. Tail voices from an OLD epoch may be reclaimed eagerly (they are
// inaudible), but a sounding voice is never stolen.

import { MAX_CLIPS_PER_GRAPH } from './arrangement/offline-render.js';

/** Voice lifecycle states. */
export const VoiceState = Object.freeze({
  PENDING: 'pending',
  SOUNDING: 'sounding',
  TAIL: 'tail',
  // Strict (engine-owned) lifecycle, OPERATION THE GOLDEN EAR II (Grok N5):
  //   allocated -> prepared -> sounding -> fading -> disconnected -> (released)
  // A slot is reserved at `allocated`, before any node exists, and is returned
  // to the free list ONLY from `disconnected` — i.e. after the engine has really
  // disconnected the voice's nodes. Stages may be skipped forwards (a voice
  // cancelled before it sounded goes prepared -> fading, a failed build goes
  // allocated -> disconnected) but never backwards.
  ALLOCATED: 'allocated',
  PREPARED: 'prepared',
  FADING: 'fading',
  DISCONNECTED: 'disconnected',
});

/** Forward order of the strict lifecycle (index = rank). */
export const STRICT_LIFECYCLE = Object.freeze([
  VoiceState.ALLOCATED, VoiceState.PREPARED, VoiceState.SOUNDING,
  VoiceState.FADING, VoiceState.DISCONNECTED,
]);

export class LifecycleError extends Error {
  constructor(id, from, to) {
    super(`voice ${id}: illegal lifecycle transition ${from} -> ${to}`);
    this.name = 'LifecycleError';
    this.code = 'ILLEGAL_LIFECYCLE';
  }
}

export class PoolExhaustedError extends Error {
  constructor(required, capacity) {
    super(`voice pool exhausted: need ${required + 1} voices but the bounded capacity is ${capacity}`);
    this.name = 'PoolExhaustedError';
    this.code = 'POOL_EXHAUSTED';
    this.required = required;
    this.capacity = capacity;
  }
}

/**
 * Derive the voice capacity from qualified concurrency scenarios and the
 * existing graph limit (MAX_CLIPS_PER_GRAPH). This is NOT an assumption that
 * "24 is enough": it computes the worst-case simultaneous voices from the plan's
 * geometry and the transport's seam behaviour.
 *
 * Worst case at one instant:
 *   sounding   : every track can have up to `maxOverlappingPerTrack` regions
 *                overlapping (double overlaps from splits/trims).
 *   handover   : a seek or loop wrap holds BOTH the outgoing and the pre-rolled
 *                incoming voice across a seam, so +1 partner per active seam.
 *   tails      : up to `tailReserve` recently-ended voices still ringing.
 *
 * The result is clamped to the graph limit by default (a caller may request
 * more but must acknowledge it exceeds the qualified instance budget).
 */
export function deriveVoiceCapacity({
  trackCount = 8,
  maxOverlappingPerTrack = 2,
  seamPartners = 2,
  tailReserve = 4,
  graphLimit = MAX_CLIPS_PER_GRAPH,
} = {}) {
  const sounding = trackCount * Math.max(1, maxOverlappingPerTrack);
  const required = sounding + seamPartners + tailReserve;
  return {
    sounding,
    seamPartners,
    tailReserve,
    required,
    graphLimit,
    fits: required <= graphLimit,
    capacity: Math.min(required, graphLimit),
  };
}

let nextVoiceId = 1;

export class VoicePool {
  /**
   * @param {number} capacity hard bound on live (non-free) voices
   */
  constructor(capacity = MAX_CLIPS_PER_GRAPH, { strict = false } = {}) {
    this.capacity = capacity;
    /** Strict mode (the live engine): no automatic reclamation; a slot frees
     *  only from DISCONNECTED via releaseDisconnected(). Legacy (non-strict)
     *  behaviour is kept for the pure pool tests. */
    this.strict = strict;
    this.illegalTransitions = 0;
    this.voices = new Map(); // id -> voice
    this.free = [];
    this.peakConcurrent = 0;
    this.allocatedTotal = 0;
    this.releasedTotal = 0;
    this.allocatedBytes = 0;
    this.peakAllocatedBytes = 0;
    this.refusals = 0;
    this.stolen = 0; // MUST stay 0: no audible clip is ever stolen
  }

  #liveCount() {
    return this.voices.size;
  }

  #sweepTail(nowFrame, epoch) {
    // Strict mode never frees a slot behind the engine's back (Grok N5: a tail
    // slot reused while its old node was still connected).
    if (this.strict) return;
    // Reclaim tail voices whose ring has finished, and any tail from an older
    // epoch (inaudible) regardless of remaining ring. A SOUNDING voice is never
    // reclaimed here.
    for (const [id, v] of this.voices) {
      if (v.state !== VoiceState.TAIL) continue;
      const expired = v.tailEndFrame != null && nowFrame >= v.tailEndFrame;
      const staleEpoch = epoch != null && v.epoch < epoch;
      if (expired || staleEpoch) this.#free(id);
    }
  }

  #free(id) {
    const v = this.voices.get(id);
    if (!v) return;
    this.allocatedBytes -= v.bytes;
    this.releasedTotal += v.bytes;
    this.voices.delete(id);
    this.free.push(id);
    v.state = 'free';
  }

  /**
   * Allocate a voice for an occurrence. Refuses (does NOT steal) when the pool is
   * full of sounding/pending voices or unexpired tails.
   *
   * @returns {{ok: true, voice} | {ok: false, code, error}}
   */
  acquire({ epoch = 0, generation = 0, role = 'occurrence', bytes = 0, clipId = null, nowFrame = 0, tailFrames = 0 } = {}) {
    // Opportunistically reclaim finished/stale tails first.
    this.#sweepTail(nowFrame, epoch);
    if (this.#liveCount() >= this.capacity) {
      this.refusals += 1;
      return {
        ok: false,
        code: 'POOL_EXHAUSTED',
        error: new PoolExhaustedError(this.#liveCount(), this.capacity),
      };
    }
    // Strict mode never reuses an id: a stale async completion that still holds
    // an old id can then never act on a different, newer voice.
    const id = this.strict ? (nextVoiceId++) : (this.free.pop() ?? (nextVoiceId++));
    const voice = {
      id,
      epoch,
      generation,
      role,
      clipId,
      state: this.strict ? VoiceState.ALLOCATED : VoiceState.PENDING,
      history: [this.strict ? VoiceState.ALLOCATED : VoiceState.PENDING],
      bytes,
      tailFrames,
      tailEndFrame: null,
    };
    this.voices.set(id, voice);
    this.allocatedTotal += 1;
    this.allocatedBytes += bytes;
    if (this.allocatedBytes > this.peakAllocatedBytes) this.peakAllocatedBytes = this.allocatedBytes;
    if (this.#liveCount() > this.peakConcurrent) this.peakConcurrent = this.#liveCount();
    return { ok: true, voice };
  }

  markSounding(id) {
    const v = this.voices.get(id);
    if (v) v.state = VoiceState.SOUNDING;
  }

  markPending(id) {
    const v = this.voices.get(id);
    if (v) v.state = VoiceState.PENDING;
  }

  /** Move a voice to tail (gate closed, DSP ring) with an absolute end frame. */
  markTail(id, tailEndFrame) {
    const v = this.voices.get(id);
    if (!v) return;
    v.state = VoiceState.TAIL;
    v.tailEndFrame = tailEndFrame;
  }

  /** Force-release a voice (its work was cancelled by a newer epoch). In strict
   *  mode this is refused unless the voice is DISCONNECTED. */
  release(id) {
    const v = this.voices.get(id);
    if (this.strict && v && v.state !== VoiceState.DISCONNECTED) {
      this.illegalTransitions += 1;
      throw new LifecycleError(id, v.state, 'released');
    }
    this.#free(id);
  }

  /**
   * Strict lifecycle step. Forward-only along STRICT_LIFECYCLE; a repeat of the
   * current state is a no-op. Throws LifecycleError on a backwards or unknown
   * transition so an engine bug cannot silently corrupt the ledger.
   */
  advance(id, to) {
    const v = this.voices.get(id);
    if (!v) throw new LifecycleError(id, 'free', to);
    const from = STRICT_LIFECYCLE.indexOf(v.state);
    const next = STRICT_LIFECYCLE.indexOf(to);
    if (next < 0 || from < 0 || next < from) {
      this.illegalTransitions += 1;
      throw new LifecycleError(id, v.state, to);
    }
    if (next === from) return v;
    v.state = to;
    v.history.push(to);
    return v;
  }

  /** Return a DISCONNECTED voice's slot to the free list (strict lifecycle end). */
  releaseDisconnected(id) {
    const v = this.voices.get(id);
    if (!v || v.state !== VoiceState.DISCONNECTED) {
      this.illegalTransitions += 1;
      throw new LifecycleError(id, v ? v.state : 'free', 'released');
    }
    const history = [...v.history, 'released'];
    this.#free(id);
    return history;
  }

  /** State of a live voice (or null once released). */
  stateOf(id) {
    return this.voices.get(id)?.state ?? null;
  }

  /**
   * Retire every voice NOT belonging to `epoch` (a new epoch supersedes old
   * work). Old-epoch voices are recycled silently with their gates at 0; this is
   * how a Play-during-stop-fade cancels the pending stop's voices.
   */
  retireEpoch(epoch) {
    for (const [id, v] of [...this.voices]) {
      if (v.epoch !== epoch) this.#free(id);
    }
  }

  /** Sweep expired/stale tails at a transport frame. */
  sweep(nowFrame, epoch = null) {
    this.#sweepTail(nowFrame, epoch);
  }

  /** Explicit testable capacity check used before beginning a new epoch. */
  canAcquire(count = 1) {
    return this.#liveCount() + count <= this.capacity;
  }

  stats() {
    let sounding = 0; let pending = 0; let tail = 0;
    const byState = {};
    for (const v of this.voices.values()) {
      byState[v.state] = (byState[v.state] ?? 0) + 1;
      if (v.state === VoiceState.SOUNDING) sounding += 1;
      else if (v.state === VoiceState.PENDING || v.state === VoiceState.ALLOCATED
        || v.state === VoiceState.PREPARED) pending += 1;
      else if (v.state === VoiceState.TAIL || v.state === VoiceState.FADING) tail += 1;
    }
    return {
      capacity: this.capacity,
      live: this.#liveCount(),
      sounding,
      pending,
      tail,
      peakConcurrent: this.peakConcurrent,
      allocatedTotal: this.allocatedTotal,
      releasedTotal: this.releasedTotal,
      allocatedBytes: this.allocatedBytes,
      peakAllocatedBytes: this.peakAllocatedBytes,
      refusals: this.refusals,
      stolen: this.stolen,
      byState,
      strict: this.strict,
      illegalTransitions: this.illegalTransitions,
    };
  }
}

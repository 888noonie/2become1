// js/runtime/committed-layer-engine.js — live committed-layer player.
//
// Phase 12A.1/12A.4. A leaf runtime module that plays ONE server-projected
// committed Ghost layer audibly during the live session, looping per phrase
// in sync with the playing Lead. It is NOT a second visible player and does
// NOT replace audioController's single HTMLAudioElement; it adds no render
// path (the export/parity pipeline stays Phase 11).
//
// Binding Sol amendments implemented here:
//   2  Authoritative sync, not optimistic add: the engine may play only a
//      server-projected committed layer, reconciled through one idempotent
//      sync(). A failed projection refresh is an honest idle/error state,
//      never a client-invented live layer.
//   3  Separate scheduled from live: `scheduled` means a future
//      AudioBufferSourceNode.start(when) is armed; `live` begins only when
//      the launch boundary has actually passed.
//   4  Transport changes suspend, not destroy: suspend() cancels timers and
//      stops sounding sources, keeping an idle entry; a later authoritative
//      sync (user-authored Lead play) may schedule again. Only shutdown()
//      destroys the engine.
//   5  Legacy conflicts fail honestly: a multi-layer projection is refused
//      with L_LAYER_LIMIT; the engine never chooses one silently.
//   7  No timer-drift claim: loop wakes come from the injected, cancellation
//      safe setTimer/clearTimer pair as a look-ahead chain; every wake
//      re-resolves against the live Lead clock. setInterval is never used.
//
// Loop model (look-ahead): at any moment at most one future instance is
// armed via source.start(launchAudioTime) plus whatever earlier instances
// are still ringing. When the armed instance's boundary passes (wake), the
// layer goes `live` and the NEXT whole-phrase instance is armed — exactly
// one fresh source per phrase, re-resolved against the live clock each time.
//
// Design hard-lines: no DOM imports; nothing on window; no runtime object
// enters StateStore; snapshot() is a frozen, JSON-serializable schedule
// receipt (proof of scheduling intent, never physical-speaker accuracy).

import { resolveLivePlacement } from '../transport/live.js';

export const ENGINE_STATES = Object.freeze({
  IDLE: 'idle',
  LOADING: 'loading',
  SCHEDULED: 'scheduled',
  LIVE: 'live',
  ERROR: 'error',
});

const WAKE_EPSILON_SECONDS = 1e-9;

export class CommittedLayerEngine {
  /**
   * @param {object} deps
   * @param {AudioContext} deps.audioContext — injected (fake in Node tests)
   * @param {(asset: object, signal: AbortSignal) => Promise<ArrayBuffer>} deps.loadAsset
   * @param {(layer: object) => object} deps.transportProvider — live Deck B transport
   * @param {(delayMs: number, fn: () => void) => number} deps.setTimer — injected
   * @param {(id: number) => void} deps.clearTimer — injected
   * @param {(layerId: string, state: string, detail?: object) => void} [deps.onStateChange]
   * @param {(layer: object, transport: object, now: number) => object} [deps.resolvePlacement]
   */
  constructor(deps) {
    if (!deps || !deps.audioContext || !deps.loadAsset || !deps.transportProvider
        || !deps.setTimer || !deps.clearTimer) {
      throw new Error('CommittedLayerEngine requires audioContext, loadAsset, transportProvider, setTimer, clearTimer');
    }
    this.ctx = deps.audioContext;
    this.loadAsset = deps.loadAsset;
    this.transportProvider = deps.transportProvider;
    this.setTimer = deps.setTimer;
    this.clearTimer = deps.clearTimer;
    this.onStateChange = deps.onStateChange || (() => {});
    this._resolvePlacement = deps.resolvePlacement || resolveLivePlacement;

    // One live layer at most (fixed musical policy).
    this._entry = null;          // { layer, state, buffer, controller, sources:Set,
                                 //   gains:Set, timerId, receipt, armedInstance, error }
    this._conflictLayers = null; // legacy multi-layer refusal (snapshot truth)
    this._shutdown = false;
    this._epoch = 0;
  }

  // ------------------------------------------------------------------
  // Authoritative reconciliation (Amendment 2)
  // ------------------------------------------------------------------

  /**
   * Reconcile the engine with the authoritative committed-layer projection.
   * Idempotent: a sync matching the currently healthy layer is a no-op.
   * @param {object[]} committedLayers — server-projected session.committedLayers
   */
  async sync(committedLayers) {
    if (this._shutdown) return { ok: false, code: 'SHUTDOWN' };
    const layers = Array.isArray(committedLayers) ? committedLayers : [];

    // Amendment 5: legacy multi-layer ledgers are refused without choosing.
    if (layers.length > 1) {
      this._cancelEntryRuntime();
      this._entry = null;
      this._conflictLayers = layers;
      for (const layer of layers) {
        this._announceLayer(layer, ENGINE_STATES.ERROR, { code: 'L_LAYER_LIMIT' });
      }
      return { ok: false, code: 'L_LAYER_LIMIT' };
    }
    this._conflictLayers = null;

    const next = layers[0] || null;
    if (!next) {
      // Layer removed (confirmed Undo / empty hydration): stop immediately.
      this._cancelEntryRuntime();
      this._entry = null;
      return { ok: true, code: 'cleared' };
    }

    const current = this._entry;
    const sameLayer = current
      && next.actionId === current.layer.actionId
      && (next.asset?.contentHash ?? next.acceptedAsset?.contentHash)
        === (current.layer.asset?.contentHash ?? current.layer.acceptedAsset?.contentHash);

    // Same layer, healthy and not suspended: idempotent no-op.
    if (sameLayer && current.state !== ENGINE_STATES.ERROR && current.state !== ENGINE_STATES.IDLE) {
      return { ok: true, code: 'unchanged' };
    }
    // New, changed, suspended, or errored layer: (re)arm from authority.
    return this._armEntry(next);
  }

  /** Immediately stop the named layer (confirmed Undo / replacement). */
  remove(commitActionId) {
    if (this._shutdown) return;
    if (this._entry?.layer?.actionId === commitActionId) {
      this._cancelEntryRuntime();
      this._entry = null;
      this._conflictLayers = null;
    }
  }

  /** Suspend all runtime work (pause/stop/ended/seek/replacement). */
  suspend(reason) {
    if (this._shutdown || !this._entry) return;
    const entry = this._entry;
    this._cancelEntryRuntime();
    entry.state = ENGINE_STATES.IDLE;
    this._announceLayer(entry.layer, ENGINE_STATES.IDLE, { reason: reason || 'transport' });
  }

  /** Hard teardown (project switch / application shutdown). */
  shutdown() {
    if (this._shutdown) return;
    this._shutdown = true;
    this._cancelEntryRuntime();
    this._entry = null;
    this._conflictLayers = null;
  }

  /** Frozen, JSON-serializable snapshot (no runtime objects). */
  snapshot() {
    if (this._conflictLayers) {
      const layers = this._conflictLayers.map((layer) => Object.freeze({
        layerId: layer.layerId || layer.actionId,
        actionId: layer.actionId,
        state: ENGINE_STATES.ERROR,
        receipt: null,
        error: { code: 'L_LAYER_LIMIT', message: 'legacy multi-layer projection refused' },
      }));
      return Object.freeze({ layers: Object.freeze(layers) });
    }
    const layers = [];
    if (this._entry) {
      const { layer, state, receipt, error } = this._entry;
      layers.push(Object.freeze({
        layerId: layer.layerId || layer.actionId,
        actionId: layer.actionId,
        state,
        receipt: receipt ? structuredClone(receipt) : null,
        error: error ? structuredClone(error) : null,
      }));
    }
    return Object.freeze({ layers: Object.freeze(layers) });
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  async _armEntry(layer) {
    this._cancelEntryRuntime();
    const entry = {
      layer,
      state: ENGINE_STATES.LOADING,
      decodeToken: ++this._epoch,
      controller: new AbortController(),
      buffer: null,
      sources: new Set(),
      gains: new Set(),
      timerId: null,
      receipt: null,
      armedInstance: null,
      error: null,
    };
    this._entry = entry;
    this._announceLayer(layer, ENGINE_STATES.LOADING);

    // Resolve against the live transport FIRST: an honest idle when the
    // Lead is not playing (no autoplay; the server stays authoritative).
    const pre = this._resolveNow(entry);
    if (!pre.ok) {
      if (pre.code === 'T_TRANSPORT_NOT_PLAYING') {
        entry.state = ENGINE_STATES.IDLE;
        this._announceLayer(layer, ENGINE_STATES.IDLE, { code: pre.code });
        return { ok: false, code: 'IDLE' };
      }
      this._fail(entry, pre.code, 'live placement could not be resolved');
      return { ok: false, code: pre.code };
    }

    // Fetch + decode the committed asset once per entry.
    try {
      const buffer = await this.loadAsset(
        layer.asset || layer.acceptedAsset || {}, entry.controller.signal,
      );
      if (this._entry !== entry || this._shutdown) return { ok: false, code: 'STALE' };
      const audioBuffer = await this.ctx.decodeAudioData(buffer);
      if (this._entry !== entry || this._shutdown) return { ok: false, code: 'STALE' };
      entry.buffer = audioBuffer;
      const scheduled = this._scheduleInstance(entry);
      if (!scheduled) return { ok: false, code: entry.error?.code || 'IDLE' };
      return { ok: true, code: 'scheduled' };
    } catch (loadError) {
      if (this._entry !== entry || this._shutdown) return { ok: false, code: 'STALE' };
      if (entry.controller.signal.aborted || loadError?.name === 'AbortError') {
        return { ok: false, code: 'STALE' };
      }
      this._fail(entry, 'S_ASSET_UNAVAILABLE', 'the committed audio could not be loaded');
      return { ok: false, code: 'S_ASSET_UNAVAILABLE' };
    }
  }

  _resolveNow(entry) {
    try {
      return this._resolvePlacement(
        entry.layer, this.transportProvider(entry.layer), this.ctx.currentTime,
      );
    } catch (err) {
      // The provider throws stable codes (T_TRANSPORT_NOT_PLAYING on a live
      // transport that is not owned/playing; GHOST_GRID_STALE on parity loss).
      return { ok: false, code: err?.code || 'T_TRANSPORT_UNAVAILABLE' };
    }
  }

  /** Arm one future instance: fresh source at its launch time + wake. */
  _scheduleInstance(entry) {
    const resolved = this._resolveNow(entry);
    if (!resolved.ok) {
      if (resolved.code === 'T_TRANSPORT_NOT_PLAYING') {
        entry.state = ENGINE_STATES.IDLE;
        this._announceLayer(entry.layer, ENGINE_STATES.IDLE, { code: resolved.code });
        return false;
      }
      this._fail(entry, resolved.code, 'live placement could not be resolved');
      return false;
    }
    const receipt = resolved.value;
    // A suspended AudioContext cannot sound a scheduled start: stay honest
    // and idle rather than claiming a launch that will never be audible.
    if (this.ctx.state && this.ctx.state !== 'running') {
      entry.state = ENGINE_STATES.IDLE;
      this._announceLayer(entry.layer, ENGINE_STATES.IDLE, { code: 'CONTEXT_SUSPENDED' });
      return false;
    }
    const source = this.ctx.createBufferSource();
    source.buffer = entry.buffer;
    const gainNode = this.ctx.createGain();
    gainNode.gain.value = receipt.gainLinear;
    source.connect(gainNode);
    gainNode.connect(this.ctx.destination);
    // Track BOTH the source and its gain node so teardown disconnects the
    // gain from the destination too — otherwise every phrase leaks a
    // connected GainNode that keeps the graph alive after suspension.
    source.onended = () => {
      entry.sources.delete(source);
      entry.gains.delete(gainNode);
      try { source.disconnect(); } catch { /* already disconnected */ }
      try { gainNode.disconnect(); } catch { /* already disconnected */ }
    };
    entry.sources.add(source);
    entry.gains.add(gainNode);
    try {
      source.start(receipt.launchAudioTime);
    } catch {
      entry.sources.delete(source);
      entry.gains.delete(gainNode);
      try { source.disconnect(); } catch { /* already disconnected */ }
      try { gainNode.disconnect(); } catch { /* already disconnected */ }
      this._fail(entry, 'SCHEDULE_FAILED', 'the committed audio could not be scheduled');
      return false;
    }
    entry.receipt = receipt;
    entry.armedInstance = {
      launchAudioTime: receipt.launchAudioTime,
      durationSeconds: receipt.durationSeconds,
    };
    // State truth (Amendment 3): `scheduled` only before the FIRST launch
    // boundary passes; once a boundary has passed the layer is `live` and
    // stays live while its instances keep launching (the next armed
    // instance is part of the live loop, not a return to `scheduled`).
    if (entry.state !== ENGINE_STATES.LIVE) {
      entry.state = ENGINE_STATES.SCHEDULED;
      // Surface the engine's RE-RESOLVED next launch beat (whole-phrase
      // stepped against the live clock), not the original accepted beat, so
      // the scheduled UI is truthful about when the layer will actually fire.
      this._announceLayer(entry.layer, ENGINE_STATES.SCHEDULED, {
        launchBeat: receipt.launchBeat,
      });
    }
    this._armWake(entry, (receipt.launchAudioTime - this.ctx.currentTime) * 1000);
    return true;
  }

  /** One look-ahead wake: boundary passed → live + arm the next instance. */
  _armWake(entry, delayMs) {
    if (this._entry !== entry || this._shutdown) return;
    if (entry.timerId !== null) this.clearTimer(entry.timerId);
    const delay = Math.max(0, Number(delayMs) || 0);
    entry.timerId = this.setTimer(delay, () => {
      entry.timerId = null;
      this._onWake(entry);
    });
  }

  _onWake(entry) {
    if (this._entry !== entry || this._shutdown) return;
    const now = this.ctx.currentTime;
    const resolved = this._resolveNow(entry);
    if (!resolved.ok && resolved.code === 'T_TRANSPORT_UNAVAILABLE') {
      // The provider became unavailable mid-loop: fail honestly.
      this._fail(entry, resolved.code, 'the live transport is unavailable');
      return;
    }
    if (!resolved.ok) {
      if (resolved.code === 'T_TRANSPORT_NOT_PLAYING') {
        this._cancelEntryRuntime();
        entry.state = ENGINE_STATES.IDLE;
        this._announceLayer(entry.layer, ENGINE_STATES.IDLE, { code: resolved.code });
        return; // a later owned Lead play re-syncs (Amendment 4)
      }
      this._fail(entry, resolved.code, 'live placement could not be resolved');
      return;
    }
    const armed = entry.armedInstance;
    if (armed && now >= armed.launchAudioTime - WAKE_EPSILON_SECONDS) {
      // The armed instance's launch boundary has actually passed (A3):
      // the layer is live, and the next whole-phrase instance gets armed.
      entry.state = ENGINE_STATES.LIVE;
      this._announceLayer(entry.layer, ENGINE_STATES.LIVE);
      entry.armedInstance = null;
      this._scheduleInstance(entry);
      return;
    }
    if (armed) {
      // Early/drifted wake: re-arm precisely to the armed boundary.
      this._armWake(entry, (armed.launchAudioTime - now) * 1000);
      return;
    }
    // Nothing armed (edge): arm the next future instance.
    this._scheduleInstance(entry);
  }

  /** Cancel all runtime work of the current entry (timers + sources). */
  _cancelEntryRuntime() {
    const entry = this._entry;
    if (!entry) return;
    if (entry.controller && !entry.controller.signal.aborted) entry.controller.abort();
    if (entry.timerId !== null) {
      this.clearTimer(entry.timerId);
      entry.timerId = null;
    }
    for (const source of [...entry.sources]) {
      try {
        source.onended = null;
        source.disconnect();
        source.stop();
      } catch { /* already stopped */ }
    }
    entry.sources.clear();
    for (const gainNode of [...entry.gains]) {
      try { gainNode.disconnect(); } catch { /* already disconnected */ }
    }
    entry.gains.clear();
    entry.armedInstance = null;
  }

  _fail(entry, code, message) {
    this._cancelEntryRuntime();
    entry.error = { code, message };
    entry.state = ENGINE_STATES.ERROR;
    this._announceLayer(entry.layer, ENGINE_STATES.ERROR, { code, message });
  }

  _announceLayer(layer, state, detail) {
    this.onStateChange(layer.layerId || layer.actionId, state, detail);
  }
}

// js/runtime/live-mixer.js — Phase 15A: independent dual-deck live mixer.
//
// Retires the "one active HTMLAudioElement" policy. One shared AudioContext,
// two deck buses (A/B), each a private media element wrapped once by
// createMediaElementSource into an independent gain node and the common
// master. Playing A never stops B.
//
// Hard-lines: no DOM/window imports (factories injected for Node tests); no
// runtime object enters StateStore (snapshot() is frozen/serializable);
// generation tokens guard every async boundary (stale play resolution, stale
// non-AbortError rejection, delayed ended/error from a replaced source);
// context resume is awaited and its failure surfaced; on()/off() exposes
// natural ended/error transitions so app.js needs no polling.
//
// The stem-stack bus (Phase 15C) is intentionally not here yet.

import { buildFailure, buildSuccess, ERROR_CODES } from '../actions/errors.js';

const DECKS = Object.freeze(['A', 'B']);

export class LiveMixer {
  constructor(deps) {
    if (!deps || !deps.audioContextFactory || !deps.mediaElementFactory) {
      throw new Error('LiveMixer requires audioContextFactory and mediaElementFactory');
    }
    this._ctxFactory = deps.audioContextFactory;
    this._elementFactory = deps.mediaElementFactory;
    this._ctx = null;
    this._decks = {
      A: this._makeDeck('A'),
      B: this._makeDeck('B'),
    };
    this._listeners = new Set();
    this._disposed = false;
  }

  _makeDeck(name) {
    return {
      name,
      element: null,
      sourceNode: null,
      gainNode: null,
      descriptor: null, // { trackId, url, kind, variant, stemName, jobId, title }
      generation: 0,
      playing: false,
      paused: true,
      ended: false,
      error: null,
    };
  }

  // Subscription contract (serializable events only)
  on(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emit(type, deckName, payload) {
    const event = Object.freeze({ type, deck: deckName, ...(payload || {}) });
    for (const fn of this._listeners) {
      try { fn(event); } catch { /* listener errors never break the mixer */ }
    }
  }

  async _ensureContext() {
    if (!this._ctx) {
      this._ctx = this._ctxFactory.create();
    }
    if (this._ctx.state === 'suspended') {
      try {
        await this._ctx.resume();
      } catch {
        return buildFailure(ERROR_CODES.T_CONTEXT_RESUME_FAILED);
      }
    }
    return buildSuccess({ context: this._ctx });
  }

  _ensureDeckGraph(deck) {
    if (deck.element) return deck;
    const ctx = this._ctx;
    const element = this._elementFactory.create();
    element.preload = 'metadata';
    // Same-origin/CORS policy is set before src is assigned (Phase 15 plan).
    element.crossOrigin = 'anonymous';
    const sourceNode = ctx.createMediaElementSource(element);
    const gainNode = ctx.createGain();
    gainNode.gain.value = 1;
    sourceNode.connect(gainNode);
    gainNode.connect(ctx.destination);
    deck.element = element;
    deck.sourceNode = sourceNode;
    deck.gainNode = gainNode;
    deck._boundGeneration = 0;
    deck._handlers = null;
    return deck;
  }

  // Bind generation-safe ended/error handlers for the CURRENT source. Called
  // on every play() so a delayed event from a replaced source is ignored.
  _bindElement(deck, generation) {
    const element = deck.element;
    if (deck._handlers) {
      element.removeEventListener('ended', deck._handlers.ended);
      element.removeEventListener('error', deck._handlers.error);
    }
    const ended = () => {
      if (deck.generation !== generation) return; // stale source
      deck.ended = true;
      deck.playing = false;
      deck.paused = true;
      this._emit('ended', deck.name, { trackId: deck.descriptor?.trackId ?? null });
    };
    const error = () => {
      if (deck.generation !== generation) return; // stale source
      deck.error = { code: ERROR_CODES.T_MEDIA_UNAVAILABLE, message: 'Audio is unavailable' };
      deck.playing = false;
      deck.paused = true;
      this._emit('error', deck.name, { code: ERROR_CODES.T_MEDIA_UNAVAILABLE });
    };
    element.addEventListener('ended', ended);
    element.addEventListener('error', error);
    deck._handlers = { ended, error };
    deck._boundGeneration = generation;
  }

  // Load and play a source on the named deck. Does NOT touch the other deck.
  async play(deckName, descriptor) {
    if (this._disposed) return buildFailure('X_INTERNAL');
    if (!DECKS.includes(deckName)) return buildFailure(ERROR_CODES.T_INVALID_DECK);
    const deck = this._decks[deckName];
    const generation = ++deck.generation;

    const ctxResult = await this._ensureContext();
    if (!ctxResult.ok) {
      // Context could not be resumed: the deck cannot play. Do not publish
      // playing state; surface the stable failure.
      deck.error = { code: ctxResult.code, message: 'Audio is unavailable' };
      deck.playing = false;
      deck.paused = true;
      return ctxResult;
    }

    this._ensureDeckGraph(deck);

    const normalized = {
      trackId: descriptor?.trackId || null,
      url: descriptor?.url || null,
      kind: descriptor?.kind || (descriptor?.stemName ? 'stem' : 'track'),
      stemName: descriptor?.stemName || null,
      variant: descriptor?.variant || (descriptor?.stemName || 'full'),
      jobId: descriptor?.jobId || null,
      title: descriptor?.title || null,
    };
    if (!normalized.url) return buildFailure('V_MISSING_SOURCE');

    deck.descriptor = normalized;
    deck.ended = false;
    deck.error = null;
    deck.element.src = normalized.url;
    // Re-bind generation-safe handlers for THIS source so a delayed event
    // from a replaced source (older generation) is ignored.
    this._bindElement(deck, generation);

    try {
      await deck.element.play();
    } catch (err) {
      // Only the CURRENT generation may publish a failure. A stale rejection
      // (older source) must not overwrite a newer successful source.
      if (generation !== deck.generation) {
        return buildSuccess({ aborted: true });
      }
      if (err && err.name === 'AbortError') {
        deck.playing = false;
        deck.paused = true;
        return buildSuccess({ aborted: true });
      }
      deck.error = { code: ERROR_CODES.T_MEDIA_UNAVAILABLE, message: 'Audio is unavailable' };
      deck.playing = false;
      deck.paused = true;
      return buildFailure(ERROR_CODES.T_MEDIA_UNAVAILABLE);
    }

    // Only the latest generation may publish playing state.
    if (generation === deck.generation) {
      deck.playing = true;
      deck.paused = false;
    }
    return buildSuccess({ deck: deckName });
  }

  pause(deckName) {
    if (this._disposed) return buildFailure('X_INTERNAL');
    if (!DECKS.includes(deckName)) return buildFailure(ERROR_CODES.T_INVALID_DECK);
    const deck = this._decks[deckName];
    ++deck.generation; // invalidate any in-flight play() promise
    if (deck.element) deck.element.pause();
    deck.playing = false;
    deck.paused = true;
    return buildSuccess({ deck: deckName });
  }

  stop(deckName) {
    if (this._disposed) return buildFailure('X_INTERNAL');
    if (!DECKS.includes(deckName)) return buildFailure(ERROR_CODES.T_INVALID_DECK);
    const deck = this._decks[deckName];
    ++deck.generation; // invalidate any in-flight play() promise
    if (deck.element) {
      deck.element.pause();
      deck.element.removeAttribute('src');
      deck.element.load();
    }
    deck.descriptor = null;
    deck.playing = false;
    deck.paused = true;
    deck.ended = false;
    deck.error = null;
    return buildSuccess({ deck: deckName });
  }

  seek(deckName, seconds) {
    if (this._disposed) return buildFailure('X_INTERNAL');
    if (!DECKS.includes(deckName)) return buildFailure(ERROR_CODES.T_INVALID_DECK);
    const deck = this._decks[deckName];
    if (deck.element && Number.isFinite(seconds)) {
      deck.element.currentTime = Math.max(0, seconds);
    }
    return buildSuccess({ deck: deckName });
  }

  // Read-only state (frozen, serializable)
  getDeck(deckName) {
    if (!DECKS.includes(deckName)) return null;
    const deck = this._decks[deckName];
    const contextState = this._ctx ? this._ctx.state : 'closed';
    const contextRunning = contextState === 'running';
    return Object.freeze({
      trackId: deck.descriptor?.trackId ?? null,
      kind: deck.descriptor?.kind ?? null,
      variant: deck.descriptor?.variant ?? null,
      stemName: deck.descriptor?.stemName ?? null,
      jobId: deck.descriptor?.jobId ?? null,
      title: deck.descriptor?.title ?? null,
      generation: deck.generation,
      playing: deck.playing && contextRunning,
      paused: deck.paused,
      ended: deck.ended,
      contextState,
      contextClock: this._ctx ? this._ctx.currentTime : 0,
      error: deck.error ? Object.freeze({ ...deck.error }) : null,
      time: deck.element ? deck.element.currentTime : 0,
      duration: deck.element ? (deck.element.duration || 0) : 0,
    });
  }

  // Frozen, JSON-serializable snapshot of both decks.
  snapshot() {
    return Object.freeze({
      decks: Object.freeze({
        A: this.getDeck('A'),
        B: this.getDeck('B'),
      }),
    });
  }

  // Hard teardown: stop/disconnect both decks, release sources, close ctx.
  async shutdown() {
    if (this._disposed) return;
    this._disposed = true;
    for (const name of DECKS) {
      const deck = this._decks[name];
      ++deck.generation;
      if (deck.element) {
        try { deck.element.pause(); } catch { /* already paused */ }
        try { deck.element.removeAttribute('src'); } catch { /* no-op */ }
        try { deck.element.load(); } catch { /* no-op */ }
      }
      if (deck.sourceNode) {
        try { deck.sourceNode.disconnect(); } catch { /* already disconnected */ }
      }
      if (deck.gainNode) {
        try { deck.gainNode.disconnect(); } catch { /* already disconnected */ }
      }
      deck.descriptor = null;
      deck.playing = false;
      deck.paused = true;
      deck.ended = false;
      deck.error = null;
    }
    if (this._ctx) {
      try { await this._ctx.close(); } catch { /* already closed */ }
      this._ctx = null;
    }
  }
}

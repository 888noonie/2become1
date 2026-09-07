// js/runtime/live-mixer.js — Phase 15A: independent dual-deck live mixer.
//
// Retires the "one active HTMLAudioElement" policy: one shared AudioContext,
// two deck buses (A/B), each a private media element wrapped once into an
// independent gain node and the common master. Playing A never stops B.
//
// Hard-lines: no DOM/window imports (factories injected for Node tests); no
// runtime object enters StateStore (snapshot() is frozen/serializable);
// generation tokens guard every async boundary; source replacement retires the
// old element and creates a fresh one so a delayed old-source event stays
// attributable to its original generation; a closed context fails explicitly;
// a canonical { type, deck, state } event contract is the single update path.
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

  // Canonical event contract: { type, deck, state: completeFrozenDeckSnapshot }.
  on(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emit(type, deckName) {
    const event = Object.freeze({ type, deck: deckName, state: this.getDeck(deckName) });
    for (const fn of this._listeners) {
      try { fn(event); } catch { /* listener errors never break the mixer */ }
    }
  }

  _emitContext() {
    const event = Object.freeze({ type: 'contextstatechange', deck: null, state: this._contextState() });
    for (const fn of this._listeners) {
      try { fn(event); } catch { /* no-op */ }
    }
  }

  _contextState() {
    return this._ctx ? this._ctx.state : 'closed';
  }

  async _ensureContext() {
    if (!this._ctx) {
      this._ctx = this._ctxFactory.create();
    }
    if (this._ctx.state === 'closed') {
      return buildFailure(ERROR_CODES.T_CONTEXT_CLOSED);
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

  // Create a fresh private element for a deck and wrap it exactly once.
  _createElement(deck) {
    const ctx = this._ctx;
    const element = this._elementFactory.create();
    element.preload = 'metadata';
    element.crossOrigin = 'anonymous';
    const sourceNode = ctx.createMediaElementSource(element);
    const gainNode = ctx.createGain();
    gainNode.gain.value = 1;
    sourceNode.connect(gainNode);
    gainNode.connect(ctx.destination);
    deck.element = element;
    deck.sourceNode = sourceNode;
    deck.gainNode = gainNode;
    this._bindElement(deck, element, deck.generation);
    return element;
  }

  // Retire the current element (detach/disconnect) before replacement.
  _retireElement(deck) {
    if (!deck.element) return;
    try { deck.element.pause(); } catch { /* no-op */ }
    try { deck.element.removeAttribute('src'); } catch { /* no-op */ }
    try { deck.element.load(); } catch { /* no-op */ }
    if (deck.sourceNode) try { deck.sourceNode.disconnect(); } catch { /* no-op */ }
    if (deck.gainNode) try { deck.gainNode.disconnect(); } catch { /* no-op */ }
    deck.element = null;
    deck.sourceNode = null;
    deck.gainNode = null;
  }

  // Bind media handlers to a SPECIFIC element; each source gets its own
  // element, so a delayed event from a retired element hits its own
  // (old-generation) handler and is ignored.
  _bindElement(deck, element, generation) {
    const ended = () => {
      if (deck.generation !== generation) return;
      deck.ended = true;
      deck.playing = false;
      deck.paused = true;
      this._emit('ended', deck.name);
    };
    const error = () => {
      if (deck.generation !== generation) return;
      deck.error = { code: ERROR_CODES.T_MEDIA_UNAVAILABLE, message: 'Audio is unavailable' };
      deck.playing = false;
      deck.paused = true;
      this._emit('error', deck.name);
    };
    const timeupdate = () => {
      if (deck.generation !== generation) return;
      this._emit('timeupdate', deck.name);
    };
    const durationchange = () => {
      if (deck.generation !== generation) return;
      this._emit('durationchange', deck.name);
    };
    element.addEventListener('ended', ended);
    element.addEventListener('error', error);
    element.addEventListener('timeupdate', timeupdate);
    element.addEventListener('durationchange', durationchange);
  }

  // Load and play a source on the named deck. Does NOT touch the other deck.
  async play(deckName, descriptor) {
    if (this._disposed) return buildFailure('X_INTERNAL');
    if (!DECKS.includes(deckName)) return buildFailure(ERROR_CODES.T_INVALID_DECK);
    const deck = this._decks[deckName];
    const generation = ++deck.generation;

    const ctxResult = await this._ensureContext();
    if (this._disposed) return buildFailure('X_INTERNAL');
    if (generation !== deck.generation) return buildSuccess({ aborted: true });
    if (!ctxResult.ok) {
      deck.error = { code: ctxResult.code, message: 'Audio is unavailable' };
      deck.playing = false;
      deck.paused = true;
      return ctxResult;
    }

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

    // Source replacement by element generation: retire old, create fresh.
    this._retireElement(deck);
    const element = this._createElement(deck);

    deck.descriptor = normalized;
    deck.ended = false;
    deck.error = null;
    element.src = normalized.url;

    try {
      await element.play();
    } catch (err) {
      if (this._disposed) return buildFailure('X_INTERNAL');
      if (generation !== deck.generation) return buildSuccess({ aborted: true });
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

    if (this._disposed) return buildFailure('X_INTERNAL');
    if (generation === deck.generation) {
      deck.playing = true;
      deck.paused = false;
      this._emit('play', deckName);
    }
    return buildSuccess({ deck: deckName });
  }

  pause(deckName) {
    if (this._disposed) return buildFailure('X_INTERNAL');
    if (!DECKS.includes(deckName)) return buildFailure(ERROR_CODES.T_INVALID_DECK);
    const deck = this._decks[deckName];
    ++deck.generation;
    if (deck.element) deck.element.pause();
    deck.playing = false;
    deck.paused = true;
    this._emit('pause', deckName);
    return buildSuccess({ deck: deckName });
  }

  stop(deckName) {
    if (this._disposed) return buildFailure('X_INTERNAL');
    if (!DECKS.includes(deckName)) return buildFailure(ERROR_CODES.T_INVALID_DECK);
    const deck = this._decks[deckName];
    ++deck.generation;
    this._retireElement(deck);
    deck.descriptor = null;
    deck.playing = false;
    deck.paused = true;
    deck.ended = false;
    deck.error = null;
    this._emit('stop', deckName);
    return buildSuccess({ deck: deckName });
  }

  seek(deckName, seconds) {
    if (this._disposed) return buildFailure('X_INTERNAL');
    if (!DECKS.includes(deckName)) return buildFailure(ERROR_CODES.T_INVALID_DECK);
    const deck = this._decks[deckName];
    if (deck.element && Number.isFinite(seconds)) {
      deck.element.currentTime = Math.max(0, seconds);
    }
    this._emit('seek', deckName);
    return buildSuccess({ deck: deckName });
  }

  // Read-only state (frozen, serializable)
  getDeck(deckName) {
    if (!DECKS.includes(deckName)) return null;
    const deck = this._decks[deckName];
    const contextState = this._contextState();
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
      this._retireElement(deck);
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
    this._emitContext();
  }
}

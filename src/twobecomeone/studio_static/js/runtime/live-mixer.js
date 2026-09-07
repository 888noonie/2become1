// js/runtime/live-mixer.js — Phase 15A: independent dual-deck live mixer.
//
// Retires the "one active HTMLAudioElement" policy deliberately. One
// application-owned LiveMixer owns one shared AudioContext and two named deck
// buses (A and B). Each deck has its own private HTMLAudioElement connected
// through a MediaElementAudioSourceNode into an independent gain node and the
// common master destination. Playing A never stops B and vice versa.
//
// Design hard-lines (mirroring the Ghost runtime discipline):
//   - No DOM/window imports; the AudioContext and media elements are injected
//     via factories so Node tests drive the exact same code path.
//   - No runtime object (element, source node, gain node, context) ever enters
//     StateStore; snapshot() returns only frozen, JSON-serializable facts.
//   - Each element is wrapped by createMediaElementSource exactly once.
//   - A suspended/closed context is never reported as playing.
//   - Rapid source changes cannot publish stale play/error state (generation
//     tokens guard the async play() promise).
//
// The stem-stack bus (Phase 15C) is intentionally NOT here yet: this module
// establishes the two-deck foundation the stack will later join.

import { buildFailure, buildSuccess, ERROR_CODES } from '../actions/errors.js';

const DECKS = Object.freeze(['A', 'B']);

export class LiveMixer {
  /**
   * @param {object} deps
   * @param {{ create: () => AudioContext }} deps.audioContextFactory
   * @param {{ create: () => HTMLAudioElement }} deps.mediaElementFactory
   */
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
      ended: false,
      error: null,
    };
  }

  _ensureContext() {
    if (!this._ctx) {
      this._ctx = this._ctxFactory.create();
    }
    if (this._ctx.state === 'suspended') {
      const resume = this._ctx.resume();
      if (resume && typeof resume.catch === 'function') {
        resume.catch(() => { /* state is reported honestly via getDeck() */ });
      }
    }
    return this._ctx;
  }

  _ensureDeckGraph(deck) {
    if (deck.element) return deck;
    const ctx = this._ensureContext();
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
    this._bindElement(deck);
    return deck;
  }

  _bindElement(deck) {
    const element = deck.element;
    element.addEventListener('ended', () => {
      deck.ended = true;
      deck.playing = false;
    });
    element.addEventListener('error', () => {
      deck.error = { message: 'Audio is unavailable' };
      deck.playing = false;
    });
  }

  /**
   * Load and play a source on the named deck. Does NOT touch the other deck.
   * @param {'A'|'B'} deckName
   * @param {object} descriptor { trackId, url, kind, variant, ... }
   * @returns {Promise<{ok:true}|{ok:false,code:string}>}
   */
  async play(deckName, descriptor) {
    if (this._disposed) return buildFailure('X_INTERNAL');
    if (!DECKS.includes(deckName)) return buildFailure(ERROR_CODES.T_INVALID_DECK);
    const deck = this._decks[deckName];
    const generation = ++deck.generation;
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

    try {
      await deck.element.play();
    } catch (err) {
      // AbortError from a rapid swap is not a real failure; the newer
      // generation owns the deck. Any other error is surfaced honestly.
      if (err && err.name === 'AbortError') {
        if (generation === deck.generation) {
          deck.playing = false;
        }
        return buildSuccess({ aborted: true });
      }
      deck.error = { message: 'Audio is unavailable' };
      deck.playing = false;
      return buildFailure('X_INTERNAL');
    }

    // Only the latest generation may publish playing state.
    if (generation === deck.generation) {
      deck.playing = true;
    }
    return buildSuccess({ deck: deckName });
  }

  pause(deckName) {
    if (!DECKS.includes(deckName)) return buildFailure(ERROR_CODES.T_INVALID_DECK);
    const deck = this._decks[deckName];
    if (deck.element) deck.element.pause();
    deck.playing = false;
    return buildSuccess({ deck: deckName });
  }

  stop(deckName) {
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
    deck.ended = false;
    deck.error = null;
    return buildSuccess({ deck: deckName });
  }

  seek(deckName, seconds) {
    if (!DECKS.includes(deckName)) return buildFailure(ERROR_CODES.T_INVALID_DECK);
    const deck = this._decks[deckName];
    if (deck.element && Number.isFinite(seconds)) {
      deck.element.currentTime = Math.max(0, seconds);
    }
    return buildSuccess({ deck: deckName });
  }

  /** Frozen, serializable per-deck facts (no runtime objects). */
  getDeck(deckName) {
    if (!DECKS.includes(deckName)) return null;
    const deck = this._decks[deckName];
    const contextRunning = this._ctx && this._ctx.state === 'running';
    return Object.freeze({
      trackId: deck.descriptor?.trackId ?? null,
      kind: deck.descriptor?.kind ?? null,
      variant: deck.descriptor?.variant ?? null,
      playing: deck.playing && contextRunning,
      ended: deck.ended,
      error: deck.error ? Object.freeze({ ...deck.error }) : null,
      time: deck.element ? deck.element.currentTime : 0,
      duration: deck.element ? (deck.element.duration || 0) : 0,
    });
  }

  /** Frozen, JSON-serializable snapshot of both decks. */
  snapshot() {
    return Object.freeze({
      decks: Object.freeze({
        A: this.getDeck('A'),
        B: this.getDeck('B'),
      }),
    });
  }

  /** Hard teardown: stop/disconnect both decks and close the context. */
  async shutdown() {
    if (this._disposed) return;
    this._disposed = true;
    for (const name of DECKS) {
      const deck = this._decks[name];
      ++deck.generation;
      if (deck.element) {
        try { deck.element.pause(); } catch { /* already paused */ }
      }
      if (deck.sourceNode) {
        try { deck.sourceNode.disconnect(); } catch { /* already disconnected */ }
      }
      if (deck.gainNode) {
        try { deck.gainNode.disconnect(); } catch { /* already disconnected */ }
      }
      deck.playing = false;
    }
    if (this._ctx) {
      try { await this._ctx.close(); } catch { /* already closed */ }
      this._ctx = null;
    }
  }
}

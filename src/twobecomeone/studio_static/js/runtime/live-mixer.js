// js/runtime/live-mixer.js — Phase 15A: independent dual-deck live mixer.
// One shared AudioContext, two deck buses (A/B), each a private media element
// wrapped once into an independent gain node and the common master. Playing A
// never stops B. No DOM/window imports; snapshot() is frozen/serializable;
// generation tokens guard every async boundary; source replacement retires the
// old element and creates a fresh one; a canonical { type, deck, state } event
// contract is the single update path.

import { buildFailure, buildSuccess, ERROR_CODES, messageFor } from '../actions/errors.js';
import {
  equalPowerGains,
  planFollowerStart,
  pitchPreservationState,
  clampPlaybackRate,
  LIMITER_POLICY,
} from '../transport/deck-sync.js';

const DECKS = Object.freeze(['A', 'B']);

export class LiveMixer {
  constructor(deps) {
    if (!deps || !deps.audioContextFactory || !deps.mediaElementFactory) {
      throw new Error('LiveMixer requires audioContextFactory and mediaElementFactory');
    }
    this._ctxFactory = deps.audioContextFactory;
    this._elementFactory = deps.mediaElementFactory;
    this._ctx = null;
    this._decks = { A: this._makeDeck('A'), B: this._makeDeck('B') };
    this._listeners = new Set();
    this._disposed = false;
    this._xfader = 0.5;
    this._master = 'A';
    this._masterGain = null;
    this._analyser = null;
    this._clipping = false;
  }

  _makeDeck(name) {
    return {
      name,
      element: null,
      sourceNode: null,
      gainNode: null,
      descriptor: null,
      generation: 0,
      playing: false,
      paused: true,
      ended: false,
      error: null,
      gridTrack: null,
    };
  }

  on(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emit(type, deckName) {
    const event = Object.freeze({ type, deck: deckName, state: this.getDeck(deckName) });
    for (const fn of this._listeners) {
      try { fn(event); } catch {}
    }
  }

  _emitContext() {
    const event = Object.freeze({
      type: 'contextstatechange',
      deck: null,
      state: Object.freeze({ contextState: this._contextState(), contextClock: this._ctx ? this._ctx.currentTime : 0 }),
    });
    for (const fn of this._listeners) {
      try { fn(event); } catch {}
    }
  }

  _contextState() {
    return this._ctx ? this._ctx.state : 'closed';
  }

  async _ensureContext() {
    if (!this._ctx) {
      this._ctx = this._ctxFactory.create();
      this._onStateChange = () => this._emitContext();
      this._ctx.addEventListener('statechange', this._onStateChange);
    }
    if (this._ctx.state === 'closed') return buildFailure(ERROR_CODES.T_CONTEXT_CLOSED);
    if (this._ctx.state === 'suspended') {
      try {
        await this._ctx.resume();
      } catch {
        return buildFailure(ERROR_CODES.T_CONTEXT_RESUME_FAILED);
      }
    }
    try {
      this._ensureMasterGraph();
    } catch {
      return buildFailure(ERROR_CODES.T_MEDIA_UNAVAILABLE);
    }
    return buildSuccess({ context: this._ctx });
  }

  _ensureMasterGraph() {
    if (!this._ctx || this._masterGain) return;
    const gain = this._ctx.createGain();
    gain.gain.value = 1;
    try {
      if (typeof this._ctx.createAnalyser === 'function') {
        this._analyser = this._ctx.createAnalyser();
        this._analyser.fftSize = 2048;
        try { gain.connect(this._analyser); } catch {}
      }
      gain.connect(this._ctx.destination);
    } catch (err) {
      try { gain.disconnect(); } catch {}
      this._analyser = null;
      throw err;
    }
    this._masterGain = gain;
    this._applyXfader();
  }

  _createElement(deck) {
    const ctx = this._ctx;
    const element = this._elementFactory.create();
    element.preload = 'metadata';
    element.crossOrigin = 'anonymous';
    deck.element = element;
    const sourceNode = ctx.createMediaElementSource(element);
    deck.sourceNode = sourceNode;
    const gainNode = ctx.createGain();
    deck.gainNode = gainNode;
    this._ensureMasterGraph();
    const gains = equalPowerGains(this._xfader);
    gainNode.gain.value = deck.name === 'A' ? gains.value.gainA : gains.value.gainB;
    sourceNode.connect(gainNode);
    gainNode.connect(this._masterGain);
    this._bindElement(deck, element, deck.generation);
    return element;
  }

  _retireElement(deck) {
    if (!deck.element) return;
    try { deck.element.pause(); } catch {}
    try { deck.element.removeAttribute('src'); } catch {}
    try { deck.element.load(); } catch {}
    if (deck.sourceNode) try { deck.sourceNode.disconnect(); } catch {}
    if (deck.gainNode) try { deck.gainNode.disconnect(); } catch {}
    deck.element = null;
    deck.sourceNode = null;
    deck.gainNode = null;
  }

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
      deck.error = { code: ERROR_CODES.T_MEDIA_UNAVAILABLE, message: messageFor(ERROR_CODES.T_MEDIA_UNAVAILABLE) };
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

  _fail(deck, code) {
    deck.error = { code, message: messageFor(code) };
    deck.playing = false;
    deck.paused = true;
    this._emit('error', deck.name);
  }

  async play(deckName, descriptor, options = {}) {
    if (this._disposed) return buildFailure('X_INTERNAL');
    if (!DECKS.includes(deckName)) return buildFailure(ERROR_CODES.T_INVALID_DECK);
    const deck = this._decks[deckName];

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

    const generation = ++deck.generation;

    this._retireElement(deck);
    deck.descriptor = normalized;
    deck.gridTrack = options.grid && typeof options.grid === 'object' ? options.grid : null;
    deck.ended = false;
    deck.error = null;
    deck.playing = false;
    deck.paused = true;
    this._emit('sourcechange', deckName);

    const ctxResult = await this._ensureContext();
    if (this._disposed) return buildFailure('X_INTERNAL');
    if (generation !== deck.generation) return buildSuccess({ aborted: true });
    if (!ctxResult.ok) {
      this._fail(deck, ctxResult.code);
      return ctxResult;
    }

    let element;
    try {
      element = this._createElement(deck);
    } catch {
      this._retireElement(deck);
      this._fail(deck, ERROR_CODES.T_MEDIA_UNAVAILABLE);
      return buildFailure(ERROR_CODES.T_MEDIA_UNAVAILABLE);
    }
    element.src = normalized.url;

    if (options.sync && this._shouldSync(deckName)) {
      const plan = this._planSync(deckName);
      if (plan.ok) {
        const waited = await this._waitForAudioTime(plan.value.launchAudioTime, generation, deck);
        if (!waited || this._disposed) return buildSuccess({ aborted: true });
        if (generation !== deck.generation) return buildSuccess({ aborted: true });
        element.currentTime = plan.value.mediaOffsetSeconds;
        const rate = clampPlaybackRate(plan.value.playbackRate);
        if (rate != null) {
          try { element.playbackRate = rate; } catch {}
          if ('preservesPitch' in element) element.preservesPitch = true;
        }
        this._emit('sync', deckName);
      }
    }

    try {
      await element.play();
    } catch (err) {
      if (this._disposed) return buildFailure('X_INTERNAL');
      if (generation !== deck.generation) {
        try { element.pause(); } catch {}
        return buildSuccess({ aborted: true });
      }
      if (err && err.name === 'AbortError') {
        deck.playing = false;
        deck.paused = true;
        this._emit('abort', deckName);
        return buildSuccess({ aborted: true });
      }
      this._fail(deck, ERROR_CODES.T_MEDIA_UNAVAILABLE);
      return buildFailure(ERROR_CODES.T_MEDIA_UNAVAILABLE);
    }

    if (this._disposed) return buildFailure('X_INTERNAL');
    if (generation !== deck.generation) {
      try { element.pause(); } catch {}
      return buildSuccess({ aborted: true });
    }
    const state = this._contextState();
    if (state !== 'running') {
      this._retireElement(deck);
      const code = state === 'closed' ? ERROR_CODES.T_CONTEXT_CLOSED : ERROR_CODES.T_CONTEXT_SUSPENDED;
      this._fail(deck, code);
      return buildFailure(code);
    }
    deck.playing = true;
    deck.paused = false;
    this._sampleClip();
    this._emit('play', deckName);
    this._emitMixer();
    return buildSuccess({ deck: deckName });
  }

  _shouldSync(deckName) {
    if (this._master === deckName) return false;
    const master = this._decks[this._master];
    return Boolean(master && master.playing && master.element);
  }

  _planSync(followerName) {
    const masterName = this._master;
    const master = this._decks[masterName];
    const follower = this._decks[followerName];
    return planFollowerStart({
      masterTrack: master.gridTrack,
      masterDeck: masterName,
      masterElementSeconds: master.element ? master.element.currentTime : 0,
      masterPlaying: master.playing === true,
      followerTrack: follower.gridTrack,
      followerDeck: followerName,
      nowAudioTime: this._ctx ? this._ctx.currentTime : 0,
    });
  }

  async _waitForAudioTime(target, generation, deck) {
    while (this._ctx && !this._disposed && deck.generation === generation) {
      if (this._ctx.currentTime + 1e-4 >= target) return true;
      const ms = Math.min(25, Math.max(0, (target - this._ctx.currentTime) * 1000));
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    return false;
  }

  setCrossfader(value) {
    if (this._disposed) return buildFailure('X_INTERNAL');
    const gains = equalPowerGains(value);
    if (!gains.ok) return buildFailure(gains.code);
    this._xfader = gains.value.xfader;
    this._applyXfader();
    this._sampleClip();
    this._emitMixer();
    return buildSuccess({ xfader: this._xfader, ...gains.value });
  }

  setMaster(deckName) {
    if (this._disposed) return buildFailure('X_INTERNAL');
    if (!DECKS.includes(deckName)) return buildFailure(ERROR_CODES.T_INVALID_DECK);
    this._master = deckName;
    this._emitMixer();
    return buildSuccess({ master: deckName });
  }

  _applyXfader() {
    const gains = equalPowerGains(this._xfader);
    if (!gains.ok) return;
    const a = this._decks.A.gainNode;
    const b = this._decks.B.gainNode;
    if (a) a.gain.value = gains.value.gainA;
    if (b) b.gain.value = gains.value.gainB;
  }

  _sampleClip() {
    this._clipping = false;
    if (!this._analyser || typeof this._analyser.getFloatTimeDomainData !== 'function') return;
    const size = this._analyser.fftSize || 2048;
    const buf = new Float32Array(size);
    try { this._analyser.getFloatTimeDomainData(buf); } catch { return; }
    for (let i = 0; i < buf.length; i += 1) {
      if (Math.abs(buf[i]) >= 0.99) {
        this._clipping = true;
        return;
      }
    }
  }

  mixerSnapshot() {
    const gains = equalPowerGains(this._xfader);
    return Object.freeze({
      xfader: this._xfader,
      master: this._master,
      gainA: gains.ok ? gains.value.gainA : 1,
      gainB: gains.ok ? gains.value.gainB : 1,
      limiterPolicy: LIMITER_POLICY,
      clipping: this._clipping === true,
      playbackRate: Object.freeze({
        A: this._decks.A.element?.playbackRate ?? 1,
        B: this._decks.B.element?.playbackRate ?? 1,
      }),
      pitchPreservation: Object.freeze({
        A: pitchPreservationState(this._decks.A.element),
        B: pitchPreservationState(this._decks.B.element),
      }),
      classC: 'unmeasured',
    });
  }

  _emitMixer() {
    const event = Object.freeze({
      type: 'mixerchange',
      deck: null,
      state: this.mixerSnapshot(),
    });
    for (const fn of this._listeners) {
      try { fn(event); } catch {}
    }
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
    deck.gridTrack = null;
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
    if (!Number.isFinite(seconds)) return buildFailure(ERROR_CODES.T_INVALID_TIME);
    const deck = this._decks[deckName];
    if (deck.element) deck.element.currentTime = Math.max(0, seconds);
    this._emit('seek', deckName);
    return buildSuccess({ deck: deckName });
  }

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
      playbackRate: deck.element ? Number(deck.element.playbackRate) || 1 : 1,
      pitchPreservation: pitchPreservationState(deck.element),
    });
  }

  snapshot() {
    return Object.freeze({
      decks: Object.freeze({ A: this.getDeck('A'), B: this.getDeck('B') }),
      mixer: this.mixerSnapshot(),
    });
  }

  async shutdown() {
    if (this._disposed) return;
    this._disposed = true;
    for (const name of DECKS) {
      const deck = this._decks[name];
      ++deck.generation;
      this._retireElement(deck);
      deck.descriptor = null;
      deck.gridTrack = null;
      deck.playing = false;
      deck.paused = true;
      deck.ended = false;
      deck.error = null;
    }
    if (this._ctx) {
      if (this._onStateChange) {
        try { this._ctx.removeEventListener('statechange', this._onStateChange); } catch {}
      }
      if (this._masterGain) {
        try { this._masterGain.disconnect(); } catch {}
      }
      try { await this._ctx.close(); } catch {}
      this._ctx = null;
    }
    this._masterGain = null;
    this._analyser = null;
    this._emitContext();
    this._emitMixer();
  }
}

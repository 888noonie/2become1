// js/runtime/live-mixer.js — Phase 15A/15B dual-deck live mixer.
// One shared AudioContext, two deck buses (A/B), each a private media element
// wrapped once into an independent gain node and a common master bus. Playing A
// never stops B. Phase 15B adds equal-power crossfader routing, beat-synced
// follower launch, bounded playback-rate tempo matching, and master headroom
// monitoring. No DOM/window imports; snapshot() is frozen/serializable.

import { buildFailure, buildSuccess, ERROR_CODES, messageFor } from '../actions/errors.js';
import { equalPowerGains } from './crossfader.js';
import { resolveSyncedFollowerLaunch } from './beat-sync.js';
import { buildDeckTransport } from './transport-bridge.js';

const DECKS = Object.freeze(['A', 'B']);
const HEADROOM_CLIP_THRESHOLD = 0.99;
const HEADROOM_WARN_THRESHOLD = 0.85;

function defaultTimers() {
  return {
    set(fn, ms) { return setTimeout(fn, ms); },
    clear(id) { clearTimeout(id); },
  };
}

export class LiveMixer {
  constructor(deps) {
    if (!deps || !deps.audioContextFactory || !deps.mediaElementFactory) {
      throw new Error('LiveMixer requires audioContextFactory and mediaElementFactory');
    }
    this._ctxFactory = deps.audioContextFactory;
    this._elementFactory = deps.mediaElementFactory;
    this._timers = deps.timerFactory || defaultTimers();
    this._ctx = null;
    this._masterGain = null;
    this._analyser = null;
    this._headroomBuffer = null;
    this._decks = { A: this._makeDeck('A'), B: this._makeDeck('B') };
    this._listeners = new Set();
    this._disposed = false;
    this._crossfaderPosition = 50;
    this._masterDeck = 'A';
    this._syncGeneration = 0;
    this._syncTimerId = null;
    this._syncTickHandler = null;
    this._syncReceipt = null;
    this._tempoRatios = { A: 1, B: 1 };
    this._pitchPreserve = { supported: null, active: false };
    this._headroom = { peak: 0, headroomDb: 0, clipping: false, attenuationRecommended: false };
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
      tempoRatio: 1,
      syncPending: false,
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

  _emitMixer() {
    const event = Object.freeze({
      type: 'mixerchange',
      deck: null,
      state: this.getMixerState(),
    });
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

  _ensureMasterBus(ctx) {
    if (this._masterGain) return;
    const masterGain = ctx.createGain();
    masterGain.gain.value = 1;
    try {
      if (typeof ctx.createAnalyser === 'function') {
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        this._headroomBuffer = new Float32Array(analyser.fftSize);
        masterGain.connect(analyser);
        analyser.connect(ctx.destination);
        this._analyser = analyser;
      } else {
        masterGain.connect(ctx.destination);
      }
      this._masterGain = masterGain;
    } catch (err) {
      try { masterGain.disconnect(); } catch {}
      throw err;
    }
  }

  _probePitchPreserve(element) {
    if (this._pitchPreserve.supported !== null) return this._pitchPreserve.supported;
    try {
      element.preservesPitch = false;
      element.mozPreservesPitch = false;
      element.webkitPreservesPitch = false;
      const supported = element.preservesPitch === false;
      element.preservesPitch = true;
      this._pitchPreserve.supported = supported;
      return supported;
    } catch {
      this._pitchPreserve.supported = false;
      return false;
    }
  }

  _applyPitchPreserve(element, enabled) {
    const supported = this._probePitchPreserve(element);
    this._pitchPreserve.active = supported && enabled;
    if (!supported) return false;
    try {
      element.preservesPitch = !enabled;
      element.mozPreservesPitch = !enabled;
      element.webkitPreservesPitch = !enabled;
      return true;
    } catch {
      this._pitchPreserve.active = false;
      return false;
    }
  }

  _applyCrossfaderGains() {
    const { gainA, gainB } = equalPowerGains(this._crossfaderPosition);
    const deckA = this._decks.A;
    const deckB = this._decks.B;
    if (deckA.gainNode) deckA.gainNode.gain.value = gainA;
    if (deckB.gainNode) deckB.gainNode.gain.value = gainB;
  }

  _updateHeadroom() {
    if (!this._analyser || !this._headroomBuffer || this._contextState() !== 'running') return;
    this._analyser.getFloatTimeDomainData(this._headroomBuffer);
    let peak = 0;
    for (let i = 0; i < this._headroomBuffer.length; i += 1) {
      const abs = Math.abs(this._headroomBuffer[i]);
      if (abs > peak) peak = abs;
    }
    const clipping = peak >= HEADROOM_CLIP_THRESHOLD;
    const attenuationRecommended = peak >= HEADROOM_WARN_THRESHOLD;
    const headroomDb = peak > 0 ? 20 * Math.log10(Math.min(1, 1 / peak)) : 24;
    this._headroom = {
      peak,
      headroomDb: Number(headroomDb.toFixed(2)),
      clipping,
      attenuationRecommended,
    };
  }

  _cancelSyncSchedule() {
    this._syncGeneration += 1;
    if (this._syncTimerId !== null) {
      this._timers.clear(this._syncTimerId);
      this._syncTimerId = null;
    }
    if (this._syncTickHandler) {
      const { element, handler } = this._syncTickHandler;
      if (element) try { element.removeEventListener('timeupdate', handler); } catch {}
      this._syncTickHandler = null;
    }
    for (const name of DECKS) {
      this._decks[name].syncPending = false;
    }
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
    return buildSuccess({ context: this._ctx });
  }

  _createElement(deck) {
    const ctx = this._ctx;
    this._ensureMasterBus(ctx);
    const element = this._elementFactory.create();
    element.preload = 'metadata';
    element.crossOrigin = 'anonymous';
    deck.element = element;
    const sourceNode = ctx.createMediaElementSource(element);
    deck.sourceNode = sourceNode;
    const gainNode = ctx.createGain();
    deck.gainNode = gainNode;
    sourceNode.connect(gainNode);
    gainNode.connect(this._masterGain);
    this._applyCrossfaderGains();
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
    deck.tempoRatio = 1;
    deck.syncPending = false;
  }

  _bindElement(deck, element, generation) {
    const ended = () => {
      if (deck.generation !== generation) return;
      if (deck.syncPending) return;
      this._cancelSyncSchedule();
      deck.ended = true;
      deck.playing = false;
      deck.paused = true;
      this._emit('ended', deck.name);
    };
    const error = () => {
      if (deck.generation !== generation) return;
      this._cancelSyncSchedule();
      deck.error = { code: ERROR_CODES.T_MEDIA_UNAVAILABLE, message: messageFor(ERROR_CODES.T_MEDIA_UNAVAILABLE) };
      deck.playing = false;
      deck.paused = true;
      this._emit('error', deck.name);
    };
    const timeupdate = () => {
      if (deck.generation !== generation) return;
      this._updateHeadroom();
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
    deck.syncPending = false;
    this._emit('error', deck.name);
  }

  setCrossfader(position) {
    if (this._disposed) return buildFailure('X_INTERNAL');
    const numeric = Number(position);
    this._crossfaderPosition = Math.max(0, Math.min(100, Number.isFinite(numeric) ? numeric : 50));
    this._applyCrossfaderGains();
    this._emitMixer();
    return buildSuccess({ position: this._crossfaderPosition });
  }

  setMasterDeck(deckName) {
    if (this._disposed) return buildFailure('X_INTERNAL');
    if (!DECKS.includes(deckName)) return buildFailure(ERROR_CODES.T_INVALID_DECK);
    this._cancelSyncSchedule();
    this._masterDeck = deckName;
    this._emitMixer();
    return buildSuccess({ masterDeck: deckName });
  }

  getMixerState() {
    const { gainA, gainB } = equalPowerGains(this._crossfaderPosition);
    return Object.freeze({
      crossfaderPosition: this._crossfaderPosition,
      masterDeck: this._masterDeck,
      gainA,
      gainB,
      tempoRatioA: this._tempoRatios.A,
      tempoRatioB: this._tempoRatios.B,
      pitchPreserveSupported: this._pitchPreserve.supported,
      pitchPreserveActive: this._pitchPreserve.active,
      syncReceipt: this._syncReceipt ? Object.freeze({ ...this._syncReceipt }) : null,
      headroom: Object.freeze({ ...this._headroom }),
    });
  }

  async play(deckName, descriptor) {
    if (this._disposed) return buildFailure('X_INTERNAL');
    if (!DECKS.includes(deckName)) return buildFailure(ERROR_CODES.T_INVALID_DECK);
    const deck = this._decks[deckName];
    this._cancelSyncSchedule();

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
    element.playbackRate = deck.tempoRatio || 1;

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
    this._tempoRatios[deckName] = deck.tempoRatio || 1;
    this._emit('play', deckName);
    return buildSuccess({ deck: deckName });
  }

  async playSynced(deckName, descriptor, syncContext) {
    if (this._disposed) return buildFailure('X_INTERNAL');
    if (!DECKS.includes(deckName)) return buildFailure(ERROR_CODES.T_INVALID_DECK);
    if (deckName === this._masterDeck) {
      return buildFailure('V_SAME_DECK', { reason: 'cannot sync master to itself' });
    }

    const masterDeck = this._decks[this._masterDeck];
    const masterTrack = syncContext?.masterTrack;
    const followerTrack = syncContext?.followerTrack;
    if (!masterTrack || !followerTrack) return buildFailure('T_TRACK_MISSING');
    if (!masterDeck.playing || !masterDeck.element) {
      return buildFailure(ERROR_CODES.T_TRANSPORT_NOT_PLAYING);
    }

    const ctxResult = await this._ensureContext();
    if (!ctxResult.ok) return ctxResult;

    const transportResult = buildDeckTransport({
      deck: this._masterDeck,
      track: masterTrack,
      elementSeconds: masterDeck.element.currentTime,
      playing: true,
      audioClockNow: this._ctx.currentTime,
      expectTrackId: masterTrack.id,
    });
    if (!transportResult.ok) return buildFailure(transportResult.code);

    const launch = resolveSyncedFollowerLaunch({
      masterTransport: transportResult.value,
      followerTrack,
      followerCueSeconds: syncContext?.cueSeconds ?? 0,
      nowAudioTime: this._ctx.currentTime,
    });
    if (!launch.ok) return launch;

    const deck = this._decks[deckName];
    this._cancelSyncSchedule();
    const generation = ++deck.generation;

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

    this._retireElement(deck);
    deck.descriptor = normalized;
    deck.ended = false;
    deck.error = null;
    deck.playing = false;
    deck.paused = true;
    deck.syncPending = true;
    deck.tempoRatio = launch.value.tempoRatio;
    this._tempoRatios[deckName] = launch.value.tempoRatio;
    this._emit('sourcechange', deckName);
    this._emitMixer();

    let element;
    try {
      element = this._createElement(deck);
    } catch {
      this._retireElement(deck);
      this._fail(deck, ERROR_CODES.T_MEDIA_UNAVAILABLE);
      return buildFailure(ERROR_CODES.T_MEDIA_UNAVAILABLE);
    }
    element.src = normalized.url;
    element.playbackRate = launch.value.tempoRatio;
    this._applyPitchPreserve(element, launch.value.tempoRatio !== 1);

    let launchElementSeconds = launch.value.launchElementSeconds;
    const followerBpm = Number(followerTrack.bpm) || transportResult.value.tempoBpm;
    const phraseSeconds = launch.value.phraseBeats * 60 / followerBpm;
    const mediaDuration = Number(followerTrack.duration);
    if (Number.isFinite(mediaDuration) && mediaDuration > 0 && phraseSeconds > 0) {
      while (launchElementSeconds >= mediaDuration - 0.05) {
        launchElementSeconds -= phraseSeconds;
      }
      if (launchElementSeconds < 0) launchElementSeconds = 0;
    }
    const scheduledDelayMs = Math.max(0, (launch.value.launchAudioTime - this._ctx.currentTime) * 1000);
    this._syncReceipt = {
      ...launch.value.receipt,
      launchElementSeconds,
      launchAudioTime: launch.value.launchAudioTime,
      scheduledDelayMs,
    };

    const launchAudioTime = launch.value.launchAudioTime;
    const syncGeneration = ++this._syncGeneration;
    const masterElement = masterDeck.element;
    let launched = false;

    const startFollower = async () => {
      if (launched) return null;
      launched = true;
      if (this._syncTimerId !== null) {
        this._timers.clear(this._syncTimerId);
        this._syncTimerId = null;
      }
      if (this._syncTickHandler) {
        try { this._syncTickHandler.element.removeEventListener('timeupdate', this._syncTickHandler.handler); } catch {}
        this._syncTickHandler = null;
      }
      if (this._disposed || syncGeneration !== this._syncGeneration || generation !== deck.generation) {
        return buildSuccess({ aborted: true });
      }
      if (typeof element.readyState === 'number' && element.readyState < 2) {
        await new Promise((resolve, reject) => {
          const onReady = () => { cleanup(); resolve(); };
          const onError = () => { cleanup(); reject(new Error('media load failed')); };
          const cleanup = () => {
            element.removeEventListener('canplay', onReady);
            element.removeEventListener('error', onError);
          };
          element.addEventListener('canplay', onReady, { once: true });
          element.addEventListener('error', onError, { once: true });
        });
      }
      element.currentTime = launchElementSeconds;
      if (this._contextState() !== 'running') {
        this._retireElement(deck);
        const code = this._contextState() === 'closed'
          ? ERROR_CODES.T_CONTEXT_CLOSED
          : ERROR_CODES.T_CONTEXT_SUSPENDED;
        this._fail(deck, code);
        return buildFailure(code);
      }
      try {
        await element.play();
      } catch {
        if (generation !== deck.generation) return buildSuccess({ aborted: true });
        this._fail(deck, ERROR_CODES.T_MEDIA_UNAVAILABLE);
        return buildFailure(ERROR_CODES.T_MEDIA_UNAVAILABLE);
      }
      if (generation !== deck.generation) {
        try { element.pause(); } catch {}
        return buildSuccess({ aborted: true });
      }
      deck.syncPending = false;
      deck.ended = false;
      deck.playing = true;
      deck.paused = false;
      this._syncReceipt = {
        ...this._syncReceipt,
        launchedAt: this._ctx.currentTime,
      };
      this._emit('play', deckName);
      this._emitMixer();
      return buildSuccess({ deck: deckName, receipt: this._syncReceipt });
    };

    return new Promise((resolve) => {
      const finish = async (result) => {
        if (result) resolve(result);
      };
      const delayMs = Math.max(0, (launchAudioTime - this._ctx.currentTime) * 1000);
      this._syncTimerId = this._timers.set(async () => {
        await finish(await startFollower());
      }, delayMs);

      const onMasterTick = () => {
        if (this._disposed || syncGeneration !== this._syncGeneration) return;
        if (this._ctx.currentTime >= launchAudioTime - 0.02) {
          void startFollower().then(finish);
        }
      };

      if (masterElement) {
        this._syncTickHandler = { element: masterElement, handler: onMasterTick };
        masterElement.addEventListener('timeupdate', onMasterTick);
      }
    });
  }

  pause(deckName) {
    if (this._disposed) return buildFailure('X_INTERNAL');
    if (!DECKS.includes(deckName)) return buildFailure(ERROR_CODES.T_INVALID_DECK);
    const deck = this._decks[deckName];
    this._cancelSyncSchedule();
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
    this._cancelSyncSchedule();
    ++deck.generation;
    this._retireElement(deck);
    deck.descriptor = null;
    deck.playing = false;
    deck.paused = true;
    deck.ended = false;
    deck.error = null;
    this._tempoRatios[deckName] = 1;
    this._emit('stop', deckName);
    this._emitMixer();
    return buildSuccess({ deck: deckName });
  }

  seek(deckName, seconds) {
    if (this._disposed) return buildFailure('X_INTERNAL');
    if (!DECKS.includes(deckName)) return buildFailure(ERROR_CODES.T_INVALID_DECK);
    if (!Number.isFinite(seconds)) return buildFailure(ERROR_CODES.T_INVALID_TIME);
    const deck = this._decks[deckName];
    if (deckName !== this._masterDeck) this._cancelSyncSchedule();
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
      syncPending: deck.syncPending,
      tempoRatio: deck.tempoRatio,
      contextState,
      contextClock: this._ctx ? this._ctx.currentTime : 0,
      error: deck.error ? Object.freeze({ ...deck.error }) : null,
      time: deck.element ? deck.element.currentTime : 0,
      duration: deck.element ? (deck.element.duration || 0) : 0,
    });
  }

  snapshot() {
    return Object.freeze({
      decks: Object.freeze({ A: this.getDeck('A'), B: this.getDeck('B') }),
      mixer: this.getMixerState(),
    });
  }

  async shutdown() {
    if (this._disposed) return;
    this._disposed = true;
    this._cancelSyncSchedule();
    for (const name of DECKS) {
      const deck = this._decks[name];
      ++deck.generation;
      this._retireElement(deck);
      deck.descriptor = null;
      deck.playing = false;
      deck.paused = true;
      deck.ended = false;
      deck.error = null;
      this._tempoRatios[name] = 1;
    }
    this._syncReceipt = null;
    if (this._masterGain) {
      try { this._masterGain.disconnect(); } catch {}
      this._masterGain = null;
    }
    if (this._analyser) {
      try { this._analyser.disconnect(); } catch {}
      this._analyser = null;
    }
    if (this._ctx) {
      if (this._onStateChange) {
        try { this._ctx.removeEventListener('statechange', this._onStateChange); } catch {}
      }
      try { await this._ctx.close(); } catch {}
      this._ctx = null;
    }
    this._emitContext();
    this._emitMixer();
  }
}

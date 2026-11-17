// js/runtime/stem-desk.js — Stem Performance Desk runtime.
//
// One track's separated stems, decoded once and started on one shared
// AudioContext clock. Each stem owns a GainNode; mute, solo and gain are
// applied on that node, so the mix law is testable without a sound card.
//
// Design hard-lines:
//   * no DOM, no fetch of its own; the caller injects both;
//   * the desk never closes an AudioContext it did not create;
//   * decoded PCM is bounded before it is kept, and refused with a truthful
//     error rather than growing without limit;
//   * a stopped or unloaded desk disconnects every node it made.
//
// Sync model: every source is scheduled with the same `when` (one shared
// context clock, one look-ahead offset), so stems cannot drift apart by
// construction. `startedAt` is the context time that `when` refers to, and
// `position()` is derived from the context clock, not from a media element.

export const STEM_DESK_LIMITS = Object.freeze({
  maxLanes: 4,
  /** Per-stem fetch ceiling before decode (a 3:47 stereo 44.1 kHz WAV). */
  maxStemBytes: 40 * 1024 * 1024,
  /** Per-stem decoded PCM ceiling (same duration at 4 bytes/sample/channel). */
  maxStemDecodedBytes: 40 * 1024 * 1024,
  /** Whole-desk decoded PCM ceiling for four stems. */
  maxDecodedBytes: 160 * 1024 * 1024,
  /** Look-ahead so `start(when)` lands in the future for every lane. */
  startLeadSeconds: 0.05,
  minGainDb: -60,
  maxGainDb: 6,
});

export class StemDeskError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StemDeskError';
    this.code = code;
  }
}

function dbToLinear(db) {
  return db <= STEM_DESK_LIMITS.minGainDb ? 0 : Math.pow(10, db / 20);
}

function assertName(name) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new StemDeskError('S_STEM_NAME', 'a stem lane needs a name');
  }
  return name;
}

export class StemDesk {
  constructor({ audioContext, fetchImpl = null, now = null, ownsContext = false } = {}) {
    if (!audioContext) {
      throw new StemDeskError('S_NO_AUDIO_CONTEXT', 'the stem desk needs an AudioContext');
    }
    this._ctx = audioContext;
    this._fetch = fetchImpl;
    this._now = now || (() => this._ctx.currentTime);
    this._lanes = [];
    this._master = null;
    this._sources = [];
    this._status = 'idle';
    this._error = null;
    this._startedAt = null;
    this._offset = 0;
    this._loop = true;
    this._ownsContext = Boolean(ownsContext);
    this._decodedBytes = 0;
  }

  get status() {
    return this._status;
  }

  /**
   * Load up to four separated stems. Any lane that fails is reported as
   * unavailable with its reason; the desk keeps whatever did load.
   */
  async load(lanes, { signal } = {}) {
    if (!Array.isArray(lanes) || lanes.length === 0) {
      throw new StemDeskError('S_NO_STEMS', 'no stem lanes were supplied');
    }
    if (lanes.length > STEM_DESK_LIMITS.maxLanes) {
      throw new StemDeskError('S_TOO_MANY_STEMS', `the stem desk holds at most ${STEM_DESK_LIMITS.maxLanes} stems`);
    }
    const names = new Set();
    for (const lane of lanes) {
      const name = assertName(lane?.name);
      if (names.has(name)) throw new StemDeskError('S_DUPLICATE_STEM', `duplicate stem lane: ${name}`);
      names.add(name);
      if (typeof lane.audioUrl !== 'string' || !lane.audioUrl) {
        throw new StemDeskError('S_NO_STEM_URL', `stem ${name} has no audio URL`);
      }
    }

    this.unload();
    this._status = 'loading';
    this._error = null;

    const loaded = [];
    const failures = [];
    for (const lane of lanes) {
      try {
        loaded.push(await this._loadLane(lane, signal));
      } catch (err) {
        failures.push({
          name: String(lane?.name ?? 'stem'),
          code: err?.code || 'S_STEM_UNAVAILABLE',
          message: String(err?.message || 'stem media is unavailable'),
        });
      }
    }

    this._lanes = loaded;
    this._rebuildGraph();
    if (loaded.length === 0) {
      this._status = 'unavailable';
      this._error = failures[0] || { code: 'S_STEM_UNAVAILABLE', message: 'no stem media loaded' };
    } else {
      this._status = 'ready';
      this._error = failures.length ? { code: 'S_STEM_PARTIAL', message: 'some stems are unavailable', failures } : null;
    }
    return this.state();
  }

  async _loadLane(lane, signal) {
    const fetchImpl = this._fetch || (typeof fetch === 'function' ? fetch : null);
    if (!fetchImpl) throw new StemDeskError('S_NO_FETCH', 'no fetch implementation is available');

    const response = await fetchImpl(lane.audioUrl, { signal });
    if (!response || response.ok === false) {
      throw new StemDeskError('S_STEM_UNAVAILABLE', `stem ${lane.name} could not be fetched`);
    }
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > STEM_DESK_LIMITS.maxStemBytes) {
      throw new StemDeskError(
        'S_STEM_TOO_LARGE',
        `stem ${lane.name} declares ${declared} bytes; the desk fetches at most ${STEM_DESK_LIMITS.maxStemBytes}`,
      );
    }
    const bytes = await response.arrayBuffer();
    if (!bytes || bytes.byteLength === 0) {
      throw new StemDeskError('S_STEM_UNAVAILABLE', `stem ${lane.name} is empty`);
    }
    if (bytes.byteLength > STEM_DESK_LIMITS.maxStemBytes) {
      throw new StemDeskError(
        'S_STEM_TOO_LARGE',
        `stem ${lane.name} is ${bytes.byteLength} bytes; the desk fetches at most ${STEM_DESK_LIMITS.maxStemBytes}`,
      );
    }

    let buffer;
    try {
      buffer = await this._ctx.decodeAudioData(bytes);
    } catch (err) {
      throw new StemDeskError('S_STEM_DECODE', `stem ${lane.name} could not be decoded`);
    }
    const decodedBytes = buffer.length * buffer.numberOfChannels * 4;
    if (decodedBytes > STEM_DESK_LIMITS.maxStemDecodedBytes) {
      throw new StemDeskError(
        'S_STEM_TOO_LONG',
        `stem ${lane.name} decodes to ${decodedBytes} bytes; the desk holds at most ${STEM_DESK_LIMITS.maxStemDecodedBytes} per stem`,
      );
    }
    if (this._decodedBytes + decodedBytes > STEM_DESK_LIMITS.maxDecodedBytes) {
      throw new StemDeskError(
        'S_DESK_FULL',
        `the stem desk holds at most ${STEM_DESK_LIMITS.maxDecodedBytes} decoded bytes`,
      );
    }
    this._decodedBytes += decodedBytes;

    return {
      name: lane.name,
      label: lane.label || lane.name,
      method: lane.method || null,
      modelName: lane.modelName || null,
      device: lane.device || null,
      buffer,
      gainDb: 0,
      muted: false,
      solo: false,
      node: null,
      source: null,
      decodedBytes,
      durationSeconds: buffer.duration,
    };
  }

  _rebuildGraph() {
    this._teardownNodes();
    if (!this._lanes.length) return;
    this._master = this._ctx.createGain();
    this._master.gain.value = 1;
    this._master.connect(this._ctx.destination);
    for (const lane of this._lanes) {
      const node = this._ctx.createGain();
      node.gain.value = 1;
      node.connect(this._master);
      lane.node = node;
    }
    this._applyGains();
  }

  _applyGains() {
    const anySolo = this._lanes.some((lane) => lane.solo);
    for (const lane of this._lanes) {
      if (!lane.node) continue;
      const audible = anySolo ? lane.solo : !lane.muted;
      lane.node.gain.value = audible ? dbToLinear(lane.gainDb) : 0;
    }
  }

  /**
   * Let the browser's autoplay policy decide. The panel calls this from the
   * Play gesture; a context that stays suspended is reported, never claimed as
   * playing.
   */
  async resume() {
    const ctx = this._ctx;
    // An OfflineAudioContext is suspended by design until startRendering().
    if (!ctx || this._offline() || typeof ctx.resume !== 'function') return this.state();
    if (ctx.state && ctx.state !== 'running' && ctx.state !== 'closed') {
      try {
        await ctx.resume();
      } catch {
        this._error = {
          code: 'S_CONTEXT_SUSPENDED',
          message: 'the browser did not allow audio; press Play again',
        };
      }
    }
    return this.state();
  }

  play({ loop = true, offset = 0 } = {}) {
    if (this._status !== 'ready' && this._status !== 'playing') {
      throw new StemDeskError('S_NOT_READY', 'the stem desk is not ready to play');
    }
    if (['suspended', 'interrupted'].includes(this._ctx?.state) && !this._offline()) {
      throw new StemDeskError(
        'S_CONTEXT_SUSPENDED',
        'the audio context is suspended by the browser; press Play again to allow sound',
      );
    }
    this._stopSources();
    const duration = this._duration();
    const safeOffset = duration > 0 ? Math.max(0, Math.min(offset, duration - 0.001)) : 0;
    const when = this._now() + STEM_DESK_LIMITS.startLeadSeconds;

    for (const lane of this._lanes) {
      const source = this._ctx.createBufferSource();
      source.buffer = lane.buffer;
      source.loop = loop;
      if (loop) {
        source.loopStart = 0;
        source.loopEnd = lane.durationSeconds;
      }
      source.connect(lane.node);
      source.start(when, safeOffset);
      lane.source = source;
      this._sources.push(source);
    }
    this._startedAt = when;
    this._offset = safeOffset;
    this._loop = loop;
    this._status = 'playing';
    this._applyGains();
    return this.state();
  }

  stop() {
    this._stopSources();
    this._startedAt = null;
    this._offset = 0;
    if (this._status === 'playing') this._status = 'ready';
    return this.state();
  }

  _stopSources() {
    for (const source of this._sources) {
      try {
        source.stop();
      } catch {
        // A source that already ended is not an error worth surfacing.
      }
      try {
        source.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    this._sources = [];
    for (const lane of this._lanes) lane.source = null;
  }

  _teardownNodes() {
    for (const lane of this._lanes) {
      if (lane.node) {
        try {
          lane.node.disconnect();
        } catch {
          // Already disconnected.
        }
        lane.node = null;
      }
    }
    if (this._master) {
      try {
        this._master.disconnect();
      } catch {
        // Already disconnected.
      }
      this._master = null;
    }
  }

  setGain(name, db) {
    const lane = this._lane(name);
    const value = Number(db);
    if (!Number.isFinite(value)) throw new StemDeskError('S_BAD_GAIN', `gain for ${name} must be a number`);
    lane.gainDb = Math.max(STEM_DESK_LIMITS.minGainDb, Math.min(STEM_DESK_LIMITS.maxGainDb, value));
    this._applyGains();
    return this.state();
  }

  setMuted(name, muted) {
    this._lane(name).muted = Boolean(muted);
    this._applyGains();
    return this.state();
  }

  setSolo(name, solo) {
    this._lane(name).solo = Boolean(solo);
    this._applyGains();
    return this.state();
  }

  /** True when the lane would be heard with the current mute/solo state. */
  audible(name) {
    const lane = this._lane(name);
    const anySolo = this._lanes.some((item) => item.solo);
    return anySolo ? lane.solo : !lane.muted;
  }

  _offline() {
    return typeof this._ctx?.startRendering === 'function';
  }

  _lane(name) {
    const lane = this._lanes.find((item) => item.name === name);
    if (!lane) throw new StemDeskError('S_UNKNOWN_STEM', `no stem lane named ${String(name)}`);
    return lane;
  }

  _duration() {
    return this._lanes.reduce((max, lane) => Math.max(max, lane.durationSeconds), 0);
  }

  /** Desk position from the shared context clock; null when not playing. */
  position() {
    if (this._status !== 'playing' || this._startedAt === null) return 0;
    const elapsed = Math.max(0, this._now() - this._startedAt + this._offset);
    const duration = this._duration();
    if (duration <= 0) return 0;
    return this._loop ? elapsed % duration : Math.min(elapsed, duration);
  }

  state() {
    const duration = this._duration();
    return Object.freeze({
      status: this._status,
      contextState: this._ctx?.state ?? 'unknown',
      error: this._error,
      playing: this._status === 'playing',
      loop: this._loop,
      positionSeconds: this.position(),
      durationSeconds: duration,
      sync: {
        clock: 'audiocontext',
        startLeadSeconds: STEM_DESK_LIMITS.startLeadSeconds,
        // Every lane is started with the same `when`, so this is a claim about
        // the schedule, not a measurement of speakers.
        scheduledTogether: this._status === 'playing',
      },
      lanes: this._lanes.map((lane) => Object.freeze({
        name: lane.name,
        label: lane.label,
        method: lane.method,
        modelName: lane.modelName,
        device: lane.device,
        durationSeconds: lane.durationSeconds,
        gainDb: lane.gainDb,
        muted: lane.muted,
        solo: lane.solo,
        audible: this.audible(lane.name),
        effectiveGain: (this._lanes.some((item) => item.solo) ? lane.solo : !lane.muted)
          ? dbToLinear(lane.gainDb)
          : 0,
      })),
    });
  }

  /** Drop decoded audio and nodes; the desk can be loaded again. */
  unload() {
    this._stopSources();
    this._teardownNodes();
    this._lanes = [];
    this._decodedBytes = 0;
    this._startedAt = null;
    this._offset = 0;
    this._status = 'idle';
    this._error = null;
  }

  /** Release everything. A context owned by the desk is closed; a shared one is not. */
  dispose() {
    this.unload();
    if (this._ownsContext && typeof this._ctx.close === 'function') {
      this._ctx.close().catch(() => {});
    }
    this._ownsContext = false;
  }
}

export function createStemDesk(options) {
  return new StemDesk(options);
}

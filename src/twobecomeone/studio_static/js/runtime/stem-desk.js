// js/runtime/stem-desk.js — Stem Performance Desk runtime.
//
// Two separated tracks (groups A and B), up to four stem lanes each, decoded
// once and started on one shared AudioContext clock. Each lane owns a GainNode
// fed into its group's GainNode, and both groups feed one master GainNode.
// Mute, solo, lane gain and the A/B crossfader are therefore exact node values,
// testable without a sound card.
//
// Design hard-lines:
//   * no DOM, no fetch of its own; the caller injects both;
//   * the desk never closes an AudioContext it did not create;
//   * decoded PCM is bounded per stem, per group and for the whole desk, and
//     an over-budget group is refused without touching groups already loaded;
//   * a stopped or unloaded desk disconnects every node it made.
//
// Sync model: every source is scheduled with the same `when` (one shared
// context clock, one look-ahead offset), so stems cannot drift apart by
// construction. That is start alignment, not beat matching or tempo sync.
// `startedAt` is the context time that `when` refers to, and `position()` is
// derived from the context clock, not from a media element.

import { equalPowerGains } from './crossfader.js';

export const STEM_DESK_LIMITS = Object.freeze({
  maxTracks: 2,
  maxLanesPerTrack: 4,
  maxLanes: 8,
  /** Per-stem fetch ceiling before decode (a 3:47 stereo 44.1 kHz WAV). */
  maxStemBytes: 40 * 1024 * 1024,
  /** Per-stem decoded PCM ceiling (same duration at 4 bytes/sample/channel). */
  maxStemDecodedBytes: 40 * 1024 * 1024,
  /** Decoded PCM ceiling for one four-lane group. */
  maxTrackDecodedBytes: 160 * 1024 * 1024,
  /** Whole-desk decoded PCM ceiling for two groups / eight lanes. */
  maxDecodedBytes: 320 * 1024 * 1024,
  /** Look-ahead so `start(when)` lands in the future for every lane. */
  startLeadSeconds: 0.05,
  minGainDb: -60,
  maxGainDb: 6,
  /**
   * Per-track level is a second gain layer, independent of the crossfader, so
   * a crossfade move can never overwrite a track level the user set.
   */
  minLevelDb: -40,
  maxLevelDb: 6,
  /**
   * A lane at or below this RMS is "effectively silent in this separation".
   * It is a truthful label, not a mixer rule: the lane still loads, still
   * obeys mute/solo/gain, and is never removed. The 2026-11-17 audition
   * failure happened because two stems were near-silent and soloing them
   * looked like Stop.
   */
  silentRmsDb: -50,
  /** Below this amplitude the output ceiling is exactly linear. */
  softClipKnee: 0.8,
});

/** Peak and RMS of a decoded buffer, used only to describe the lane honestly. */
function measureBuffer(buffer) {
  let sumSquares = 0;
  let peak = 0;
  let count = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) {
      const value = data[i];
      sumSquares += value * value;
      const absolute = value < 0 ? -value : value;
      if (absolute > peak) peak = absolute;
      count += 1;
    }
  }
  const rms = count ? Math.sqrt(sumSquares / count) : 0;
  return {
    rmsDb: 20 * Math.log10(rms + 1e-12),
    peakDb: 20 * Math.log10(peak + 1e-12),
  };
}

export class StemDeskError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StemDeskError';
    this.code = code;
  }
}

/** Linear below `STEM_DESK_LIMITS.softClipKnee`, saturating at 1.0 above it. */
export function softClipCurve(samples = 4097) {
  // A WaveShaperNode maps its input range -1..1 across the *whole* curve, so
  // the curve itself must be defined over -1..1 or it applies an unwanted
  // gain. Inputs beyond full scale are clamped to the end points, i.e. 1.0.
  const curve = new Float32Array(samples);
  const knee = STEM_DESK_LIMITS.softClipKnee;
  const span = 1 - knee;
  for (let i = 0; i < samples; i += 1) {
    const x = -1 + (2 * i) / (samples - 1);
    const magnitude = Math.abs(x);
    if (magnitude <= knee) {
      curve[i] = x;
    } else {
      // Quadratic knee: continuous at the knee with zero slope, always below
      // the identity line above it (compression, never expansion), and exactly
      // 1.0 at full scale. Inputs past ±1 clamp to these end points.
      const over = (magnitude - knee) / span;
      curve[i] = Math.sign(x) * (knee + span * over * over);
    }
  }
  return curve;
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

function normalizeGroup(group) {
  const trackId = group?.trackId == null || group.trackId === ''
    ? 'A'
    : String(group.trackId);
  const lanes = group?.lanes;
  if (!Array.isArray(lanes) || lanes.length === 0) {
    throw new StemDeskError('S_NO_STEMS', 'no stem lanes were supplied');
  }
  if (lanes.length > STEM_DESK_LIMITS.maxLanesPerTrack) {
    throw new StemDeskError(
      'S_TOO_MANY_STEMS',
      `a stem group holds at most ${STEM_DESK_LIMITS.maxLanesPerTrack} stems`,
    );
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
  return {
    trackId,
    title: String(group?.title || trackId),
    lanes,
  };
}

function budgetFailure(group, detail) {
  return {
    name: group.trackId,
    code: 'S_DESK_FULL',
    message: `group ${group.trackId} was refused: ${detail}`,
  };
}

export class StemDesk {
  constructor({ audioContext, fetchImpl = null, now = null, ownsContext = false } = {}) {
    if (!audioContext) {
      throw new StemDeskError('S_NO_AUDIO_CONTEXT', 'the stem desk needs an AudioContext');
    }
    this._ctx = audioContext;
    this._fetch = fetchImpl;
    this._now = now || (() => this._ctx.currentTime);
    this._groups = [];
    this._lanes = [];
    this._master = null;
    this._ceiling = null;
    this._disposed = false;
    this._sources = [];
    this._status = 'idle';
    this._error = null;
    this._startedAt = null;
    this._endAt = null;
    this._offset = 0;
    this._loop = false;
    this._crossfader = 50;
    this._ownsContext = Boolean(ownsContext);
    this._decodedBytes = 0;
  }

  get status() {
    return this._status;
  }

  /**
   * Compatibility wrapper for the original four-lane desk. It replaces the
   * whole desk with one group called A, exactly as the single-track desk did.
   */
  async load(lanes, options = {}) {
    this.unload();
    return this.loadGroups([{ trackId: 'A', lanes }], options);
  }

  /**
   * Load or replace one or more groups without touching the others. A group
   * that would exceed the lane or decoded-PCM budget is refused with
   * S_DESK_FULL and the groups already loaded stay intact.
   */
  async loadGroups(groups, { signal } = {}) {
    // A disposed desk holds no audio; a load arriving afterwards is refused
    // without downloading anything.
    if (this._disposed) return this.state();
    if (!Array.isArray(groups) || groups.length === 0) {
      throw new StemDeskError('S_NO_STEMS', 'no stem groups were supplied');
    }
    const seen = new Set();
    const specs = groups.map((group) => {
      const spec = normalizeGroup(group);
      if (seen.has(spec.trackId)) {
        throw new StemDeskError('S_DUPLICATE_TRACK', `duplicate stem group: ${spec.trackId}`);
      }
      seen.add(spec.trackId);
      return spec;
    });

    const failures = [];
    let changed = false;

    for (const spec of specs) {
      const outcome = await this._loadGroup(spec, signal);
      failures.push(...outcome.failures);
      if (outcome.committed) changed = true;
    }

    if (changed) {
      // Re-read the transport here, not at entry: the owner can press Play
      // while a fetch is still resolving. Old sources must be stopped and the
      // transport reset, or a disconnected graph keeps a stale clock.
      const playingNow = this._status === 'playing';
      this._stopSources();
      this._startedAt = null;
      this._endAt = null;
      this._offset = 0;
      this._rebuildGraph();
      if (playingNow) this._status = 'ready';
    }

    if (this._disposed) {
      // The panel went away while this load was decoding; leave the desk in
      // its released state rather than reporting a failed available desk.
      return this.state();
    }

    this._decodedBytes = this._groups.reduce(
      (total, group) => total + group.lanes.reduce((sum, lane) => sum + lane.decodedBytes, 0),
      0,
    );

    if (this._lanes.length === 0) {
      this._status = failures.length ? 'unavailable' : 'idle';
      this._error = failures[0] || null;
    } else {
      if (this._status !== 'playing') this._status = 'ready';
      if (failures.length) {
        const only = failures.length === 1 ? failures[0] : null;
        this._error = only && only.code === 'S_DESK_FULL'
          ? { code: 'S_DESK_FULL', message: only.message, failures }
          : { code: 'S_STEM_PARTIAL', message: 'some stems are unavailable', failures };
      } else {
        this._error = null;
      }
    }
    return this.state();
  }

  async _loadGroup(spec, signal) {
    const existing = this._group(spec.trackId);
    const otherGroups = this._groups.filter((group) => group.trackId !== spec.trackId);
    const existingBytes = existing
      ? existing.lanes.reduce((sum, lane) => sum + lane.decodedBytes, 0)
      : 0;
    const existingLaneCount = existing ? existing.lanes.length : 0;
    const projectedLanes = this._laneCount() - existingLaneCount + spec.lanes.length;

    if (otherGroups.length + 1 > STEM_DESK_LIMITS.maxTracks) {
      return {
        committed: false,
        failures: [budgetFailure(spec, `the desk holds at most ${STEM_DESK_LIMITS.maxTracks} tracks`)],
      };
    }
    if (projectedLanes > STEM_DESK_LIMITS.maxLanes) {
      return {
        committed: false,
        failures: [budgetFailure(spec, `the desk holds at most ${STEM_DESK_LIMITS.maxLanes} lanes`)],
      };
    }

    const candidateBytes = this._decodedBytes - existingBytes;
    const loaded = [];
    const failures = [];
    let groupBytes = 0;

    for (const lane of spec.lanes) {
      try {
        const decoded = await this._decodeLane(lane, spec.trackId, signal);
        const nextGroupBytes = groupBytes + decoded.decodedBytes;
        if (nextGroupBytes > STEM_DESK_LIMITS.maxTrackDecodedBytes) {
          return {
            committed: false,
            failures: [
              ...failures,
              budgetFailure(spec, `at most ${STEM_DESK_LIMITS.maxTrackDecodedBytes} decoded bytes per track`),
            ],
          };
        }
        if (candidateBytes + nextGroupBytes > STEM_DESK_LIMITS.maxDecodedBytes) {
          return {
            committed: false,
            failures: [
              ...failures,
              budgetFailure(spec, `at most ${STEM_DESK_LIMITS.maxDecodedBytes} decoded bytes for the desk`),
            ],
          };
        }
        groupBytes = nextGroupBytes;
        loaded.push(decoded);
      } catch (err) {
        failures.push({
          name: String(lane?.name ?? 'stem'),
          code: err?.code || 'S_STEM_UNAVAILABLE',
          message: String(err?.message || 'stem media is unavailable'),
        });
      }
    }

    if (loaded.length === 0) {
      return { committed: false, failures };
    }

    if (this._disposed) {
      // The owner unmounted the panel while this decode was in flight; keep no
      // decoded audio and report the load as not committed.
      return { committed: false, failures: [{ name: spec.trackId, code: 'S_DISPOSED', message: 'the desk was disposed' }] };
    }

    // Recompute against the desk as it is NOW, not as it was when this load
    // started. Two loads can overlap (the owner presses Load A and Load B in
    // quick succession), and committing from the entry snapshot would drop
    // whichever group finished first.
    const currentOthers = this._groups.filter((entry) => entry.trackId !== spec.trackId);
    const currentOtherBytes = currentOthers.reduce(
      (total, entry) => total + entry.lanes.reduce((sum, lane) => sum + lane.decodedBytes, 0),
      0,
    );
    const currentOtherLanes = currentOthers.reduce((total, entry) => total + entry.lanes.length, 0);
    if (currentOthers.length + 1 > STEM_DESK_LIMITS.maxTracks) {
      return {
        committed: false,
        failures: [budgetFailure(spec, `the desk holds at most ${STEM_DESK_LIMITS.maxTracks} tracks`)],
      };
    }
    if (currentOtherLanes + loaded.length > STEM_DESK_LIMITS.maxLanes) {
      return {
        committed: false,
        failures: [budgetFailure(spec, `the desk holds at most ${STEM_DESK_LIMITS.maxLanes} lanes`)],
      };
    }
    if (currentOtherBytes + groupBytes > STEM_DESK_LIMITS.maxDecodedBytes) {
      return {
        committed: false,
        failures: [
          budgetFailure(spec, `at most ${STEM_DESK_LIMITS.maxDecodedBytes} decoded bytes for the desk`),
        ],
      };
    }

    const group = {
      trackId: spec.trackId,
      title: spec.title,
      lanes: loaded,
      levelDb: existing?.levelDb ?? 0,
      node: null,
    };
    this._groups = [...currentOthers, group];
    this._lanes = this._groups.flatMap((entry) => entry.lanes);
    this._decodedBytes = currentOtherBytes + groupBytes;
    return { committed: true, failures };
  }

  async _decodeLane(lane, trackId, signal) {
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
    // The output ceiling is per destination channel; a >2-channel stem would be
    // downmixed into stereo after it, where channels can sum past full scale.
    // The desk serves separated stems, which are mono or stereo.
    if (buffer.numberOfChannels > 2) {
      throw new StemDeskError(
        'S_STEM_LAYOUT',
        `stem ${lane.name} has ${buffer.numberOfChannels} channels; the desk accepts mono or stereo`,
      );
    }
    const measured = measureBuffer(buffer);

    return {
      key: `${trackId}:${lane.name}`,
      trackId,
      name: lane.name,
      label: lane.label || lane.name,
      method: lane.method || null,
      modelName: lane.modelName || null,
      device: lane.device || null,
      stemSetId: lane.stemSetId || null,
      buffer,
      gainDb: 0,
      muted: false,
      solo: false,
      node: null,
      source: null,
      decodedBytes,
      durationSeconds: buffer.duration,
      rmsDb: measured.rmsDb,
      peakDb: measured.peakDb,
      silent: measured.rmsDb <= STEM_DESK_LIMITS.silentRmsDb,
    };
  }

  _rebuildGraph() {
    this._teardownNodes();
    if (!this._lanes.length) return;
    this._master = this._ctx.createGain();
    this._master.gain.value = 1;
    // Output protection, not a mastering chain. Eight lanes can be boosted by
    // +6 dB per lane and +6 dB per track, so a coincident sum can exceed full
    // scale. A soft-clip curve is used rather than a compressor because the
    // Web Audio compressor applies automatic makeup gain, which would change
    // quiet material; this curve is exactly linear below 0.8 and saturates at
    // 1.0, so a normal mix is untouched and a boosted one cannot hard clip.
    this._ceiling = typeof this._ctx.createWaveShaper === 'function'
      ? this._ctx.createWaveShaper()
      : null;
    if (this._ceiling) {
      this._ceiling.curve = softClipCurve();
      if ('oversample' in this._ceiling) this._ceiling.oversample = 'none';
      this._master.connect(this._ceiling);
      this._ceiling.connect(this._ctx.destination);
    } else {
      this._master.connect(this._ctx.destination);
    }
    for (const group of this._groups) {
      const node = this._ctx.createGain();
      node.gain.value = this._groupGainValue(group);
      node.connect(this._master);
      group.node = node;
      for (const lane of group.lanes) {
        const laneNode = this._ctx.createGain();
        laneNode.gain.value = 1;
        laneNode.connect(node);
        lane.node = laneNode;
      }
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
    for (const group of this._groups) {
      if (group.node) group.node.gain.value = this._groupGainValue(group);
    }
  }

  _xfadeValue(group) {
    const ordered = this._orderedGroups();
    if (!ordered.length) return 0;
    // One loaded track is never faded to silence by a crossfader that has no
    // second side; the desk reports it as disabled instead.
    if (ordered.length === 1) return 1;
    const law = equalPowerGains(this._crossfader);
    return ordered.indexOf(group) === 0 ? law.gainA : law.gainB;
  }

  /**
   * The group gain is the crossfade gain multiplied by the track level. They
   * are separate layers: moving the crossfader must not rewrite the level.
   */
  _groupGainValue(group) {
    return this._xfadeValue(group) * dbToLinear(group.levelDb ?? 0);
  }

  _crossfaderState() {
    const law = equalPowerGains(this._crossfader);
    const ordered = this._orderedGroups();
    if (ordered.length === 0) {
      return { position: this._crossfader, gainA: 0, gainB: 0, disabled: true };
    }
    if (ordered.length === 1) {
      const onlyB = ordered[0].trackId === 'B';
      return {
        position: this._crossfader,
        gainA: onlyB ? 0 : 1,
        gainB: onlyB ? 1 : 0,
        disabled: true,
      };
    }
    return { position: this._crossfader, gainA: law.gainA, gainB: law.gainB, disabled: false };
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

  play({ loop = false, offset = 0 } = {}) {
    this._maybeEnd();
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
    // A multi-group load publishes each group's lanes before it rebuilds the
    // graph. If Play lands in that window, build the graph first rather than
    // connecting a source to a missing node.
    if (this._lanes.length && this._lanes.some((lane) => !lane.node || !lane.node.gain)) {
      this._rebuildGraph();
    }
    const duration = this._duration();
    const requested = Number(offset);
    const safeOffset = duration > 0
      ? Math.max(0, Math.min(Number.isFinite(requested) ? requested : 0, duration - 0.001))
      : 0;
    const when = this._now() + STEM_DESK_LIMITS.startLeadSeconds;
    const endAt = loop ? null : when + Math.max(0, duration - safeOffset);

    for (const lane of this._lanes) {
      // A lane shorter than the requested start offset contributes nothing;
      // do not schedule a source that would start in the past.
      if (safeOffset >= lane.durationSeconds) {
        lane.source = null;
        continue;
      }
      const source = this._ctx.createBufferSource();
      source.buffer = lane.buffer;
      source.loop = loop;
      if (loop) {
        // The whole buffer loops; there is deliberately no per-lane loopEnd,
        // so lanes of different lengths never define separate loop points.
        source.loopStart = 0;
      }
      source.connect(lane.node);
      source.start(when, safeOffset);
      if (endAt !== null && typeof source.stop === 'function') {
        try {
          source.stop(endAt);
        } catch {
          // A source that cannot take an end time is still stopped on state().
        }
      }
      lane.source = source;
      this._sources.push(source);
    }
    this._startedAt = when;
    this._endAt = endAt;
    this._offset = safeOffset;
    this._loop = loop;
    this._status = 'playing';
    this._applyGains();
    return this.state();
  }

  stop() {
    this._stopSources();
    this._startedAt = null;
    this._endAt = null;
    this._offset = 0;
    if (this._status === 'playing') this._status = 'ready';
    return this.state();
  }

  _maybeEnd() {
    if (this._status !== 'playing' || this._loop || this._startedAt === null) return false;
    if (this._endAt === null || this._now() < this._endAt) return false;
    this._stopSources();
    this._startedAt = null;
    this._endAt = null;
    this._offset = 0;
    this._status = 'ready';
    return true;
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
    for (const group of this._groups) {
      if (group.node) {
        try {
          group.node.disconnect();
        } catch {
          // Already disconnected.
        }
        group.node = null;
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
    if (this._ceiling) {
      try {
        this._ceiling.disconnect();
      } catch {
        // Already disconnected.
      }
      this._ceiling = null;
    }
  }

  setGain(name, db) {
    const lane = this._lane(name);
    const value = Number(db);
    if (!Number.isFinite(value)) throw new StemDeskError('S_BAD_GAIN', `gain for ${lane.key} must be a number`);
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

  /** Crossfade the two groups with the same equal-power law as LiveMixer. */
  /** Independent per-track level, in dB, applied on top of the crossfade. */
  setTrackLevel(trackId, db) {
    const group = this._requireGroup(trackId);
    const value = Number(db);
    if (!Number.isFinite(value)) {
      throw new StemDeskError('S_BAD_GAIN', `level for ${trackId} must be a number`);
    }
    group.levelDb = Math.max(
      STEM_DESK_LIMITS.minLevelDb,
      Math.min(STEM_DESK_LIMITS.maxLevelDb, value),
    );
    this._applyGains();
    return this.state();
  }

  /** Equal-power A/B crossfade; it multiplies each track's own level. */
  setCrossfader(position) {
    const value = Number(position);
    if (!Number.isFinite(value)) {
      throw new StemDeskError('S_BAD_CROSSFADER', 'the crossfader must be a number from 0 to 100');
    }
    this._crossfader = Math.max(0, Math.min(100, value));
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
    const key = String(name);
    const exact = this._lanes.find((item) => item.key === key);
    if (exact) return exact;
    // A bare stem name is only safe when it is unique. Two loaded tracks both
    // have a "vocals", so an ambiguous bare name must not silently address the
    // first match.
    const matches = this._lanes.filter((item) => item.name === key);
    if (matches.length > 1) {
      throw new StemDeskError(
        'S_AMBIGUOUS_STEM',
        `stem name ${key} exists in more than one track; address it as track:name`,
      );
    }
    if (!matches.length) {
      throw new StemDeskError('S_UNKNOWN_STEM', `no stem lane named ${key}`);
    }
    return matches[0];
  }

  _group(trackId) {
    return this._groups.find((group) => group.trackId === String(trackId));
  }

  /** Like _group but refuses an unknown track with a truthful error. */
  _requireGroup(trackId) {
    const group = this._group(trackId);
    if (!group) {
      throw new StemDeskError('S_UNKNOWN_TRACK', `no stem group named ${String(trackId)}`);
    }
    return group;
  }

  _laneCount() {
    return this._groups.reduce((total, group) => total + group.lanes.length, 0);
  }

  _orderedGroups() {
    return [...this._groups].sort((a, b) => String(a.trackId).localeCompare(String(b.trackId)));
  }

  _duration() {
    return this._lanes.reduce((max, lane) => Math.max(max, lane.durationSeconds), 0);
  }

  /** Desk position from the shared context clock; null when not playing. */
  position() {
    this._maybeEnd();
    if (this._status !== 'playing' || this._startedAt === null) return 0;
    const elapsed = Math.max(0, this._now() - this._startedAt + this._offset);
    const duration = this._duration();
    if (duration <= 0) return 0;
    return this._loop ? elapsed % duration : Math.min(elapsed, duration);
  }

  state() {
    this._maybeEnd();
    const duration = this._duration();
    const anySolo = this._lanes.some((lane) => lane.solo);
    const crossfader = this._crossfaderState();
    const groupGainByTrack = new Map(
      this._orderedGroups().map((group) => [group.trackId, this._groupGainValue(group)]),
    );
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
        // the schedule, not a measurement of speakers, tempo or beat grid.
        scheduledTogether: this._status === 'playing',
        beatMatched: false,
      },
      crossfader,
      groups: this._orderedGroups().map((group) => Object.freeze({
        trackId: group.trackId,
        title: group.title,
        gain: this._groupGainValue(group),
        xfadeGain: this._xfadeValue(group),
        levelDb: group.levelDb ?? 0,
        laneCount: group.lanes.length,
        laneKeys: group.lanes.map((lane) => lane.key),
      })),
      lanes: this._lanes.map((lane) => Object.freeze({
        key: lane.key,
        trackId: lane.trackId,
        name: lane.name,
        label: lane.label,
        method: lane.method,
        modelName: lane.modelName,
        device: lane.device,
        stemSetId: lane.stemSetId,
        durationSeconds: lane.durationSeconds,
        gainDb: lane.gainDb,
        muted: lane.muted,
        solo: lane.solo,
        audible: anySolo ? lane.solo : !lane.muted,
        rmsDb: lane.rmsDb,
        peakDb: lane.peakDb,
        silent: lane.silent,
        // Post-crossfade, post-level: what this lane actually contributes now.
        // A soloed lane at a hard crossfade away from its track is truthfully 0.
        groupGain: groupGainByTrack.get(lane.trackId) ?? 0,
        effectiveGain: (anySolo ? lane.solo : !lane.muted)
          ? dbToLinear(lane.gainDb) * (groupGainByTrack.get(lane.trackId) ?? 0)
          : 0,
      })),
    });
  }

  /** Free one group without disturbing the other group's decoded audio. */
  unloadGroup(trackId) {
    const id = String(trackId);
    if (!this._group(id)) return this.state();
    if (this._status === 'playing') {
      this._stopSources();
      this._startedAt = null;
      this._endAt = null;
      this._offset = 0;
      this._status = 'ready';
    }
    this._groups = this._groups.filter((group) => group.trackId !== id);
    this._lanes = this._groups.flatMap((group) => group.lanes);
    this._decodedBytes = this._groups.reduce(
      (total, group) => total + group.lanes.reduce((sum, lane) => sum + lane.decodedBytes, 0),
      0,
    );
    this._rebuildGraph();
    if (this._lanes.length === 0) this._status = 'idle';
    else if (this._status !== 'playing') this._status = 'ready';
    this._error = null;
    return this.state();
  }

  /** Drop decoded audio and nodes; the desk can be loaded again. */
  unload() {
    this._stopSources();
    this._teardownNodes();
    this._groups = [];
    this._lanes = [];
    this._decodedBytes = 0;
    this._startedAt = null;
    this._endAt = null;
    this._offset = 0;
    this._status = 'idle';
    this._error = null;
  }

  /** Release everything. A context owned by the desk is closed; a shared one is not. */
  dispose() {
    this._disposed = true;
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

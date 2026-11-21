// js/arrangement/project-state.js — ProjectState, the single source of truth
// for the arrangement engine.
//
// OPERATION ALL THE TIME IN THE WORLD, Milestone A. Timeline state and audio
// rendering are separate systems: everything here is serializable metadata.
// No AudioBuffer ever enters this model — decoded audio lives in an independent,
// bounded runtime cache and is reached only through an asset's serializable
// `bufferReference`.
//
// All editing operations (edit-api.js) mutate exactly one serializable,
// versioned ProjectState through validated, atomic updates. The renderer
// (later milestones) consumes immutable snapshots of this state and never
// writes back.

import {
  DEFAULT_MICRO_FADE_BEATS,
  EPSILON,
  MAX_STRETCH_RATIO,
  MIN_CLIP_DURATION_BEATS,
  MIN_STRETCH_RATIO,
  clipSourceSpanSec,
  compareClips,
  defaultMicroFades,
} from './time-math.js';

export const SCHEMA_VERSION = 1;
export const TRACK_COUNT = 8;
export const DEFAULT_SAMPLE_RATE = 48000;
export const DEFAULT_TIME_SIGNATURE = Object.freeze([4, 4]);
export const MIN_VOLUME_DB = -60;
export const MAX_VOLUME_DB = 6;
export const MIN_CLIP_GAIN_DB = -24;
export const MAX_CLIP_GAIN_DB = 24;
export const MIN_PITCH_SEMITONES = -12;
export const MAX_PITCH_SEMITONES = 12;
export const MIN_EQ_GAIN_DB = -12;
export const MAX_EQ_GAIN_DB = 12;
export const STRETCH_MODES = Object.freeze(['beat_sync', 'manual']);
/** Gain and pan breakpoints, each. A step is two points. The 49th is refused. */
export const MAX_AUTOMATION_POINTS = 48;

/**
 * Overlap policy (normative): multiple regions on one track may overlap and
 * are all audible, summed in deterministic (timelineStartBeat, id) order —
 * see compareClips(). Edits never auto-trim or replace a neighbour, and
 * validators surface overlaps as warnings, not errors.
 */
export const OVERLAP_POLICY = 'sum';

/** Deep plain-object clone used for atomic updates and history snapshots. */
export function cloneState(state) {
  return structuredClone(state);
}

function eq(lowGainDb, midGainDb, highGainDb) {
  return { lowGainDb, midGainDb, highGainDb };
}

function makeTrack(trackIndex, name) {
  return {
    id: `track-${trackIndex}`,
    trackIndex,
    name,
    volumeDb: 0,
    pan: 0,
    mute: false,
    solo: false,
    eq: eq(0, 0, 0),
  };
}

/**
 * Create a fresh ProjectState: exactly eight tracks (index 0..7), an empty
 * asset map, no clips. `idFactory` is injectable so tests are deterministic;
 * the default counts per project and never reuses a live id.
 */
export function createProject(options = {}) {
  const {
    masterBpm = 120,
    sampleRate = DEFAULT_SAMPLE_RATE,
    timeSignature = [...DEFAULT_TIME_SIGNATURE],
  } = options;
  const state = {
    schemaVersion: SCHEMA_VERSION,
    transport: {
      masterBpm,
      timeSignature,
      sampleRate,
      playheadBeat: 0,
      isPlaying: false,
      loopRange: null,
    },
    assets: {},
    tracks: Array.from({ length: TRACK_COUNT }, (_, i) => makeTrack(i, `Track ${i + 1}`)),
    clips: [],
  };
  const errors = validateProject(state).errors;
  if (errors.length) {
    throw new InvalidStateError('createProject produced an invalid state', errors);
  }
  return state;
}

/** Thrown when a state cannot be built or restored. Carries validation detail. */
export class InvalidStateError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'InvalidStateError';
    this.errors = errors;
  }
}

/** Thrown by deserializeProject on schema-version problems. */
export class SchemaVersionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SchemaVersionError';
    this.code = code;
  }
}

/** Build an asset record. `bufferReference` must be a persistent identifier. */
export function makeAsset({ id, name, durationSec, bufferReference, nativeBpm = null, detectedKey = null }) {
  return { id, name, durationSec, nativeBpm, detectedKey, bufferReference };
}

/**
 * Build a clip record. Fade defaults are the 0.015-beat micro-fades, clamped
 * for very short clips. `customStretchRatio` is present only in manual mode.
 */
export function makeClip({
  id,
  trackIndex,
  assetId,
  timelineStartBeat,
  durationBeats,
  sourceOffsetSec,
  stretchMode,
  customStretchRatio = null,
  pitchSemitones = 0,
  preserveFormants = false,
  clipGainDb = 0,
  fadeInBeats,
  fadeOutBeats,
}) {
  const fades = defaultMicroFades(durationBeats);
  return {
    id,
    trackIndex,
    assetId,
    timelineStartBeat,
    durationBeats,
    sourceOffsetSec,
    stretchMode,
    customStretchRatio: stretchMode === 'manual' ? (customStretchRatio ?? 1) : null,
    pitchSemitones,
    preserveFormants,
    clipGainDb,
    fadeInBeats: fadeInBeats ?? fades.fadeInBeats,
    fadeOutBeats: fadeOutBeats ?? fades.fadeOutBeats,
  };
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function inRange(v, lo, hi) {
  return isFiniteNumber(v) && v >= lo && v <= hi;
}

function pushError(errors, path, code, message) {
  errors.push({ path, code, message });
}

/**
 * Read one envelope. Absent, null, and [] mean no automation. The returned
 * points keep the caller's order so a shared beat stays a step to the later
 * point. This does not rebuild the track: asset.source and nativeBpmSource
 * are not touched here.
 */
export function readAutomationPoints(points, kind) {
  if (points == null) return { points: [] };
  const label = kind === 'pan' ? 'pan' : 'gain';
  if (!Array.isArray(points)) {
    return { error: { code: 'INVALID_ARGUMENT', message: `${label} points must be an array` } };
  }
  if (points.length > MAX_AUTOMATION_POINTS) {
    return {
      error: {
        code: 'OUT_OF_RANGE',
        message: `${label} allows at most ${MAX_AUTOMATION_POINTS} points`,
      },
    };
  }
  const cleaned = [];
  for (const [i, point] of points.entries()) {
    if (!point || typeof point !== 'object') {
      return { error: { code: 'INVALID_ARGUMENT', message: `${label} point ${i} must be an object` } };
    }
    if (!isFiniteNumber(point.beat) || point.beat < 0) {
      return { error: { code: 'OUT_OF_RANGE', message: `${label} point ${i} beat must be finite and >= 0` } };
    }
    if (label === 'gain') {
      if (!inRange(point.db, MIN_VOLUME_DB, MAX_VOLUME_DB)) {
        return {
          error: {
            code: 'OUT_OF_RANGE',
            message: `${label} point ${i} db must be ${MIN_VOLUME_DB}..${MAX_VOLUME_DB}`,
          },
        };
      }
      cleaned.push({ beat: point.beat, db: point.db });
    } else if (!inRange(point.pan, -1, 1)) {
      return { error: { code: 'OUT_OF_RANGE', message: `${label} point ${i} pan must be -1..1` } };
    } else {
      cleaned.push({ beat: point.beat, pan: point.pan });
    }
  }
  return { points: cleaned };
}

/**
 * Full state validation. Returns { ok, errors, warnings } and never throws.
 * Errors are contract violations; warnings (overlap) are surfaced but legal.
 */
export function validateProject(state) {
  const errors = [];
  const warnings = [];
  if (!state || typeof state !== 'object') {
    pushError(errors, 'state', 'NOT_AN_OBJECT', 'ProjectState must be an object');
    return { ok: false, errors, warnings };
  }
  if (state.schemaVersion !== SCHEMA_VERSION) {
    pushError(errors, 'schemaVersion', 'SCHEMA_VERSION_MISMATCH', `schemaVersion must be ${SCHEMA_VERSION}`);
  }

  const t = state.transport;
  if (!t || typeof t !== 'object') {
    pushError(errors, 'transport', 'NOT_AN_OBJECT', 'transport must be an object');
  } else {
    if (!isFiniteNumber(t.masterBpm) || t.masterBpm <= 0) {
      pushError(errors, 'transport.masterBpm', 'OUT_OF_RANGE', 'masterBpm must be finite and > 0');
    }
    if (!Array.isArray(t.timeSignature) || t.timeSignature.length !== 2
      || !t.timeSignature.every((n) => Number.isInteger(n) && n > 0)) {
      pushError(errors, 'transport.timeSignature', 'INVALID', 'timeSignature must be [numerator, denominator] of positive integers');
    }
    if (!Number.isInteger(t.sampleRate) || t.sampleRate <= 0) {
      pushError(errors, 'transport.sampleRate', 'OUT_OF_RANGE', 'sampleRate must be a positive integer');
    }
    if (!isFiniteNumber(t.playheadBeat) || t.playheadBeat < -EPSILON) {
      pushError(errors, 'transport.playheadBeat', 'OUT_OF_RANGE', 'playheadBeat must be finite and >= 0');
    }
    if (typeof t.isPlaying !== 'boolean') {
      pushError(errors, 'transport.isPlaying', 'INVALID', 'isPlaying must be boolean');
    }
    if (t.loopRange !== null) {
      const ok = Array.isArray(t.loopRange) && t.loopRange.length === 2
        && t.loopRange.every(isFiniteNumber)
        && t.loopRange[0] >= -EPSILON
        && t.loopRange[1] > t.loopRange[0];
      if (!ok) {
        pushError(errors, 'transport.loopRange', 'INVALID', 'loopRange must be [startBeat, endBeat] with endBeat > startBeat >= 0, or null');
      }
    }
  }

  const assets = state.assets;
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)) {
    pushError(errors, 'assets', 'NOT_A_MAP', 'assets must be a map of assetId to asset');
  } else {
    for (const [key, asset] of Object.entries(assets)) {
      const p = `assets.${key}`;
      if (!asset || asset.id !== key) {
        pushError(errors, p, 'ID_MISMATCH', 'asset key must equal asset.id');
        continue;
      }
      if (typeof asset.name !== 'string' || !asset.name.length) {
        pushError(errors, `${p}.name`, 'INVALID', 'name must be a non-empty string');
      }
      if (!isFiniteNumber(asset.durationSec) || asset.durationSec <= 0) {
        pushError(errors, `${p}.durationSec`, 'OUT_OF_RANGE', 'durationSec must be finite and > 0');
      }
      // Unmeasured BPM and key stay explicitly unknown: null is legal,
      // a zero or negative tempo is not.
      if (asset.nativeBpm !== null && (!isFiniteNumber(asset.nativeBpm) || asset.nativeBpm <= 0)) {
        pushError(errors, `${p}.nativeBpm`, 'OUT_OF_RANGE', 'nativeBpm must be null (unknown) or finite and > 0');
      }
      if (asset.detectedKey !== null && typeof asset.detectedKey !== 'string') {
        pushError(errors, `${p}.detectedKey`, 'INVALID', 'detectedKey must be null (unknown) or a string');
      }
      if (typeof asset.bufferReference !== 'string' || !asset.bufferReference.length) {
        pushError(errors, `${p}.bufferReference`, 'INVALID', 'bufferReference must be a persistent serializable identifier');
      }
    }
  }

  const tracks = state.tracks;
  if (!Array.isArray(tracks) || tracks.length !== TRACK_COUNT) {
    pushError(errors, 'tracks', 'INVALID', `exactly ${TRACK_COUNT} tracks are required`);
  } else {
    tracks.forEach((tr, i) => {
      const p = `tracks.${i}`;
      if (!tr || tr.trackIndex !== i) {
        pushError(errors, p, 'INDEX_MISMATCH', 'tracks must be ordered with trackIndex 0..7');
        return;
      }
      if (typeof tr.id !== 'string' || !tr.id.length) {
        pushError(errors, `${p}.id`, 'INVALID', 'track id must be a non-empty string');
      }
      if (!inRange(tr.volumeDb, MIN_VOLUME_DB, MAX_VOLUME_DB)) {
        pushError(errors, `${p}.volumeDb`, 'OUT_OF_RANGE', `volumeDb must be ${MIN_VOLUME_DB}..${MAX_VOLUME_DB}`);
      }
      if (!inRange(tr.pan, -1, 1)) {
        pushError(errors, `${p}.pan`, 'OUT_OF_RANGE', 'pan must be -1..+1');
      }
      if (typeof tr.mute !== 'boolean' || typeof tr.solo !== 'boolean') {
        pushError(errors, `${p}.mute`, 'INVALID', 'mute and solo must be boolean');
      }
      const e = tr.eq;
      if (!e || !inRange(e.lowGainDb, MIN_EQ_GAIN_DB, MAX_EQ_GAIN_DB)
        || !inRange(e.midGainDb, MIN_EQ_GAIN_DB, MAX_EQ_GAIN_DB)
        || !inRange(e.highGainDb, MIN_EQ_GAIN_DB, MAX_EQ_GAIN_DB)) {
        pushError(errors, `${p}.eq`, 'OUT_OF_RANGE', `eq gains must be ${MIN_EQ_GAIN_DB}..${MAX_EQ_GAIN_DB}`);
      }
      // Missing gainPoints means none. schemaVersion stays 1; old projects
      // have no field and stay valid. Extra asset fields are not rewritten.
      if (tr.gainPoints !== undefined) {
        const read = readAutomationPoints(tr.gainPoints, 'gain');
        if (read.error) pushError(errors, `${p}.gainPoints`, read.error.code, read.error.message);
      }
      if (tr.panPoints !== undefined) {
        const read = readAutomationPoints(tr.panPoints, 'pan');
        if (read.error) pushError(errors, `${p}.panPoints`, read.error.code, read.error.message);
      }
    });
  }

  // Optional master stage (OPERATION FULL HOUSE). Absent means 0 dB, so every
  // earlier v1 project stays valid unchanged.
  if (state.master !== undefined) {
    if (!state.master || typeof state.master !== 'object'
      || !inRange(state.master.volumeDb, MIN_VOLUME_DB, MAX_VOLUME_DB)) {
      pushError(errors, 'master.volumeDb', 'OUT_OF_RANGE', `master.volumeDb must be ${MIN_VOLUME_DB}..${MAX_VOLUME_DB}`);
    }
  }

  const clips = state.clips;
  if (!Array.isArray(clips)) {
    pushError(errors, 'clips', 'INVALID', 'clips must be an array');
  } else {
    const seen = new Set();
    for (const [i, clip] of clips.entries()) {
      const p = `clips.${i}`;
      if (!clip || typeof clip.id !== 'string' || !clip.id.length) {
        pushError(errors, p, 'INVALID', 'clip id must be a non-empty string');
        continue;
      }
      if (seen.has(clip.id)) {
        pushError(errors, p, 'DUPLICATE_ID', `duplicate clip id ${clip.id}`);
      }
      seen.add(clip.id);
      if (!Number.isInteger(clip.trackIndex) || clip.trackIndex < 0 || clip.trackIndex >= TRACK_COUNT) {
        pushError(errors, `${p}.trackIndex`, 'OUT_OF_RANGE', `trackIndex must be 0..${TRACK_COUNT - 1}`);
      }
      const asset = assets?.[clip.assetId];
      if (!asset) {
        pushError(errors, `${p}.assetId`, 'UNKNOWN_ASSET', `clip references unknown asset ${clip.assetId}`);
      }
      if (!isFiniteNumber(clip.timelineStartBeat) || clip.timelineStartBeat < -EPSILON) {
        pushError(errors, `${p}.timelineStartBeat`, 'OUT_OF_RANGE', 'timelineStartBeat must be finite and >= 0');
      }
      if (!isFiniteNumber(clip.durationBeats) || clip.durationBeats < MIN_CLIP_DURATION_BEATS - EPSILON) {
        pushError(errors, `${p}.durationBeats`, 'OUT_OF_RANGE', `durationBeats must be >= ${MIN_CLIP_DURATION_BEATS}`);
      }
      if (!isFiniteNumber(clip.sourceOffsetSec) || clip.sourceOffsetSec < -EPSILON) {
        pushError(errors, `${p}.sourceOffsetSec`, 'OUT_OF_RANGE', 'sourceOffsetSec must be finite and >= 0');
      }
      if (!STRETCH_MODES.includes(clip.stretchMode)) {
        pushError(errors, `${p}.stretchMode`, 'INVALID', `stretchMode must be one of ${STRETCH_MODES.join(', ')}`);
      } else if (clip.stretchMode === 'beat_sync') {
        if (clip.customStretchRatio !== null) {
          pushError(errors, `${p}.customStretchRatio`, 'INVALID', 'customStretchRatio must be null in beat_sync mode');
        }
        if (asset && asset.nativeBpm == null) {
          pushError(errors, `${p}.stretchMode`, 'BEAT_SYNC_UNAVAILABLE', 'beat_sync requires a measured asset.nativeBpm');
        }
      } else if (!inRange(clip.customStretchRatio, MIN_STRETCH_RATIO, MAX_STRETCH_RATIO)) {
        pushError(errors, `${p}.customStretchRatio`, 'OUT_OF_RANGE', `customStretchRatio must be ${MIN_STRETCH_RATIO}..${MAX_STRETCH_RATIO}`);
      }
      if (!inRange(clip.pitchSemitones, MIN_PITCH_SEMITONES, MAX_PITCH_SEMITONES)) {
        pushError(errors, `${p}.pitchSemitones`, 'OUT_OF_RANGE', `pitchSemitones must be ${MIN_PITCH_SEMITONES}..${MAX_PITCH_SEMITONES}`);
      }
      if (typeof clip.preserveFormants !== 'boolean') {
        pushError(errors, `${p}.preserveFormants`, 'INVALID', 'preserveFormants must be boolean');
      }
      if (!inRange(clip.clipGainDb, MIN_CLIP_GAIN_DB, MAX_CLIP_GAIN_DB)) {
        pushError(errors, `${p}.clipGainDb`, 'OUT_OF_RANGE', `clipGainDb must be ${MIN_CLIP_GAIN_DB}..${MAX_CLIP_GAIN_DB}`);
      }
      if (!isFiniteNumber(clip.fadeInBeats) || !isFiniteNumber(clip.fadeOutBeats)
        || clip.fadeInBeats < -EPSILON || clip.fadeOutBeats < -EPSILON) {
        pushError(errors, `${p}.fadeInBeats`, 'OUT_OF_RANGE', 'fadeInBeats and fadeOutBeats must be finite and >= 0');
      } else if (clip.fadeInBeats + clip.fadeOutBeats > clip.durationBeats + EPSILON) {
        pushError(errors, `${p}.fadeInBeats`, 'FADES_EXCEED_CLIP', 'fadeInBeats + fadeOutBeats must not exceed durationBeats');
      }
      if (asset && t && isFiniteNumber(t.masterBpm) && t.masterBpm > 0
        && isFiniteNumber(clip.durationBeats) && isFiniteNumber(clip.sourceOffsetSec)) {
        try {
          const span = clipSourceSpanSec(clip, asset, t.masterBpm);
          if (clip.sourceOffsetSec + span > asset.durationSec + EPSILON) {
            pushError(errors, `${p}.sourceOffsetSec`, 'BEYOND_ASSET_END', 'clip source region must stay inside the asset');
          }
        } catch {
          // beat_sync with unknown BPM already reported above.
        }
      }
    }
  }

  for (const pair of findOverlaps(state)) {
    const [a, b] = pair.map((c) => c.id);
    warnings.push({
      path: `clips`,
      code: 'OVERLAP',
      message: `clips ${a} and ${b} overlap on track ${pair[0].trackIndex} (policy: ${OVERLAP_POLICY})`,
    });
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Deterministically ordered overlapping pairs per track. Uses the same
 * (timelineStartBeat, id) order as rendering, so the report cannot disagree
 * with what is heard.
 */
export function findOverlaps(state) {
  const pairs = [];
  const byTrack = new Map();
  for (const clip of state.clips ?? []) {
    if (!byTrack.has(clip.trackIndex)) byTrack.set(clip.trackIndex, []);
    byTrack.get(clip.trackIndex).push(clip);
  }
  for (const clips of byTrack.values()) {
    clips.sort(compareClips);
    for (let i = 0; i < clips.length; i += 1) {
      for (let j = i + 1; j < clips.length; j += 1) {
        const a = clips[i];
        const b = clips[j];
        if (b.timelineStartBeat >= a.timelineStartBeat + a.durationBeats - EPSILON) break;
        pairs.push([a, b]);
      }
    }
  }
  return pairs;
}

/** Deterministic clip order for one track (rendering and hit-testing order). */
export function clipsOnTrack(state, trackIndex) {
  return state.clips.filter((c) => c.trackIndex === trackIndex).sort(compareClips);
}

/**
 * Serialize a ProjectState to JSON text with stable key order, suitable for
 * persistence. Round-trips through deserializeProject losslessly.
 */
export function serializeProject(state) {
  return JSON.stringify(state, null, 2);
}

/**
 * Restore a ProjectState from serialized text. Enforces schema-version
 * handling: the current version is validated, an older known version is
 * migrated forward, anything newer or missing is refused rather than guessed.
 */
export function deserializeProject(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new InvalidStateError(`project text is not valid JSON: ${err.message}`);
  }
  const version = parsed?.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new SchemaVersionError('project text has no integer schemaVersion', 'SCHEMA_VERSION_MISSING');
  }
  if (version > SCHEMA_VERSION) {
    throw new SchemaVersionError(
      `project schemaVersion ${version} is newer than supported ${SCHEMA_VERSION}`,
      'SCHEMA_VERSION_TOO_NEW',
    );
  }
  if (version < SCHEMA_VERSION) {
    const migrated = MIGRATIONS[version]?.(parsed);
    if (!migrated) {
      throw new SchemaVersionError(`no migration from schemaVersion ${version}`, 'SCHEMA_VERSION_UNMIGRATABLE');
    }
    parsed = migrated;
  }
  const { ok, errors } = validateProject(parsed);
  if (!ok) {
    throw new InvalidStateError('restored project failed validation', errors);
  }
  return cloneState(parsed);
}

/** Forward migrations keyed by the version they read. v1 is current. */
const MIGRATIONS = {};

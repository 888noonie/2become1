// js/arrangement/edit-api.js — atomic, non-destructive edit engine.
//
// OPERATION ALL THE TIME IN THE WORLD, Milestone A. Every editing operation
// runs through one validated, atomic path (`run`) and mutates exactly one
// ProjectState. No editing operation lives inside a UI component; the UI
// (Milestone D) and the AI Producer both call this API and nothing else.
//
// Atomicity contract: an edit either commits a fully validated new state or
// throws and leaves the previous state object untouched (identity preserved).
// Source assets are never destructively edited — clips reference them by
// immutable asset records and carry only metadata.
//
// Undo/redo is snapshot-based over the editing state. The live transport
// markers (playheadBeat, isPlaying) are not editing state: they survive
// undo/redo unchanged and never enter history. loopRange and masterBpm are
// arrangement choices and do.

import {
  MAX_CLIP_GAIN_DB,
  MAX_EQ_GAIN_DB,
  MAX_PITCH_SEMITONES,
  MAX_VOLUME_DB,
  MIN_CLIP_GAIN_DB,
  MIN_EQ_GAIN_DB,
  MIN_PITCH_SEMITONES,
  MIN_VOLUME_DB,
  cloneState,
  createProject,
  deserializeProject,
  makeAsset,
  makeClip,
  serializeProject,
  validateProject,
} from './project-state.js';
import {
  DEFAULT_MICRO_FADE_BEATS,
  EPSILON,
  MAX_STRETCH_RATIO,
  MIN_CLIP_DURATION_BEATS,
  MIN_STRETCH_RATIO,
  beatsToSourceSeconds,
  clampMicroFades,
  sourceAdvanceRate,
} from './time-math.js';

const HISTORY_LIMIT = 200;

/** An edit that fails validation. The state is guaranteed unchanged. */
export class InvalidEditError extends Error {
  constructor(message, code, errors = []) {
    super(message);
    this.name = 'InvalidEditError';
    this.code = code;
    this.errors = errors;
  }
}

/**
 * exportMasterMix is part of the required API surface but genuinely depends on
 * the renderer, which is Milestone B. It fails loudly instead of pretending.
 */
export class ExportNotReadyError extends Error {
  constructor(message = 'exportMasterMix arrives with the offline renderer in Milestone B') {
    super(message);
    this.name = 'ExportNotReadyError';
    this.code = 'EXPORT_NOT_READY';
  }
}

/** A proposal commit without an explicit owner approval. */
export class ApprovalRequiredError extends Error {
  constructor(message = 'this proposal may only be applied with explicit owner approval') {
    super(message);
    this.name = 'ApprovalRequiredError';
    this.code = 'APPROVAL_REQUIRED';
  }
}

/** Round computed times so repeated trims and splits cannot accumulate drift. */
function roundTime(x) {
  return Math.round(x * 1e9) / 1e9;
}

function requireClip(draft, clipId) {
  const clip = draft.clips.find((c) => c.id === clipId);
  if (!clip) throw new InvalidEditError(`no clip ${clipId}`, 'NOT_FOUND');
  return clip;
}

function requireAsset(draft, clip) {
  const asset = draft.assets[clip.assetId];
  if (!asset) throw new InvalidEditError(`clip ${clip.id} references missing asset ${clip.assetId}`, 'NOT_FOUND');
  return asset;
}

function requireTrackIndex(trackIndex) {
  if (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex > 7) {
    throw new InvalidEditError(`trackIndex ${trackIndex} must be an integer 0..7`, 'OUT_OF_RANGE');
  }
}

function requireFinite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidEditError(`${label} must be a finite number`, 'INVALID_ARGUMENT');
  }
}

function requireRange(value, lo, hi, label) {
  requireFinite(value, label);
  if (value < lo || value > hi) {
    throw new InvalidEditError(`${label} must be ${lo}..${hi}`, 'OUT_OF_RANGE');
  }
}

/** Round-trip source bounds check against the asset; refuses overshoot. */
function requireSourceBounds(draft, clip, asset, sourceOffsetSec, durationBeats) {
  const span = beatsToSourceSeconds(
    durationBeats,
    { ...clip, durationBeats },
    asset,
    draft.transport.masterBpm,
  );
  if (sourceOffsetSec < -EPSILON) {
    throw new InvalidEditError('source region starts before the asset', 'BEYOND_ASSET_START');
  }
  if (sourceOffsetSec + span > asset.durationSec + EPSILON) {
    throw new InvalidEditError('source region runs past the end of the asset', 'BEYOND_ASSET_END');
  }
}

/**
 * Command implementations. Each receives (draft, args, helpers) and may throw
 * InvalidEditError; the engine guarantees the draft is discarded on any throw.
 * Every UI action and every AI Producer proposal funnels through here.
 */
const COMMANDS = {
  loadStemToTrack(draft, args, h) {
    const { trackIndex, audioFile, nativeBpm } = args;
    requireTrackIndex(trackIndex);
    if (!audioFile || typeof audioFile !== 'object') {
      throw new InvalidEditError('audioFile must be an asset descriptor', 'INVALID_ARGUMENT');
    }
    const { name, durationSec, bufferReference } = audioFile;
    if (typeof name !== 'string' || !name.length) {
      throw new InvalidEditError('audioFile.name must be a non-empty string', 'INVALID_ARGUMENT');
    }
    requireFinite(durationSec, 'audioFile.durationSec');
    if (durationSec <= 0) {
      throw new InvalidEditError('audioFile.durationSec must be > 0', 'OUT_OF_RANGE');
    }
    // bufferReference must be a serializable persistent identifier — a raw
    // AudioBuffer or any object can never enter the model.
    if (typeof bufferReference !== 'string' || !bufferReference.length) {
      throw new InvalidEditError('audioFile.bufferReference must be a persistent string identifier', 'INVALID_ARGUMENT');
    }
    let measuredBpm = null;
    const requested = nativeBpm === undefined ? audioFile.nativeBpm ?? null : nativeBpm;
    if (requested !== null) {
      requireFinite(requested, 'nativeBpm');
      if (requested <= 0) throw new InvalidEditError('nativeBpm must be > 0', 'OUT_OF_RANGE');
      measuredBpm = requested;
    }
    const detectedKey = audioFile.detectedKey ?? null;

    const assetId = h.nextId('asset', 'assets');
    const asset = Object.freeze(makeAsset({ id: assetId, name, durationSec, bufferReference, nativeBpm: measuredBpm, detectedKey }));
    const clipId = h.nextId('clip', 'clips');
    // A measured BPM gives beat_sync with the musical beat length; an unmeasured
    // BPM stays unknown and the clip starts in manual mode at ratio 1.
    const stretchMode = measuredBpm === null ? 'manual' : 'beat_sync';
    const durationBeats = roundTime(
      measuredBpm === null
        ? durationSec * (draft.transport.masterBpm / 60)
        : (durationSec * measuredBpm) / 60,
    );
    draft.assets[assetId] = asset;
    const clip = makeClip({
      id: clipId,
      trackIndex,
      assetId,
      timelineStartBeat: 0,
      durationBeats,
      sourceOffsetSec: 0,
      stretchMode,
      customStretchRatio: stretchMode === 'manual' ? 1 : null,
    });
    draft.clips.push(clip);
    return { assetId, clipId };
  },

  moveClip(draft, args) {
    const { clipId, newTrackIndex, newStartBeat } = args;
    requireTrackIndex(newTrackIndex);
    requireFinite(newStartBeat, 'newStartBeat');
    if (newStartBeat < -EPSILON) {
      throw new InvalidEditError('newStartBeat must be >= 0', 'OUT_OF_RANGE');
    }
    const clip = requireClip(draft, clipId);
    clip.trackIndex = newTrackIndex;
    clip.timelineStartBeat = roundTime(Math.max(0, newStartBeat));
    return { clipId };
  },

  trimClip(draft, args) {
    const { clipId, edge, deltaBeats } = args;
    if (edge !== 'start' && edge !== 'end') {
      throw new InvalidEditError(`edge must be 'start' or 'end'`, 'INVALID_ARGUMENT');
    }
    requireFinite(deltaBeats, 'deltaBeats');
    const clip = requireClip(draft, clipId);
    const asset = requireAsset(draft, clip);

    let newStart = clip.timelineStartBeat;
    let newDuration = clip.durationBeats;
    let newSourceOffset = clip.sourceOffsetSec;
    if (edge === 'start') {
      newStart = clip.timelineStartBeat + deltaBeats;
      newDuration = clip.durationBeats - deltaBeats;
      // The start edge advances in source time at the clip's own rate.
      newSourceOffset = clip.sourceOffsetSec + beatsToSourceSeconds(deltaBeats, clip, asset, draft.transport.masterBpm);
    } else {
      newDuration = clip.durationBeats + deltaBeats;
    }
    if (newStart < -EPSILON) {
      throw new InvalidEditError('trim would move the clip before beat 0', 'OUT_OF_RANGE');
    }
    if (newDuration < MIN_CLIP_DURATION_BEATS - EPSILON) {
      throw new InvalidEditError(`trim would leave less than ${MIN_CLIP_DURATION_BEATS} beats`, 'OUT_OF_RANGE');
    }
    newStart = roundTime(Math.max(0, newStart));
    newDuration = roundTime(newDuration);
    newSourceOffset = roundTime(Math.max(0, newSourceOffset));
    requireSourceBounds(draft, clip, asset, newSourceOffset, newDuration);
    const fades = clampMicroFades(clip.fadeInBeats, clip.fadeOutBeats, newDuration);
    clip.timelineStartBeat = newStart;
    clip.durationBeats = newDuration;
    clip.sourceOffsetSec = newSourceOffset;
    clip.fadeInBeats = fades.fadeInBeats;
    clip.fadeOutBeats = fades.fadeOutBeats;
    return { clipId, timelineStartBeat: newStart, durationBeats: newDuration, sourceOffsetSec: newSourceOffset };
  },

  splitClipAtBeat(draft, args, h) {
    const { clipId, splitBeat } = args;
    requireFinite(splitBeat, 'splitBeat');
    const clip = requireClip(draft, clipId);
    requireAsset(draft, clip);
    const rel = splitBeat - clip.timelineStartBeat;
    if (rel < MIN_CLIP_DURATION_BEATS - EPSILON
      || rel > clip.durationBeats - MIN_CLIP_DURATION_BEATS + EPSILON) {
      throw new InvalidEditError('splitBeat must leave both halves at least 1/64 beat', 'SPLIT_OUTSIDE_CLIP');
    }
    const leftDuration = roundTime(rel);
    const rightDuration = roundTime(clip.durationBeats - rel);
    // Source offsets advance at the clip's own source-advance rate, so the
    // second region continues exactly where the first one stops.
    const deltaSource = beatsToSourceSeconds(rel, clip, requireAsset(draft, clip), draft.transport.masterBpm);
    const rightId = requireNewId(args) ?? h.nextId('clip', 'clips');
    const right = makeClip({
      id: rightId,
      trackIndex: clip.trackIndex,
      assetId: clip.assetId,
      timelineStartBeat: roundTime(splitBeat),
      durationBeats: rightDuration,
      sourceOffsetSec: roundTime(clip.sourceOffsetSec + deltaSource),
      stretchMode: clip.stretchMode,
      customStretchRatio: clip.customStretchRatio,
      pitchSemitones: clip.pitchSemitones,
      preserveFormants: clip.preserveFormants,
      clipGainDb: clip.clipGainDb,
    });
    // Click-safe inner edges get the default micro-fade; outer edges keep the
    // parent's fades, each clamped to its own half.
    const leftFades = clampMicroFades(clip.fadeInBeats, Math.min(DEFAULT_MICRO_FADE_BEATS, leftDuration / 2), leftDuration);
    const rightFades = clampMicroFades(Math.min(DEFAULT_MICRO_FADE_BEATS, rightDuration / 2), clip.fadeOutBeats, rightDuration);
    clip.durationBeats = leftDuration;
    clip.fadeInBeats = leftFades.fadeInBeats;
    clip.fadeOutBeats = leftFades.fadeOutBeats;
    right.fadeInBeats = rightFades.fadeInBeats;
    right.fadeOutBeats = rightFades.fadeOutBeats;
    draft.clips.push(right);
    return { leftId: clip.id, rightId: right.id };
  },

  setClipStretch(draft, args) {
    const { clipId, ratioOrAuto } = args;
    const clip = requireClip(draft, clipId);
    const asset = requireAsset(draft, clip);
    if (ratioOrAuto === 'auto') {
      if (asset.nativeBpm == null) {
        throw new InvalidEditError('beat_sync is unavailable while the asset BPM is unknown', 'BEAT_SYNC_UNAVAILABLE');
      }
      clip.stretchMode = 'beat_sync';
      clip.customStretchRatio = null;
    } else {
      requireRange(ratioOrAuto, MIN_STRETCH_RATIO, MAX_STRETCH_RATIO, 'ratioOrAuto');
      clip.stretchMode = 'manual';
      clip.customStretchRatio = roundTime(ratioOrAuto);
    }
    // The clip keeps its timeline duration; the rate decides how much source
    // it consumes. Refuse a rate that would run past the asset.
    requireSourceBounds(draft, clip, asset, clip.sourceOffsetSec, clip.durationBeats);
    return { clipId, stretchMode: clip.stretchMode, customStretchRatio: clip.customStretchRatio };
  },

  setClipPitch(draft, args) {
    const { clipId, semitones, preserveFormants } = args;
    requireRange(semitones, MIN_PITCH_SEMITONES, MAX_PITCH_SEMITONES, 'semitones');
    if (typeof preserveFormants !== 'boolean') {
      throw new InvalidEditError('preserveFormants must be boolean', 'INVALID_ARGUMENT');
    }
    const clip = requireClip(draft, clipId);
    clip.pitchSemitones = semitones;
    clip.preserveFormants = preserveFormants;
    // Pitch is metadata only: duration, rate and source offsets are untouched.
    return { clipId, pitchSemitones: semitones, preserveFormants, durationBeats: clip.durationBeats };
  },

  setClipGain(draft, args) {
    const { clipId, gainDb } = args;
    requireRange(gainDb, MIN_CLIP_GAIN_DB, MAX_CLIP_GAIN_DB, 'gainDb');
    const clip = requireClip(draft, clipId);
    clip.clipGainDb = gainDb;
    return { clipId, clipGainDb: gainDb };
  },

  setClipFades(draft, args) {
    const { clipId, fadeInBeats, fadeOutBeats } = args;
    requireFinite(fadeInBeats, 'fadeInBeats');
    requireFinite(fadeOutBeats, 'fadeOutBeats');
    const clip = requireClip(draft, clipId);
    if (fadeInBeats < -EPSILON || fadeOutBeats < -EPSILON) {
      throw new InvalidEditError('fades must be >= 0', 'OUT_OF_RANGE');
    }
    if (fadeInBeats + fadeOutBeats > clip.durationBeats + EPSILON) {
      throw new InvalidEditError('fades must not exceed the clip duration', 'FADES_EXCEED_CLIP');
    }
    clip.fadeInBeats = fadeInBeats;
    clip.fadeOutBeats = fadeOutBeats;
    return { clipId, fadeInBeats, fadeOutBeats };
  },

  setTrackVolume(draft, args) {
    const { trackIndex, volumeDb } = args;
    requireTrackIndex(trackIndex);
    requireRange(volumeDb, MIN_VOLUME_DB, MAX_VOLUME_DB, 'volumeDb');
    draft.tracks[trackIndex].volumeDb = volumeDb;
    return { trackIndex, volumeDb };
  },

  setTrackPan(draft, args) {
    const { trackIndex, pan } = args;
    requireTrackIndex(trackIndex);
    requireRange(pan, -1, 1, 'pan');
    draft.tracks[trackIndex].pan = pan;
    return { trackIndex, pan };
  },

  setTrackMute(draft, args) {
    const { trackIndex, mute } = args;
    requireTrackIndex(trackIndex);
    if (typeof mute !== 'boolean') throw new InvalidEditError('mute must be boolean', 'INVALID_ARGUMENT');
    draft.tracks[trackIndex].mute = mute;
    return { trackIndex, mute };
  },

  setTrackSolo(draft, args) {
    const { trackIndex, solo } = args;
    requireTrackIndex(trackIndex);
    if (typeof solo !== 'boolean') throw new InvalidEditError('solo must be boolean', 'INVALID_ARGUMENT');
    draft.tracks[trackIndex].solo = solo;
    return { trackIndex, solo };
  },

  setTrackEq(draft, args) {
    const { trackIndex, eq } = args;
    requireTrackIndex(trackIndex);
    if (!eq || typeof eq !== 'object') throw new InvalidEditError('eq must be an object', 'INVALID_ARGUMENT');
    for (const band of ['lowGainDb', 'midGainDb', 'highGainDb']) {
      if (eq[band] === undefined) continue;
      requireRange(eq[band], MIN_EQ_GAIN_DB, MAX_EQ_GAIN_DB, `eq.${band}`);
      draft.tracks[trackIndex].eq[band] = eq[band];
    }
    return { trackIndex, eq: { ...draft.tracks[trackIndex].eq } };
  },

  setMasterBpm(draft, args) {
    const { masterBpm } = args;
    requireFinite(masterBpm, 'masterBpm');
    if (masterBpm <= 0) throw new InvalidEditError('masterBpm must be > 0', 'OUT_OF_RANGE');
    draft.transport.masterBpm = masterBpm;
    // Manual-mode source spans scale with the tempo mapping; the full-state
    // validation below refuses a tempo that would run a clip off its asset.
    return { masterBpm };
  },

  setLoopRange(draft, args) {
    const { startBeat, endBeat } = args;
    if (startBeat === null && endBeat === null) {
      draft.transport.loopRange = null;
      return { loopRange: null };
    }
    requireFinite(startBeat, 'startBeat');
    requireFinite(endBeat, 'endBeat');
    if (startBeat < -EPSILON || endBeat <= startBeat) {
      throw new InvalidEditError('loopRange must satisfy endBeat > startBeat >= 0', 'OUT_OF_RANGE');
    }
    draft.transport.loopRange = [roundTime(Math.max(0, startBeat)), roundTime(endBeat)];
    return { loopRange: draft.transport.loopRange };
  },
};

/** Optional explicit id for the second half of a split (tests use it). */
function requireNewId(args) {
  return typeof args?.newClipId === 'string' && args.newClipId.length ? args.newClipId : undefined;
}

export class EditEngine {
  /**
   * @param {{project?: object, idFactory?: (prefix: string) => string}} options
   */
  constructor(options = {}) {
    this._state = options.project ? cloneState(options.project) : createProject();
    this._validateNow(this._state);
    this._idFactory = options.idFactory ?? null;
    this._past = [];
    this._future = [];
    this._proposalSeq = 0;
  }

  _validateNow(state) {
    const { ok, errors } = validateProject(state);
    if (!ok) throw new InvalidEditError('state failed validation', 'INVALID_STATE', errors);
  }

  /** The live state object. Treat as read-only; use snapshot() to copy. */
  get state() {
    return this._state;
  }

  /** A deep copy of the state, e.g. for a renderer snapshot. */
  snapshot() {
    return cloneState(this._state);
  }

  get canUndo() {
    return this._past.length > 0;
  }

  get canRedo() {
    return this._future.length > 0;
  }

  get historyDepth() {
    return { past: this._past.length, future: this._future.length };
  }

  _nextId(prefix, collectionKey) {
    if (this._idFactory) return this._idFactory(prefix);
    const collection = collectionKey === 'assets' ? this._draft.assets : this._draft.clips;
    let max = 0;
    const re = new RegExp(`^${prefix}-(\\d+)$`);
    for (const item of Object.values(collection)) {
      const m = re.exec(item.id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `${prefix}-${max + 1}`;
  }

  /**
   * The single mutation path. Clones the state, applies the command to the
   * draft, validates the whole result, then commits atomically. Any throw
   * leaves the previous state object untouched and pushes no history.
   */
  run(command) {
    const impl = COMMANDS[command?.name];
    if (!impl) throw new InvalidEditError(`unknown command ${command?.name}`, 'UNKNOWN_COMMAND');
    const previous = this._state;
    const draft = cloneState(previous);
    this._draft = draft;
    let result;
    try {
      result = impl(draft, command.args ?? {}, {
        nextId: (prefix, key) => this._nextId(prefix, key),
      });
    } finally {
      this._draft = null;
    }
    const { ok, errors, warnings } = validateProject(draft);
    if (!ok) {
      throw new InvalidEditError(`edit ${command.name} produced an invalid state`, 'INVALID_STATE', errors);
    }
    this._state = draft;
    this._past.push(previous);
    if (this._past.length > HISTORY_LIMIT) this._past.shift();
    this._future = [];
    return { result, warnings };
  }

  // --- Edit primitives (Milestone A contract) ---

  loadStemToTrack(trackIndex, audioFile, nativeBpm) {
    return this.run({ name: 'loadStemToTrack', args: { trackIndex, audioFile, nativeBpm } }).result;
  }

  moveClip(clipId, newTrackIndex, newStartBeat) {
    return this.run({ name: 'moveClip', args: { clipId, newTrackIndex, newStartBeat } }).result;
  }

  trimClip(clipId, edge, deltaBeats) {
    return this.run({ name: 'trimClip', args: { clipId, edge, deltaBeats } }).result;
  }

  splitClipAtBeat(clipId, splitBeat) {
    return this.run({ name: 'splitClipAtBeat', args: { clipId, splitBeat } }).result;
  }

  setClipStretch(clipId, ratioOrAuto) {
    return this.run({ name: 'setClipStretch', args: { clipId, ratioOrAuto } }).result;
  }

  setClipPitch(clipId, semitones, preserveFormants) {
    return this.run({ name: 'setClipPitch', args: { clipId, semitones, preserveFormants } }).result;
  }

  setClipGain(clipId, gainDb) {
    return this.run({ name: 'setClipGain', args: { clipId, gainDb } }).result;
  }

  setClipFades(clipId, fadeInBeats, fadeOutBeats) {
    return this.run({ name: 'setClipFades', args: { clipId, fadeInBeats, fadeOutBeats } }).result;
  }

  /** Arrives with the offline renderer (Milestone B). Fails loudly until then. */
  exportMasterMix() {
    throw new ExportNotReadyError();
  }

  // --- Track and transport ---

  setTrackVolume(trackIndex, volumeDb) {
    return this.run({ name: 'setTrackVolume', args: { trackIndex, volumeDb } }).result;
  }

  setTrackPan(trackIndex, pan) {
    return this.run({ name: 'setTrackPan', args: { trackIndex, pan } }).result;
  }

  setTrackMute(trackIndex, mute) {
    return this.run({ name: 'setTrackMute', args: { trackIndex, mute } }).result;
  }

  setTrackSolo(trackIndex, solo) {
    return this.run({ name: 'setTrackSolo', args: { trackIndex, solo } }).result;
  }

  setTrackEq(trackIndex, eq) {
    return this.run({ name: 'setTrackEq', args: { trackIndex, eq } }).result;
  }

  setMasterBpm(masterBpm) {
    return this.run({ name: 'setMasterBpm', args: { masterBpm } }).result;
  }

  setLoopRange(startBeat, endBeat) {
    return this.run({ name: 'setLoopRange', args: { startBeat, endBeat } }).result;
  }

  /** Live playback marker: atomic and validated, but never enters history. */
  setPlayhead(playheadBeat) {
    requireFinite(playheadBeat, 'playheadBeat');
    if (playheadBeat < -EPSILON) throw new InvalidEditError('playheadBeat must be >= 0', 'OUT_OF_RANGE');
    const draft = cloneState(this._state);
    draft.transport.playheadBeat = roundTime(Math.max(0, playheadBeat));
    this._validateNow(draft);
    this._state = draft;
    return { playheadBeat: draft.transport.playheadBeat };
  }

  /** Live playback marker: atomic and validated, but never enters history. */
  setPlaying(isPlaying) {
    if (typeof isPlaying !== 'boolean') throw new InvalidEditError('isPlaying must be boolean', 'INVALID_ARGUMENT');
    const draft = cloneState(this._state);
    draft.transport.isPlaying = isPlaying;
    this._validateNow(draft);
    this._state = draft;
    return { isPlaying };
  }

  // --- Undo / redo ---

  undo() {
    if (!this._past.length) return false;
    const current = this._state;
    this._future.push(current);
    const restored = this._past.pop();
    // Live transport markers are not editing state: carry them forward.
    restored.transport.playheadBeat = current.transport.playheadBeat;
    restored.transport.isPlaying = current.transport.isPlaying;
    this._state = restored;
    return true;
  }

  redo() {
    if (!this._future.length) return false;
    const current = this._state;
    this._past.push(current);
    const restored = this._future.pop();
    restored.transport.playheadBeat = current.transport.playheadBeat;
    restored.transport.isPlaying = current.transport.isPlaying;
    this._state = restored;
    return true;
  }

  // --- Persistence ---

  serialize() {
    return serializeProject(this._state);
  }

  static deserialize(text, options = {}) {
    return new EditEngine({ ...options, project: deserializeProject(text) });
  }

  // --- AI Producer seam ---
  //
  // A proposal is a validated dry run plus an explicit approval boundary.
  // propose() never mutates; applyProposal() requires the owner's approval and
  // re-runs the same validated command path as any hand edit.

  propose(command) {
    const id = `proposal-${(this._proposalSeq += 1)}`;
    const draft = cloneState(this._state);
    const impl = COMMANDS[command?.name];
    if (!impl) {
      return { id, command, status: 'rejected', errors: [{ code: 'UNKNOWN_COMMAND', message: `unknown command ${command?.name}` }] };
    }
    this._draft = draft;
    try {
      impl(draft, command.args ?? {}, { nextId: (prefix, key) => this._nextId(prefix, key) });
    } catch (err) {
      return {
        id,
        command,
        status: 'rejected',
        errors: [{ code: err.code ?? 'INVALID_ARGUMENT', message: err.message }],
      };
    } finally {
      this._draft = null;
    }
    const { ok, errors } = validateProject(draft);
    if (!ok) {
      return { id, command, status: 'rejected', errors };
    }
    return { id, command, status: 'pending' };
  }

  applyProposal(proposal, options = {}) {
    if (!proposal || proposal.status !== 'pending') {
      throw new InvalidEditError('only a pending proposal can be applied', 'PROPOSAL_NOT_APPLICABLE');
    }
    if (options.approved !== true) {
      throw new ApprovalRequiredError();
    }
    return this.run(proposal.command).result;
  }
}

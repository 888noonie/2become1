// A stem-desk proposal is data until approveStemDeskProposal runs.
// The desk remains the only code that changes mute, gain, level, crossfader,
// or entry offset. This module does not call a model and does not call play().

import { STEM_DESK_LIMITS } from './stem-desk.js';

export const PROPOSAL_SCHEMA = 'stem-desk-proposal/v1';

const TOP_KEYS = new Set([
  'schema', 'tracks', 'lanes', 'groups', 'crossfader', 'rationale', 'evidence', 'caveats', 'confidence',
]);
const TRACK_KEYS = new Set(['stemSetId']);
const GROUP_KEYS = new Set(['levelDb', 'entryOffsetMs']);
const LANE_KEYS = new Set(['muted', 'gainDb']);
const MEASURE_KEYS = new Set(['rmsDb', 'peakDb', 'silent']);
const CAVEAT_KEYS = new Set(['tempo', 'key']);
const LANE_NAME = /^(A|B):[A-Za-z][A-Za-z0-9_-]*$/;
const KEEP = { A: new Set(['drums', 'bass']), B: new Set(['vocals', 'other']) };

function reject(code, message) {
  return { ok: false, code, message };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function extraKey(value, allowed) {
  if (!isObject(value)) return null;
  return Object.keys(value).find((key) => !allowed.has(key)) ?? null;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function inRange(value, min, max) {
  return finiteNumber(value) && value >= min && value <= max;
}

function parse(raw) {
  if (typeof raw !== 'string') return { value: raw };
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return { error: reject('INVALID_PROPOSAL', 'the proposal is not JSON') };
  }
}

function laneMap(deskState) {
  const lanes = new Map();
  for (const lane of deskState?.lanes || []) lanes.set(lane.key, lane);
  return lanes;
}

function groupMap(deskState) {
  const groups = new Map();
  for (const group of deskState?.groups || []) groups.set(group.trackId, group);
  return groups;
}

/**
 * Check one proposal against a desk snapshot. This calls nothing on the desk.
 * @returns {{ok: true, proposal: object} | {ok: false, code: string, message: string}}
 */
export function validateStemDeskProposal(raw, deskState) {
  const parsed = parse(raw);
  if (parsed.error) return parsed.error;
  const proposal = parsed.value;
  if (!isObject(proposal)) return reject('INVALID_PROPOSAL', 'the proposal must be one object');
  const unknown = extraKey(proposal, TOP_KEYS);
  if (unknown) return reject('UNKNOWN_OP', `${unknown} is not a stem-desk proposal field`);
  if (proposal.schema !== PROPOSAL_SCHEMA) {
    return reject('INVALID_PROPOSAL', 'the proposal schema is not stem-desk-proposal/v1');
  }
  if (!isObject(proposal.tracks) || !isObject(proposal.groups) || !isObject(proposal.lanes)) {
    return reject('INVALID_PROPOSAL', 'tracks, groups, and lanes must be objects');
  }
  if (!isObject(proposal.evidence) || !isObject(proposal.caveats)) {
    return reject('INVALID_PROPOSAL', 'evidence and caveats must be objects');
  }
  const trackIds = Object.keys(proposal.tracks);
  if (trackIds.length < 1 || trackIds.length > 2 || trackIds.some((id) => id !== 'A' && id !== 'B')) {
    return reject('INVALID_PROPOSAL', 'tracks must name A, B, or both');
  }
  if (Object.keys(proposal.groups).sort().join() !== [...trackIds].sort().join()) {
    return reject('INVALID_PROPOSAL', 'groups must name the same tracks');
  }
  if (typeof proposal.rationale !== 'string' || proposal.rationale.length < 1 || proposal.rationale.length > 500) {
    return reject('INVALID_PROPOSAL', 'rationale must be a short string');
  }
  const caveatKey = extraKey(proposal.caveats, CAVEAT_KEYS);
  if (caveatKey) return reject('UNKNOWN_OP', `caveats.${caveatKey} is not a stem-desk proposal field`);
  if (typeof proposal.caveats.tempo !== 'string' || !proposal.caveats.tempo) {
    return reject('INVALID_PROPOSAL', 'caveats.tempo must say what was not matched');
  }
  if (typeof proposal.caveats.key !== 'string' || !proposal.caveats.key) {
    return reject('INVALID_PROPOSAL', 'caveats.key must say what was not matched');
  }
  if (!inRange(proposal.confidence, 0, 1)) {
    return reject('INVALID_PROPOSAL', 'confidence must be a number from 0 to 1');
  }
  if (!inRange(proposal.crossfader, 0, 100)) {
    return reject('CROSSFADER_OUT_OF_RANGE', 'crossfader must be a number from 0 to 100');
  }

  const loadedLanes = laneMap(deskState);
  const loadedGroups = groupMap(deskState);
  const soloed = [...loadedLanes.values()].find((lane) => lane.solo);
  if (soloed) {
    return reject('SOLO_HELD', `clear solo on ${soloed.key} before approving a proposal`);
  }
  const omitted = [...loadedGroups.keys()].find((trackId) => !proposal.tracks[trackId]);
  if (omitted) {
    return reject('GROUP_OMITTED', `group ${omitted} is loaded, so a proposal has to name it before the shared crossfader can move`);
  }
  for (const trackId of trackIds) {
    const track = proposal.tracks[trackId];
    const trackExtra = extraKey(track, TRACK_KEYS);
    if (trackExtra) return reject('UNKNOWN_OP', `tracks.${trackId}.${trackExtra} is not a stem-desk proposal field`);
    if (!isObject(track) || typeof track.stemSetId !== 'string' || !track.stemSetId) {
      return reject('INVALID_PROPOSAL', `track ${trackId} needs a stem set id`);
    }
    const group = proposal.groups[trackId];
    const groupExtra = extraKey(group, GROUP_KEYS);
    if (groupExtra) return reject('UNKNOWN_OP', `groups.${trackId}.${groupExtra} is not a stem-desk proposal field`);
    if (!isObject(group)) return reject('INVALID_PROPOSAL', `group ${trackId} must be an object`);
    if (!inRange(group.levelDb, STEM_DESK_LIMITS.minLevelDb, STEM_DESK_LIMITS.maxLevelDb)) {
      return reject('LEVEL_OUT_OF_RANGE', `group ${trackId} level is outside ${STEM_DESK_LIMITS.minLevelDb} to ${STEM_DESK_LIMITS.maxLevelDb} dB`);
    }
    if (!inRange(group.entryOffsetMs, -STEM_DESK_LIMITS.maxEntryOffsetMs, STEM_DESK_LIMITS.maxEntryOffsetMs)) {
      return reject('OFFSET_OUT_OF_RANGE', `group ${trackId} entry is outside ±${STEM_DESK_LIMITS.maxEntryOffsetMs} ms`);
    }
    const loaded = loadedGroups.get(trackId);
    if (!loaded) return reject('TRACK_NOT_LOADED', `group ${trackId} is not loaded`);
    const lanesForTrack = [...loadedLanes.values()].filter((lane) => lane.trackId === trackId);
    if (!lanesForTrack.length || lanesForTrack.some((lane) => lane.stemSetId !== track.stemSetId)) {
      return reject('TRACK_NOT_LOADED', `group ${trackId} is not the stem set ${track.stemSetId}`);
    }
  }

  const laneIds = Object.keys(proposal.lanes);
  const evidenceIds = Object.keys(proposal.evidence);
  if (laneIds.length > 8) return reject('INVALID_PROPOSAL', 'a proposal can name at most eight lanes');
  if (evidenceIds.length !== laneIds.length || evidenceIds.some((key) => !proposal.lanes[key])) {
    return reject('EVIDENCE_MISMATCH', 'evidence must describe the same lanes as the proposal');
  }
  for (const key of laneIds) {
    if (!LANE_NAME.test(key)) return reject('UNKNOWN_LANE', `${key} is not a track:name lane`);
    const trackId = key.slice(0, 1);
    if (!proposal.tracks[trackId]) return reject('UNKNOWN_LANE', `${key} is not in a named track`);
    const lane = proposal.lanes[key];
    const laneExtra = extraKey(lane, LANE_KEYS);
    if (laneExtra) return reject('UNKNOWN_OP', `${key}.${laneExtra} is not a stem-desk proposal field`);
    if (!isObject(lane) || typeof lane.muted !== 'boolean') {
      return reject('INVALID_PROPOSAL', `${key} needs a boolean mute`);
    }
    if (!inRange(lane.gainDb, STEM_DESK_LIMITS.minGainDb, STEM_DESK_LIMITS.maxGainDb)) {
      return reject('GAIN_OUT_OF_RANGE', `${key} gain is outside ${STEM_DESK_LIMITS.minGainDb} to ${STEM_DESK_LIMITS.maxGainDb} dB`);
    }
    const loaded = loadedLanes.get(key);
    if (!loaded) return reject('UNKNOWN_LANE', `${key} is not loaded`);
    const measure = proposal.evidence[key];
    const measureExtra = extraKey(measure, MEASURE_KEYS);
    if (measureExtra) return reject('UNKNOWN_OP', `evidence.${key}.${measureExtra} is not a stem-desk proposal field`);
    if (!isObject(measure) || !finiteNumber(measure.rmsDb) || !finiteNumber(measure.peakDb) || typeof measure.silent !== 'boolean') {
      return reject('EVIDENCE_MISMATCH', `evidence for ${key} must quote the loaded measurement`);
    }
    if (Math.abs(measure.rmsDb - loaded.rmsDb) > 0.05 || Math.abs(measure.peakDb - loaded.peakDb) > 0.05 || measure.silent !== loaded.silent) {
      return reject('EVIDENCE_MISMATCH', `evidence for ${key} does not match the loaded lane`);
    }
  }
  return { ok: true, proposal };
}

/**
 * Apply a proposal only after it validates against the desk's current state.
 * Does not start playback.
 */
export function approveStemDeskProposal(raw, desk) {
  const checked = validateStemDeskProposal(raw, desk.state());
  if (!checked.ok) return checked;
  const proposal = checked.proposal;
  desk.setCrossfader(proposal.crossfader);
  for (const [trackId, group] of Object.entries(proposal.groups)) {
    desk.setTrackLevel(trackId, group.levelDb);
    desk.setGroupEntryOffset(trackId, group.entryOffsetMs);
  }
  for (const [key, lane] of Object.entries(proposal.lanes)) {
    desk.setGain(key, lane.gainDb);
    desk.setMuted(key, lane.muted);
  }
  return { ok: true, state: desk.state() };
}

function measureOf(lane) {
  return { rmsDb: lane.rmsDb, peakDb: lane.peakDb, silent: lane.silent };
}

/**
 * One preference: A keeps drums and bass, B keeps vocals and other.
 * Silent lanes stay muted. Offsets stay at 0. Nothing is applied.
 */
export function suggestStemDeskProposal(deskState) {
  const groups = groupMap(deskState);
  if (!groups.has('A') || !groups.has('B')) {
    return reject('TRACK_NOT_LOADED', 'a suggestion needs group A and group B loaded');
  }
  const lanes = [...laneMap(deskState).values()];
  const tracks = {};
  const groupBody = {};
  const laneBody = {};
  const evidence = {};
  for (const trackId of ['A', 'B']) {
    const own = lanes.filter((lane) => lane.trackId === trackId);
    const stemSetId = own[0]?.stemSetId;
    if (!own.length || !stemSetId || own.some((lane) => lane.stemSetId !== stemSetId)) {
      return reject('TRACK_NOT_LOADED', `group ${trackId} has no single stem set`);
    }
    tracks[trackId] = { stemSetId };
    groupBody[trackId] = { levelDb: 0, entryOffsetMs: 0 };
    for (const lane of own) {
      laneBody[lane.key] = {
        muted: lane.silent === true || !KEEP[trackId].has(lane.name),
        gainDb: 0,
      };
      evidence[lane.key] = measureOf(lane);
    }
  }
  const proposal = {
    schema: PROPOSAL_SCHEMA,
    tracks,
    groups: groupBody,
    lanes: laneBody,
    crossfader: 50,
    rationale: 'Group A keeps drums and bass. Group B keeps vocals and other. Silent lanes stay muted.',
    evidence,
    caveats: {
      tempo: 'Entry offsets stay at 0 ms. The desk does not beat-match.',
      key: 'The desk has no pitch control.',
    },
    confidence: 0.5,
  };
  return validateStemDeskProposal(proposal, deskState);
}

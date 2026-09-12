// js/runtime/beat-sync.js — beat-sync launch resolution for dual-deck live mix.
//
// Phase 15B. Pure module: no DOM, Web Audio, timers, or fetch. Derives the
// follower's quantized launch time, media offset, and bounded tempo ratio
// against a playing master transport. Missing or stale grids fail closed.

import { buildFailure, buildSuccess, ERROR_CODES } from '../actions/errors.js';
import { beatAtTime, resolveNextPhrase } from '../transport/derive.js';
import { normalizeTransport } from '../transport/normalize.js';
import { localGridRevision, secondsToBeats } from './transport-bridge.js';

export const BEAT_SYNC_MIN_LEAD_SECONDS = 0.25;
export const BEAT_SYNC_MIN_TEMPO_RATIO = 0.25;
export const BEAT_SYNC_MAX_TEMPO_RATIO = 4.0;

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Inverse of secondsToBeats: beat -> element seconds on the track grid.
 * @param {number} beat
 * @param {{first_beat: number}} beatGrid
 * @param {number} bpm
 */
export function beatsToSeconds(beat, beatGrid, bpm) {
  return Number(beatGrid.first_beat) + beat * 60 / bpm;
}

/**
 * Extract validated grid facts from a library/deck track record.
 * @returns {{ ok: true, value: object } | { ok: false, code: string }}
 */
export function extractTrackGridFacts(track) {
  if (!track || typeof track !== 'object') {
    return buildFailure('T_TRACK_MISSING');
  }
  const bpm = Number(track.bpm);
  if (!finiteNumber(bpm) || bpm <= 0) {
    return buildFailure(ERROR_CODES.T_INVALID_TEMPO, { value: bpm });
  }
  const grid = track.beat_grid;
  if (!grid || typeof grid !== 'object') {
    return buildFailure('T_GRID_MISSING');
  }
  const firstBeat = Number(grid.first_beat);
  const interval = Number(grid.interval);
  if (!finiteNumber(firstBeat) || firstBeat < 0) {
    return buildFailure('T_GRID_MISSING');
  }
  if (!finiteNumber(interval) || interval <= 0) {
    return buildFailure('T_GRID_MISSING');
  }
  return buildSuccess(Object.freeze({
    bpm,
    beatGrid: Object.freeze({ first_beat: firstBeat, interval }),
    gridRevision: localGridRevision(track, bpm),
  }));
}

/**
 * Bounded playback-rate ratio so the follower matches the master tempo.
 * @returns {{ ok: true, value: number } | { ok: false, code: string }}
 */
export function computeTempoRatio(masterBpm, followerBpm) {
  if (!finiteNumber(masterBpm) || masterBpm <= 0) {
    return buildFailure(ERROR_CODES.T_INVALID_TEMPO, { value: masterBpm, field: 'masterBpm' });
  }
  if (!finiteNumber(followerBpm) || followerBpm <= 0) {
    return buildFailure(ERROR_CODES.T_INVALID_TEMPO, { value: followerBpm, field: 'followerBpm' });
  }
  const ratio = masterBpm / followerBpm;
  if (!finiteNumber(ratio) || ratio < BEAT_SYNC_MIN_TEMPO_RATIO || ratio > BEAT_SYNC_MAX_TEMPO_RATIO) {
    return buildFailure(ERROR_CODES.T_TEMPO_RATIO_OUT_OF_RANGE, { ratio, masterBpm, followerBpm });
  }
  return buildSuccess(ratio);
}

/**
 * Resolve a beat-synced follower launch against a playing master transport.
 *
 * @param {object} args
 * @param {object} args.masterTransport normalized or raw DeckTransport
 * @param {object} args.followerTrack deck track record with bpm + beat_grid
 * @param {number} [args.followerCueSeconds=0] current/cue element position
 * @param {number} args.nowAudioTime AudioContext.currentTime when resolving
 * @returns {{ ok: true, value: object } | { ok: false, code: string }}
 */
export function resolveSyncedFollowerLaunch({
  masterTransport,
  followerTrack,
  followerCueSeconds = 0,
  nowAudioTime,
}) {
  const masterNorm = normalizeTransport(masterTransport);
  if (!masterNorm.ok) return masterNorm;
  const transport = masterNorm.value;
  if (!transport.playing) {
    return buildFailure(ERROR_CODES.T_TRANSPORT_NOT_PLAYING);
  }
  if (!finiteNumber(nowAudioTime)) {
    return buildFailure(ERROR_CODES.T_INVALID_TIME, { value: nowAudioTime, field: 'nowAudioTime' });
  }
  if (!finiteNumber(followerCueSeconds) || followerCueSeconds < 0) {
    return buildFailure('T_ELEMENT_TIME_INVALID', { value: followerCueSeconds });
  }

  const followerFacts = extractTrackGridFacts(followerTrack);
  if (!followerFacts.ok) return followerFacts;

  const tempo = computeTempoRatio(transport.tempoBpm, followerFacts.value.bpm);
  if (!tempo.ok) return tempo;

  const phrase = resolveNextPhrase(transport, nowAudioTime);
  if (!phrase.ok) return phrase;

  const leadSeconds = phrase.value.launchAudioTime - nowAudioTime;
  if (leadSeconds < BEAT_SYNC_MIN_LEAD_SECONDS) {
    return buildFailure(ERROR_CODES.T_SYNC_LEAD_TOO_SHORT, { leadSeconds });
  }

  const masterBeatNow = beatAtTime(transport, nowAudioTime);
  const masterBeatAtLaunch = phrase.value.launchBeat;
  const followerBeatNow = secondsToBeats(
    followerCueSeconds,
    followerFacts.value.beatGrid,
    followerFacts.value.bpm,
  );
  const followerBeatAtLaunch = followerBeatNow + (masterBeatAtLaunch - masterBeatNow);
  const launchElementSeconds = beatsToSeconds(
    followerBeatAtLaunch,
    followerFacts.value.beatGrid,
    followerFacts.value.bpm,
  );
  if (!finiteNumber(launchElementSeconds) || launchElementSeconds < 0) {
    return buildFailure('T_GRID_MISSING', { reason: 'invalid launch element seconds' });
  }

  return buildSuccess(Object.freeze({
    launchAudioTime: phrase.value.launchAudioTime,
    launchElementSeconds,
    launchBeat: masterBeatAtLaunch,
    followerBeatAtLaunch,
    tempoRatio: tempo.value,
    masterBeatNow,
    phraseIndex: phrase.value.phraseIndex,
    phraseBeats: phrase.value.phraseBeats,
    gridRevision: transport.gridRevision,
    receipt: Object.freeze({
      launchAudioTime: phrase.value.launchAudioTime,
      launchElementSeconds,
      launchBeat: masterBeatAtLaunch,
      tempoRatio: tempo.value,
      requestedAt: nowAudioTime,
      masterDeck: transport.deck,
      gridRevision: transport.gridRevision,
    }),
  }));
}

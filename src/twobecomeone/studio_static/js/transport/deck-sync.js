// js/transport/deck-sync.js — Phase 15B pure DJ-sync + equal-power math.
//
// No DOM, Web Audio, timers, or fetch. Follower starts align to the master's
// next *beat* boundary (Goal: "future beat boundary"), using beatAtTime from
// the production transport module. Tests compute expected launch independently.

import { PHRASE_EPSILON, beatsPerSecond, beatAtTime } from './derive.js';
import { buildDeckTransport } from '../runtime/transport-bridge.js';

export const MIN_LEAD_SECONDS = 0.25;
export const MIN_PLAYBACK_RATE = 0.5;
export const MAX_PLAYBACK_RATE = 2;
export const LIMITER_POLICY = 'off';

/**
 * Equal-power stereo-pair gains for a live crossfader.
 * 0 = A only, 1 = B only, 0.5 = both at equal power (≈ -3 dB each).
 */
export function equalPowerGains(xfader) {
  if (!Number.isFinite(xfader)) {
    return { ok: false, code: 'T_INVALID_TIME', field: 'xfader' };
  }
  const x = Math.min(1, Math.max(0, xfader));
  const angle = x * (Math.PI / 2);
  let gainA = Math.cos(angle);
  let gainB = Math.sin(angle);
  if (Math.abs(gainA) < 1e-10) gainA = 0;
  if (Math.abs(gainB) < 1e-10) gainB = 0;
  return {
    ok: true,
    value: Object.freeze({
      xfader: x,
      gainA,
      gainB,
    }),
  };
}

export function clampPlaybackRate(rate) {
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, rate));
}

/** Master BPM / follower BPM, clamped. Null if either BPM is unusable. */
export function tempoMatchRate(masterBpm, followerBpm) {
  const master = Number(masterBpm);
  const follower = Number(followerBpm);
  if (!Number.isFinite(master) || master <= 0) return null;
  if (!Number.isFinite(follower) || follower <= 0) return null;
  return clampPlaybackRate(master / follower);
}

/**
 * Pitch preservation is a browser capability, not a truth because a property
 * was assigned. We never return "preserved".
 */
export function pitchPreservationState(element) {
  if (!element || typeof element !== 'object') return 'unknown';
  const hasFlag = 'preservesPitch' in element
    || 'mozPreservesPitch' in element
    || 'webkitPreservesPitch' in element;
  if (!hasFlag) return 'unsupported';
  const flag = element.preservesPitch ?? element.mozPreservesPitch ?? element.webkitPreservesPitch;
  if (flag === true) return 'requested';
  if (flag === false) return 'off';
  return 'unsupported';
}

export function beatsToSeconds(beat, beatGrid, bpm) {
  return Number(beatGrid.first_beat) + beat * (60 / bpm);
}

/**
 * Next future beat boundary on an already-normalized playing transport.
 */
export function nextBeatLaunch(transport, nowAudioTime, minLeadSeconds = MIN_LEAD_SECONDS) {
  if (!Number.isFinite(nowAudioTime)) {
    return { ok: false, code: 'T_INVALID_TIME' };
  }
  const beat = beatAtTime(transport, nowAudioTime);
  const bps = beatsPerSecond(transport.tempoBpm);
  let nextBeat = Math.floor(beat + PHRASE_EPSILON) + 1;
  let launchAudioTime = transport.startedAtAudioTime
    + (nextBeat - transport.beatAtStart) / bps;
  const lead = Number(minLeadSeconds);
  while (Number.isFinite(lead) && launchAudioTime - nowAudioTime < lead) {
    nextBeat += 1;
    launchAudioTime = transport.startedAtAudioTime
      + (nextBeat - transport.beatAtStart) / bps;
  }
  return {
    ok: true,
    value: Object.freeze({
      launchBeat: nextBeat,
      launchAudioTime,
      requestedAt: nowAudioTime,
      gridRevision: transport.gridRevision,
    }),
  };
}

/**
 * Plan a follower start aligned to the master's next safe beat boundary.
 */
export function planFollowerStart({
  masterTrack,
  masterDeck,
  masterElementSeconds,
  masterPlaying,
  followerTrack,
  followerDeck,
  nowAudioTime,
  minLeadSeconds = MIN_LEAD_SECONDS,
  matchTempo = true,
}) {
  const masterTransport = buildDeckTransport({
    deck: masterDeck,
    track: masterTrack,
    elementSeconds: masterElementSeconds,
    playing: masterPlaying,
    audioClockNow: nowAudioTime,
  });
  if (!masterTransport.ok) return masterTransport;

  const beatPlan = nextBeatLaunch(masterTransport.value, nowAudioTime, minLeadSeconds);
  if (!beatPlan.ok) return beatPlan;

  const followerBpm = Number(followerTrack?.bpm);
  const followerGrid = followerTrack?.beat_grid;
  if (!Number.isFinite(followerBpm) || followerBpm <= 0) {
    return { ok: false, code: 'T_INVALID_TEMPO' };
  }
  if (!followerGrid || !Number.isFinite(Number(followerGrid.first_beat))) {
    return { ok: false, code: 'T_GRID_MISSING' };
  }

  const launchBeat = beatPlan.value.launchBeat;
  const mediaOffsetSeconds = beatsToSeconds(launchBeat, followerGrid, followerBpm);
  if (!Number.isFinite(mediaOffsetSeconds) || mediaOffsetSeconds < 0) {
    return { ok: false, code: 'T_INVALID_TIME' };
  }

  const playbackRate = matchTempo
    ? tempoMatchRate(masterTransport.value.tempoBpm, followerBpm)
    : 1;
  if (playbackRate == null) return { ok: false, code: 'T_INVALID_TEMPO' };

  return {
    ok: true,
    value: Object.freeze({
      masterDeck,
      followerDeck,
      launchAudioTime: beatPlan.value.launchAudioTime,
      launchBeat,
      mediaOffsetSeconds,
      playbackRate,
      displayedRatio: playbackRate,
      gridRevision: beatPlan.value.gridRevision,
      requestedAt: nowAudioTime,
      minLeadSeconds: Number(minLeadSeconds),
    }),
  };
}
